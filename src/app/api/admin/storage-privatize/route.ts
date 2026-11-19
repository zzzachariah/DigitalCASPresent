import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { privatizeLegacyRecords } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: unknown = await req.json().catch(() => ({}));
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const dryRun = input.dryRun !== false;
  if (!dryRun && input.confirm !== "MOVE_LEGACY_TO_PRIVATE") {
    return NextResponse.json({ error: "Explicit confirmation required" }, { status: 409 });
  }
  try {
    return NextResponse.json({ ok: true, ...await privatizeLegacyRecords({ dryRun }) });
  } catch {
    console.error("[storage-privatize] incomplete; unverified sources retained");
    return NextResponse.json({ error: "转移未完成；未验证的原文件仍保留，请重试。 / Move incomplete; unverified originals retained. Retry." }, { status: 503 });
  }
}
