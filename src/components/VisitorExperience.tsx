"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicPerson, ChatTurn } from "@/lib/types";
import { TopProgress } from "./Loading";
import { useDidStream } from "./useDidStream";
import { readJson } from "@/lib/http";

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
    moreOptions: "选择部分 / 提问",
    collapse: "收起",
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
    moreOptions: "Choose a part / Ask",
    collapse: "Collapse",
  },
};

export default function VisitorExperience({
  person,
  avatarStream = false,
  previewToken,
}: {
  person: PublicPerson;
  avatarStream?: boolean;
  /** Student edit token: lets an unpublished page be previewed (sent with
   *  every AI/avatar request so the server allows them too). */
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
  // Section picker / input starts open; collapses into a small pill after each
  // selection so the avatar + caption get more room, and reopens on tap.
  const [controlsOpen, setControlsOpen] = useState(true);
  // The section the visitor is currently hearing — gives follow-ups context.
  const [currentSectionId, setCurrentSectionId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
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

  // The live stream is usable only once real frames are flowing (handles the
  // case where the stream "connects" but media is blocked, e.g. some networks).
  const streamUsable = avatarStream && streamPlaying;
  // Unified "is the avatar talking right now?" flag (stream / narration audio / browser TTS).
  const talking = streamSpeaking || stage === "speaking" || audioPlaying;

  useEffect(() => {
    if (avatarStream) startStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarStream]);

  // The ambient loop video should only animate while actually narrating —
  // play (restarting from the top so each utterance begins cleanly) when
  // talking starts, and pause immediately the moment it stops.
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
    setControlsOpen(false);
    if (payload.mode === "section") setCurrentSectionId(payload.sectionId);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    // Unlock audio autoplay on strict mobile browsers (e.g. iOS Safari) by
    // calling play() synchronously within this user-gesture-triggered call,
    // before any `await` below breaks the gesture association. Pause + rewind
    // immediately so the PREVIOUS narration doesn't audibly replay while the
    // new answer is still being generated (which also kept the loop video
    // animating during the "thinking" phase).
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

      // Avatar output — never let an avatar failure break the turn; fall back
      // to the browser voice so the visitor always hears the answer.
      try {
        if (streamUsable) {
          // Real-time stream IS actually playing → make it speak (~1-2s).
          setStage("ready");
          const ok = await sayStream(text, lang);
          if (!ok) speak(text, lang);
        } else if (avatarStream) {
          speak(text, lang);
        } else {
          // Queue a render (A2E / D-ID), or just speak via the browser.
          const avRes = await fetch("/api/avatar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personId: person.id, text, lang, previewToken }),
          });
          const av = await readJson(avRes);
          if (avRes.ok && av.avatar?.kind === "audio") {
            // Fast path: narration audio only, played over the ambient loop
            // video — near-instant, no per-answer render.
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
        // Avatar failed (timeout / non-JSON / provider error) → just speak.
        setVideoLoading(false);
        speak(text, lang);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "出错了，请重试");
      setVideoLoading(false);
      setStage("ready");
    }
  }

  // Poll the queued render until it's ready (talking-photo can take a while),
  // else give up → TTS. ~3 min max; exits early as soon as the video is ready.
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
    <div className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden bg-[var(--bg)]">
      {/* Narration audio (A2E TTS fast path) — hidden, played over the loop
          video. Deliberately NO onPlay handler: audioPlaying is set explicitly
          in playNarration(), so the silent autoplay-unlock play() in run() can
          never flip the talking state (and animate the video) while thinking. */}
      <audio
        ref={audioRef}
        playsInline
        hidden
        onEnded={() => setAudioPlaying(false)}
        onPause={() => setAudioPlaying(false)}
        onError={() => setAudioPlaying(false)}
      />
      {/* ── Top info bar — separate from the avatar, never overlays the face ── */}
      <div className="flex shrink-0 items-center justify-between gap-2 bg-white px-4 py-2.5 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-gray-100 ring-1 ring-black/5">
            {displayImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={displayImage} alt={person.name} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-lg">🙂</div>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight text-ink">{person.name}</h1>
            {person.subtitle && (
              <p className="truncate text-[11px] leading-tight text-ink-mute">{person.subtitle}</p>
            )}
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-mute">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  stage === "thinking" || videoLoading
                    ? "animate-pulse bg-amber-400"
                    : talking
                      ? "animate-pulse bg-green-500"
                      : "bg-brand-400"
                }`}
              />
              {statusText}
            </div>
          </div>
        </div>
      </div>

      {person.status === "pending" && (
        <div className="shrink-0 bg-amber-50 px-4 py-1.5 text-center text-[11px] text-amber-800">
          预览模式 · 尚未发布，老师审核通过后访客才能看到 / Preview · not published yet
        </div>
      )}

      {/* ── Digital human — fills remaining space. Neutral backdrop (no blue
           frame) so the letterboxed area around the contained video blends in. ── */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--bg)]">
        {(stage === "thinking" || videoLoading) && <TopProgress />}

        {/* language toggle — a bare floating ring, no filled background, so it
            never reads as its own solid panel sitting over the person. */}
        <button
          onClick={() => {
            setLangTouched(true);
            setUiLang((l) => (l === "zh" ? "en" : "zh"));
          }}
          className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full text-xs font-medium text-ink-soft ring-1 ring-inset ring-black/20 backdrop-blur-[2px]"
          title="切换语言 / Toggle language"
        >
          {uiLang === "zh" ? "EN" : "中"}
        </button>

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
              // Show the photo until real video frames arrive (or forever if the
              // stream's media is blocked) — never leaves a blank white frame.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={displayImage}
                alt={person.name}
                className="absolute inset-0 h-full w-full object-contain"
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
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : person.loopVideoUrl ? (
          <>
            {/* Ambient "talking" loop (generated once): paused by default, and
                driven to play/pause by the `talking` effect above — animates
                only while narration is actually playing, freezes otherwise. */}
            <video
              ref={loopVideoRef}
              key={person.loopVideoUrl}
              src={person.loopVideoUrl}
              muted
              loop
              playsInline
              preload="auto"
              onLoadedData={() => setLoopVideoReady(true)}
              className="absolute inset-0 h-full w-full object-contain"
            />
            {!loopVideoReady && displayImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={displayImage}
                alt={person.name}
                className="absolute inset-0 h-full w-full object-contain"
              />
            )}
          </>
        ) : displayImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={displayImage} alt={person.name} className="absolute inset-0 h-full w-full object-contain" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-7xl">🙂</div>
        )}

        {/* ── Caption — a translucent rounded bubble floating over the video
             (deliberately allowed to overlap the person a little). ── */}
        <div className="absolute inset-x-0 bottom-0 z-10 p-3">
          {lastUser && (stage === "thinking" || talking) && (
            <div className="mb-2 flex justify-end">
              <span className="max-w-[80%] truncate rounded-full bg-white/55 px-3 py-1 text-xs text-ink-soft backdrop-blur-md">
                {lastUser.text}
              </span>
            </div>
          )}
          <div className="max-h-[32dvh] overflow-y-auto rounded-3xl bg-white/55 px-4 py-3 backdrop-blur-md">
            {stage === "thinking" ? (
              <span className="flex items-center gap-1.5 text-ink-mute">
                <Dot /> <Dot d="0.15s" /> <Dot d="0.3s" />
                <span className="ml-1 text-sm">{t.thinking}</span>
              </span>
            ) : (
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{caption}</p>
            )}
          </div>
          {error && (
            <p className="mt-2 rounded-2xl bg-white/55 px-3 py-1.5 text-sm text-red-600 backdrop-blur-md">
              {error}
            </p>
          )}
          {/* replay */}
          {stage === "ready" && !talking && !videoLoading && messages.length > 0 && (
            <button
              onClick={replay}
              className="chip mt-2 bg-white/55 text-ink-soft backdrop-blur-md active:scale-95"
            >
              ↻ {t.replay}
            </button>
          )}
        </div>
      </div>

      {/* ── Compact control bar (collapsible, animated) ────────────
           Both states stay mounted; the grid-rows 0fr↔1fr trick animates the
           height smoothly without measuring content. ── */}
      <div
        className={`grid shrink-0 transition-[grid-template-rows] duration-300 ease-in-out ${
          controlsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
        <div className="bg-white">
          {/* grip handle — tap to collapse (with a text hint) */}
          <button
            onClick={() => setControlsOpen(false)}
            className="flex w-full flex-col items-center gap-0.5 pb-1 pt-1.5"
            aria-label={t.collapse}
          >
            <span className="h-1 w-10 rounded-full bg-black/15" />
            <span className="text-[11px] text-ink-mute">{t.collapse} ⌄</span>
          </button>

          <div className="px-4">
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
      </div>

      {/* collapsed pill — translucent, no solid white strip behind it */}
      <div
        className={`grid shrink-0 transition-[grid-template-rows] duration-300 ease-in-out ${
          controlsOpen ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-4 py-2.5">
            <button
              onClick={() => setControlsOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-white/55 py-2.5 text-sm font-medium text-ink-soft ring-1 ring-black/10 backdrop-blur-md active:scale-[0.98]"
            >
              <span className="text-xs">⌃</span> {t.moreOptions}
            </button>
          </div>
        </div>
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
