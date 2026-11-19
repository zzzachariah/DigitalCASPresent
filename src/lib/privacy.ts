/** Increment whenever participants must accept revised collection/processing terms. */
export const PRIVACY_VERSION = "2026-11-19";
export const PRIVACY_CONSENT_HEADER = "x-privacy-consent";
export const PRIVACY_CONSENT_ERROR = "请先阅读并同意隐私协议 / Please read and accept the privacy agreement first";

export interface PrivacyConsent {
  version: string;
  /** The server records the time; clients cannot choose an earlier date. */
  acceptedAt: number;
}

export function acceptsCurrentPrivacy(headers: Pick<Headers, "get">): boolean {
  return headers.get(PRIVACY_CONSENT_HEADER) === PRIVACY_VERSION;
}

export function consentReceipt(headers: Pick<Headers, "get">, now = Date.now()): PrivacyConsent | null {
  return acceptsCurrentPrivacy(headers) ? { version: PRIVACY_VERSION, acceptedAt: now } : null;
}
