"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicPerson, ChatTurn } from "@/lib/types";
import { TopProgress } from "./Loading";

type Stage = "intro" | "thinking" | "speaking" | "ready";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
}

const T = {
  zh: {
    greeting: (n: string) => `你好，我是 ${n}。`,
    pick: "你想先听哪一部分？",
    other: "听其他部分",
    askPlaceholder: "输入你的问题…",
    send: "发送",
    thinking: "正在思考…",
    speaking: "正在讲解…",
    replay: "重播",
    stop: "停止",
    followHint: "可以继续追问，或选择听其他部分。",
    suggestions: ["能举个例子吗？", "可以说得更具体一点吗？", "这和现实生活有什么联系？"],
    poweredThinking: "准备中…",
    rendering: "数字人生成中…",
  },
  en: {
    greeting: (n: string) => `Hi, I'm ${n}.`,
    pick: "Which part would you like to hear first?",
    other: "Hear another part",
    askPlaceholder: "Type your question…",
    send: "Send",
    thinking: "Thinking…",
    speaking: "Speaking…",
    replay: "Replay",
    stop: "Stop",
    followHint: "Ask a follow-up, or pick another part to hear.",
    suggestions: ["Can you give an example?", "Could you be more specific?", "How does this connect to real life?"],
    poweredThinking: "Preparing…",
    rendering: "Generating avatar…",
  },
};

export default function VisitorExperience({ person }: { person: PublicPerson }) {
  // Deterministic initial value (same on server + first client render) to avoid
  // a hydration mismatch. For "auto"/"bilingual" we refine to the device
  // language in an effect AFTER mount (see below).
  const initialLang: "zh" | "en" = person.language === "zh" ? "zh" : "en";

  const [uiLang, setUiLang] = useState<"zh" | "en">(initialLang);
  const [langTouched, setLangTouched] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [stage, setStage] = useState<Stage>("intro");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [input, setInput] = useState("");
  const [lastText, setLastText] = useState<string>("");
  const [lastLang, setLastLang] = useState<"en" | "zh">(initialLang);
  const [error, setError] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const t = T[uiLang];

  useEffect(() => {
    // warm up speech voices
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
    }
    // Refine language to the visitor's device for auto/bilingual people,
    // unless they've already toggled it manually.
    if (
      !langTouched &&
      (person.language === "auto" || person.language === "bilingual") &&
      /^zh/i.test(navigator.language)
    ) {
      setUiLang("zh");
      setLastLang("zh");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, stage]);

  function historyTurns(): ChatTurn[] {
    return messages.map((m) => ({ role: m.role, content: m.text }));
  }

  // ── Speech (mock / TTS mode) ────────────────────────────────────────
  function pickVoice(lang: "en" | "zh"): SpeechSynthesisVoice | undefined {
    if (!("speechSynthesis" in window)) return undefined;
    const voices = window.speechSynthesis.getVoices();
    const want = lang === "zh" ? /zh|cmn|chinese/i : /^en|english/i;
    return (
      voices.find((v) => want.test(v.lang) || want.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      voices[0]
    );
  }

  function speak(text: string, lang: "en" | "zh") {
    if (!("speechSynthesis" in window)) {
      setStage("ready");
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "zh" ? "zh-CN" : "en-US";
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = 1;
    u.onstart = () => setStage("speaking");
    u.onend = () => setStage("ready");
    u.onerror = () => setStage("ready");
    setStage("speaking"); // optimistic; corrected by the fallback below
    synth.speak(u);
    // Safety net: if the engine never actually starts (no matching voice on
    // this device), don't get stuck — fall back to the "ready" controls.
    window.setTimeout(() => {
      if (!synth.speaking && !synth.pending) setStage("ready");
    }, 900);
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setStage("ready");
  }

  function replay() {
    if (videoUrl) {
      setStage("speaking");
      // re-trigger video by remounting via key bump handled below
      setVideoUrl((u) => u); // no-op; <video> has its own controls
    } else if (lastText) {
      speak(lastText, lastLang);
    }
  }

  // ── Core: get answer text, then avatar ──────────────────────────────
  async function run(
    payload:
      | { mode: "section"; sectionId: string; label: string }
      | { mode: "followup"; question: string }
  ) {
    setError("");
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setVideoUrl(null);

    const userBubble =
      payload.mode === "section"
        ? `${uiLang === "zh" ? "想听" : "Tell me about"}：${payload.label}`
        : payload.question;
    setMessages((m) => [...m, { id: rid(), role: "user", text: userBubble }]);
    setStage("thinking");

    try {
      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: person.id,
          mode: payload.mode,
          sectionId: payload.mode === "section" ? payload.sectionId : undefined,
          question: payload.mode === "followup" ? payload.question : undefined,
          history: historyTurns(),
          uiLang,
        }),
      });
      const chat = await chatRes.json();
      if (!chatRes.ok) throw new Error(chat.error || "AI error");

      const text: string = chat.text;
      const lang: "en" | "zh" = chat.lang || "en";
      setMessages((m) => [...m, { id: rid(), role: "assistant", text }]);
      setLastText(text);
      setLastLang(lang);

      // Now the avatar: either browser TTS (mock) or a queued D-ID video.
      const avRes = await fetch("/api/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: person.id, text, lang }),
      });
      const av = await avRes.json();

      if (avRes.ok && av.avatar?.kind === "video-pending") {
        // Show the answer + speak it while the video renders, then swap to video.
        setVideoLoading(true);
        speak(text, lang);
        const url = await pollForVideo(av.avatar.id);
        setVideoLoading(false);
        if (url) {
          if ("speechSynthesis" in window) window.speechSynthesis.cancel();
          setVideoUrl(url);
          setStage("speaking");
        } else if (stage !== "speaking") {
          setStage("ready");
        }
      } else {
        speak(text, lang);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "出错了，请重试");
      setVideoLoading(false);
      setStage("ready");
    }
  }

  // Poll the queued D-ID render until it's ready (~max 60s), else give up → TTS.
  async function pollForVideo(id: string): Promise<string | null> {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await fetch(`/api/avatar/status?id=${encodeURIComponent(id)}`);
        const d = await r.json();
        if (d.status === "done" && d.videoUrl) return d.videoUrl;
        if (d.status === "error") return null;
      } catch {
        /* keep trying */
      }
    }
    return null;
  }

  const busy = stage === "thinking" || stage === "speaking" || videoLoading;

  function submitFollowUp(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    run({ mode: "followup", question });
  }

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-[var(--bg)]">
      {/* ── Avatar stage ───────────────────────────────────────────── */}
      <div className="relative shrink-0 overflow-hidden bg-gradient-to-b from-brand-50 to-[var(--bg)] px-5 pb-4 pt-6">
        {(stage === "thinking" || videoLoading) && <TopProgress />}
        <div className="flex items-center gap-4">
          <div className="relative">
            {stage === "speaking" && !videoUrl && (
              <>
                <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand-300" />
                <span
                  className="absolute inset-0 animate-pulse-ring rounded-full bg-brand-200"
                  style={{ animationDelay: "0.5s" }}
                />
              </>
            )}
            <div
              className={`relative h-24 w-24 overflow-hidden rounded-full bg-white shadow-lift ring-4 ring-white ${
                stage === "speaking" && !videoUrl ? "animate-breathe" : ""
              }`}
            >
              {videoUrl ? (
                <video
                  key={videoUrl}
                  src={videoUrl}
                  autoPlay
                  playsInline
                  controls={false}
                  onEnded={() => setStage("ready")}
                  className="h-full w-full object-cover"
                />
              ) : person.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={person.photoUrl} alt={person.name} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-3xl">🙂</div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">{person.name}</h1>
            {person.subtitle && (
              <p className="truncate text-xs text-ink-mute">{person.subtitle}</p>
            )}
            <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-1 text-xs text-ink-soft ring-1 ring-black/5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  stage === "thinking" || videoLoading
                    ? "animate-pulse bg-amber-400"
                    : stage === "speaking"
                      ? "animate-pulse bg-green-500"
                      : "bg-brand-400"
                }`}
              />
              {videoLoading
                ? t.rendering
                : stage === "thinking"
                  ? t.thinking
                  : stage === "speaking"
                    ? t.speaking
                    : "数字人 · Digital guide"}
            </div>
          </div>

          {/* language toggle */}
          <button
            onClick={() => {
              setLangTouched(true);
              setUiLang((l) => (l === "zh" ? "en" : "zh"));
            }}
            className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-ink-soft shadow-soft ring-1 ring-black/5"
            title="切换语言 / Toggle language"
          >
            {uiLang === "zh" ? "EN" : "中"}
          </button>
        </div>
      </div>

      {/* ── Transcript ─────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {/* greeting */}
        <Bubble role="assistant">
          {t.greeting(person.name)} {messages.length === 0 ? t.pick : ""}
        </Bubble>

        {messages.map((m) => (
          <Bubble key={m.id} role={m.role}>
            {m.text}
          </Bubble>
        ))}

        {stage === "thinking" && (
          <div className="flex items-center gap-1.5 pl-1 text-ink-mute">
            <Dot /> <Dot d="0.15s" /> <Dot d="0.3s" />
          </div>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}

        {/* speaking controls */}
        {(stage === "speaking" || stage === "ready") && messages.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {stage === "speaking" ? (
              <button onClick={stopSpeaking} className="chip bg-white text-ink-soft ring-1 ring-black/5">
                ⏹ {t.stop}
              </button>
            ) : (
              <button onClick={replay} className="chip bg-white text-ink-soft ring-1 ring-black/5">
                ↻ {t.replay}
              </button>
            )}
          </div>
        )}

        {/* follow-up suggestions, shown once an answer has been given */}
        {stage === "ready" && messages.length > 0 && (
          <div className="pt-1">
            <p className="mb-1.5 text-xs text-ink-mute">{t.followHint}</p>
            <div className="flex flex-wrap gap-2">
              {t.suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => submitFollowUp(s)}
                  className="chip bg-brand-50 text-brand-700 hover:bg-brand-100"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Section menu (always reachable) ────────────────────────── */}
      <div className="shrink-0 border-t border-black/5 bg-white/80 backdrop-blur">
        <div className="px-5 pt-3">
          <p className="mb-2 text-xs font-medium text-ink-mute">
            {messages.length === 0 ? t.pick : t.other}
          </p>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-3">
            {person.sections.map((s, i) => (
              <button
                key={s.id}
                disabled={busy}
                onClick={() => run({ mode: "section", sectionId: s.id, label: s.title })}
                className="shrink-0 rounded-2xl bg-white px-4 py-2.5 text-left shadow-soft ring-1 ring-black/5 transition active:scale-95 disabled:opacity-50"
              >
                <span className="block text-[11px] text-brand-500">第 {i + 1} 部分</span>
                <span className="block max-w-[44vw] truncate text-sm font-medium">{s.title}</span>
              </button>
            ))}
            {person.sections.length === 0 && (
              <span className="py-2 text-sm text-ink-mute">（暂无分段）</span>
            )}
          </div>
        </div>

        {/* ── Follow-up input ──────────────────────────────────────── */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitFollowUp(input);
          }}
          className="flex items-center gap-2 border-t border-black/5 px-4 py-3"
        >
          <input
            className="input flex-1 py-2.5"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.askPlaceholder}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="btn-primary px-4 py-2.5"
          >
            {t.send}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Small UI bits ─────────────────────────────────────────────────────
function Bubble({ role, children }: { role: "user" | "assistant"; children: React.ReactNode }) {
  const isUser = role === "user";
  return (
    <div className={`flex animate-fade-up ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] whitespace-pre-wrap rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed ${
          isUser
            ? "rounded-br-lg bg-brand-500 text-white"
            : "rounded-bl-lg bg-white text-ink shadow-soft ring-1 ring-black/5"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function Dot({ d = "0s" }: { d?: string }) {
  return (
    <span
      className="h-2 w-2 animate-bounce rounded-full bg-ink-mute"
      style={{ animationDelay: d }}
    />
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
