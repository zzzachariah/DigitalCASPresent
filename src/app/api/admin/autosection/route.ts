import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { isAdmin } from "@/lib/auth";
import { chat, extractJson } from "@/lib/ai";
import { autoSectionPrompt } from "@/lib/prompts";
import type { Section } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// Ask the AI to split a script into logical parts the visitor can pick.
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { script } = (await req.json().catch(() => ({}))) as { script?: string };
  if (!script?.trim()) {
    return NextResponse.json({ error: "请先提供讲稿 / Provide a script first" }, { status: 400 });
  }

  try {
    const raw = await chat({
      system: autoSectionPrompt(script),
      messages: [{ role: "user", content: "Split it now. Return only the JSON." }],
      temperature: 0.2,
      maxTokens: 2000,
    });

    const parsed = extractJson<{ sections: Partial<Section>[] }>(raw);
    const sections: Section[] = (parsed.sections ?? [])
      .filter((s) => s.content?.trim())
      .map((s) => ({
        id: nanoid(8),
        title: s.title?.trim() || "Untitled",
        hint: s.hint?.trim() || undefined,
        content: s.content!.trim(),
      }));

    if (sections.length === 0) {
      // Fallback: one section with the whole script.
      sections.push({ id: nanoid(8), title: "全文 / Full talk", content: script.trim() });
    }

    return NextResponse.json({ sections });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "分段失败 / Sectioning failed" },
      { status: 500 }
    );
  }
}
