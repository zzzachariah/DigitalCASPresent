import { eventRetentionStatus } from "./event-retention";
import { reviewExhibitionAnswer } from "./ai-safety";
import type { SafetyReviewDiagnostic } from "./ai-safety";
import { AiRequestError, aiHttpError, aiTransportError, safeAiFailure, type AiFailureDiagnostic } from "./ai-errors";

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

type ProbeStatus = "ok" | "http_error" | "invalid_response" | "network_error" | "timeout" | "aborted" | "unknown_error" | "event_closed" | "skipped";
export interface ProbeStep {
  status: ProbeStatus;
  elapsedMs: number;
  pass: boolean;
  httpStatus?: number;
  maxTokens?: number;
  failure?: AiFailureDiagnostic;
  reviewReason?: SafetyReviewDiagnostic["reason"];
  /** Only the exact expected answer or canonical five-boolean review. */
  response?: string;
}

function fixedSyntheticResponse(text: string): string | undefined {
  if (text === EXPECTED_ANSWER) return EXPECTED_ANSWER;
  try {
    const data: unknown = JSON.parse(text);
    const fields = ["safe", "grounded", "private", "relevant", "respectful"];
    if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === fields.length &&
        fields.every((field) => typeof (data as Record<string, unknown>)[field] === "boolean")) {
      return JSON.stringify(Object.fromEntries(fields.map((field) => [field, (data as Record<string, unknown>)[field]])));
    }
  } catch { /* never expose free-form model output */ }
  return undefined;
}

async function responseData(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new AiRequestError({ kind: "invalid_response", httpStatus: response.status });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new AiRequestError({ kind: "invalid_response", httpStatus: response.status });
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AiRequestError({ kind: "invalid_response", httpStatus: response.status }); }
}

function responseText(data: unknown, httpStatus: number): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new AiRequestError({ kind: "invalid_response", httpStatus });
  if ("error" in data) throw aiHttpError(httpStatus, data);
  // Thinking-only truncation must be distinguished from an empty response.
  if ("stop_reason" in data && data.stop_reason === "max_tokens") throw new AiRequestError({ kind: "truncated_response", httpStatus });
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new AiRequestError({ kind: "invalid_response", httpStatus });
  const text = content.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("").trim();
  if (!text) throw new AiRequestError({ kind: "empty_response", httpStatus });
  if (text.length > 8000) throw new AiRequestError({ kind: "invalid_response", httpStatus });
  return text;
}

async function probeRequest(model: ProbeModel, system: string, messages: { role: "user"; content: string }[], signal: AbortSignal, maxTokens = 200): Promise<{ step: ProbeStep; raw?: string }> {
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
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST", redirect: "error", cache: "no-store", signal: requestSignal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, system, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
    });
    httpStatus = response.status;
    if (!response.ok) {
      const data = await responseData(response).catch(() => undefined);
      throw aiHttpError(httpStatus, data);
    }
    const raw = responseText(await responseData(response), httpStatus);
    requestSignal.throwIfAborted();
    if (eventRetentionStatus().state !== "open") return { step: { status: "event_closed", elapsedMs: Date.now() - start, pass: false } };
    return { raw, step: { status: "ok", httpStatus, maxTokens, elapsedMs: Date.now() - start, pass: false, response: fixedSyntheticResponse(raw) } };
  } catch (error) {
    const failure = safeAiFailure(aiTransportError(error, requestSignal));
    const status: ProbeStatus = eventRetentionStatus().state !== "open" ? "event_closed" : failure.kind === "aborted" ? "aborted" : failure.kind === "timeout" ? "timeout" :
      failure.kind === "http" ? "http_error" : failure.kind === "network" ? "network_error" : failure.kind === "unknown" ? "unknown_error" : "invalid_response";
    return { step: { status, httpStatus, maxTokens, failure, elapsedMs: Date.now() - start, pass: false } };
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
      const result = await probeRequest(model, options.system, options.messages, signal, options.maxTokens);
      review = result.step;
      if (result.raw === undefined) throw new AiRequestError(result.step.failure || { kind: "unknown" });
      return result.raw;
    }, (diagnostic) => { review.reviewReason = diagnostic.reason; });
    review.pass = approved;
  }
  return { model, syntheticOnly: true, pass: generation.step.pass && review.pass, elapsedMs: Date.now() - start, generation: generation.step, review };
}
