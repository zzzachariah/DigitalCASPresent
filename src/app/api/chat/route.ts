import { NextRequest, NextResponse } from "next/server";
import { getPerson } from "@/lib/store";
import { chat, chatStream } from "@/lib/ai";
import { explainSectionPrompt, followUpPrompt, systemPrompt } from "@/lib/prompts";
import { canView } from "@/lib/access";
import { limitRequest } from "@/lib/ratelimit";
import { a2eConfigured, a2eTts } from "@/lib/a2e";
import { SUGGESTION_MARKER, markerHoldback, splitAnswer, takeSentences } from "@/lib/sentences";
import type { ChatTurn, Person, Section } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const PUBLIC_AI_ERROR = "数字人暂时没能回答，请稍后再试 / The guide couldn't answer just now — please try again";

function looksChinese(s: string): boolean {
  return /[一-鿿]/.test(s);
}

/** Which cachedAnswers slot a section explanation resolves to for this
 *  person + visitor language toggle. */
function resolveAnswerLangKey(person: Person, uiLang?: "en" | "zh"): "en" | "zh" | "bilingual" {
  if (person.language === "bilingual") return "bilingual";
  if (person.language === "en") return "en";
  if (person.language === "zh") return "zh";
  return uiLang === "zh" ? "zh" : "en"; // "auto": follow the visitor's toggle
}

/** How the browser should voice the answer:
 *  - audio: this route streams per-sentence narration (A2E fast mode)
 *  - video: per-answer render via /api/avatar after the text is complete
 *  - tts:   the browser's own voice */
type AvatarMode = "audio" | "video" | "tts";
function avatarMode(): AvatarMode {
  const provider = (process.env.AVATAR_PROVIDER || "mock").toLowerCase();
  if (provider === "a2e" && a2eConfigured()) {
    return (process.env.A2E_MODE || "fast").toLowerCase() === "precise" ? "video" : "audio";
  }
  if (provider === "did" && process.env.DID_API_KEY?.trim()) return "video";
  return "tts";
}

// ── TTS: a small per-instance cache (same sentence, same voice → same clip
//    for a while) and a concurrency cap so a hall of phones can't fan out
//    into hundreds of simultaneous synth calls.
const TTS_CACHE_MAX = 300;
const TTS_CACHE_MS = 30 * 60_000;
const ttsCache = new Map<string, { url: string; at: number }>();
let ttsInFlight = 0;
const ttsWaiters: (() => void)[] = [];
const TTS_MAX_CONCURRENT = 6;

async function withTtsSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ttsInFlight >= TTS_MAX_CONCURRENT) await new Promise<void>((r) => ttsWaiters.push(r));
  ttsInFlight++;
  try {
    return await fn();
  } finally {
    ttsInFlight--;
    ttsWaiters.shift()?.();
  }
}

async function synth(text: string, gender: Person["gender"], signal: AbortSignal): Promise<string> {
  const key = `${gender || ""}|${text}`;
  const hit = ttsCache.get(key);
  if (hit && Date.now() - hit.at < TTS_CACHE_MS) return hit.url;
  const url = await withTtsSlot(() => a2eTts(text, gender, AbortSignal.any([signal, AbortSignal.timeout(15_000)])));
  if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value as string);
  ttsCache.set(key, { url, at: Date.now() });
  return url;
}

interface Body {
  personId?: string;
  mode?: "section" | "followup";
  sectionId?: string;
  question?: string;
  history?: ChatTurn[];
  uiLang?: "en" | "zh";
  previewToken?: string;
  /** NDJSON streaming (the visitor page); omit for one JSON reply. */
  stream?: boolean;
}

// Generate the spoken ANSWER TEXT — streamed as NDJSON events when
// `stream` is set, with narration audio synthesized sentence by sentence
// so the digital human starts talking after the first sentence.
//
// Event order: meta → delta* → suggestions → done → audio* (audio clips may
// trail `done`; `done.chunks` says how many to expect).
export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "chat");
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as Body;
  const person = body.personId ? await getPerson(body.personId) : null;
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canView(person, body.previewToken)) {
    return NextResponse.json({ error: "尚未发布 / Not published yet" }, { status: 403 });
  }

  const langKey = resolveAnswerLangKey(person, body.uiLang);
  // Earlier turns come from the browser: capped, and used only as quoted
  // context inside the prompt (never as real assistant turns).
  const history: ChatTurn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .slice(-6)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 1200) }));

  let userPrompt: string;
  let section: Section | undefined;

  if (body.mode === "section") {
    const idx = person.sections.findIndex((s) => s.id === body.sectionId);
    section = person.sections[idx];
    if (!section) return NextResponse.json({ error: "bad section" }, { status: 400 });
    userPrompt = explainSectionPrompt(section, idx, person.sections.length);
    if (person.language === "auto" && body.uiLang) {
      userPrompt += `\n\nSpeak in ${body.uiLang === "zh" ? "Simplified Chinese (简体中文)" : "English"}.`;
    }
  } else {
    const question = body.question?.trim();
    if (!question) return NextResponse.json({ error: "empty question" }, { status: 400 });
    if (question.length > 1000) return NextResponse.json({ error: "问题太长 / Question too long" }, { status: 400 });
    const current = person.sections.find((s) => s.id === body.sectionId);
    userPrompt = followUpPrompt(question, current, history);
  }

  const cachedText = section?.cachedAnswers?.[langKey];
  const cachedAudio = section?.cachedAudio?.[langKey];
  const cachedSuggestions = section?.cachedSuggestions?.[langKey] ?? [];
  const sectionTitle = section?.title;

  // Live (un-cached) answers spend money: a second, hourly brake.
  if (!cachedText) {
    const brake = limitRequest(req, "chatLive");
    if (brake) return brake;
  }

  const opts = {
    system: systemPrompt(person, body.uiLang),
    messages: [{ role: "user" as const, content: userPrompt }],
    temperature: body.mode === "section" ? 0.6 : 0.55,
    maxTokens: body.mode === "section" ? 600 : 400,
    live: true,
    signal: req.signal,
  };

  // ── One-shot JSON (tests, simple clients) ──
  if (!body.stream) {
    if (cachedText) {
      return NextResponse.json({
        text: cachedText,
        lang: looksChinese(cachedText) ? "zh" : "en",
        sectionTitle,
        cached: true,
        suggestions: cachedSuggestions,
        audioUrl: cachedAudio,
      });
    }
    try {
      const { answer, suggestions } = splitAnswer(await chat(opts));
      return NextResponse.json({ text: answer, lang: looksChinese(answer) ? "zh" : "en", sectionTitle, suggestions });
    } catch (err) {
      console.error("[chat] failed:", err);
      return NextResponse.json({ error: PUBLIC_AI_ERROR }, { status: 502 });
    }
  }

  // ── Streaming NDJSON ──
  const mode = avatarMode();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };
      let seq = 0;
      const ttsJobs: Promise<void>[] = [];
      const narrate = (text: string) => {
        if (mode !== "audio" || req.signal.aborted) return;
        const s = seq++;
        ttsJobs.push(
          synth(text, person.gender, req.signal)
            .then((url) => send({ type: "audio", seq: s, url, text }))
            .catch((err) => {
              if (!req.signal.aborted) console.error("[chat] tts failed:", err);
              send({ type: "audio", seq: s, url: null, text });
            })
        );
      };

      try {
        if (cachedText) {
          const lang = looksChinese(cachedText) ? "zh" : "en";
          send({ type: "meta", lang, sectionTitle, cached: true, avatar: mode });
          send({ type: "delta", text: cachedText });
          if (mode === "audio" && cachedAudio) {
            send({ type: "audio", seq: seq++, url: cachedAudio, text: cachedText });
          } else {
            takeSentences(cachedText, true).chunks.forEach(narrate);
          }
          send({ type: "suggestions", items: cachedSuggestions });
          send({ type: "done", chunks: seq, lang, text: cachedText });
          return;
        }

        send({ type: "meta", lang: langKey === "zh" ? "zh" : "en", sectionTitle, cached: false, avatar: mode });
        let buf = "";
        let emitted = 0;
        let trailer = false;
        let pending = "";
        for await (const delta of chatStream(opts)) {
          if (req.signal.aborted) return;
          buf += delta;
          if (trailer) continue;
          const from = Math.max(0, emitted - SUGGESTION_MARKER.length);
          const idx = buf.indexOf(SUGGESTION_MARKER, from);
          let upto: number;
          if (idx !== -1) {
            upto = idx;
            trailer = true;
          } else {
            upto = buf.length - markerHoldback(buf);
          }
          if (upto > emitted) {
            const piece = buf.slice(emitted, upto);
            emitted = upto;
            send({ type: "delta", text: piece });
            pending += piece;
            const { chunks, rest } = takeSentences(pending);
            pending = rest;
            chunks.forEach(narrate);
          }
        }
        if (!trailer && buf.length > emitted) {
          const piece = buf.slice(emitted);
          send({ type: "delta", text: piece });
          pending += piece;
        }
        takeSentences(pending, true).chunks.forEach(narrate);
        const { answer, suggestions } = splitAnswer(buf);
        // Text is complete: tell the client now; audio clips trail as they finish.
        send({ type: "suggestions", items: suggestions });
        send({ type: "done", chunks: seq, lang: looksChinese(answer) ? "zh" : "en", text: answer });
      } catch (err) {
        if (!req.signal.aborted) {
          console.error("[chat] stream failed:", err);
          send({ type: "error", message: PUBLIC_AI_ERROR });
        }
      } finally {
        await Promise.allSettled(ttsJobs);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
