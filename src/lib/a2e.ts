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

// Default voice (Andrew Multilingual — speaks zh + en). Override with A2E_TTS_ID.
const TTS_ID = process.env.A2E_TTS_ID || "66d3fb1bc051cfb134c60f20";

// Cache the A2E-hosted copy of each photo so we upload it only once per source.
const imageCache = new Map<string, string>();

async function a2eHostedImage(srcUrl: string): Promise<string> {
  const hit = imageCache.get(srcUrl);
  if (hit) return hit;
  const cdn = await a2eUploadImage(srcUrl);
  imageCache.set(srcUrl, cdn);
  return cdn;
}

/** Create a talking-photo (lip-sync) task: TTS the text, then animate the photo.
 *  Returns the A2E task id. */
export async function a2eCreateTalkingPhoto(text: string, srcPhotoUrl: string): Promise<string> {
  const image_url = await a2eHostedImage(srcPhotoUrl);

  const tts = await a2e("/api/v1/video/send_tts", "POST", { msg: text, tts_id: TTS_ID });
  const audio_url = typeof tts.json?.data === "string" ? tts.json.data : findUrl(tts.json);
  if (!audio_url) throw new Error("send_tts returned no audio: " + JSON.stringify(tts.json).slice(0, 200));

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
