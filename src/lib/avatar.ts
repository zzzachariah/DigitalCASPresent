import type { AvatarCreateResult, AvatarPollResult } from "./types";
import { a2eConfigured, a2eCreateTalkingPhoto, a2ePollTalkingPhoto } from "./a2e";

// ─────────────────────────────────────────────────────────────────────
// Talking-avatar (digital human) provider.
//
//   mock : no video — the browser speaks the text with a built-in voice while
//          the photo animates. Zero cost, no key, works locally. (default)
//   did  : real lip-sync video via D-ID. Requires DID_API_KEY and a PUBLIC
//          photo URL D-ID can fetch (Blob CDN URLs work; localhost does not).
//
// Flow (serverless-friendly): packyapi produces the answer TEXT → createAvatar()
// queues a D-ID render and returns a job id immediately → the browser polls
// pollAvatar(id) until the video is ready. This avoids long-running functions
// and Vercel timeouts; if the render fails/stalls the browser falls back to TTS.
// ─────────────────────────────────────────────────────────────────────

const PROVIDER = (process.env.AVATAR_PROVIDER || "mock").toLowerCase();
const DID_API_KEY = process.env.DID_API_KEY?.trim() || "";
const DID_API_URL = "https://api.d-id.com";

function langTag(lang: "en" | "zh"): string {
  return lang === "zh" ? "zh-CN" : "en-US";
}

function didVoiceFor(lang: "en" | "zh"): string {
  if (process.env.DID_VOICE_ID) return process.env.DID_VOICE_ID;
  return lang === "zh" ? "zh-CN-XiaoxiaoNeural" : "en-US-JennyNeural";
}

// D-ID keys from the dashboard are usually a ready-to-use base64 token, but
// some are shown as raw "email:key". Accept either form.
function didAuthHeader(): string {
  const token = DID_API_KEY.includes(":")
    ? Buffer.from(DID_API_KEY).toString("base64")
    : DID_API_KEY;
  return `Basic ${token}`;
}

export function avatarProvider(): string {
  return PROVIDER;
}

export interface AvatarRequest {
  text: string;
  lang: "en" | "zh";
  /** Absolute, publicly reachable photo URL (required for video providers). */
  photoPublicUrl?: string;
  /** Person's voice gender (picks the TTS voice). */
  gender?: "male" | "female";
}

function isPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return !/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      u.hostname
    );
  } catch {
    return false;
  }
}

export async function createAvatar(req: AvatarRequest): Promise<AvatarCreateResult> {
  // A2E talking-photo (domestic, China-friendly lip-sync video).
  if (PROVIDER === "a2e" && a2eConfigured() && req.photoPublicUrl) {
    try {
      const id = await a2eCreateTalkingPhoto(req.text, req.photoPublicUrl, req.gender);
      return { kind: "video-pending", id, text: req.text };
    } catch (err) {
      console.error("[avatar] A2E failed, falling back to TTS:", err);
      return { kind: "tts", text: req.text, lang: langTag(req.lang) };
    }
  }

  const canVideo =
    PROVIDER === "did" &&
    !!DID_API_KEY &&
    !!req.photoPublicUrl &&
    isPublicUrl(req.photoPublicUrl);

  if (!canVideo) {
    return { kind: "tts", text: req.text, lang: langTag(req.lang) };
  }

  try {
    const res = await fetch(`${DID_API_URL}/talks`, {
      method: "POST",
      headers: { Authorization: didAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        source_url: req.photoPublicUrl,
        script: {
          type: "text",
          input: req.text,
          provider: { type: "microsoft", voice_id: didVoiceFor(req.lang) },
        },
        config: { stitch: true },
      }),
    });
    if (!res.ok) {
      throw new Error(`D-ID create failed (${res.status}): ${await res.text()}`);
    }
    const { id } = (await res.json()) as { id: string };
    return { kind: "video-pending", id, text: req.text };
  } catch (err) {
    console.error("[avatar] create failed, falling back to TTS:", err);
    return { kind: "tts", text: req.text, lang: langTag(req.lang) };
  }
}

export async function pollAvatar(id: string): Promise<AvatarPollResult> {
  if (PROVIDER === "a2e") {
    return a2ePollTalkingPhoto(id);
  }
  try {
    const res = await fetch(`${DID_API_URL}/talks/${id}`, {
      headers: { Authorization: didAuthHeader() },
    });
    if (!res.ok) return { status: "pending" }; // transient; let the client retry
    const data = (await res.json()) as { status: string; result_url?: string };
    if (data.status === "done" && data.result_url) {
      return { status: "done", videoUrl: data.result_url };
    }
    if (data.status === "error" || data.status === "rejected") {
      return { status: "error" };
    }
    return { status: "pending" }; // created / started
  } catch {
    return { status: "pending" };
  }
}
