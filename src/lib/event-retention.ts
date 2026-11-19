/** Shared by Edge middleware and server storage. Never infer an event date. */
export interface EventRetentionStatus {
  state: "unconfigured" | "invalid" | "open" | "closed";
  endsAt: string | null;
}

export function eventRetentionStatus(now = Date.now()): EventRetentionStatus {
  const raw = process.env.EVENT_ENDS_AT?.trim();
  if (!raw) return { state: "unconfigured", endsAt: null };
  // Require a full timestamp and timezone, so host locale cannot move expiry.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(raw)) {
    return { state: "invalid", endsAt: null };
  }
  const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return { state: "invalid", endsAt: null };
  }
  const end = Date.parse(raw);
  if (!Number.isFinite(end)) return { state: "invalid", endsAt: null };
  return { state: now >= end ? "closed" : "open", endsAt: new Date(end).toISOString() };
}

export function eventDataClosed(): boolean {
  const { state } = eventRetentionStatus();
  return state === "closed" || state === "invalid";
}

export function assertEventOpen(): void {
  if (eventDataClosed()) throw new Error("活动资料已关闭 / Event data is closed");
}

export function assertEventPurgeAllowed(): void {
  if (eventRetentionStatus().state !== "closed") {
    throw new Error("Event deletion requires a valid EVENT_ENDS_AT in the past");
  }
}

/** All data APIs are closed, including student tokens, AI/TTS and admin edits.
 *  Authentication, diagnostics and the purge itself remain available. */
export function isEventDataPath(path: string): boolean {
  if (path === "/submit" || path.startsWith("/submit/") || path.startsWith("/p/")) return true;
  if (!path.startsWith("/api/")) return false;
  return !new Set([
    "/api/admin/login", "/api/admin/logout", "/api/admin/health",
    "/api/admin/retention", "/api/cron/retention", "/api/cron/privacy",
  ]).has(path);
}

export interface PurgeResult {
  dryRun: boolean;
  candidates: number;
  deleted: number;
  remaining: number;
}
