import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { isAdmin } from "@/lib/auth";
import { createPerson, listPeople } from "@/lib/store";
import type { Section } from "@/lib/types";

export async function GET() {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const people = await listPeople();
  return NextResponse.json({ people });
}

export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    subtitle?: string;
    script?: string;
    sections?: Partial<Section>[];
    language?: string;
  };

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "请填写姓名 / Name is required" }, { status: 400 });
  }
  if (!body.script?.trim()) {
    return NextResponse.json({ error: "请提供讲稿 / Script is required" }, { status: 400 });
  }

  const sections: Section[] = (body.sections ?? []).map((s) => ({
    id: s.id || nanoid(8),
    title: s.title?.trim() || "Untitled",
    hint: s.hint?.trim() || undefined,
    content: s.content?.trim() || "",
  }));

  const language = (["auto", "en", "zh", "bilingual"].includes(body.language || "")
    ? body.language
    : "auto") as "auto" | "en" | "zh" | "bilingual";

  const person = await createPerson({
    name: body.name.trim(),
    subtitle: body.subtitle?.trim() || undefined,
    script: body.script.trim(),
    sections,
    language,
  });

  return NextResponse.json({ person });
}
