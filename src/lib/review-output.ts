import { AiRequestError } from "./ai-errors";

export const REVIEW_FIELDS = ["safe", "grounded", "private", "relevant", "respectful"] as const;
export const REVIEW_OUTPUT_MODES = ["text", "json_schema", "tool"] as const;
export type ReviewOutputMode = (typeof REVIEW_OUTPUT_MODES)[number];
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
export function reviewRequestFields(mode: ReviewOutputMode): Record<string, unknown> {
  if (mode === "text") return {};
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
export function reviewToolResult(data: { content?: unknown; stop_reason?: unknown }, httpStatus: number): string {
  const calls = Array.isArray(data.content) ? data.content.filter((block) => block && typeof block === "object" && block.type === "tool_use") : [];
  const call = calls[0];
  if (data.stop_reason !== "tool_use" || calls.length !== 1 || call.name !== REVIEW_TOOL_NAME || !isReviewDecision(call.input)) {
    throw new AiRequestError({ kind: "invalid_response", httpStatus });
  }
  return JSON.stringify(Object.fromEntries(REVIEW_FIELDS.map((field) => [field, call.input[field]])));
}
