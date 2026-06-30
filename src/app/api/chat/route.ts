import { NextRequest, NextResponse } from "next/server";
import { getPerson } from "@/lib/store";
import { chat } from "@/lib/ai";
import { explainSectionPrompt, followUpPrompt, systemPrompt } from "@/lib/prompts";
import type { ChatTurn } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function looksChinese(s: string): boolean {
  return /[一-鿿]/.test(s);
}

// Generate the spoken ANSWER TEXT (fast). The avatar/video is a separate call.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    personId?: string;
    mode?: "section" | "followup";
    sectionId?: string;
    question?: string;
    history?: ChatTurn[];
    uiLang?: "en" | "zh";
  };

  const person = body.personId ? await getPerson(body.personId) : null;
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });

  let userPrompt: string;
  let currentSectionTitle: string | undefined;

  if (body.mode === "section") {
    const section = person.sections.find((s) => s.id === body.sectionId);
    if (!section) return NextResponse.json({ error: "bad section" }, { status: 400 });
    currentSectionTitle = section.title;
    userPrompt = explainSectionPrompt(section);
    // A section explanation has no visitor message to detect language from,
    // so when the person is set to "auto" we follow the visitor's UI toggle.
    if (person.language === "auto" && body.uiLang) {
      userPrompt += `\n\nSpeak in ${body.uiLang === "zh" ? "Simplified Chinese (简体中文)" : "English"}.`;
    }
  } else {
    if (!body.question?.trim()) {
      return NextResponse.json({ error: "empty question" }, { status: 400 });
    }
    userPrompt = followUpPrompt(body.question, body.history?.at(-1)?.content);
  }

  // Keep a little history for non-repetition, but cap it.
  const history = (body.history ?? []).slice(-6);

  try {
    const text = await chat({
      system: systemPrompt(person),
      messages: [...history, { role: "user", content: userPrompt }],
      temperature: body.mode === "section" ? 0.6 : 0.55,
      maxTokens: body.mode === "section" ? 500 : 350,
    });

    const lang: "en" | "zh" = looksChinese(text) ? "zh" : "en";
    return NextResponse.json({ text, lang, sectionTitle: currentSectionTitle });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI error" },
      { status: 500 }
    );
  }
}
