import type { AvatarResult } from "./types";

// ─────────────────────────────────────────────────────────────────────
// Talking-avatar (digital human) provider.
//
//   mock : no video — the browser speaks the text with a built-in voice while
//          the photo animates. Zero cost, no key, works locally. (default)
//   did  : real lip-sync video via D-ID. Requires DID_API_KEY and a PUBLIC
//          photo URL D-ID's servers can fetch (works once deployed to Vercel;
//          localhost photos are not reachable by D-ID, so mock is used there).
//
// The flow the product uses: packyapi produces the answer TEXT, then that text
// is handed here to be turned into a talking avatar.
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

export interface AvatarRequest {
  text: string;
  lang: "en" | "zh";
  /** Absolute, publicly reachable URL of the person's photo (for video providers). */
  photoPublicUrl?: string;
}

export function avatarProvider(): string {
  return PROVIDER;
}

export async function generateAvatar(req: AvatarRequest): Promise<AvatarResult> {
  const canDoVideo =
    PROVIDER === "did" && !!DID_API_KEY && !!req.photoPublicUrl && isPublicUrl(req.photoPublicUrl);

  if (!canDoVideo) {
    return { kind: "tts", text: req.text, lang: langTag(req.lang) };
  }

  try {
    const videoUrl = await didTalk(req.text, req.lang, req.photoPublicUrl!);
    return { kind: "video", videoUrl, text: req.text };
  } catch (err) {
    // Never let a video failure break the answer — fall back to spoken text.
    console.error("[avatar] D-ID failed, falling back to TTS:", err);
    return { kind: "tts", text: req.text, lang: langTag(req.lang) };
  }
}

function isPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    // D-ID can't reach localhost / private hosts.
    return !/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      u.hostname
    );
  } catch {
    return false;
  }
}

async function didTalk(
  text: string,
  lang: "en" | "zh",
  photoPublicUrl: string
): Promise<string> {
  const create = await fetch(`${DID_API_URL}/talks`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${DID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_url: photoPublicUrl,
      script: {
        type: "text",
        input: text,
        provider: { type: "microsoft", voice_id: didVoiceFor(lang) },
      },
      config: { stitch: true },
    }),
  });

  if (!create.ok) {
    throw new Error(`D-ID create failed (${create.status}): ${await create.text()}`);
  }
  const { id } = (await create.json()) as { id: string };

  // Poll for completion (D-ID renders in a few seconds → up to ~40s).
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${DID_API_URL}/talks/${id}`, {
      headers: { Authorization: `Basic ${DID_API_KEY}` },
    });
    if (!poll.ok) continue;
    const data = (await poll.json()) as { status: string; result_url?: string };
    if (data.status === "done" && data.result_url) return data.result_url;
    if (data.status === "error") throw new Error("D-ID render error");
  }
  throw new Error("D-ID render timed out");
}
