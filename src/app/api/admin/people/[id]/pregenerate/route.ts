import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, updatePerson, storageWritable } from "@/lib/store";
import { chat } from "@/lib/ai";
import { explainSectionPrompt, systemPrompt } from "@/lib/prompts";
import type { Person, Section } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

// Which language variants to pre-generate for a person. Fixed-language people
// only need one; "auto" people can be toggled by the visitor, so cover both.
function targetLangKeys(language: Person["language"]): ("en" | "zh" | "bilingual")[] {
  if (language === "bilingual") return ["bilingual"];
  if (language === "en") return ["en"];
  if (language === "zh") return ["zh"];
  return ["zh", "en"];
}

async function generateForSection(person: Person, section: Section): Promise<Section> {
  const keys = targetLangKeys(person.language);
  const cachedAnswers = { ...(section.cachedAnswers || {}) };
  await Promise.all(
    keys.map(async (key) => {
      let prompt = explainSectionPrompt(section);
      if (key !== "bilingual") {
        prompt += `\n\nSpeak in ${key === "zh" ? "Simplified Chinese (简体中文)" : "English"}.`;
      }
      const text = await chat({
        system: systemPrompt(person),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        maxTokens: 500,
      });
      cachedAnswers[key] = text;
    })
  );
  return { ...section, cachedAnswers };
}

// Pre-generate the spoken explanation for one section (body.sectionId) or all
// sections (omit sectionId), so opening them on the visitor page is instant —
// no AI call in the loop. Follow-up questions are never cached (always live).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });

  const person = await getPerson(params.id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { sectionId?: string };

  try {
    let sections: Section[];
    if (body.sectionId) {
      const idx = person.sections.findIndex((s) => s.id === body.sectionId);
      if (idx === -1) return NextResponse.json({ error: "bad section" }, { status: 400 });
      sections = [...person.sections];
      sections[idx] = await generateForSection(person, sections[idx]);
    } else {
      sections = await Promise.all(person.sections.map((s) => generateForSection(person, s)));
    }
    const updated = await updatePerson(params.id, { sections });
    return NextResponse.json({ sections: updated?.sections ?? sections });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "预生成失败" },
      { status: 500 }
    );
  }
}
