import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, saveAudio, updatePerson, storageWritable } from "@/lib/store";
import { chat } from "@/lib/ai";
import { explainSectionPrompt, systemPrompt } from "@/lib/prompts";
import { a2eConfigured, a2eTts } from "@/lib/a2e";
import { splitAnswer } from "@/lib/sentences";
import type { AnswerLang, Person, Section } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

// Which language variants to pre-generate for a person. Fixed-language people
// only need one; "auto" people can be toggled by the visitor, so cover both.
function targetLangKeys(language: Person["language"]): AnswerLang[] {
  if (language === "bilingual") return ["bilingual"];
  if (language === "en") return ["en"];
  if (language === "zh") return ["zh"];
  return ["zh", "en"];
}

function audioExt(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac")) return "m4a";
  if (contentType.includes("ogg")) return "ogg";
  return "mp3";
}

/** Generate the spoken text, the suggested follow-ups, and (when A2E is
 *  configured) a permanent copy of the narration audio — so opening this
 *  part on the visitor page is instant: no AI call, no TTS round-trip. */
async function generateForSection(person: Person, section: Section, index: number): Promise<Section> {
  const keys = targetLangKeys(person.language);
  const cachedAnswers = { ...(section.cachedAnswers || {}) };
  const cachedAudio = { ...(section.cachedAudio || {}) };
  const cachedSuggestions = { ...(section.cachedSuggestions || {}) };
  await Promise.all(
    keys.map(async (key) => {
      let prompt = explainSectionPrompt(section, index, person.sections.length);
      if (key !== "bilingual") {
        prompt += `\n\nSpeak in ${key === "zh" ? "Simplified Chinese (简体中文)" : "English"}.`;
      }
      const raw = await chat({
        system: systemPrompt(person),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        maxTokens: 600,
      });
      const { answer, suggestions } = splitAnswer(raw);
      cachedAnswers[key] = answer;
      cachedSuggestions[key] = suggestions;
      delete cachedAudio[key];
      if (a2eConfigured()) {
        try {
          const url = await a2eTts(answer, person.gender);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`download audio failed: ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const ext = audioExt(res.headers.get("content-type") || "audio/mpeg");
          cachedAudio[key] = await saveAudio(person.id, `${section.id}-${key}`, buffer, ext);
        } catch (err) {
          // Text is still cached; the visitor page falls back to live TTS.
          console.error("[pregenerate] audio failed:", err);
        }
      }
    })
  );
  return { ...section, cachedAnswers, cachedAudio, cachedSuggestions };
}

// Pre-generate the spoken explanation for one section (body.sectionId) or all
// sections (omit sectionId). Follow-up questions are never cached (always live).
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
      sections[idx] = await generateForSection(person, sections[idx], idx);
    } else {
      sections = await Promise.all(person.sections.map((s, i) => generateForSection(person, s, i)));
    }
    // Re-read before writing: the generation took a while and the record
    // may have been edited meanwhile — only the cached fields are ours.
    const fresh = (await getPerson(params.id)) ?? person;
    const merged = fresh.sections.map((s) => {
      const g = sections.find((x) => x.id === s.id);
      return g && g.title === s.title && g.content === s.content
        ? { ...s, cachedAnswers: g.cachedAnswers, cachedAudio: g.cachedAudio, cachedSuggestions: g.cachedSuggestions }
        : s;
    });
    const updated = await updatePerson(params.id, { sections: merged });
    return NextResponse.json({ sections: updated?.sections ?? merged });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "预生成失败" }, { status: 500 });
  }
}
