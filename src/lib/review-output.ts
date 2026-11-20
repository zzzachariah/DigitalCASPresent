import { AiRequestError } from "./ai-errors";

export const REVIEW_FIELDS = ["safe", "grounded", "private", "relevant", "respectful"] as const;
export const REVIEW_OUTPUT_MODES = ["text", "json_schema", "tool"] as const;
export type ReviewOutputMode = (typeof REVIEW_OUTPUT_MODES)[number];
export type ReviewProtocol = "anthropic" | "openai";
export const REVIEW_TOOL_NAME = "submit_safety_review";
export const REVIEW_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(REVIEW_FIELDS.map((field) => [field, { type: "boolean" }])),
  required: [...REVIEW_FIELDS], additionalProperties: false,
};

export function isReviewOutputMode(value: unknown): value is ReviewOutputMode {
  return (REVIEW_OUTPUT_MODES as readonly unknown[]).includes(value);
}

export function configuredReviewOutputMode(): ReviewOutputMode {
  const value = process.env.AI_REVIEW_FORMAT ?? "json_schema";
  if (!isReviewOutputMode(value)) throw new Error("Invalid AI review format configuration");
  return value;
}

/** Only this constant, non-personal schema can be sent by the review switch.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs */
export function reviewRequestFields(mode: ReviewOutputMode, protocol: ReviewProtocol = "anthropic"): Record<string, unknown> {
  if (mode === "text") return {};
  if (protocol === "openai") {
    if (mode === "json_schema") return { response_format: { type: "json_schema", json_schema: { name: REVIEW_TOOL_NAME, strict: true, schema: REVIEW_SCHEMA } } };
    if (mode === "tool") return {
      tools: [{ type: "function", function: { name: REVIEW_TOOL_NAME, description: "Return the five safety review decisions. This tool performs no external action.", strict: true, parameters: REVIEW_SCHEMA } }],
      tool_choice: { type: "function", function: { name: REVIEW_TOOL_NAME } }, parallel_tool_calls: false,
    };
    throw new Error("Invalid AI review format");
  }
  if (mode === "json_schema") return { output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA } } };
  if (mode === "tool") return {
    tools: [{ name: REVIEW_TOOL_NAME, description: "Return the five safety review decisions. This tool performs no external action.", input_schema: REVIEW_SCHEMA }],
    tool_choice: { type: "tool", name: REVIEW_TOOL_NAME, disable_parallel_tool_use: true },
  };
  throw new Error("Invalid AI review format");
}

export function isReviewDecision(value: unknown): value is Record<(typeof REVIEW_FIELDS)[number], boolean> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === REVIEW_FIELDS.length &&
    REVIEW_FIELDS.every((field) => typeof (value as Record<string, unknown>)[field] === "boolean"));
}

/** Tool-mode results cannot be supplied by text blocks, another tool, or
 * multiple calls. The tool is a typed return channel and is never executed. */
export function reviewToolResult(data: { content?: unknown; stop_reason?: unknown; choices?: unknown }, httpStatus: number, protocol: ReviewProtocol = "anthropic"): string {
  if (protocol === "openai") {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = choices[0];
    const calls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
    const call = calls[0];
    let decision: unknown;
    if (choices.length === 1 && choice?.finish_reason === "tool_calls" && calls.length === 1 && call?.type === "function" &&
        call.function?.name === REVIEW_TOOL_NAME && typeof call.function.arguments === "string") {
      // Exactly five fields also rules out ambiguous duplicate JSON keys.
      try { if ((call.function.arguments.match(/:/g) || []).length === REVIEW_FIELDS.length) decision = JSON.parse(call.function.arguments); } catch { /* fixed failure below */ }
    }
    if (!isReviewDecision(decision)) throw new AiRequestError({ kind: "invalid_response", httpStatus });
    return JSON.stringify(Object.fromEntries(REVIEW_FIELDS.map((field) => [field, decision[field]])));
  }
  const calls = Array.isArray(data.content) ? data.content.filter((block) => block && typeof block === "object" && block.type === "tool_use") : [];
  const call = calls[0];
  if (data.stop_reason !== "tool_use" || calls.length !== 1 || call.name !== REVIEW_TOOL_NAME || !isReviewDecision(call.input)) {
    throw new AiRequestError({ kind: "invalid_response", httpStatus });
  }
  return JSON.stringify(Object.fromEntries(REVIEW_FIELDS.map((field) => [field, call.input[field]])));
}
