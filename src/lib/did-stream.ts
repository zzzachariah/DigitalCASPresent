// ─────────────────────────────────────────────────────────────────────
// D-ID real-time streaming (WebRTC) helpers — server side.
//
// Flow: createStream → browser does the WebRTC handshake (sdp/ice) → speak()
// makes the always-on avatar talk in ~1-2s (no per-answer video render).
// These run server-side so the D-ID key never reaches the browser.
// ─────────────────────────────────────────────────────────────────────

const DID_API_URL = "https://api.d-id.com";

function auth(): string {
  const k = process.env.DID_API_KEY?.trim() || "";
  return k.includes(":") ? `Basic ${Buffer.from(k).toString("base64")}` : `Basic ${k}`;
}

export function didStreamEnabled(): boolean {
  return (
    (process.env.AVATAR_PROVIDER || "mock").toLowerCase() === "did" &&
    !!process.env.DID_API_KEY?.trim()
  );
}

export function didVoiceFor(lang: "en" | "zh"): string {
  if (process.env.DID_VOICE_ID) return process.env.DID_VOICE_ID;
  return lang === "zh" ? "zh-CN-XiaoxiaoNeural" : "en-US-JennyNeural";
}

async function didFetch(path: string, method: string, body?: unknown) {
  const res = await fetch(`${DID_API_URL}${path}`, {
    method,
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`D-ID ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    (err as any).status = res.status;
    throw err;
  }
  return json;
}

/** Create a new stream for a source photo. Returns id, session_id, offer, ice_servers. */
export function createStream(sourceUrl: string) {
  return didFetch("/talks/streams", "POST", { source_url: sourceUrl });
}

export function sendSdp(streamId: string, sessionId: string, answer: unknown) {
  return didFetch(`/talks/streams/${streamId}/sdp`, "POST", { answer, session_id: sessionId });
}

export function sendIce(
  streamId: string,
  sessionId: string,
  candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
) {
  return didFetch(`/talks/streams/${streamId}/ice`, "POST", {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    session_id: sessionId,
  });
}

export function speak(streamId: string, sessionId: string, text: string, lang: "en" | "zh") {
  return didFetch(`/talks/streams/${streamId}`, "POST", {
    script: {
      type: "text",
      input: text,
      provider: { type: "microsoft", voice_id: didVoiceFor(lang) },
    },
    config: { fluent: true, pad_audio: 0 },
    session_id: sessionId,
  });
}

export function closeStream(streamId: string, sessionId: string) {
  return didFetch(`/talks/streams/${streamId}`, "DELETE", { session_id: sessionId }).catch(
    () => ({})
  );
}
