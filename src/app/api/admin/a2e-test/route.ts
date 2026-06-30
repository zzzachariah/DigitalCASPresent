import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, listPeople } from "@/lib/store";
import { a2e, a2eUploadImage, findUrl } from "@/lib/a2e";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Admin-only discovery tool: runs the A2E talking-photo flow end-to-end and
// dumps each raw response so we can wire the exact field names.
// Usage:
//   /api/admin/a2e-test            → just list voices (cheap, no credits)
//   /api/admin/a2e-test?full=1     → also TTS + upload + talkingPhoto (uses credits)
//   &voice=<tts_id>  &personId=<id>
export async function GET(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const full = req.nextUrl.searchParams.get("full") === "1";
  const voiceParam = req.nextUrl.searchParams.get("voice") || undefined;
  const personId = req.nextUrl.searchParams.get("personId") || undefined;

  const out: Record<string, unknown> = {
    config: {
      provider: process.env.AVATAR_PROVIDER || "(unset)",
      keySet: !!process.env.A2E_API_KEY,
    },
  };

  // ── Cartoon-ify discovery (?cartoon=1): probe the image-edit endpoints so we
  //    can turn a photo into a light cartoon that still looks like the person. ──
  if (req.nextUrl.searchParams.get("cartoon") === "1") {
    const person = personId ? await getPerson(personId) : (await listPeople())[0];
    if (!person?.photoUrl) {
      return NextResponse.json({ error: "没有带照片的人物" }, { status: 404 });
    }
    const cartoonOut: Record<string, unknown> = {};
    try {
      const cdnUrl = await a2eUploadImage(person.photoUrl);
      cartoonOut.uploadedImageCdnUrl = cdnUrl;
      const prompt =
        "Turn this portrait into a soft, lightly stylized cartoon illustration while keeping the person clearly recognizable. Clean friendly cartoon style, smooth shading, not too realistic, head and shoulders, plain background.";
      // Superset of likely field names; raw responses reveal the right ones.
      const bodies = {
        nanoBanana: { prompt, image_urls: [cdnUrl], imageUrls: [cdnUrl], images: [cdnUrl], image_url: cdnUrl },
        gptImage: { prompt, image_url: cdnUrl, image: cdnUrl, images: [cdnUrl], imageUrls: [cdnUrl] },
        imageEdit: { prompt, image_url: cdnUrl, imageUrl: cdnUrl, image: cdnUrl },
      };
      cartoonOut.nanoBanana_start = await a2e("/api/v1/userNanoBanana/start", "POST", bodies.nanoBanana);
      cartoonOut.gptImage_start = await a2e("/api/v1/userGptImage/start", "POST", bodies.gptImage);
      cartoonOut.imageEdit_start = await a2e("/api/v1/userImageEdit/start", "POST", bodies.imageEdit);

      // Try to poll whichever returned an id, to learn the result-image field.
      const probe = async (label: string, res: any, detailPath: (id: string) => string) => {
        const id = res?.json?.data?._id || res?.json?.data?.id;
        if (!id) return;
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          const d = await a2e(detailPath(id), "GET");
          (cartoonOut as any)[`${label}_detail`] = d;
          if (findUrl(d.json, /result|image|url|cartoon|cdn/i)) break;
        }
      };
      await probe("nanoBanana", cartoonOut.nanoBanana_start, (id) => `/api/v1/userNanoBanana/detail/${id}`);
      await probe("gptImage", cartoonOut.gptImage_start, (id) => `/api/v1/userGptImage/detail/${id}`);
      await probe("imageEdit", cartoonOut.imageEdit_start, (id) => `/api/v1/userImageEdit/${id}`);
    } catch (e) {
      cartoonOut.error = e instanceof Error ? e.message : String(e);
    }
    return NextResponse.json({ config: out.config, cartoon: cartoonOut });
  }

  // Credits balance (to check the "额度" question).
  out.credits = await a2e("/api/v1/transactionRecord/creditsHistory", "GET");

  // 1) Voices (cheap). Try POST then GET shapes.
  out.tts_list = await a2e("/api/v1/anchor/tts_list", "POST", {});
  out.voice_list = await a2e("/api/v1/anchor/voice_list", "GET");

  if (!full) {
    out.note = "加 ?full=1 跑完整流程（会消耗少量额度）。先把 tts_list/voice_list 的结构发我也行。";
    return NextResponse.json(out);
  }

  // 2) TTS for a short test phrase.
  const ttsBody: Record<string, unknown> = { msg: "你好，这是一段测试。Hello, this is a test." };
  if (voiceParam) ttsBody.tts_id = voiceParam;
  const tts = await a2e("/api/v1/video/send_tts", "POST", ttsBody);
  out.send_tts = tts;
  const audioUrl = findUrl(tts.json, /audio|mp3|wav|url|result/i);
  out.audioUrlDetected = audioUrl;

  // 3) Upload the person's photo into A2E storage → cdnUrl.
  const person = personId ? await getPerson(personId) : (await listPeople())[0];
  if (!person?.photoUrl) {
    out.error = "没有带照片的人物；先在后台创建一个带真实照片的人。";
    return NextResponse.json(out);
  }
  try {
    const cdnUrl = await a2eUploadImage(person.photoUrl);
    out.uploadedImageCdnUrl = cdnUrl;

    // 4) Start talking photo. Now includes prompt/negative_prompt (required per
    //    the prior 400) + a superset of likely image/audio field names.
    const startBody: Record<string, unknown> = {
      name: "dcp-test",
      prompt: "A person looking at the camera and talking naturally with subtle head movement, friendly expression",
      negative_prompt: "blurry, low quality, distorted face, deformed, extra fingers, watermark",
      image_url: cdnUrl,
      imageUrl: cdnUrl,
      image: cdnUrl,
      audio_url: audioUrl,
      audioUrl: audioUrl,
      audio: audioUrl,
      audioSrc: audioUrl,
    };
    out.talkingPhoto_startBodySent = startBody;
    const start = await a2e("/api/v1/talkingPhoto/start", "POST", startBody);
    out.talkingPhoto_start = start;

    // 5) Poll a few times for the detail/result shape.
    const taskId = start.json?.data?._id || start.json?.data?.id || start.json?.data;
    out.detectedTaskId = taskId;
    if (typeof taskId === "string" && /^[\w-]+$/.test(taskId)) {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const detail = await a2e(`/api/v1/talkingPhoto/${taskId}`, "GET");
        out.talkingPhoto_detail = detail;
        const st = detail.json?.data?.status;
        if (st && /success|done|complet|fail|error/i.test(String(st))) break;
      }
    }
  } catch (e) {
    out.uploadError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json(out);
}
