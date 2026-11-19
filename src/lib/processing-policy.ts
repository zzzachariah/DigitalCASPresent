/** Enable only after the organizer has approved the provider's retention,
 * training and deletion terms for this event. Consent alone is insufficient. */
export function externalProcessingAllowed(): boolean {
  return process.env.EXTERNAL_AI_PROCESSING_APPROVED === "true";
}

export function requireExternalProcessing(): void {
  if (!externalProcessingAllowed()) {
    throw new Error("External processing is disabled pending a privacy review.");
  }
}


/** Text-only AI approval is separate from photo/avatar/narration providers.
 * An explicit value overrides the legacy global setting, including false.
 * Existing deployments that have not set it retain the old approved behavior. */
export function aiProcessingAllowed(): boolean {
  const value = process.env.AI_PROCESSING_APPROVED;
  return value === undefined ? externalProcessingAllowed() : value === "true";
}
