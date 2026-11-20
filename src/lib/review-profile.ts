/** Review-only latency controls. Never add effort to ordinary generation. */
export const REVIEW_PROFILES = ["default", "medium", "low"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

export function isReviewProfile(value: unknown): value is ReviewProfile {
  return (REVIEW_PROFILES as readonly unknown[]).includes(value);
}

export function reviewProfileFromEnv(value: string | undefined): ReviewProfile {
  if (value === undefined) return "default";
  if (value === "medium" || value === "low") return value;
  throw new Error("Invalid AI review effort configuration");
}

export function configuredReviewProfile(): ReviewProfile {
  return reviewProfileFromEnv(process.env.AI_REVIEW_EFFORT);
}

export function supportsReviewProfile(model: string, profile: ReviewProfile): boolean {
  return profile === "default" || model === "claude-sonnet-5";
}

/** Preserve the fixed JSON schema when combining output_config controls.
 * https://platform.claude.com/docs/en/build-with-claude/effort */
export function withReviewProfile(fields: Record<string, unknown>, model: string, profile: ReviewProfile): Record<string, unknown> {
  if (!isReviewProfile(profile) || !supportsReviewProfile(model, profile)) throw new Error("Unsupported review effort profile");
  if (profile === "default") return fields;
  return { ...fields, output_config: { ...(fields.output_config as Record<string, unknown> | undefined), effort: profile } };
}
