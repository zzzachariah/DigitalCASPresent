import { NextRequest, NextResponse } from "next/server";
import { isAdmin, safeEqual } from "@/lib/auth";
import { eventRetentionStatus } from "@/lib/event-retention";
import { isProbeModel, runAiProbe } from "@/lib/ai-probe";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/** A synthetic-only maintenance diagnostic. No GET/automatic scheduled run,
 * arbitrary prompt, URL, secret, group or provider configuration is accepted. */
export async function POST(req: NextRequest) {
  const secret = process.env.AI_PROBE_SECRET?.trim();
  const expiresRaw = process.env.AI_PROBE_EXPIRES_AT?.trim() || "";
  const expires = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(expiresRaw) ? Date.parse(expiresRaw) : NaN;
  // A dedicated bearer is deliberately short-lived; it never shares or
  // changes the real scheduled-cleanup credential.
  const bearer = Boolean(secret && Number.isFinite(expires) && expires > Date.now() && expires - Date.now() <= 60 * 60_000 && safeEqual(req.headers.get("authorization"), `Bearer ${secret}`));
  if (!bearer && !isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: HEADERS });
  if (eventRetentionStatus().state !== "open") return NextResponse.json({ error: "Diagnostics require a configured, active event" }, { status: 409, headers: HEADERS });
  if (Number(req.headers.get("content-length")) > 256) return NextResponse.json({ error: "invalid request" }, { status: 400, headers: HEADERS });
  const raw = await req.text().catch(() => "");
  let body: unknown;
  try { body = raw.length <= 256 ? JSON.parse(raw) : null; } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("model" in body) || !isProbeModel(body.model)) {
    return NextResponse.json({ error: "Provide only one allowed model" }, { status: 400, headers: HEADERS });
  }
  if (!process.env.AI_API_KEY?.trim()) return NextResponse.json({ error: "AI key is not configured" }, { status: 503, headers: HEADERS });
  // Per-instance spend brake, not an account-wide guaranteed quota.
  const limit = rateLimit("ai-probe:*", 6, 10 * 60_000);
  if (!limit.ok) return NextResponse.json({ error: "Diagnostic limit reached", retryAfter: limit.retryAfterSec }, { status: 429, headers: { ...HEADERS, "Retry-After": String(limit.retryAfterSec) } });
  try {
    const signal = bearer ? AbortSignal.any([req.signal, AbortSignal.timeout(Math.max(1, expires - Date.now()))]) : req.signal;
    const result = await runAiProbe(body.model, signal);
    if (bearer && Date.now() >= expires) return NextResponse.json({ error: "Diagnostic authorization expired" }, { status: 401, headers: HEADERS });
    if (eventRetentionStatus().state !== "open") return NextResponse.json({ error: "Event has ended" }, { status: 409, headers: HEADERS });
    return NextResponse.json(result, { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Diagnostic unavailable" }, { status: 502, headers: HEADERS });
  }
}
