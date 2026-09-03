"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicPerson, ChatTurn } from "@/lib/types";
import { ThinkingDots, TopProgress } from "./Loading";
import { useDidStream } from "./useDidStream";
import { readJson } from "@/lib/http";
import { IconArrowRight, IconReplay, IconStop } from "./icons";

type Stage = "intro" | "thinking" | "speaking" | "ready";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
}

const T = {
  zh: {
    greeting: (n: string) => `你好，我是 ${n}。`,
    pick: "想先听哪一部分？",
    other: "听其他部分",
    askPlaceholder: (n: string) => `向 ${n} 提问…`,
    send: "发送",
    thinking: "正在思考",
    speaking: "正在讲解",
    ready: "准备好了",
    rendering: "数字人生成中",
    replay: "重播",
    stop: "停止",
    suggestions: ["能举个例子吗？", "可以说得更具体一点吗？", "这和现实生活有什么联系？"],
    index: "目录",
    conversation: "对话",
    parts: (n: number) => `${n} 个部分`,
    turns: (n: number) => `${n} 轮`,
    now: "正在听",
    preview: "预览模式 · 尚未发布，老师审核通过后访客才能看到",
    exhibition: "TOK Exhibition",
    empty: "选一个部分开始，讲完可以追问。",
  },
  en: {
    greeting: (n: string) => `Hi, I'm ${n}.`,
    pick: "Which part would you like to hear first?",
    other: "Hear another part",
    askPlaceholder: (n: string) => `Ask ${n} a question…`,
    send: "Send",
    thinking: "Thinking",
    speaking: "Speaking",
    ready: "Ready",
    rendering: "Generating avatar",
    replay: "Replay",
    stop: "Stop",
    suggestions: ["Can you give an example?", "Could you be more specific?", "How does this connect to real life?"],
    index: "Index",
    conversation: "Conversation",
    parts: (n: number) => `${n} parts`,
    turns: (n: number) => `${n} turns`,
    now: "Now hearing",
    preview: "Preview · not published yet — visitors will see this page once a teacher approves it",
    exhibition: "TOK Exhibition",
    empty: "Pick a part to begin; you can ask follow-ups afterwards.",
  },
};

function pad(i: number): string {
  return String(i + 1).padStart(2, "0");
}

export default function VisitorExperience({
  person,
  avatarStream = false,
  previewToken,
}: {
  person: PublicPerson;
  avatarStream?: boolean;
  /** Student token: lets an unpublished page be previewed (sent with every
   *  AI/avatar request so the server allows them too). */
  previewToken?: string;
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
  const [lastAudioUrl, setLastAudioUrl] = useState<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [error, setError] = useState("");
  // The section the visitor is currently hearing — gives follow-ups context
  // and marks the index row.
  const [currentSectionId, setCurrentSectionId] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loopVideoRef = useRef<HTMLVideoElement>(null);
  const [loopVideoReady, setLoopVideoReady] = useState(false);
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
  void streamStatus;

  // The live stream is usable only once real frames are flowing.
  const streamUsable = avatarStream && streamPlaying;
  // Unified "is the avatar talking right now?" flag (stream / narration audio / browser TTS).
  const talking = streamSpeaking || stage === "speaking" || audioPlaying;

  useEffect(() => {
    if (avatarStream) startStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarStream]);

  // The ambient loop video only animates while actually narrating.
  useEffect(() => {
    const el = loopVideoRef.current;
    if (!el) return;
    if (talking) {
      el.currentTime = 0;
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [talking]);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
    }
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
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
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
    setStage("speaking");
    synth.speak(u);
    window.setTimeout(() => {
      if (!synth.speaking && !synth.pending) setStage("ready");
    }, 900);
  }

  // Play narration audio (A2E TTS) over the ambient loop video. Falls back to
  // the browser voice if playback fails (e.g. autoplay blocked).
  function playNarration(url: string, onFail: () => void) {
    const el = audioRef.current;
    if (!el) return onFail();
    el.pause();
    el.src = url;
    el.currentTime = 0;
    setAudioPlaying(true);
    el.play().catch(() => {
      setAudioPlaying(false);
      onFail();
    });
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    audioRef.current?.pause();
    setAudioPlaying(false);
    setStage("ready");
  }

  function replay() {
    if (!lastText) return;
    if (avatarStream) {
      sayStream(lastText, lastLang).then((ok) => {
        if (!ok) speak(lastText, lastLang);
      });
    } else if (lastAudioUrl) {
      playNarration(lastAudioUrl, () => speak(lastText, lastLang));
    } else {
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
    if (payload.mode === "section") setCurrentSectionId(payload.sectionId);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    // Unlock audio autoplay on strict mobile browsers by calling play()
    // synchronously within this user-gesture-triggered call.
    try {
      const el = audioRef.current;
      if (el) {
        const p = el.play();
        el.pause();
        el.currentTime = 0;
        p?.catch(() => {});
      }
    } catch {
      /* ignore */
    }
    setAudioPlaying(false);
    setVideoUrl(null);

    const userBubble =
      payload.mode === "section"
        ? uiLang === "zh"
          ? `想听：${payload.label}`
          : `Tell me about: ${payload.label}`
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
          sectionId: payload.mode === "section" ? payload.sectionId : currentSectionId ?? undefined,
          question: payload.mode === "followup" ? payload.question : undefined,
          history: historyTurns(),
          uiLang,
          previewToken,
        }),
      });
      const chat = await readJson(chatRes);
      if (!chatRes.ok) throw new Error(chat.error || "AI error");

      const text: string = chat.text;
      const lang: "en" | "zh" = chat.lang || "en";
      setMessages((m) => [...m, { id: rid(), role: "assistant", text }]);
      setLastText(text);
      setLastLang(lang);

      try {
        if (streamUsable) {
          setStage("ready");
          const ok = await sayStream(text, lang);
          if (!ok) speak(text, lang);
        } else if (avatarStream) {
          speak(text, lang);
        } else {
          const avRes = await fetch("/api/avatar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personId: person.id, text, lang, previewToken }),
          });
          const av = await readJson(avRes);
          if (avRes.ok && av.avatar?.kind === "audio") {
            setLastAudioUrl(av.avatar.audioUrl);
            setStage("ready");
            playNarration(av.avatar.audioUrl, () => speak(text, lang));
          } else if (avRes.ok && av.avatar?.kind === "video-pending") {
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
      } catch {
        setVideoLoading(false);
        speak(text, lang);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "出错了，请重试");
      setVideoLoading(false);
      setStage("ready");
    }
  }

  async function pollForVideo(id: string): Promise<string | null> {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
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

  const displayImage = person.cartoonUrl || person.photoUrl;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const caption = messages.length === 0 ? `${t.greeting(person.name)} ${t.pick}` : lastAssistant?.text || "";
  const currentSection = person.sections.find((s) => s.id === currentSectionId);
  const currentIndex = person.sections.findIndex((s) => s.id === currentSectionId);
  const canReplay = stage === "ready" && !talking && !videoLoading && !!lastText;
  const showSuggestions = stage === "ready" && !talking && !videoLoading && messages.length > 0;

  const statusLabel = videoLoading
    ? t.rendering
    : stage === "thinking"
      ? t.thinking
      : talking
        ? t.speaking
        : t.ready;
  const statusMeta =
    currentSection && currentIndex >= 0 ? `${pad(currentIndex)} · ${currentSection.title}` : t.exhibition;

  const langToggle = (
    <div className="seg" role="group" aria-label="Language">
      <button
        type="button"
        data-on={uiLang === "zh"}
        onClick={() => {
          setLangTouched(true);
          setUiLang("zh");
        }}
      >
        中
      </button>
      <button
        type="button"
        data-on={uiLang === "en"}
        onClick={() => {
          setLangTouched(true);
          setUiLang("en");
        }}
      >
        EN
      </button>
    </div>
  );

  const suggestionChips = (
    <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] lg:flex-wrap lg:overflow-visible">
      {t.suggestions.map((s, i) => (
        <button
          key={s}
          type="button"
          onClick={() => submitFollowUp(s)}
          className="chip shrink-0 animate-rise"
          style={{ animationDelay: `${i * 45}ms` }}
        >
          {s}
        </button>
      ))}
    </div>
  );

  return (
    <div className="visitor-shell text-ink">
      {/* Narration audio (A2E TTS fast path) — hidden, played over the loop
          video. No onPlay handler: audioPlaying is set explicitly in
          playNarration(), so the silent autoplay-unlock play() in run() can
          never flip the talking state while thinking. */}
      <audio
        ref={audioRef}
        playsInline
        hidden
        onEnded={() => setAudioPlaying(false)}
        onPause={() => setAudioPlaying(false)}
        onError={() => setAudioPlaying(false)}
      />

      {/* ── Header ── */}
      <header className="[grid-area:header] flex items-start justify-between gap-4 px-5 pb-3 pt-4 lg:h-16 lg:items-center lg:border-b lg:border-line lg:px-0 lg:py-0">
        {/* phone: identity block */}
        <div className="min-w-0 lg:hidden">
          <h1 className="truncate font-display text-[22px] font-semibold leading-tight tracking-[-0.01em]">{person.name}</h1>
          {person.subtitle && <p className="truncate text-[13px] leading-snug text-ink-2">{person.subtitle}</p>}
          <p className="eyebrow mt-1">
            {t.exhibition} · {t.parts(person.sections.length)}
          </p>
        </div>
        {/* desktop: breadcrumb + meta */}
        <div className="hidden min-w-0 items-center gap-2.5 text-[13px] text-ink-3 lg:flex">
          <span>{t.exhibition}</span>
          <span className="text-ink-4">/</span>
          <span className="truncate font-medium text-ink">{person.name}</span>
        </div>
        <p className="eyebrow hidden lg:block">
          {t.parts(person.sections.length)}
          {messages.length > 0 && ` · ${t.turns(messages.length)}`}
        </p>
        <div className="shrink-0">{langToggle}</div>
      </header>

      {/* ── Stage: the digital human ── */}
      <section
        className={`visitor-stage [grid-area:stage] relative mx-5 flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-2 transition-shadow duration-500 ease-out lg:mx-0 ${
          talking ? "animate-speaking-ring" : ""
        }`}
      >
        {(stage === "thinking" || videoLoading) && <TopProgress />}
        {person.status === "pending" && (
          <div className="z-10 shrink-0 bg-warning-soft px-3 py-1.5 text-center text-[11px] leading-snug text-warning">
            {t.preview}
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Blurred still behind the contained media: no letterbox bars,
              whatever the aspect ratio of the photo / loop video. */}
          {displayImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displayImage}
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl dark:opacity-40"
            />
          )}

          {avatarStream ? (
            <>
              <video
                ref={streamVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-contain"
              />
              {!streamPlaying && displayImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayImage} alt={person.name} className="absolute inset-0 h-full w-full object-contain" />
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
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : person.loopVideoUrl ? (
            <>
              <video
                ref={loopVideoRef}
                key={person.loopVideoUrl}
                src={person.loopVideoUrl}
                muted
                loop
                playsInline
                preload="auto"
                onLoadedData={() => setLoopVideoReady(true)}
                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-500 ease-out ${
                  loopVideoReady ? "opacity-100" : "opacity-0"
                }`}
              />
              {!loopVideoReady && displayImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayImage} alt={person.name} className="absolute inset-0 h-full w-full object-contain" />
              )}
            </>
          ) : displayImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={displayImage} alt={person.name} className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <div className="grid h-24 w-24 place-items-center rounded-full bg-surface-3 font-display text-3xl font-semibold text-ink-4">
                {person.name.slice(0, 1)}
              </div>
            </div>
          )}
        </div>

        {/* status strip */}
        <div className="z-10 flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`dot ${
                stage === "thinking" || videoLoading
                  ? "bg-warning animate-pulse-dot"
                  : talking
                    ? "bg-accent animate-pulse-dot"
                    : "bg-success"
              }`}
            />
            <span className="eyebrow shrink-0 !text-accent">{statusLabel}</span>
            <span className="truncate text-[12px] text-ink-3">{statusMeta}</span>
          </div>
          {talking && !avatarStream ? (
            <button type="button" onClick={stopSpeaking} className="chip !py-1 text-ink-3">
              <IconStop size={14} /> {t.stop}
            </button>
          ) : canReplay ? (
            <button type="button" onClick={replay} className="chip !py-1 text-ink-3">
              <IconReplay size={14} /> {t.replay}
            </button>
          ) : null}
        </div>
      </section>

      {/* ── Caption (phone only) ── */}
      <div className="[grid-area:caption] px-5 pt-3 lg:hidden">
        <div key={lastAssistant?.id ?? "greeting"} className="max-h-[19dvh] overflow-y-auto animate-rise">
          {lastUser && messages.length > 0 && (
            <p className="mb-1 truncate text-[12px] text-ink-3">
              {uiLang === "zh" ? "你问" : "You asked"}：{lastUser.text}
            </p>
          )}
          {stage === "thinking" ? (
            <p className="flex items-center gap-2 text-[15px] text-ink-3">
              <ThinkingDots /> {t.thinking}…
            </p>
          ) : (
            <p className="text-[15px] leading-[1.6] text-ink [text-wrap:pretty]">{caption}</p>
          )}
          {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
        </div>
      </div>

      {/* ── Index (parts) ── */}
      <nav className="[grid-area:index] flex min-h-0 flex-col px-5 pt-3 lg:px-0 lg:pt-6">
        <div className="mb-4 hidden lg:block">
          <h1 className="font-display text-[30px] font-semibold leading-[1.05] tracking-[-0.015em]">{person.name}</h1>
          {person.subtitle && <p className="mt-2 text-[15px] leading-snug text-ink-2 [text-wrap:pretty]">“{person.subtitle}”</p>}
        </div>
        <div className="card flex min-h-0 flex-1 flex-col overflow-hidden lg:max-h-[calc(100dvh-300px)] lg:flex-none">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="eyebrow">{t.index}</span>
            <span className="eyebrow">{messages.length === 0 ? t.pick : t.other}</span>
          </div>
          <div className="stagger min-h-0 overflow-y-auto">
            {person.sections.map((s, i) => {
              const active = s.id === currentSectionId;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy}
                  onClick={() => run({ mode: "section", sectionId: s.id, label: s.title })}
                  style={{ ["--i" as string]: i }}
                  className={`flex w-full items-center gap-3 border-b border-line/70 px-3.5 py-3 text-left transition-[background-color] duration-200 ease-out last:border-b-0 disabled:opacity-60 ${
                    active ? "bg-accent-soft" : "hover:bg-surface-2"
                  }`}
                >
                  <span className={`w-6 shrink-0 font-mono text-[11px] ${active ? "text-accent" : "text-ink-4"}`}>{pad(i)}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>{s.title}</span>
                    {s.hint && <span className="block truncate text-[12px] text-ink-3">{s.hint}</span>}
                  </span>
                  {active && <span className="dot bg-accent" />}
                </button>
              );
            })}
            {person.sections.length === 0 && (
              <p className="px-3.5 py-6 text-center text-[13px] text-ink-3">（暂无分段）</p>
            )}
          </div>
        </div>
        <p className="mt-3 hidden text-[12px] leading-relaxed text-ink-3 lg:block">{t.empty}</p>
      </nav>

      {/* ── Transcript (desktop only) ── */}
      <section className="[grid-area:transcript] card hidden min-h-0 flex-col overflow-hidden lg:flex lg:mt-6">
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <span className="eyebrow">{t.conversation}</span>
          <span className="eyebrow">{t.turns(messages.length)}</span>
        </div>
        <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <p className="text-[15px] leading-[1.6] text-ink-2 animate-rise">
              {t.greeting(person.name)} {t.pick}
            </p>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="max-w-[85%] self-end rounded-lg bg-accent-soft px-3 py-1.5 text-[13px] text-accent animate-rise">
                {m.text}
              </div>
            ) : (
              <p key={m.id} className="text-[15px] leading-[1.6] text-ink [text-wrap:pretty] animate-rise">
                {m.text}
              </p>
            )
          )}
          {stage === "thinking" && (
            <p className="flex items-center gap-2 text-[14px] text-ink-3 animate-fade">
              <ThinkingDots /> {t.thinking}…
            </p>
          )}
          {error && <p className="text-[13px] text-danger">{error}</p>}
        </div>
        {showSuggestions && <div className="border-t border-line px-4 py-3">{suggestionChips}</div>}
      </section>

      {/* ── Ask ── */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitFollowUp(input);
        }}
        className="[grid-area:ask] flex flex-col gap-2.5 px-5 pb-4 pt-3 lg:px-0 lg:pb-0 lg:pt-4"
      >
        {showSuggestions && <div className="lg:hidden">{suggestionChips}</div>}
        <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface p-1 pl-3.5 transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-accent focus-within:shadow-ring">
          <input
            className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-ink outline-none placeholder:text-ink-4"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.askPlaceholder(person.name)}
            disabled={busy}
            aria-label={t.send}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-accent-on transition-[background-color,opacity,transform] duration-200 ease-out hover:bg-accent-hover active:scale-95 disabled:opacity-40"
            aria-label={t.send}
          >
            <IconArrowRight size={17} />
          </button>
        </div>
      </form>
    </div>
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
