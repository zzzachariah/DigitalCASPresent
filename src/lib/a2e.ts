import { externalProcessingAllowed, requireExternalProcessing } from "./processing-policy";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { assertEventOpen } from "./event-retention";
// ─────────────────────────────────────────────────────────────────────
// A2E (video.a2e.com.cn) — domestic talking-photo / lip-sync provider.
// Responses are wrapped as { code: 0, data: {...} }. Auth: Bearer sk_...
// ─────────────────────────────────────────────────────────────────────

import type { AvatarPollResult } from "./types";

const BASE = (process.env.A2E_BASE_URL || "https://video.a2e.com.cn").replace(/\/$/, "");

function key(): string {
  return process.env.A2E_API_KEY?.trim() || "";
}

export type A2eReadinessStatus = "privacy_disabled" | "provider_missing" | "key_missing" | "ready";
export interface A2eReadiness {
  status: A2eReadinessStatus;
  ready: boolean;
  message: string;
}

/** Local configuration/approval only; this never contacts the provider.
 * Privacy takes precedence so a deliberate block is not misreported as a
 * missing credential. Text AI approval does not approve A2E media processing. */
export function a2eReadiness(): A2eReadiness {
  if (!externalProcessingAllowed()) return {
    status: "privacy_disabled", ready: false,
    message: "A2E 通用媒体处理尚未获准。个别人员的照片与配音授权单独显示，文字 AI 授权不包含 A2E。 / General A2E processing is disabled; individual photo and narration permissions are separate.",
  };
  return a2eConfigurationReadiness();
}

function a2eConfigurationReadiness(): A2eReadiness {
  if ((process.env.AVATAR_PROVIDER || "mock").toLowerCase() !== "a2e") return {
    status: "provider_missing", ready: false,
    message: "尚未选择 A2E 作为形象与配音服务，请由管理员检查服务设置。 / A2E is not selected as the media provider.",
  };
  if (!key()) return {
    status: "key_missing", ready: false,
    message: "A2E 服务凭据尚未配置，请由管理员补齐。 / A2E credentials are missing.",
  };
  return { status: "ready", ready: true, message: "A2E 已获准且配置完整，尚未验证服务连通性。 / A2E is approved and configured; connectivity has not been verified." };
}

export function a2eConfigured(): boolean {
  return a2eReadiness().ready;
}

/** Organizer approval for this activity's current and future participants.
 * This authorizes only the existing person-bound A2E photo and reviewed TTS
 * operations. It does not open D-ID or the legacy arbitrary media endpoints. */
export function a2eActivityProcessingApproved(): boolean {
  return process.env.A2E_PROCESSING_APPROVED?.trim().toLowerCase() === "true";
}

function approvedScope(personId: string | undefined, ids: string[]): boolean {
  if (personId !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(personId)) return false;
  return a2eActivityProcessingApproved() || !!personId && ids.includes(personId);
}

/** Optional record-specific approval remains available when activity-wide
 * processing is closed. Browser input never grants permission. */
export function a2ePhotoApprovedPersonIds(): string[] {
  return approvedPersonIds(process.env.A2E_PHOTO_APPROVED_PERSON_IDS);
}

function approvedPersonIds(value?: string): string[] {
  return Array.from(new Set((value || "").split(",").map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id))));
}

export function a2eSpeechApprovedPersonIds(): string[] {
  return approvedPersonIds(process.env.A2E_SPEECH_APPROVED_PERSON_IDS);
}

/** Activity approval covers narration; legacy photo-only approval does not. */
export function a2eSpeechReadiness(personId?: string): A2eReadiness {
  if (!approvedScope(personId, a2eSpeechApprovedPersonIds())) return {
    status: "privacy_disabled", ready: false,
    message: "尚未获准让 A2E 为此人的已审核讲解配音。照片与文字 AI 授权不包含配音。 / A2E narration requires this person's separate approval; photo and text AI permissions do not include narration.",
  };
  const readiness = a2eConfigurationReadiness();
  return readiness.ready ? { ...readiness, message: a2eActivityProcessingApproved()
    ? "本活动所有同学（包括后续提交）的已审核讲解配音已统一启用。 / Reviewed narration is enabled for all current and future participants in this activity."
    : "此人的已审核讲解配音已获准且配置完整。 / This person's reviewed narration is approved and configured." } : readiness;
}

function requireSpeechProcessing(personId: string): void {
  assertEventOpen();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(personId)) throw new Error("Invalid participant");
  const readiness = a2eSpeechReadiness(personId);
  if (!readiness.ready) throw new Error(readiness.message);
}

export function a2ePhotoReadiness(personId?: string): A2eReadiness {
  if (!approvedScope(personId, a2ePhotoApprovedPersonIds())) return {
    status: "privacy_disabled", ready: false,
    message: "尚未获准让 A2E 处理此人的照片。仅单独获准的人员可生成卡通形象和动态视频，不包含配音。 / A2E photo processing requires this person's separate approval; narration is not included.",
  };
  const readiness = a2eConfigurationReadiness();
  return readiness.ready ? { ...readiness, message: a2eActivityProcessingApproved()
    ? "本活动所有同学（包括后续提交）的 A2E 卡通形象与动态视频已统一启用。 / A2E cartoons and ambient videos are enabled for all current and future participants in this activity."
    : "此人的 A2E 卡通形象与动态视频处理已获准且配置完整。 / This person's photo processing is approved and configured." } : readiness;
}

function requirePhotoProcessing(personId: string): void {
  assertEventOpen();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(personId)) throw new Error("Invalid participant");
  const readiness = a2ePhotoReadiness(personId);
  if (!readiness.ready) throw new Error(readiness.message);
}

function photoPathAllowed(path: string, method: string): boolean {
  return method === "POST" ? ["/api/v1/r2/upload-presigned-url", "/api/v1/userNanoBanana/start", "/api/v1/userImage2Video/start"].includes(path)
    : method === "GET" && /^\/api\/v1\/(?:userNanoBanana\/detail|userImage2Video)\/[A-Za-z0-9_-]{1,64}$/.test(path);
}

export type A2ePhotoTaskKind = "cartoon" | "loop";
/** Keep the browser's taskId opaque and bind it to its owner and purpose. */
export function issueA2ePhotoTask(personId: string, kind: A2ePhotoTaskKind, taskId: string): string {
  requirePhotoProcessing(personId);
  if (!safeTaskId(taskId)) throw new Error("Invalid photo task id");
  const payload = Buffer.from(JSON.stringify([personId, kind, taskId, Date.now()])).toString("base64url");
  return `${payload}.${createHmac("sha256", key()).update(`a2e-photo-task:${payload}`).digest("base64url")}`;
}

export function verifyA2ePhotoTask(token: string | null, personId: string, kind: A2ePhotoTaskKind): string | null {
  if (!key() || !token || token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const [payload, signature] = token.split(".");
    const expected = createHmac("sha256", key()).update(`a2e-photo-task:${payload}`).digest("base64url");
    const a = Buffer.from(signature); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const values: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Array.isArray(values) || values.length !== 4 || values[0] !== personId || values[1] !== kind ||
        typeof values[3] !== "number" || values[3] > Date.now() + 60_000 || Date.now() - values[3] > 24 * 60 * 60_000) return null;
    return typeof values[2] === "string" ? safeTaskId(values[2]) : null;
  } catch { return null; }
}

export interface A2eResult {
  httpStatus: number;
  ok: boolean;
  json: any;
}

export async function a2e(path: string, method = "POST", body?: unknown, signal?: AbortSignal, scope?: string | { speechPersonId: string }): Promise<A2eResult> {
  assertEventOpen();
  if (typeof scope === "string") {
    requirePhotoProcessing(scope);
    if (!photoPathAllowed(path, method)) throw new Error("This operation is outside photo-only approval");
  } else if (scope !== undefined) {
    requireSpeechProcessing(scope.speechPersonId);
    if (method !== "POST" || path !== "/api/v1/video/send_tts") throw new Error("This operation is outside speech-only approval");
  } else requireExternalProcessing();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(20_000),
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
const HAN_SCRIPT = new RegExp("\\p{Script=Han}", "u");
const SPEAKABLE_TEXT = new RegExp("[\\p{L}\\p{N}]", "u");

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
export async function a2eTts(text: string, gender?: "male" | "female", signal?: AbortSignal, personId?: string, language?: "en" | "zh"): Promise<string> {
  if (!SPEAKABLE_TEXT.test(text)) throw new Error("send_tts requires speakable text.");
  if (language !== undefined && language !== "en" && language !== "zh") throw new Error("Unsupported speech language.");
  // Set the locale for each spoken chunk, including bilingual answers. Leaving
  // it to upstream detection can reject short/mixed Chinese chunks with 1005.
  // A2E's documented locale fields are country (language) + region, not `lang`.
  // https://video.a2e.ai/dev/text-to-speech-api
  // A known answer language takes precedence over names/titles written in
  // another script. Bilingual chunks retain the existing per-chunk detection.
  const locale = (language ?? (HAN_SCRIPT.test(text) ? "zh" : "en")) === "zh"
    ? { country: "zh", region: "CN" }
    : { country: "en", region: "US" };
  const tts = await a2e("/api/v1/video/send_tts", "POST", { msg: text, tts_id: voiceFor(gender), ...locale }, signal, personId === undefined ? undefined : { speechPersonId: personId });
  if (!tts.ok) throw new Error(`send_tts failed (${tts.httpStatus}): ${JSON.stringify(tts.json).slice(0, 200)}`);
  const audioUrl = typeof tts.json?.data === "string" ? tts.json.data : findUrl(tts.json?.data);
  if (!audioUrl || !/^https?:\/\//.test(audioUrl)) {
    throw new Error("send_tts returned no audio: " + JSON.stringify(tts.json).slice(0, 200));
  }
  return audioUrl;
}

/** Task ids are interpolated into API paths — keep them to a safe shape. */
export function safeTaskId(id: string | null | undefined): string | null {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
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
  srcPhotoUrl: string, photoPersonId?: string
): Promise<{ taskId: string } | { error: string }> {
  const model = process.env.A2E_CARTOON_MODEL || "nano-banana-pro";
  try {
    if (photoPersonId !== undefined) requirePhotoProcessing(photoPersonId);
    // Scoped callers supply only the CDN result of a2eUploadImageBytes.
    const cdnUrl = photoPersonId !== undefined ? srcPhotoUrl : await a2eHostedImage(srcPhotoUrl);
    const start = await a2e("/api/v1/userNanoBanana/start", "POST", {
      model,
      prompt:
        "Turn this portrait into a soft, lightly stylized cartoon illustration while keeping the person clearly recognizable (same face, hair, features). Clean friendly cartoon style, smooth shading, not too realistic, head and shoulders, simple plain background.",
      input_images: [cdnUrl],
      image_size: "1K",
    }, undefined, photoPersonId);
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
  taskId: string, photoPersonId?: string
): Promise<{ done: true; url: string } | { pending: true } | { error: string }> {
  const d = await a2e(`/api/v1/userNanoBanana/detail/${taskId}`, "GET", undefined, undefined, photoPersonId);
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
  srcPhotoUrl: string, photoPersonId?: string
): Promise<{ taskId: string } | { error: string }> {
  try {
    if (photoPersonId !== undefined) requirePhotoProcessing(photoPersonId);
    // Scoped callers supply only the CDN result of a2eUploadImageBytes.
    const cdnUrl = photoPersonId !== undefined ? srcPhotoUrl : await a2eHostedImage(srcPhotoUrl);
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
    }, undefined, photoPersonId);
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
  taskId: string, photoPersonId?: string
): Promise<{ done: true; url: string } | { pending: true; status?: string } | { error: string }> {
  const d = await a2e(`/api/v1/userImage2Video/${taskId}`, "GET", undefined, undefined, photoPersonId);
  const data = d.json?.data;
  const url = extractVideoUrl(data);
  if (url) return { done: true, url };
  if (data?.failed_message) return { error: `render failed: ${data.failed_message}` };
  return { pending: true, status: data?.current_status };
}

/** Legacy broad-media path only; individual photo approval never fetches a
 * browser-supplied URL or forwards a private application/preview link. */
export async function a2eUploadImage(srcUrl: string): Promise<string> {
  requireExternalProcessing();
  const img = await fetch(srcUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!img.ok) throw new Error(`fetch source image failed: ${img.status}`);
  return uploadImageBytes(Buffer.from(await img.arrayBuffer()), img.headers.get("content-type") || "image/jpeg");
}

/** Source bytes must come from the authenticated server-side owner lookup. */
export async function a2eUploadImageBytes(buffer: Buffer, contentType: string, personId: string): Promise<string> {
  requirePhotoProcessing(personId);
  return uploadImageBytes(buffer, contentType, personId);
}

async function uploadImageBytes(buffer: Buffer, contentType: string, personId?: string): Promise<string> {
  if (personId !== undefined) requirePhotoProcessing(personId); else requireExternalProcessing();
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[contentType];
  if (!ext || buffer.length === 0 || buffer.length > 4 * 1024 * 1024) throw new Error("Unsupported source image");
  // Content hash avoids collisions between different students' equal-size files.
  const stamp = createHash("sha256").update(buffer).digest("hex");
  const pres = await a2e("/api/v1/r2/upload-presigned-url", "POST", {
    key: `dcp/${stamp}.${ext}`, contentType, fileSize: buffer.length,
  }, undefined, personId);
  const up = pres.json?.data;
  if (!pres.ok || typeof up?.uploadUrl !== "string" || typeof up?.cdnUrl !== "string") throw new Error("A2E image upload could not be prepared");
  for (const value of [up.uploadUrl, up.cdnUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid A2E image upload location");
  }
  if (personId !== undefined) requirePhotoProcessing(personId); else requireExternalProcessing();
  const response = await fetch(up.uploadUrl, { method: "PUT", redirect: "error", headers: { "Content-Type": contentType }, body: buffer as BodyInit, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`A2E image upload failed (${response.status})`);
  return up.cdnUrl;
}
