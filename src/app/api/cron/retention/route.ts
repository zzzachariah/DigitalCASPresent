import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth";
import { purgeEventData } from "@/lib/store";
import { eventRetentionStatus } from "@/lib/event-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const retention = eventRetentionStatus();
  if (retention.state !== "closed") {
    return NextResponse.json({ ok: retention.state === "open", skipped: true, state: retention.state }, { status: retention.state === "invalid" ? 503 : 200 });
  }
  try {
    const report = await purgeEventData({ dryRun: false });
    const ok = report.remaining === 0;
    // Counts only: never log names, manuscript text, tokens or object URLs.
    console.info("[retention]", JSON.stringify({ deleted: report.deleted, remaining: report.remaining }));
    return NextResponse.json({ ok, ...report }, { status: ok ? 200 : 503 });
  } catch {
    console.error("[retention] cleanup incomplete; retry and verify remaining objects");
    return NextResponse.json({ error: "Cleanup incomplete; retry and verify." }, { status: 503 });
  }
}
