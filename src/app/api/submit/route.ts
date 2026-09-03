import { NextRequest, NextResponse } from "next/server";
import { createPerson, storageWritable, toOwner } from "@/lib/store";
import { newEditToken } from "@/lib/store-shared";
import { previewTokenFor } from "@/lib/access";
import { parsePersonInput } from "@/lib/validate";
import { limitRequest } from "@/lib/ratelimit";
import type { PersonInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────
// Student self-submission (public, rate-limited). Creates a PENDING person
// and hands back a secret edit token; the student keeps the link
// /submit/<id>?token=… to revise later. Nothing goes live until an admin
// approves it in the backend.
// ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "submitWrite");
  if (limited) return limited;

  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const parsed = parsePersonInput(body, { partial: false, allowCachedAnswers: false });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const editToken = newEditToken();
    const person = await createPerson({
      ...(parsed.value as PersonInput),
      source: "student",
      status: "pending",
      editToken,
    });
    return NextResponse.json({ person: toOwner(person), editToken, previewToken: previewTokenFor(person) });
  } catch (err) {
    console.error("[submit:create] failed:", err);
    return NextResponse.json(
      { error: "提交失败 / Submit failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}
