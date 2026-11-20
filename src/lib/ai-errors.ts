export const AI_FAILURE_KINDS = ["http", "network", "timeout", "aborted", "invalid_response", "empty_response", "truncated_response", "unknown"] as const;
export const AI_UPSTREAM_CODES = ["protocol_not_supported", "overloaded_error", "rate_limit_error", "authentication_error", "invalid_request_error", "permission_error", "not_found_error", "api_error", "insufficient_quota"] as const;
export interface AiFailureDiagnostic {
  kind: (typeof AI_FAILURE_KINDS)[number];
  httpStatus?: number;
  code?: (typeof AI_UPSTREAM_CODES)[number];
}

function cleanDiagnostic(value: AiFailureDiagnostic): AiFailureDiagnostic {
  const kind = (AI_FAILURE_KINDS as readonly unknown[]).includes(value.kind) ? value.kind : "unknown";
  const httpStatus = Number.isInteger(value.httpStatus) && value.httpStatus! >= 100 && value.httpStatus! <= 599 ? value.httpStatus : undefined;
  const code = (AI_UPSTREAM_CODES as readonly unknown[]).includes(value.code) ? value.code : undefined;
  return { kind, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(code ? { code } : {}) };
}

/** Never stores a raw error, response, URL, header or provider message. */
export class AiRequestError extends Error {
  readonly diagnostic: AiFailureDiagnostic;
  constructor(value: AiFailureDiagnostic) {
    const safe = cleanDiagnostic(value);
    const messages: Record<AiFailureDiagnostic["kind"], string> = {
      http: `AI request failed (${safe.httpStatus ?? 200}${safe.code ? `; ${safe.code}` : ""}).`,
      network: "AI network request failed.", timeout: "AI request timed out.", aborted: "AI request was cancelled.",
      invalid_response: "AI returned an invalid JSON response.", empty_response: "AI returned an empty response.",
      truncated_response: "AI response was truncated.", unknown: "AI request failed.",
    };
    super(messages[safe.kind]);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = safe.kind === "timeout" ? "TimeoutError" : safe.kind === "aborted" ? "AbortError" : "AiRequestError";
    this.diagnostic = Object.freeze(safe);
  }
}

/** Only errors issued by this module carry metadata; lookalike/local errors
 * remain unknown. Rebuild from allowlists even when reading our own instance. */
export function safeAiFailure(error: unknown): AiFailureDiagnostic {
  return error instanceof AiRequestError ? cleanDiagnostic(error.diagnostic) : { kind: "unknown" };
}

export function aiHttpError(httpStatus: number, payload?: unknown): AiRequestError {
  const body = payload && typeof payload === "object" ? payload as { error?: unknown } : undefined;
  const error = body?.error && typeof body.error === "object" ? body.error as { code?: unknown; type?: unknown } : undefined;
  const rawCode = error?.code || error?.type;
  const code = (AI_UPSTREAM_CODES as readonly unknown[]).includes(rawCode) ? rawCode as AiFailureDiagnostic["code"] : undefined;
  return new AiRequestError({ kind: "http", httpStatus, code });
}

/** Call only at the network boundary. An unrelated exception must not be
 * mislabeled as a provider failure merely because its message sounds like one. */
export function aiTransportError(error: unknown, signal?: AbortSignal): AiRequestError {
  if (error instanceof AiRequestError) return error;
  if (signal?.aborted) {
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    return new AiRequestError({ kind: timedOut ? "timeout" : "aborted" });
  }
  return new AiRequestError({ kind: error instanceof TypeError ? "network" : "unknown" });
}
