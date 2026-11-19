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
