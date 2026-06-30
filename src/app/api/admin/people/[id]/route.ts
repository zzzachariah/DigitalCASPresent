import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { isAdmin } from "@/lib/auth";
import { deletePerson, getPerson, updatePerson } from "@/lib/store";
import type { Section } from "@/lib/types";

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

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    subtitle?: string;
    script?: string;
    sections?: Partial<Section>[];
    language?: string;
  };

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.subtitle === "string") patch.subtitle = body.subtitle.trim() || undefined;
  if (typeof body.script === "string") patch.script = body.script.trim();
  if (Array.isArray(body.sections)) {
    patch.sections = body.sections.map((s) => ({
      id: s.id || nanoid(8),
      title: s.title?.trim() || "Untitled",
      hint: s.hint?.trim() || undefined,
      content: s.content?.trim() || "",
    }));
  }
  if (body.language && ["auto", "en", "zh", "bilingual"].includes(body.language)) {
    patch.language = body.language;
  }

  const person = await updatePerson(params.id, patch);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ person });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ok = await deletePerson(params.id);
  return NextResponse.json({ ok });
}
