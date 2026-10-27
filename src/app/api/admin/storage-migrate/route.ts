import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { migrateLegacyRecords, storageWritable } from "@/lib/store";
import { safeId } from "@/lib/store-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Explicit copy-only operation: default is dry-run. Sources and old QR slugs
// remain untouched. A partial failure is reported per id, never called success.
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });
  const body: unknown = await req.json().catch(() => ({}));
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > 100 ||
      !input.ids.every((id) => typeof id === "string" && safeId(id)))) {
    return NextResponse.json({ error: "ids must contain at most 100 valid person ids" }, { status: 400 });
  }
  try {
    const report = await migrateLegacyRecords({ dryRun: input.dryRun !== false, ids: input.ids as string[] | undefined });
    return NextResponse.json({ ok: report.failed === 0, ...report }, { status: report.failed ? 207 : 200 });
  } catch (err) {
    console.error("[storage-migrate] failed:", err);
    return NextResponse.json({ error: "资料复制未完成，原文件未删除。 / Copy failed; original files were retained." }, { status: 500 });
  }
}
