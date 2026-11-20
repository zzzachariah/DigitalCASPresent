import { aiProcessingAllowed } from "@/lib/processing-policy";
import { PRIVACY_VERSION } from "@/lib/privacy";
import { reviewExhibitionAnswer } from "@/lib/ai-safety";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, readPhoto, saveAudio, updatePerson, storageWritable } from "@/lib/store";
import { chat } from "@/lib/ai";
import { explainSectionPrompt, systemPrompt } from "@/lib/prompts";
import { a2eSpeechReadiness, a2eTts } from "@/lib/a2e";
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
async function readAudio(url: string, signal: AbortSignal): Promise<AudioAsset> {
  signal.throwIfAborted();
  if (url.startsWith("/api/photo/")) {
    const id = url.slice("/api/photo/".length).split("?")[0];
    if (!/^[A-Za-z0-9_-]{1,40}\.audio\.[A-Za-z0-9_-]{1,80}$/.test(id)) throw new AudioReadError("unavailable");
    const assetVersion = new URL(url, "https://local.invalid").searchParams.get("asset") || undefined;
    const asset = await readPhoto(id, assetVersion);
    if (!asset) throw new AudioReadError("missing");
    return asset;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new AudioReadError("unavailable");
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
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

function narrationDependencies(person: Person, section: Section, reviewedAnswer: string, signal: AbortSignal) {
  return {
    getPerson, updatePerson, saveAudio,
    readAudio: (url: string) => readAudio(url, signal),
    tts: async (text: string, gender: Person["gender"]) => {
      signal.throwIfAborted();
      // The preparation service rereads caches. A concurrent edit must not
      // substitute new, unreviewed words after this request's safety review.
      if (text !== reviewedAnswer) throw new Error("Reviewed narration changed");
      const fresh = await getPerson(person.id);
      const current = fresh?.sections.find((s) => s.id === section.id);
      if (!fresh || !current || fresh.privacyConsent?.version !== PRIVACY_VERSION ||
          fresh.script !== person.script || fresh.gender !== person.gender ||
          current.title !== section.title || current.content !== section.content) throw new Error("Reviewed source changed");
      signal.throwIfAborted();
      return a2eTts(text, gender, AbortSignal.any([signal, AbortSignal.timeout(55_000)]), person.id);
    },
  };
}

/** Only an explicit regenerateText=true replaces a populated text cache.
 *  Commit a new text/audio pair together, after the audio is permanent. */
async function generateVariant(person: Person, section: Section, index: number, language: AnswerLang, signal: AbortSignal, includeAudio = true): Promise<PreparationResult> {
  const start = Date.now();
  const result = (status: PreparationResult["status"], reason: string, extra: Partial<PreparationResult> = {}): PreparationResult =>
    ({ sectionId: section.id, language, status, reason, elapsedMs: Date.now() - start, ...extra });
  try {
    let prompt = explainSectionPrompt(section, index, person.sections.length);
    if (language !== "bilingual") prompt += `\n\nSpeak in ${language === "zh" ? "Simplified Chinese (简体中文)" : "English"}.`;
    const { answer, suggestions } = splitAnswer(await chat({
      system: systemPrompt({ ...person, script: section.content, sections: [section] }), messages: [{ role: "user", content: prompt }], temperature: 0.6, maxTokens: 600, signal,
    }));
    if (!answer.trim()) return result("failed", "empty_answer");
    const approved = await reviewExhibitionAnswer({ source: section.content, question: `Explain this selected exhibition section briefly: ${section.title}`, answer, suggestions }, (opts) => chat({ ...opts, signal }));
    signal.throwIfAborted();
    if (!approved) return result("failed", "answer_not_approved");
    const audio = includeAudio && a2eSpeechReadiness(person.id).ready
      ? await createPermanentNarration(person, section.id, language, answer, narrationDependencies(person, section, answer, signal)) : undefined;
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
    return result("failed", signal.aborted ? "request_time_budget" : "generation_failed");
  }
}

// Explicit admin action only. Example safe repair:
// { audioOnly: true, sectionId: "...", language: "zh" }
// Existing text is reused by default. Visitors never invoke this endpoint.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (body.audioOnly !== undefined && typeof body.audioOnly !== "boolean") ||
      (body.textOnly !== undefined && typeof body.textOnly !== "boolean") ||
      (body.regenerateText !== undefined && typeof body.regenerateText !== "boolean") ||
      (body.sectionId !== undefined && (typeof body.sectionId !== "string" || !body.sectionId.trim())) ||
      (body.language !== undefined && (typeof body.language !== "string" || !["en", "zh", "bilingual"].includes(body.language))) ||
      (body.audioOnly === true && (body.regenerateText === true || body.textOnly === true))) {
    return NextResponse.json({ error: "invalid preparation options" }, { status: 400 });
  }
  if (body.audioOnly) {
    const readiness = a2eSpeechReadiness(params.id);
    if (!readiness.ready) return NextResponse.json(
      { error: readiness.message, code: `a2e_${readiness.status}`, a2e: readiness },
      { status: readiness.status === "privacy_disabled" ? 403 : 503 }
    );
  }
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });
  if (!aiProcessingAllowed()) return NextResponse.json({ error: "外部处理未获隐私批准 / External processing is disabled pending privacy review" }, { status: 503 });
  const person = await getPerson(params.id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (person.privacyConsent?.version !== PRIVACY_VERSION) return NextResponse.json({ error: "请先由学生确认新版AI处理隐私协议 / The student must accept the current AI processing terms first" }, { status: 428 });
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
    // Leave time for persistence/readback before the platform's 120 s limit.
    // Generation, review, speech and audio download share this same deadline.
    const deadline = AbortSignal.timeout(100_000);
    const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
    const results: PreparationResult[] = [];
    // Deliberately sequential: parallel read/merge/write of one Person loses
    // other sections' freshly prepared caches. Prefer one variant per call.
    for (const { section, index } of targets) {
      for (const language of languages) {
        if (signal.aborted || Date.now() - started > 25_000) {
          results.push({ sectionId: section.id, language, status: "skipped", reason: "request_time_budget", elapsedMs: 0 });
          continue;
        }
        if (body.audioOnly || (body.regenerateText !== true && section.cachedAnswers?.[language]?.trim())) {
          const approved = await reviewExhibitionAnswer({
            source: section.content,
            question: `Explain this selected exhibition section briefly: ${section.title}`,
            answer: section.cachedAnswers?.[language] || "",
            suggestions: section.cachedSuggestions?.[language] || [],
          }, (opts) => chat({ ...opts, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) }));
          if (!approved) {
            results.push({ sectionId: section.id, language, status: "failed", reason: signal.aborted ? "request_time_budget" : "answer_not_approved", elapsedMs: 0 });
            continue;
          }
          results.push(!body.textOnly && a2eSpeechReadiness(person.id).ready
            ? await prepareExistingNarration(person.id, section.id, language, narrationDependencies(person, section, section.cachedAnswers?.[language] || "", signal))
            : { sectionId: section.id, language, status: "skipped", reason: "text_already_cached", elapsedMs: 0 });
        } else {
          results.push(await generateVariant(person, section, index, language, signal, !body.textOnly));
        }
      }
    }
    const final = await getPerson(person.id);
    const failed = results.filter((r) => r.status === "failed").length;
    return NextResponse.json({
      mode: body.textOnly ? "text-only" : body.audioOnly ? "audio-only" : body.regenerateText ? "regenerate-text" : "reuse-existing-text",
      sections: final?.sections ?? [], results,
      prepared: results.filter((r) => r.status === "prepared").length,
      skipped: results.filter((r) => r.status === "skipped").length, failed,
    }, { status: failed === results.length && failed > 0 ? 502 : 200 });
  } finally { release(); }
}
