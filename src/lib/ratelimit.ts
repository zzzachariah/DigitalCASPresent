import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────
// Small in-memory sliding-window rate limiter for the public endpoints that
// spend money (AI answers, TTS) or accept writes (student submissions).
//
// Scope: per server instance. On Vercel each function instance keeps its own
// counters, so this is a brake on abuse rather than an exact global quota —
// good enough to stop a runaway script or a bored visitor holding the button.
// Limits are deliberately generous per IP because a whole exhibition hall
// (or a whole class) usually sits behind ONE school NAT address.
// ─────────────────────────────────────────────────────────────────────

const RATE = {
  /** Visitor answers (a whole hall of phones may share one IP). */
  chat: { limit: 150, windowMs: 60_000, global: 900 },
  /** Live, un-cached AI answers per hour — a spend brake per instance. Cached
   *  section plays never count. */
  chatLive: { limit: 600, windowMs: 60 * 60_000, global: 1200 },
  /** Talking-avatar / TTS synthesis (per-answer video path, D-ID stream). */
  avatar: { limit: 90, windowMs: 60_000, global: 600 },
  /** Student submission writes (create / update / photo): a class of 30
   *  submits ~3 writes each within minutes. */
  submitWrite: { limit: 400, windowMs: 10 * 60_000, global: 1500 },
  /** Student-triggered AI (auto-sectioning) and file parsing. */
  submitAi: { limit: 200, windowMs: 10 * 60_000, global: 300 },
  /** Admin login attempts. */
  login: { limit: 10, windowMs: 60_000, global: 200 },
} as const;

export type RateScope = keyof typeof RATE;

const hits = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  hits.forEach((arr, k) => {
    const keep = arr.filter((t) => now - t < 15 * 60_000);
    if (keep.length) hits.set(k, keep);
    else hits.delete(k);
  });
}

/** Record a hit for `key`; returns how long to wait when over the limit. */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): { ok: true } | { ok: false; retryAfterSec: number } {
  sweep(now);
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true };
}

/** Only believe proxy headers where a proxy actually sets them (Vercel, or a
 *  self-hosted deployment that opts in with TRUST_PROXY=1); otherwise a client
 *  could mint a fresh "IP" per request. */
function trustProxy(): boolean {
  return !!process.env.VERCEL || process.env.TRUST_PROXY === "1";
}

export function clientIp(req: NextRequest): string {
  if (trustProxy()) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real;
  }
  return req.ip || "shared";
}

/** Apply a scope's per-IP and global limits. Returns a 429 response to send,
 *  or null when the request may proceed. */
export function limitRequest(req: NextRequest, scope: RateScope): NextResponse | null {
  const cfg = RATE[scope];
  const perIp = rateLimit(`${scope}:${clientIp(req)}`, cfg.limit, cfg.windowMs);
  const global = rateLimit(`${scope}:*`, cfg.global, cfg.windowMs);
  const blocked = !perIp.ok ? perIp : !global.ok ? global : null;
  if (!blocked) return null;
  const secs = blocked.retryAfterSec;
  const wait = secs >= 90 ? `${Math.ceil(secs / 60)} 分钟 / ${Math.ceil(secs / 60)} min` : `${secs} 秒 / ${secs}s`;
  return NextResponse.json(
    { error: `请求太频繁，请 ${wait} 后再试 / Too many requests, please try again in ${wait.split(" / ")[1]}`, retryAfter: secs },
    { status: 429, headers: { "Retry-After": String(secs) } }
  );
}

/** Test hook. */
export function _resetRateLimits() {
  hits.clear();
}
