import { eventRetentionStatus } from "./event-retention";
import { reviewExhibitionAnswer } from "./ai-safety";

/** These diagnostic requests contain only the fixed fictional material below.
 * They deliberately do not use chat(), student storage, or the manuscript
 * processing gate. Changing a model here never enables manuscript processing. */
export const PROBE_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5-2",
] as const;
export type ProbeModel = typeof PROBE_MODELS[number];
export function isProbeModel(value: unknown): value is ProbeModel {
  return typeof value === "string" && (PROBE_MODELS as readonly string[]).includes(value);
}

const ENDPOINT = "https://cf.api.fan/v1/messages";
const SOURCE = "This is a fictional classroom exhibition. It displays a blue toy compass that points north. No information about its maker, price, or owner is supplied.";
const QUESTION = "According to the fictional exhibition, which direction does the toy compass point?";
const EXPECTED_ANSWER = "The toy compass points north.";
const MAX_RESPONSE_BYTES = 32_768;

type ProbeStatus = "ok" | "http_error" | "invalid_response" | "network_error" | "timeout" | "aborted" | "event_closed" | "skipped";
export interface ProbeStep {
  status: ProbeStatus;
  elapsedMs: number;
  pass: boolean;
  httpStatus?: number;
  /** Bounded, credential-redacted response to fixed fictional content only. */
  response?: string;
}

function cleanSyntheticResponse(text: string, key: string): string {
  return text.split(key).join("[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[URL omitted]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .slice(0, 1200);
}

async function responseText(response: Response): Promise<string> {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Invalid diagnostic response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Invalid diagnostic response");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data) || "error" in data) throw new Error("Invalid diagnostic response");
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Invalid diagnostic response");
  const text = content.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("").trim();
  if (!text || text.length > 8000) throw new Error("Invalid diagnostic response");
  return text;
}

async function probeRequest(model: ProbeModel, system: string, messages: { role: "user"; content: string }[], signal: AbortSignal): Promise<{ step: ProbeStep; raw?: string }> {
  const start = Date.now();
  if (signal.aborted) return { step: { status: "aborted", elapsedMs: 0, pass: false } };
  const state = eventRetentionStatus();
  if (state.state !== "open" || !state.endsAt) return { step: { status: "event_closed", elapsedMs: 0, pass: false } };
  const key = process.env.AI_API_KEY?.trim();
  if (!key) throw new Error("AI key is not configured");
  const timeoutMs = model === "claude-fable-5-2" ? 50_000 : 25_000;
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, Date.parse(state.endsAt) - Date.now())));
  const requestSignal = AbortSignal.any([signal, timeout]);
  let httpStatus: number | undefined;
  let received = false;
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST", redirect: "error", cache: "no-store", signal: requestSignal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, system, messages, max_tokens: 200, temperature: 0, stream: false }),
    });
    received = true; httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { step: { status: "http_error", httpStatus, elapsedMs: Date.now() - start, pass: false } };
    }
    const raw = await responseText(response);
    requestSignal.throwIfAborted();
    if (eventRetentionStatus().state !== "open") return { step: { status: "event_closed", elapsedMs: Date.now() - start, pass: false } };
    return { raw, step: { status: "ok", httpStatus, elapsedMs: Date.now() - start, pass: false, response: cleanSyntheticResponse(raw, key) } };
  } catch {
    const status: ProbeStatus = eventRetentionStatus().state !== "open" ? "event_closed" : signal.aborted ? "aborted" : timeout.aborted ? "timeout" : received ? "invalid_response" : "network_error";
    return { step: { status, httpStatus, elapsedMs: Date.now() - start, pass: false } };
  }
}

/** At most two requests, no retries and no input other than a listed model.
 * The review uses a fixed correct answer, never arbitrary upstream output. */
export async function runAiProbe(model: ProbeModel, signal: AbortSignal) {
  if (!isProbeModel(model)) throw new Error("Unsupported diagnostic model");
  const start = Date.now();
  const generation = await probeRequest(model,
    "Use only the supplied fictional exhibit facts. Answer in exactly one English sentence using the template 'The toy compass points DIRECTION.' Replace DIRECTION with the direction stated in the source. Do not add any other text or facts.",
    [{ role: "user", content: `${SOURCE}\n\n${QUESTION}` }], signal);
  generation.step.pass = generation.raw === EXPECTED_ANSWER;
  let review: ProbeStep = { status: "skipped", elapsedMs: 0, pass: false };
  if (generation.step.status === "ok" && !signal.aborted && eventRetentionStatus().state === "open") {
    const approved = await reviewExhibitionAnswer({ source: SOURCE, question: QUESTION, answer: EXPECTED_ANSWER, suggestions: [] }, async (options) => {
      const result = await probeRequest(model, options.system, options.messages, signal);
      review = result.step;
      if (result.raw === undefined) throw new Error("Diagnostic review unavailable");
      return result.raw;
    });
    review.pass = approved;
  }
  return { model, syntheticOnly: true, pass: generation.step.pass && review.pass, elapsedMs: Date.now() - start, generation: generation.step, review };
}
