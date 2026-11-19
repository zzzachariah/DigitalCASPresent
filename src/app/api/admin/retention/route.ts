import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { purgeEventData } from "@/lib/store";
import { eventRetentionStatus } from "@/lib/event-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ...eventRetentionStatus(), cronConfigured: !!process.env.CRON_SECRET?.trim() });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: unknown = await req.json().catch(() => ({}));
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const dryRun = input.dryRun !== false;
  const retention = eventRetentionStatus();
  if (!dryRun && (retention.state !== "closed" || input.confirmEndsAt !== retention.endsAt)) {
    return NextResponse.json({ error: "活动结束后，须明确确认已配置的结束时间才能销毁资料。 / Confirm the configured end time after the event has ended." }, { status: 409 });
  }
  try {
    const report = await purgeEventData({ dryRun });
    const ok = dryRun || report.remaining === 0;
    return NextResponse.json({ ok, ...report }, { status: ok ? 200 : 503 });
  } catch {
    console.error("[retention] cleanup incomplete; retry and verify remaining objects");
    return NextResponse.json({ error: "清理未完成，请重试并核验。 / Cleanup incomplete; retry and verify." }, { status: 503 });
  }
}
