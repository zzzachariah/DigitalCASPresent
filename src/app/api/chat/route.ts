import { eventDataClosed } from "@/lib/event-retention";
import { NextRequest, NextResponse } from "next/server";
import { getPerson } from "@/lib/store";
import { aiIsMock, chat } from "@/lib/ai";
import { explainSectionPrompt, followUpPrompt, systemPrompt } from "@/lib/prompts";
import { blockedVisitorRequest, reviewExhibitionAnswer, safeFallback } from "@/lib/ai-safety";
import { aiProcessingAllowed } from "@/lib/processing-policy";
import { PRIVACY_VERSION } from "@/lib/privacy";
import { canView } from "@/lib/access";
import { limitRequest } from "@/lib/ratelimit";
import { a2eSpeechReadiness, a2eTts } from "@/lib/a2e";
import { splitAnswer, takeSentences } from "@/lib/sentences";
import type { AnswerLang, Person, Section } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

function looksChinese(s: string): boolean { return /[一-鿿]/.test(s); }
function resolveAnswerLangKey(person: Person, uiLang?: "en" | "zh"): AnswerLang {
  return person.language === "auto" ? uiLang === "zh" ? "zh" : "en" : person.language;
}

type AvatarMode = "audio" | "video" | "tts";
function avatarMode(personId: string): AvatarMode {
  if (!a2eSpeechReadiness(personId).ready) return "tts";
  const provider = (process.env.AVATAR_PROVIDER || "mock").toLowerCase();
  if (provider === "a2e") {
    // Public arbitrary-text video endpoints are disabled. Only reviewed text
    // from this route may reach an external narration service.
    return (process.env.A2E_MODE || "fast").toLowerCase() === "precise" ? "tts" : "audio";
  }
  return "tts";
}

let ttsInFlight = 0;
const ttsWaiters: (() => void)[] = [];
async function synth(text: string, person: Person, signal: AbortSignal): Promise<string> {
  if (ttsInFlight >= 6) await new Promise<void>((resolve) => ttsWaiters.push(resolve));
  ttsInFlight++;
  try {
    signal.throwIfAborted();
    if (eventDataClosed()) throw new Error("Event closed");
    // No in-process cache of student-derived narration text.
    return await a2eTts(text, person.gender, AbortSignal.any([signal, AbortSignal.timeout(12_000)]), person.id);
  } finally {
    ttsInFlight--;
    ttsWaiters.shift()?.();
  }
}

interface Body {
  personId?: string;
  mode?: "section" | "followup";
  sectionId?: string;
  question?: string;
  uiLang?: "en" | "zh";
  previewToken?: string;
  stream?: boolean;
}

/** JSON and NDJSON share the same fail-closed release path. No candidate
 * token, suggestion or audio leaves the server before the complete review. */
export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "chat");
  if (limited) return limited;
  const parsed: unknown = await req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const body = parsed as Body;
  if (typeof body.personId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.personId) ||
      (body.mode !== "section" && body.mode !== "followup") ||
      (body.sectionId !== undefined && typeof body.sectionId !== "string") ||
      (body.previewToken !== undefined && typeof body.previewToken !== "string") ||
      (body.uiLang !== undefined && body.uiLang !== "en" && body.uiLang !== "zh") ||
      (body.stream !== undefined && typeof body.stream !== "boolean")) {
    return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const person = await getPerson(body.personId);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404, headers: PRIVATE_HEADERS });
  if (!canView(person, body.previewToken)) {
    return NextResponse.json({ error: "尚未发布 / Not published yet" }, { status: 403, headers: PRIVATE_HEADERS });
  }

  let language = resolveAnswerLangKey(person, body.uiLang);
  let userPrompt: string;
  let selected: Section | undefined;
  let question: string;
  if (body.mode === "section") {
    const index = person.sections.findIndex((section) => section.id === body.sectionId);
    selected = person.sections[index];
    if (!selected) return NextResponse.json({ error: "bad section" }, { status: 400, headers: PRIVATE_HEADERS });
    userPrompt = explainSectionPrompt(selected, index, person.sections.length);
    question = `Explain this selected exhibition section briefly: ${selected.title}`;
  } else {
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 1000) {
      return NextResponse.json({ error: "请输入简短的问题 / Enter a short question" }, { status: 400, headers: PRIVATE_HEADERS });
    }
    question = body.question.trim();
    if (person.language === "auto") language = looksChinese(question) ? "zh" : body.uiLang ?? "en";
    selected = person.sections.find((section) => section.id === body.sectionId);
    // Client-supplied assistant/history turns are intentionally not used.
    // They cannot establish facts or grant permission to disclose a source.
    userPrompt = followUpPrompt(question, selected);
  }

  const fallback = safeFallback(language);
  let answer = fallback;
  let suggestions: string[] = [];
  let released = false;
  let cached = false;
  const cachedText = body.mode === "section" ? selected?.cachedAnswers?.[language] : undefined;
  const candidateSuggestions = body.mode === "section" ? selected?.cachedSuggestions?.[language] ?? [] : [];
  const sectionTitle = body.mode === "section" ? selected?.title : undefined;
  // Use only the selected section as context, never the entire manuscript.
  if (selected?.content.trim() && !blockedVisitorRequest(question) && aiProcessingAllowed() && person.privacyConsent?.version === PRIVACY_VERSION && !aiIsMock()) {
    const brake = limitRequest(req, "chatLive");
    if (brake) return brake;
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(43_000)]);
    try {
      const context: Person = { ...person, script: selected.content, sections: [selected] };
      const candidate = cachedText ? { answer: cachedText, suggestions: candidateSuggestions } : splitAnswer(await chat({
        system: systemPrompt(context, language === "zh" ? "zh" : "en"),
        messages: [{ role: "user", content: `${userPrompt}\n\nUse ${language === "zh" ? "Simplified Chinese" : language === "bilingual" ? "English followed by Simplified Chinese" : "English"}.` }],
        temperature: 0,
        maxTokens: 450,
        live: true,
        signal,
      }));
      released = await reviewExhibitionAnswer({
        source: selected.content,
        question,
        answer: candidate.answer,
        suggestions: candidate.suggestions,
      }, (options) => chat({ ...options, live: true, signal }));
      if (released) {
        answer = candidate.answer;
        suggestions = candidate.suggestions;
        cached = Boolean(cachedText);
      }
    } catch {
      // Never log source text, provider response bodies, prompts or answers.
      // Failure and uncertainty are both represented by the fixed fallback.
    }
  }
  if (eventDataClosed()) return NextResponse.json({ error: "活动已结束 / Event closed" }, { status: 410, headers: PRIVATE_HEADERS });
  if (req.signal.aborted) return new Response(null, { status: 499, headers: PRIVATE_HEADERS });
  const lang = language === "zh" || looksChinese(answer) ? "zh" : "en";
  // Legacy audio has no trustworthy binding to the reviewed words. Never
  // release it; only synthesize the reviewed text when processing is enabled.
  if (!body.stream) {
    return NextResponse.json({ text: answer, lang, sectionTitle, cached, suggestions, withheld: !released }, { headers: PRIVATE_HEADERS });
  }

  const mode = released ? avatarMode(person.id) : "tts";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed || req.signal.aborted || eventDataClosed()) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { closed = true; }
      };
      let count = 0;
      const jobs: Promise<void>[] = [];
      try {
        send({ type: "meta", lang, sectionTitle, cached, avatar: mode });
        send({ type: "delta", text: answer });
        if (mode === "audio") {
          for (const text of takeSentences(answer, true).chunks) {
            const seq = count++;
            jobs.push(synth(text, person, req.signal)
              .then((url) => send({ type: "audio", seq, url, text }))
              .catch(() => send({ type: "audio", seq, url: null, text })));
          }
        }
        send({ type: "suggestions", items: suggestions });
        send({ type: "done", chunks: count, lang, text: answer });
      } finally {
        await Promise.allSettled(jobs);
        closed = true;
        try { controller.close(); } catch { /* disconnected */ }
      }
    },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "private, no-store, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
