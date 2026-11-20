/** Exact model allowlist: never inject vendor options into unrelated models.
 * Qwen's documented non-thinking mode also permits named tool_choice.
 * A relay rejecting this option must fail; never silently enable reasoning.
 * https://help.aliyun.com/zh/model-studio/deep-thinking/ */
export function openAiModelFields(model: string): Record<string, unknown> {
  return model === "qwen3.7-plus" || model === "qwen3.8-flash" ? { enable_thinking: false } : {};
}
