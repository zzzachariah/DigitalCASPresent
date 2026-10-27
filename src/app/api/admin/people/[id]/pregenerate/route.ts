import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, readPhoto, saveAudio, updatePerson, storageWritable } from "@/lib/store";
import { chat } from "@/lib/ai";
import { explainSectionPrompt, systemPrompt } from "@/lib/prompts";
import { a2eConfigured, a2eTts } from "@/lib/a2e";
import { splitAnswer } from "@/lib/sentences";
import { AudioReadError, beginPreparation, createPermanentNarration, prepareExistingNarration } from "@/lib/prepared-narration";
import type { AudioAsset, PreparationResult } from "@/lib/prepared-narration";
import type { AnswerLang, Person, Section } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function targetLangKeys(language: Person["language"]): AnswerLang[] {
  return language === "auto" ? ["zh", "en"] : [language];
}

/** Download without credentials. For local media, read the same bytes served
 *  by /api/photo instead of making an authenticated request to ourselves. */
async function readAudio(url: string): Promise<AudioAsset> {
  if (url.startsWith("/api/photo/")) {
    const id = url.slice("/api/photo/".length).split("?")[0];
    if (!/^[A-Za-z0-9_-]{1,40}\.audio\.[A-Za-z0-9_-]{1,80}$/.test(id)) throw new AudioReadError("unavailable");
    const asset = await readPhoto(id);
    if (!asset) throw new AudioReadError("missing");
    return asset;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new AudioReadError("unavailable");
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 || response.status === 410) throw new AudioReadError("missing");
  if (!response.ok || !response.body) throw new AudioReadError("unavailable");
  const limit = 20 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new AudioReadError("invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new AudioReadError("invalid");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks), contentType: response.headers.get("content-type") || "" };
}

const dependencies = {
  getPerson, updatePerson, saveAudio, readAudio,
  tts: (text: string, gender: Person["gender"]) => a2eTts(text, gender, AbortSignal.timeout(55_000)),
};

/** Only an explicit regenerateText=true replaces a populated text cache.
 *  Commit a new text/audio pair together, after the audio is permanent. */
async function generateVariant(person: Person, section: Section, index: number, language: AnswerLang): Promise<PreparationResult> {
  const start = Date.now();
  const result = (status: PreparationResult["status"], reason: string, extra: Partial<PreparationResult> = {}): PreparationResult =>
    ({ sectionId: section.id, language, status, reason, elapsedMs: Date.now() - start, ...extra });
  try {
    let prompt = explainSectionPrompt(section, index, person.sections.length);
    if (language !== "bilingual") prompt += `\n\nSpeak in ${language === "zh" ? "Simplified Chinese (简体中文)" : "English"}.`;
    const { answer, suggestions } = splitAnswer(await chat({
      system: systemPrompt(person), messages: [{ role: "user", content: prompt }], temperature: 0.6, maxTokens: 600,
    }));
    if (!answer.trim()) return result("failed", "empty_answer");
    const audio = a2eConfigured() ? await createPermanentNarration(person, section.id, language, answer, dependencies) : undefined;
    const fresh = await getPerson(person.id);
    const current = fresh?.sections.find((s) => s.id === section.id);
    if (!fresh || !current) return result("failed", "person_or_section_missing");
    if (fresh.script !== person.script || fresh.gender !== person.gender || current.title !== section.title ||
        current.content !== section.content || current.cachedAnswers?.[language] !== section.cachedAnswers?.[language] ||
        current.cachedAudio?.[language] !== section.cachedAudio?.[language]) return result("failed", "source_changed");
    const cachedAudio = { ...current.cachedAudio };
    if (audio) cachedAudio[language] = audio.url;
    else delete cachedAudio[language]; // Retain the file, but never pair old audio with new words.
    const sections = fresh.sections.map((s) => s.id === section.id ? {
      ...s, cachedAnswers: { ...s.cachedAnswers, [language]: answer },
      cachedSuggestions: { ...s.cachedSuggestions, [language]: suggestions }, cachedAudio,
    } : s);
    if (!(await updatePerson(person.id, { sections }))) return result("failed", "person_missing");
    const verified = (await getPerson(person.id))?.sections.find((s) => s.id === section.id);
    if (verified?.cachedAnswers?.[language] !== answer || verified.cachedAudio?.[language] !== audio?.url) {
      return result("failed", "persist_unverified");
    }
    return result("prepared", audio ? "text_and_audio_saved" : "text_saved", audio ? { audioUrl: audio.url, bytes: audio.bytes } : {});
  } catch {
    return result("failed", "generation_failed");
  }
}

// Explicit admin action only. Example safe repair:
// { audioOnly: true, sectionId: "...", language: "zh" }
// Existing text is reused by default. Visitors never invoke this endpoint.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (body.audioOnly !== undefined && typeof body.audioOnly !== "boolean") ||
      (body.regenerateText !== undefined && typeof body.regenerateText !== "boolean") ||
      (body.sectionId !== undefined && (typeof body.sectionId !== "string" || !body.sectionId.trim())) ||
      (body.language !== undefined && (typeof body.language !== "string" || !["en", "zh", "bilingual"].includes(body.language))) ||
      (body.audioOnly === true && body.regenerateText === true)) {
    return NextResponse.json({ error: "invalid preparation options" }, { status: 400 });
  }
  const person = await getPerson(params.id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (body.audioOnly && !a2eConfigured()) return NextResponse.json({ error: "narration provider is not configured" }, { status: 503 });
  const targets = person.sections.map((section, index) => ({ section, index }))
    .filter(({ section }) => !body.sectionId || section.id === body.sectionId);
  if (body.sectionId && !targets.length) return NextResponse.json({ error: "bad section" }, { status: 400 });
  const languages = body.language ? [body.language as AnswerLang] : targetLangKeys(person.language);
  if (targets.length > 4 || targets.length * languages.length > 8) {
    return NextResponse.json({ error: "Prepare at most four sections/eight variants per request; select sectionId to continue." }, { status: 400 });
  }
  const release = beginPreparation(person.id);
  if (!release) return NextResponse.json({ error: "This person's preparation is already running; wait for it to finish." }, { status: 409 });
  try {
    const started = Date.now();
    const results: PreparationResult[] = [];
    // Deliberately sequential: parallel read/merge/write of one Person loses
    // other sections' freshly prepared caches. Prefer one variant per call.
    for (const { section, index } of targets) {
      for (const language of languages) {
        if (Date.now() - started > 25_000) {
          results.push({ sectionId: section.id, language, status: "skipped", reason: "request_time_budget", elapsedMs: 0 });
          continue;
        }
        if (body.audioOnly || (body.regenerateText !== true && section.cachedAnswers?.[language]?.trim())) {
          results.push(a2eConfigured()
            ? await prepareExistingNarration(person.id, section.id, language, dependencies)
            : { sectionId: section.id, language, status: "skipped", reason: "text_already_cached", elapsedMs: 0 });
        } else {
          results.push(await generateVariant(person, section, index, language));
        }
      }
    }
    const final = await getPerson(person.id);
    const failed = results.filter((r) => r.status === "failed").length;
    return NextResponse.json({
      mode: body.audioOnly ? "audio-only" : body.regenerateText ? "regenerate-text" : "reuse-existing-text",
      sections: final?.sections ?? [], results,
      prepared: results.filter((r) => r.status === "prepared").length,
      skipped: results.filter((r) => r.status === "skipped").length, failed,
    }, { status: failed === results.length && failed > 0 ? 502 : 200 });
  } finally { release(); }
}
