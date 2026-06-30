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
