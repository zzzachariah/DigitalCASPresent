import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth";
import { privatizeLegacyRecords } from "@/lib/store";
import { eventRetentionStatus } from "@/lib/event-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** On-demand maintenance endpoint; not a scheduled cron. Authentication is
 *  required before inspecting input, storage or event configuration. */
function rejectRequest(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (eventRetentionStatus().state !== "open") {
    return NextResponse.json({ error: "Legacy privatization requires a configured, active event." }, { status: 409 });
  }
  return null;
}

async function run(dryRun: boolean) {
  try {
    return NextResponse.json({ ok: true, ...await privatizeLegacyRecords({ dryRun }) });
  } catch {
    console.error("[privacy-maintenance] incomplete; unverified sources retained");
    return NextResponse.json({ error: "Move incomplete; unverified originals retained. Retry." }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  const rejection = rejectRequest(req);
  if (rejection) return rejection;
  // Query parameters cannot turn a diagnostic GET into a write.
  return run(true);
}

export async function POST(req: NextRequest) {
  const rejection = rejectRequest(req);
  if (rejection) return rejection;
  const body: unknown = await req.json().catch(() => ({}));
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const dryRun = input.dryRun !== false;
  if (!dryRun && input.confirm !== "MOVE_LEGACY_TO_PRIVATE") {
    return NextResponse.json({ error: "Explicit confirmation required" }, { status: 409 });
  }
  return run(dryRun);
}
