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
  /** Visitor answer generation. */
  chat: { limit: 90, windowMs: 60_000, global: 600 },
  /** Talking-avatar / TTS synthesis. */
  avatar: { limit: 90, windowMs: 60_000, global: 600 },
  /** Student submission writes (create / update / photo). */
  submitWrite: { limit: 40, windowMs: 10 * 60_000, global: 400 },
  /** Student-triggered AI (auto-sectioning) and file parsing. */
  submitAi: { limit: 40, windowMs: 10 * 60_000, global: 300 },
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

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || req.ip || "unknown";
}

/** Apply a scope's per-IP and global limits. Returns a 429 response to send,
 *  or null when the request may proceed. */
export function limitRequest(req: NextRequest, scope: RateScope): NextResponse | null {
  const cfg = RATE[scope];
  const perIp = rateLimit(`${scope}:${clientIp(req)}`, cfg.limit, cfg.windowMs);
  const global = rateLimit(`${scope}:*`, cfg.global, cfg.windowMs);
  const blocked = !perIp.ok ? perIp : !global.ok ? global : null;
  if (!blocked) return null;
  return NextResponse.json(
    { error: "请求太频繁，请稍后再试 / Too many requests, please slow down" },
    { status: 429, headers: { "Retry-After": String(blocked.retryAfterSec) } }
  );
}

/** Test hook. */
export function _resetRateLimits() {
  hits.clear();
}
