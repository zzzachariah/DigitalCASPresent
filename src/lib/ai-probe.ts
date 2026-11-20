import { eventRetentionStatus } from "./event-retention";
import { reviewExhibitionAnswer } from "./ai-safety";
import type { SafetyReviewDiagnostic } from "./ai-safety";
import { AiRequestError, aiHttpError, aiTransportError, safeAiFailure, type AiFailureDiagnostic } from "./ai-errors";
import { configuredReviewOutputMode, isReviewOutputMode, reviewRequestFields, reviewToolResult, type ReviewOutputMode, type ReviewProtocol } from "./review-output";
import { configuredReviewProfile, isReviewProfile, supportsReviewProfile, withReviewProfile, type ReviewProfile } from "./review-profile";
import { isProbeFixture, probeFixture, type ProbeFixture } from "./ai-probe-fixtures";
import { openAiModelFields } from "./model-options";
export { isReviewOutputMode } from "./review-output";
export { isReviewProfile, supportsReviewProfile } from "./review-profile";
export { isProbeFixture } from "./ai-probe-fixtures";

/** These diagnostic requests contain only the fixed fictional material below.
 * They deliberately do not use chat(), student storage, or the manuscript
 * processing gate. Changing a model here never enables manuscript processing. */
export const PROBE_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5-2",
  "qwen3.7-plus",
  "qwen3.8-flash",
] as const;
export type ProbeModel = typeof PROBE_MODELS[number];
export function isProbeModel(value: unknown): value is ProbeModel {
  return typeof value === "string" && (PROBE_MODELS as readonly string[]).includes(value);
}

const ENDPOINT = "https://cf.api.fan/v1";
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
  formatIssue?: SafetyReviewDiagnostic["formatIssue"];
  rejectedCriteria?: SafetyReviewDiagnostic["rejectedCriteria"];
  outputTokens?: number;
  stopReason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | "pause_turn" | "stop" | "length" | "tool_calls" | "content_filter";
  /** Only the exact expected answer or canonical five-boolean review. */
  response?: string;
}

function fixedSyntheticResponse(text: string, expectedAnswer?: string): string | undefined {
  if (expectedAnswer && text === expectedAnswer) return expectedAnswer;
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

function responseText(data: unknown, httpStatus: number, reviewMode?: ReviewOutputMode, protocol: ReviewProtocol = "anthropic"): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new AiRequestError({ kind: "invalid_response", httpStatus });
  if ("error" in data) throw aiHttpError(httpStatus, data);
  if (protocol === "openai") {
    const choices = "choices" in data && Array.isArray(data.choices) ? data.choices : [];
    if (choices.some((choice) => choice?.finish_reason === "length")) throw new AiRequestError({ kind: "truncated_response", httpStatus });
    if (reviewMode === "tool") return reviewToolResult(data, httpStatus, protocol);
    if (choices.length !== 1) throw new AiRequestError({ kind: "invalid_response", httpStatus });
    const text = choices[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new AiRequestError({ kind: "empty_response", httpStatus });
    if (text.length > 8000) throw new AiRequestError({ kind: "invalid_response", httpStatus });
    return text.trim();
  }
  // Thinking-only truncation must be distinguished from an empty response.
  if ("stop_reason" in data && data.stop_reason === "max_tokens") throw new AiRequestError({ kind: "truncated_response", httpStatus });
  if (reviewMode === "tool") return reviewToolResult(data, httpStatus);
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new AiRequestError({ kind: "invalid_response", httpStatus });
  const text = content.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("").trim();
  if (!text) throw new AiRequestError({ kind: "empty_response", httpStatus });
  if (text.length > 8000) throw new AiRequestError({ kind: "invalid_response", httpStatus });
  return text;
}

function safeMetrics(data: unknown): Pick<ProbeStep, "outputTokens" | "stopReason"> {
  if (!data || typeof data !== "object") return {};
  const { usage, stop_reason, choices } = data as { usage?: { output_tokens?: unknown; completion_tokens?: unknown }; stop_reason?: unknown; choices?: { finish_reason?: unknown }[] };
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
  const stopReason = stop_reason ?? (Array.isArray(choices) ? choices[0]?.finish_reason : undefined);
  return {
    ...(typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0 && outputTokens <= 1_000_000 ? { outputTokens } : {}),
    ...(["end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal", "pause_turn", "stop", "length", "tool_calls", "content_filter"].includes(stopReason as string) ? { stopReason: stopReason as ProbeStep["stopReason"] } : {}),
  };
}

async function probeRequest(model: ProbeModel, system: string, messages: { role: "user"; content: string }[], signal: AbortSignal, expectedAnswer?: string, maxTokens = 200, reviewMode?: ReviewOutputMode, reviewProfile: ReviewProfile = "default"): Promise<{ step: ProbeStep; raw?: string }> {
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
  let metrics: Pick<ProbeStep, "outputTokens" | "stopReason"> = {};
  const protocol: ReviewProtocol = model.startsWith("claude-") ? "anthropic" : "openai";
  const reviewFields = reviewMode ? withReviewProfile(reviewRequestFields(reviewMode, protocol), model, reviewProfile) : {};
  try {
    const response = await fetch(`${ENDPOINT}/${protocol === "anthropic" ? "messages" : "chat/completions"}`, {
      method: "POST", redirect: "error", cache: "no-store", signal: requestSignal,
      headers: protocol === "anthropic" ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" } : { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, stream: false, ...reviewFields,
        ...(protocol === "anthropic" ? { system, messages } : { store: false, ...openAiModelFields(model), messages: [{ role: "system", content: system }, ...messages] }) }),
    });
    httpStatus = response.status;
    if (!response.ok) {
      const data = await responseData(response).catch(() => undefined);
      throw aiHttpError(httpStatus, data);
    }
    const data = await responseData(response);
    metrics = safeMetrics(data);
    const raw = responseText(data, httpStatus, reviewMode, protocol);
    requestSignal.throwIfAborted();
    if (eventRetentionStatus().state !== "open") return { step: { status: "event_closed", elapsedMs: Date.now() - start, pass: false } };
    return { raw, step: { status: "ok", httpStatus, maxTokens, ...metrics, elapsedMs: Date.now() - start, pass: false, response: fixedSyntheticResponse(raw, expectedAnswer) } };
  } catch (error) {
    const failure = safeAiFailure(aiTransportError(error, requestSignal));
    const status: ProbeStatus = eventRetentionStatus().state !== "open" ? "event_closed" : failure.kind === "aborted" ? "aborted" : failure.kind === "timeout" ? "timeout" :
      failure.kind === "http" ? "http_error" : failure.kind === "network" ? "network_error" : failure.kind === "unknown" ? "unknown_error" : "invalid_response";
    return { step: { status, httpStatus, maxTokens, ...metrics, failure, elapsedMs: Date.now() - start, pass: false } };
  }
}

/** Basic probes use at most two requests; complex probes use one review.
 * Fixed candidates include negative controls, never arbitrary upstream output. */
export async function runAiProbe(model: ProbeModel, signal: AbortSignal, options: { language?: "en" | "zh"; reviewMode?: ReviewOutputMode; fixture?: ProbeFixture; reviewProfile?: ReviewProfile } = {}) {
  if (!isProbeModel(model)) throw new Error("Unsupported diagnostic model");
  const language = options.language ?? "en";
  if (language !== "en" && language !== "zh") throw new Error("Unsupported diagnostic language");
  const configuredReviewMode = configuredReviewOutputMode();
  const reviewMode = options.reviewMode ?? configuredReviewMode;
  if (!isReviewOutputMode(reviewMode)) throw new Error("Unsupported diagnostic review mode");
  const configuredProfile = configuredReviewProfile();
  const reviewProfile = options.reviewProfile ?? configuredProfile;
  if (!isReviewProfile(reviewProfile) || !supportsReviewProfile(model, reviewProfile)) throw new Error("Unsupported diagnostic review profile");
  const fixtureName = options.fixture ?? "basic";
  if (!isProbeFixture(fixtureName)) throw new Error("Unsupported diagnostic fixture");
  const fixture = probeFixture(language, fixtureName);
  const start = Date.now();
  let generation: { step: ProbeStep; raw?: string } = { step: { status: "skipped", elapsedMs: 0, pass: false } };
  if (fixtureName === "basic") {
    generation = await probeRequest(model, fixture.instruction, [{ role: "user", content: `${fixture.source}\n\n${fixture.question}` }], signal, fixture.answer);
    generation.step.pass = generation.raw === fixture.answer;
  }
  let review: ProbeStep = { status: "skipped", elapsedMs: 0, pass: false };
  if ((fixtureName !== "basic" || generation.step.status === "ok") && !signal.aborted && eventRetentionStatus().state === "open") {
    const approved = await reviewExhibitionAnswer({ source: fixture.source, question: fixture.question, answer: fixture.answer, suggestions: [] }, async (options) => {
      const result = await probeRequest(model, options.system, options.messages, signal, fixtureName === "basic" ? fixture.answer : undefined, options.maxTokens, options.reviewOutput, reviewProfile);
      review = result.step;
      if (result.raw === undefined) throw new AiRequestError(result.step.failure || { kind: "unknown" });
      return result.raw;
    }, (diagnostic) => { review.reviewReason = diagnostic.reason; review.formatIssue = diagnostic.formatIssue; review.rejectedCriteria = diagnostic.rejectedCriteria; }, { outputMode: reviewMode });
    review.pass = approved;
  }
  const matchedExpectation = review.status === "ok" && (fixture.expectedApproved ? review.pass :
    review.reviewReason === "model_rejection" && fixture.expectedRejectedCriteria.every((field) => review.rejectedCriteria?.includes(field as NonNullable<ProbeStep["rejectedCriteria"]>[number]))) &&
    (fixtureName !== "basic" || generation.step.pass);
  return { model, language, fixture: fixtureName, reviewMode, configuredReviewMode, reviewProfile, configuredReviewProfile: configuredProfile,
    expectedApproved: fixture.expectedApproved, expectedRejectedCriteria: fixture.expectedRejectedCriteria, matchedExpectation,
    syntheticOnly: true, pass: matchedExpectation, elapsedMs: Date.now() - start, generation: generation.step, review };
}
