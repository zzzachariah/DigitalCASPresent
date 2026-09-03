import { NextRequest, NextResponse } from "next/server";
import { getPerson, storageWritable, toOwner, updatePerson } from "@/lib/store";
import { ownerTokenValid, previewTokenFor } from "@/lib/access";
import { parsePersonInput } from "@/lib/validate";
import { limitRequest } from "@/lib/ratelimit";
import type { Person, Section } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The student's secret, from the x-edit-token header or ?token=. */
function tokenFrom(req: NextRequest): string | null {
  return req.headers.get("x-edit-token") || req.nextUrl.searchParams.get("token");
}

/** Load the record only if the caller holds its edit token. A wrong token
 *  gets the same 404 as a missing record, so ids can't be probed. */
async function loadOwned(req: NextRequest, id: string): Promise<Person | null> {
  const person = await getPerson(id);
  if (!person || person.source !== "student" || !ownerTokenValid(person, tokenFrom(req))) return null;
  return person;
}

const NOT_FOUND = { error: "链接无效或已失效 / This link is invalid or has expired" };

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const person = await loadOwned(req, params.id);
  if (!person) return NextResponse.json(NOT_FOUND, { status: 404 });
  return NextResponse.json({ person: toOwner(person), previewToken: previewTokenFor(person) });
}

/** Keep an admin's pre-generated answers for sections the student didn't touch. */
function carryCachedAnswers(next: Section[], prev: Section[]): Section[] {
  return next.map((s) => {
    const old = prev.find((p) => p.id === s.id);
    return old && old.title === s.title && old.content === s.content && old.cachedAnswers
      ? { ...s, cachedAnswers: old.cachedAnswers, cachedAudio: old.cachedAudio, cachedSuggestions: old.cachedSuggestions }
      : s;
  });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const limited = limitRequest(req, "submitWrite");
  if (limited) return limited;

  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });

  const person = await loadOwned(req, params.id);
  if (!person) return NextResponse.json(NOT_FOUND, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = parsePersonInput(body, { partial: true, allowCachedAnswers: false });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const patch: Partial<Omit<Person, "id" | "createdAt">> = {
    ...parsed.value,
    // Any student edit goes back through review.
    status: "pending",
    submittedAt: Date.now(),
  };
  if (parsed.value.sections) {
    patch.sections = carryCachedAnswers(parsed.value.sections, person.sections);
  }

  try {
    const updated = await updatePerson(person.id, patch);
    if (!updated) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ person: toOwner(updated) });
  } catch (err) {
    console.error("[submit:update] failed:", err);
    return NextResponse.json(
      { error: "保存失败 / Save failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}
