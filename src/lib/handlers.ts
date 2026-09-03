import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { chat, extractJson } from "./ai";
import { autoSectionPrompt } from "./prompts";
import { extractText } from "./parse";
import { LIMITS } from "./validate";
import type { Section } from "./types";

// Request handlers shared by the admin and the student (self-submission)
// endpoints. The routes only differ in who may call them.

/** Upload a .txt / .pdf / .docx and get back the extracted plain text. */
export async function handleParse(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "未找到文件 / No file" }, { status: 400 });
  }
  if (file.size > 15 * 1024 * 1024) {
    return NextResponse.json({ error: "文件过大（<15MB）/ File too large" }, { status: 400 });
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const text = (await extractText(buffer, file.name, file.type)).slice(0, LIMITS.script);
    if (!text.trim()) {
      return NextResponse.json(
        { error: "未能从文件中提取到文字 / Could not extract text" },
        { status: 422 }
      );
    }
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "解析失败 / Parse failed" },
      { status: 422 }
    );
  }
}

/** Ask the AI to split a script into logical parts the visitor can pick. */
export async function handleAutosection(req: NextRequest): Promise<NextResponse> {
  const { script } = (await req.json().catch(() => ({}))) as { script?: string };
  if (!script?.trim()) {
    return NextResponse.json({ error: "请先提供讲稿 / Provide a script first" }, { status: 400 });
  }
  if (script.length > LIMITS.script) {
    return NextResponse.json({ error: `讲稿过长（≤${LIMITS.script} 字）/ Script too long` }, { status: 400 });
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
      .slice(0, LIMITS.sections)
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
