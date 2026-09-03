import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { deletePerson, getPerson, updatePerson, storageWritable } from "@/lib/store";
import { parsePersonInput } from "@/lib/validate";
import type { Person } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const person = await getPerson(params.id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ person });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parsePersonInput(body, { partial: true, allowCachedAnswers: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const patch: Partial<Omit<Person, "id" | "createdAt">> = { ...parsed.value };

  // Publication state (student submissions start "pending").
  if (body.status === "approved" || body.status === "pending") patch.status = body.status;

  // These are generated separately (by the cartoon/loop-video buttons, which
  // already persisted them). Re-asserting them here — instead of relying on
  // an omitted field implying "keep existing" — closes any gap where a save
  // could otherwise clobber a just-generated asset.
  if (typeof body.cartoonUrl === "string") patch.cartoonUrl = body.cartoonUrl || undefined;
  if (typeof body.loopVideoUrl === "string") patch.loopVideoUrl = body.loopVideoUrl || undefined;

  const writable = storageWritable();
  if (!writable.ok) {
    return NextResponse.json({ error: writable.reason }, { status: 503 });
  }

  try {
    const person = await updatePerson(params.id, patch);
    if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ person });
  } catch (err) {
    console.error("[people:update] failed:", err);
    return NextResponse.json(
      { error: "保存失败 / Save failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });
  const ok = await deletePerson(params.id);
  return NextResponse.json({ ok });
}
