// ─────────────────────────────────────────────────────────────────────
// A2E (video.a2e.com.cn) — domestic talking-photo / lip-sync provider.
// Responses are wrapped as { code: 0, data: {...} }. Auth: Bearer sk_...
// ─────────────────────────────────────────────────────────────────────

import type { AvatarPollResult } from "./types";

const BASE = (process.env.A2E_BASE_URL || "https://video.a2e.com.cn").replace(/\/$/, "");

function key(): string {
  return process.env.A2E_API_KEY?.trim() || "";
}

export function a2eConfigured(): boolean {
  return (process.env.AVATAR_PROVIDER || "mock").toLowerCase() === "a2e" && !!key();
}

export interface A2eResult {
  httpStatus: number;
  ok: boolean;
  json: any;
}

export async function a2e(path: string, method = "POST", body?: unknown): Promise<A2eResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 800) };
  }
  // A2E uses code:0 for success even on HTTP 200; treat code!==0 as not-ok.
  const ok = res.ok && (json?.code === 0 || json?.code === undefined);
  return { httpStatus: res.status, ok, json };
}

/** Recursively find the first http(s) URL string in an object (handy for
 *  locating result/audio/video URLs whose exact field name we don't yet know). */
export function findUrl(obj: unknown, hint?: RegExp): string | null {
  const urls: { key: string; url: string }[] = [];
  const walk = (o: unknown, k = "") => {
    if (typeof o === "string") {
      if (/^https?:\/\//.test(o)) urls.push({ key: k, url: o });
    } else if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${k}[${i}]`));
    } else if (o && typeof o === "object") {
      for (const [kk, vv] of Object.entries(o)) walk(vv, k ? `${k}.${kk}` : kk);
    }
  };
  walk(obj);
  if (hint) {
    const m = urls.find((u) => hint.test(u.key) || hint.test(u.url));
    if (m) return m.url;
  }
  return urls[0]?.url ?? null;
}

// Multilingual (zh + en) default voices, per gender. Override via env.
const VOICE_MALE = process.env.A2E_TTS_ID_MALE || "66d3fb1bc051cfb134c60f20"; // Andrew Multilingual
const VOICE_FEMALE = process.env.A2E_TTS_ID_FEMALE || "66d3fb89357648b14c4f4f26"; // Emma Multilingual

function voiceFor(gender?: "male" | "female"): string {
  if (gender === "female") return VOICE_FEMALE;
  if (gender === "male") return VOICE_MALE;
  return process.env.A2E_TTS_ID || VOICE_MALE;
}

// Cache the A2E-hosted copy of each photo so we upload it only once per source.
const imageCache = new Map<string, string>();

async function a2eHostedImage(srcUrl: string): Promise<string> {
  const hit = imageCache.get(srcUrl);
  if (hit) return hit;
  const cdn = await a2eUploadImage(srcUrl);
  imageCache.set(srcUrl, cdn);
  return cdn;
}

/** Text-to-speech: returns an audio URL. This call is synchronous/fast (no
 *  polling needed) — this is what makes the "fast" avatar path near-instant. */
export async function a2eTts(text: string, gender?: "male" | "female"): Promise<string> {
  const tts = await a2e("/api/v1/video/send_tts", "POST", { msg: text, tts_id: voiceFor(gender) });
  const audioUrl = typeof tts.json?.data === "string" ? tts.json.data : findUrl(tts.json);
  if (!audioUrl) throw new Error("send_tts returned no audio: " + JSON.stringify(tts.json).slice(0, 200));
  return audioUrl;
}

/** Create a talking-photo (lip-sync) task: TTS the text, then animate the photo.
 *  Returns the A2E task id. Slow (precise per-answer render) — used only in
 *  A2E_MODE=precise; the default "fast" mode uses a2eTts + a pre-generated loop. */
export async function a2eCreateTalkingPhoto(
  text: string,
  srcPhotoUrl: string,
  gender?: "male" | "female"
): Promise<string> {
  const image_url = await a2eHostedImage(srcPhotoUrl);
  const audio_url = await a2eTts(text, gender);

  const start = await a2e("/api/v1/talkingPhoto/start", "POST", {
    name: "dcp",
    prompt: "A person looking at the camera talking naturally with subtle head movement, friendly expression",
    negative_prompt: "blurry, low quality, distorted face, deformed, extra fingers, watermark",
    image_url,
    audio_url,
  });
  const id = start.json?.data?._id;
  if (!id) throw new Error("talkingPhoto/start failed: " + JSON.stringify(start.json).slice(0, 300));
  return id as string;
}

/** Poll a talking-photo task. Done when result_url is set; error if failed. */
export async function a2ePollTalkingPhoto(id: string): Promise<AvatarPollResult> {
  const r = await a2e(`/api/v1/talkingPhoto/${id}`, "GET");
  const d = r.json?.data;
  if (d?.result_url) return { status: "done", videoUrl: d.result_url as string };
  if (d?.failed_message || d?.failed_code) return { status: "error" };
  return { status: "pending" };
}

// Cartoon-ify is async (Nano Banana render can exceed serverless limits):
// start the task, then poll separately from the client.

/** Start a cartoon-ify task. Returns the A2E task id (or an error reason). */
export async function a2eCartoonStart(
  srcPhotoUrl: string
): Promise<{ taskId: string } | { error: string }> {
  const model = process.env.A2E_CARTOON_MODEL || "nano-banana-pro";
  try {
    const cdnUrl = await a2eHostedImage(srcPhotoUrl);
    const start = await a2e("/api/v1/userNanoBanana/start", "POST", {
      model,
      prompt:
        "Turn this portrait into a soft, lightly stylized cartoon illustration while keeping the person clearly recognizable (same face, hair, features). Clean friendly cartoon style, smooth shading, not too realistic, head and shoulders, simple plain background.",
      input_images: [cdnUrl],
      image_size: "1K",
    });
    const id = start.json?.data?._id;
    if (!id) {
      const j = start.json || {};
      return {
        error: `start ${start.httpStatus}: ${j.msg || j.message || j.code || JSON.stringify(j).slice(0, 200)}`,
      };
    }
    return { taskId: id as string };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Poll a cartoon-ify task once. */
export async function a2eCartoonPoll(
  taskId: string
): Promise<{ done: true; url: string } | { pending: true } | { error: string }> {
  const d = await a2e(`/api/v1/userNanoBanana/detail/${taskId}`, "GET");
  const data = d.json?.data;
  const urls: string[] = data?.image_urls || [];
  if (urls.length > 0) return { done: true, url: urls[0] };
  if (data?.failed_message) return { error: `render failed: ${data.failed_message}` };
  return { pending: true };
}

// Ambient "talking" loop video — generated ONCE per person (not per answer).
// A short clip of the person gesturing/talking with generic motion; played on
// loop client-side while real narration audio (a2eTts) plays over it. This is
// what makes answers start in seconds instead of waiting for a lip-sync render.

/** Start generating the ambient loop video from a person's photo/cartoon. */
export async function a2eLoopVideoStart(
  srcPhotoUrl: string
): Promise<{ taskId: string } | { error: string }> {
  try {
    const cdnUrl = await a2eHostedImage(srcPhotoUrl);
    const start = await a2e("/api/v1/userImage2Video/start", "POST", {
      name: "dcp-loop",
      prompt:
        "The person talks naturally to the camera: subtle mouth movement as if speaking, gentle head motion, occasional relaxed hand gestures, friendly calm demeanor, static camera, plain background, smooth continuous motion suitable for a seamless loop.",
      negative_prompt:
        "static image, no motion, frozen, blurry, low quality, distorted face, deformed, extra limbs, watermark, text overlay, camera movement, scene change",
      image_url: cdnUrl,
      duration: "5",
      aspect_ratio: "9:16",
      resolution: "720p",
    });
    const id = start.json?.data?._id;
    if (!id) {
      const j = start.json || {};
      const detail = j.errors ? JSON.stringify(j.errors) : j.msg || j.message || JSON.stringify(j);
      return { error: `start ${start.httpStatus}: ${String(detail).slice(0, 300)}` };
    }
    return { taskId: id as string };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Extract an actual video file URL from an A2E response. Deliberately strict:
 *  every A2E asset (including the source photo / cover thumbnail) is hosted on
 *  a domain containing "video" (video.a2e.com.cn), so a loose "url containing
 *  video" match would happily grab the INPUT PHOTO instead of the rendered
 *  clip. Only accept known result fields, and only if they look like a video
 *  file — never fall back to a generic scan. */
function extractVideoUrl(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.result_url,
    data.video_url,
    data.output_url,
    data.output_video_url,
    data.render_url,
    data.result?.video_url,
    data.result?.url,
    ...(Array.isArray(data.video_urls) ? data.video_urls : []),
    ...(Array.isArray(data.result_urls) ? data.result_urls : []),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  return candidates.find((u) => /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(u)) ?? null;
}

/** Poll a loop-video task once. Includes the raw status even while pending,
 *  so a client-side timeout can report something diagnosable instead of a
 *  bare "timed out" (this is what let a silent failure go unnoticed before —
 *  the error banner just wasn't visible on screen when it happened). */
export async function a2eLoopVideoPoll(
  taskId: string
): Promise<{ done: true; url: string } | { pending: true; status?: string } | { error: string }> {
  const d = await a2e(`/api/v1/userImage2Video/${taskId}`, "GET");
  const data = d.json?.data;
  const url = extractVideoUrl(data);
  if (url) return { done: true, url };
  if (data?.failed_message) return { error: `render failed: ${data.failed_message}` };
  return { pending: true, status: data?.current_status };
}

/** Upload an image (from any public URL) into A2E's storage; returns cdnUrl. */
export async function a2eUploadImage(srcUrl: string): Promise<string> {
  const img = await fetch(srcUrl);
  if (!img.ok) throw new Error(`fetch source image failed: ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  const ct = img.headers.get("content-type") || "image/jpeg";
  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  const stamp = `${buf.length}-${ext}`;
  const pres = await a2e("/api/v1/r2/upload-presigned-url", "POST", {
    key: `dcp/${stamp}.${ext}`,
    contentType: ct,
    fileSize: buf.length,
  });
  const up = pres.json?.data;
  if (!up?.uploadUrl) throw new Error("presign failed: " + JSON.stringify(pres.json).slice(0, 200));
  const put = await fetch(up.uploadUrl, { method: "PUT", headers: { "Content-Type": ct }, body: buf });
  if (!put.ok) throw new Error(`PUT upload failed: ${put.status}`);
  return up.cdnUrl as string;
}
