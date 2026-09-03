import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { createPerson, listPeople, storageWritable } from "@/lib/store";
import { parsePersonInput } from "@/lib/validate";
import type { PersonInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const people = await listPeople();
  return NextResponse.json({ people });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsed = parsePersonInput(body, { partial: false, allowCachedAnswers: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const writable = storageWritable();
  if (!writable.ok) {
    return NextResponse.json({ error: writable.reason }, { status: 503 });
  }

  try {
    const person = await createPerson({
      ...(parsed.value as PersonInput),
      source: "admin",
      status: "approved",
    });
    return NextResponse.json({ person });
  } catch (err) {
    console.error("[people:create] failed:", err);
    return NextResponse.json(
      { error: "保存失败 / Save failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}
