import { NextResponse } from "next/server";
import { acceptsCurrentPrivacy, PRIVACY_CONSENT_ERROR } from "./privacy";

/** Check before reading an upload/body, invoking a provider or writing a record. */
export function requirePrivacyConsent(req: Pick<Request, "headers">): NextResponse | null {
  return acceptsCurrentPrivacy(req.headers) ? null : NextResponse.json(
    { error: PRIVACY_CONSENT_ERROR }, { status: 428, headers: { "Cache-Control": "no-store" } }
  );
}
