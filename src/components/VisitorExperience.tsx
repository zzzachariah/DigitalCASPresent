"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicPerson, ChatTurn } from "@/lib/types";
import { TopProgress } from "./Loading";
import { useDidStream } from "./useDidStream";

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

export default function VisitorExperience({
  person,
  avatarStream = false,
}: {
  person: PublicPerson;
  avatarStream?: boolean;
}) {
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

  // Real-time talking-avatar stream (D-ID WebRTC). No-op when not enabled.
  const {
    videoRef: streamVideoRef,
    status: streamStatus,
    speaking: streamSpeaking,
    playing: streamPlaying,
    start: startStream,
    say: sayStream,
  } = useDidStream(person.id, avatarStream);

  // The live stream is usable only once real frames are flowing (handles the
  // case where the stream "connects" but media is blocked, e.g. some networks).
  const streamUsable = avatarStream && streamPlaying;
  // Unified "is the avatar talking right now?" flag (stream OR browser TTS).
  const talking = streamSpeaking || stage === "speaking";

  useEffect(() => {
    if (avatarStream) startStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarStream]);

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
    if (!voices.length) return undefined;

    if (lang === "zh") {
      const zh = voices.filter((v) => /zh|cmn|chinese/i.test(v.lang) || /chinese|中文|普通话/i.test(v.name));
      // Prefer known higher-quality Mandarin voices, then zh-CN, then any zh.
      const nicer = /xiaoxiao|yunxi|huihui|yaoyao|tingting|ting-ting|mei-?jia|sinji|google|microsoft/i;
      return (
        zh.find((v) => nicer.test(v.name) && /zh[-_]?cn|zh$/i.test(v.lang)) ||
        zh.find((v) => /zh[-_]?cn/i.test(v.lang)) ||
        zh.find((v) => nicer.test(v.name)) ||
        zh[0] ||
        voices[0]
      );
    }
    const en = voices.filter((v) => /^en/i.test(v.lang) || /english/i.test(v.name));
    const nicerEn = /jenny|aria|guy|google|microsoft|samantha/i;
    return en.find((v) => nicerEn.test(v.name)) || en[0] || voices[0];
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
    if (!lastText) return;
    if (avatarStream) {
      sayStream(lastText, lastLang).then((ok) => {
        if (!ok) speak(lastText, lastLang);
      });
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

      // Avatar output, in order of preference:
      if (streamUsable) {
        // Real-time stream IS actually playing → make it speak (~1-2s).
        setStage("ready"); // "talking" is driven by the stream's speaking flag
        const ok = await sayStream(text, lang);
        if (!ok) speak(text, lang); // stream hiccup → fall back to browser voice
      } else if (avatarStream) {
        // Stream enabled but media isn't flowing (blocked/slow) → speak the
        // answer with the browser voice so the visitor always hears it.
        speak(text, lang);
      } else {
        // No stream: queue a D-ID clip (poll), or just speak via the browser.
        const avRes = await fetch("/api/avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: person.id, text, lang }),
        });
        const av = await avRes.json();
        if (avRes.ok && av.avatar?.kind === "video-pending") {
          setVideoLoading(true);
          const url = await pollForVideo(av.avatar.id);
          setVideoLoading(false);
          if (url) {
            setVideoUrl(url);
            setStage("speaking");
          } else {
            speak(text, lang);
          }
        } else {
          speak(text, lang);
        }
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

  const busy = stage === "thinking" || talking || videoLoading;

  function submitFollowUp(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    run({ mode: "followup", question });
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const caption =
    messages.length === 0
      ? `${t.greeting(person.name)} ${t.pick}`
      : lastAssistant?.text || t.greeting(person.name);
  const statusText = videoLoading
    ? t.rendering
    : stage === "thinking"
      ? t.thinking
      : talking
        ? t.speaking
        : "数字人 · Digital guide";

  return (
    <div className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden bg-black">
      {/* ── Full-screen digital human ──────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden bg-gradient-to-b from-brand-100 to-brand-50">
        {(stage === "thinking" || videoLoading) && <TopProgress />}

        {avatarStream ? (
          <>
            <video
              ref={streamVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-cover"
            />
            {!streamPlaying && person.photoUrl && (
              // Show the photo until real video frames arrive (or forever if the
              // stream's media is blocked) — never leaves a blank white frame.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={person.photoUrl}
                alt={person.name}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
          </>
        ) : videoUrl ? (
          <video
            key={videoUrl}
            src={videoUrl}
            autoPlay
            playsInline
            controls={false}
            onEnded={() => setStage("ready")}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : person.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={person.photoUrl} alt={person.name} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-brand-50 text-7xl">🙂</div>
        )}

        {/* legibility gradients */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/65 to-transparent" />

        {/* top bar: name + status + language */}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-white drop-shadow-sm">{person.name}</h1>
            {person.subtitle && (
              <p className="truncate text-xs text-white/80 drop-shadow-sm">{person.subtitle}</p>
            )}
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-black/30 px-2.5 py-1 text-xs text-white backdrop-blur">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  stage === "thinking" || videoLoading
                    ? "animate-pulse bg-amber-400"
                    : talking
                      ? "animate-pulse bg-green-400"
                      : "bg-white/70"
                }`}
              />
              {statusText}
            </div>
          </div>
          <button
            onClick={() => {
              setLangTouched(true);
              setUiLang((l) => (l === "zh" ? "en" : "zh"));
            }}
            className="shrink-0 rounded-full bg-black/30 px-3 py-1.5 text-xs font-medium text-white backdrop-blur"
            title="切换语言 / Toggle language"
          >
            {uiLang === "zh" ? "EN" : "中"}
          </button>
        </div>

        {/* caption overlay (read along) */}
        <div className="absolute inset-x-0 bottom-0 p-3">
          {lastUser && (stage === "thinking" || talking) && (
            <div className="mb-2 flex justify-end">
              <span className="max-w-[80%] truncate rounded-full bg-white/90 px-3 py-1 text-xs text-ink shadow-soft">
                {lastUser.text}
              </span>
            </div>
          )}
          <div className="max-h-[40vh] overflow-y-auto rounded-2xl bg-black/45 px-4 py-3 backdrop-blur">
            {stage === "thinking" ? (
              <span className="flex items-center gap-1.5 text-white/90">
                <Dot /> <Dot d="0.15s" /> <Dot d="0.3s" />
                <span className="ml-1 text-sm">{t.thinking}</span>
              </span>
            ) : (
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-white">{caption}</p>
            )}
          </div>
          {error && <p className="mt-2 text-sm text-red-200">{error}</p>}
          {/* replay */}
          {stage === "ready" && !talking && !videoLoading && messages.length > 0 && (
            <button
              onClick={replay}
              className="mt-2 rounded-full bg-white/85 px-3 py-1 text-xs text-ink-soft shadow-soft active:scale-95"
            >
              ↻ {t.replay}
            </button>
          )}
        </div>
      </div>

      {/* ── Compact control bar ────────────────────────────────────── */}
      <div className="shrink-0 bg-white">
        <div className="px-4 pt-3">
          <p className="mb-2 text-xs font-medium text-ink-mute">
            {messages.length === 0 ? t.pick : t.other}
          </p>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 pt-1.5">
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

        {/* follow-up suggestions (compact, single row) */}
        {stage === "ready" && !talking && !videoLoading && messages.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-5 pb-1">
            {t.suggestions.map((s) => (
              <button
                key={s}
                onClick={() => submitFollowUp(s)}
                className="chip shrink-0 whitespace-nowrap bg-brand-50 text-brand-700 hover:bg-brand-100"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitFollowUp(input);
          }}
          className="flex items-center gap-2 px-4 pb-3 pt-2"
        >
          <input
            className="input flex-1 py-2.5"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.askPlaceholder}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !input.trim()} className="btn-primary px-4 py-2.5">
            {t.send}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Small UI bits ─────────────────────────────────────────────────────
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
