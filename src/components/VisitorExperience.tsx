"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicPerson, ChatTurn } from "@/lib/types";
import { ThinkingDots, TopProgress } from "./Loading";
import { useDidStream } from "./useDidStream";
import { useVisitorViewport } from "./useVisitorViewport";
import { readJson } from "@/lib/http";
import { takeSentences } from "@/lib/sentences";
import { createNarrationPlayer, rememberNarration } from "@/lib/narration-player";
import type { AudioRecovery, NarrationClip } from "@/lib/narration-player";
import { IconArrowRight, IconChevronDown, IconReplay, IconStop } from "./icons";

type Stage = "intro" | "thinking" | "speaking" | "ready";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** For user turns: a menu pick vs a typed question. For assistant turns:
   *  "error" renders as a failure with a retry chip. */
  kind?: "section" | "question" | "error";
}

/** 8 samples of silence. Played inside the tap that starts an answer so iOS
 *  Safari treats the <audio> element as user-activated before the first real
 *  narration clip arrives a few seconds later. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA";

const T = {
  zh: {
    greeting: (n: string) => `你好，我是 ${n}。`,
    pick: "想先听哪一部分？",
    other: "听其他部分",
    askPlaceholder: (n: string) => `向 ${n} 提问…`,
    send: "发送",
    thinking: "正在思考",
    preparing: "正在准备讲解",
    speaking: "正在讲解",
    ready: "准备好了",
    rendering: "数字人生成中",
    replay: "重播",
    stop: "停止",
    playSound: "点击播放声音",
    retrySound: "重试声音",
    resumeSound: "继续播放声音",
    soundBlocked: "声音尚未播放，点击后从当前句继续。",
    soundPaused: "声音已暂停，点击后继续听。",
    soundFailed: "这句声音暂时未能播放，文字仍可阅读。",
    suggestions: ["能举个例子吗？", "可以说得更具体一点吗？", "这和现实生活有什么联系？"],
    index: "目录",
    conversation: "对话",
    parts: (n: number) => `${n} 个部分`,
    turns: (n: number) => `${n} 轮`,
    now: "正在听",
    preview: "预览模式 · 尚未发布，老师审核通过后访客才能看到",
    exhibition: "TOK Exhibition",
    empty: "选一个部分开始，讲完可以追问。",
    noParts: "还没有内容",
    error: "出错了，请重试",
    retry: "重试",
    soundHint: "打开声音，数字人会开口讲解",
    speaksIn: (l: "en" | "zh" | "bilingual") => (l === "en" ? "TA 用英文讲解" : l === "zh" ? "TA 用中文讲解" : "TA 用中英双语讲解"),
  },
  en: {
    greeting: (n: string) => `Hi, I'm ${n}.`,
    pick: "Which part would you like to hear first?",
    other: "Hear another part",
    askPlaceholder: (n: string) => `Ask ${n} a question…`,
    send: "Send",
    thinking: "Thinking",
    preparing: "Preparing narration",
    speaking: "Speaking",
    ready: "Ready",
    rendering: "Generating avatar",
    replay: "Replay",
    stop: "Stop",
    playSound: "Tap to play sound",
    retrySound: "Retry sound",
    resumeSound: "Continue listening",
    soundBlocked: "Sound has not started. Tap to continue from this sentence.",
    soundPaused: "Sound is paused. Tap to continue listening.",
    soundFailed: "This audio clip could not play. You can still read the answer.",
    suggestions: ["Can you give an example?", "Could you be more specific?", "How does this connect to real life?"],
    index: "Index",
    conversation: "Conversation",
    parts: (n: number) => `${n} parts`,
    turns: (n: number) => `${n} turns`,
    now: "Now hearing",
    preview: "Preview · not published yet — visitors will see this page once a teacher approves it",
    exhibition: "TOK Exhibition",
    empty: "Pick a part to begin; you can ask follow-ups afterwards.",
    noParts: "Nothing here yet",
    error: "Something went wrong — please try again",
    retry: "Retry",
    soundHint: "Turn your sound on — the guide speaks",
    speaksIn: (l: "en" | "zh" | "bilingual") => (l === "en" ? "This guide speaks English" : l === "zh" ? "This guide speaks Chinese" : "This guide speaks both languages"),
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
  const [questionFocused, setQuestionFocused] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const { style: viewportStyle, isKeyboardOpen } = useVisitorViewport(questionFocused);
  const [lastText, setLastText] = useState<string>("");
  const [lastLang, setLastLang] = useState<"en" | "zh">(initialLang);
  const [audioPlaying, setAudioPlaying] = useState(false);
  // Hold this answer until actual playback starts, not merely until its
  // audio URL is queued. Errors still reveal readable text and recovery UI.
  const [awaitingVoice, setAwaitingVoice] = useState(false);
  const [awaitingAnswerId, setAwaitingAnswerId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // The section the visitor is currently hearing — gives follow-ups context
  // and marks the index row.
  const [currentSectionId, setCurrentSectionId] = useState<string | null>(null);
  // Streaming answer: true while text is still arriving.
  const [streaming, setStreaming] = useState(false);
  // Per-sentence narration audio (server-synthesized) playing in order.
  const [narrating, setNarrating] = useState(false);
  // Follow-up suggestions from the model for the latest answer.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [lastAudio, setLastAudio] = useState<NarrationClip[]>([]);
  const [audioRecovery, setAudioRecovery] = useState<AudioRecovery>(null);
  const narrationRef = useRef<ReturnType<typeof createNarrationPlayer> | null>(null);
  const lastAudioTotalRef = useRef<number | null>(null);
  const ttsCountRef = useRef(0);
  const voiceEpochRef = useRef(0);
  // One live answer at a time: a newer run aborts the previous stream, and
  // late events from an old run are ignored. "Stop" silences the current run
  // (text keeps arriving, nothing more is voiced).
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const silencedRunRef = useRef(-1);
  const phoneContentRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLInputElement>(null);
  const timersRef = useRef<Set<number>>(new Set());
  const lastPayloadRef = useRef<Parameters<typeof run>[0] | null>(null);
  const [warmMedia, setWarmMedia] = useState(false);

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
  const talking = streamSpeaking || stage === "speaking" || audioPlaying || narrating;

  useEffect(() => {
    if (streamSpeaking) setAwaitingVoice(false);
  }, [streamSpeaking]);

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
    const timers = timersRef.current; // stable Set instance
    const runs = runIdRef; // invalidate the latest generation, not a captured id
    const onVisibility = () => {
      if (document.hidden) narrationRef.current?.suspend();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      runs.current++;
      abortRef.current?.abort();
      narrationRef.current?.reset(false);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      timers.forEach((t) => window.clearTimeout(t));
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  }, [uiLang]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: streaming ? "auto" : "smooth" });
    // The phone has a single reading area. Leave its position under the
    // visitor's control instead of pulling them away from earlier sentences.
  }, [messages, stage, streaming]);

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

  /** Browser voice for one chunk of text. Utterances queue natively, so
   *  streamed sentences can be handed over as they complete. */
  function speak(text: string, lang: "en" | "zh") {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setAwaitingVoice(false);
      setStage("ready");
      return;
    }
    const synth = window.speechSynthesis;
    const forRun = runIdRef.current;
    const forVoice = voiceEpochRef.current;
    const current = () => runIdRef.current === forRun && voiceEpochRef.current === forVoice;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "zh" ? "zh-CN" : "en-US";
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = 1;
    ttsCountRef.current++;
    const finish = () => {
      if (!current()) return;
      ttsCountRef.current = Math.max(0, ttsCountRef.current - 1);
      if (ttsCountRef.current === 0) setStage("ready");
    };
    u.onstart = () => {
      if (current()) { setAwaitingVoice(false); setStage("speaking"); }
    };
    u.onend = finish;
    u.onerror = () => { if (current()) setAwaitingVoice(false); finish(); };
    setStage("speaking");
    synth.speak(u);
    // Safety net: if the engine never starts (no matching voice), don't get
    // stuck — but only for the run that queued this utterance.
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      if (!current()) return;
      if (!synth.speaking && !synth.pending) {
        setAwaitingVoice(false);
        ttsCountRef.current = 0;
        setStage("ready");
      }
    }, 1200);
    timersRef.current.add(timer);
  }

  function speakAll(text: string, lang: "en" | "zh") {
    voiceEpochRef.current++;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    ttsCountRef.current = 0;
    const chunks = takeSentences(text, true).chunks;
    if (!chunks.length) {
      setAwaitingVoice(false);
      setStage("ready");
      return;
    }
    chunks.forEach((c) => speak(c, /[一-鿿]/.test(c) ? "zh" : lang));
  }

  // ── Narration queue (server-synthesized audio, one item per sentence) ──
  function narration() {
    if (!narrationRef.current) {
      narrationRef.current = createNarrationPlayer({
        audio: () => audioRef.current,
        state: ({ playing, narrating, recovery }) => {
          if (playing || recovery) setAwaitingVoice(false);
          setAudioPlaying(playing);
          setNarrating(narrating);
          setAudioRecovery(recovery);
        },
        speak: (text, handlers) => {
          if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = /[一-鿿]/.test(text) ? "zh-CN" : "en-US";
          utterance.onstart = handlers.started;
          utterance.onboundary = (event) => handlers.progress(event.charIndex);
          utterance.onend = handlers.ended;
          utterance.onerror = (event) => handlers.failed(event.error);
          window.speechSynthesis.speak(utterance);
          return () => {
            utterance.onstart = null;
            utterance.onboundary = null;
            utterance.onend = null;
            utterance.onerror = null;
            window.speechSynthesis.cancel();
          };
        },
      });
    }
    return narrationRef.current;
  }
  function queueReset() {
    narration().reset();
  }
  function queueAdd(seq: number, url: string | null, text: string) {
    narration().add({ seq, url, text });
  }
  function queueFinish(total: number) {
    narration().finish(total);
  }

  // Play a whole narration (replay of a stored answer) over the loop video.
  function playNarration(clips: NarrationClip[], text: string, lang: "en" | "zh", total?: number | null) {
    queueReset();
    voiceEpochRef.current++;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    clips.forEach((clip) => narration().add(clip));
    queueFinish(total ?? (clips.length ? Math.max(...clips.map((clip) => clip.seq)) + 1 : 0));
    if (!clips.length && !total) speakAll(text, lang);
  }

  /** Silence everything (voice, narration queue, rendered video). The text of
   *  an answer still streaming keeps arriving; it just won't be voiced. */
  function stopSpeaking() {
    setAwaitingVoice(false);
    silencedRunRef.current = runIdRef.current;
    voiceEpochRef.current++;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current.clear();
    queueReset();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    ttsCountRef.current = 0;
    audioRef.current?.pause();
    setAudioPlaying(false);
    setNarrating(false);
    setVideoUrl(null);
    setStage("ready");
  }

  function replay() {
    if (!lastText) return;
    if (avatarStream) {
      sayStream(lastText, lastLang).then((ok) => {
        if (!ok) speakAll(lastText, lastLang);
      });
    } else if (lastAudio.length || (lastAudioTotalRef.current ?? 0) > 0) {
      // Stop may have silenced this answer while its clips were still arriving.
      // Replay reopens that same ordered queue; it never starts another request.
      silencedRunRef.current = -1;
      playNarration(lastAudio, lastText, lastLang, lastAudioTotalRef.current);
    } else {
      speakAll(lastText, lastLang);
    }
  }

  // ── Core: stream the answer text; narrate sentence by sentence ────────
  async function run(
    payload:
      | { mode: "section"; sectionId: string; label: string }
      | { mode: "followup"; question: string }
  ) {
    setPartsOpen(false);
    questionRef.current?.blur();
    phoneContentRef.current?.scrollTo({ top: 0 });
    // Supersede whatever is in flight: abort its stream, silence its voice.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const myRun = ++runIdRef.current;
    setAwaitingVoice(true);
    const alive = () => runIdRef.current === myRun;
    const silenced = () => silencedRunRef.current === myRun;
    lastPayloadRef.current = payload;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current.clear();
    setWarmMedia(true);
    queueReset();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    ttsCountRef.current = 0;
    audioRef.current?.pause();
    setAudioPlaying(false);
    setNarrating(false);
    setVideoUrl(null);
    setVideoLoading(false);
    setLastAudio([]);
    setLastText("");
    lastAudioTotalRef.current = null;
    setError("");
    setSuggestions([]);
    if (payload.mode === "section") setCurrentSectionId(payload.sectionId);

    // Prime the shared media element inside this gesture. Success is checked
    // before marking it unlocked; late priming cannot pause a real clip.
    narration().prime(SILENT_WAV);

    const userBubble =
      payload.mode === "section"
        ? uiLang === "zh"
          ? `想听：${payload.label}`
          : `Tell me about: ${payload.label}`
        : payload.question;
    setMessages((m) => [...m, { id: rid(), role: "user", text: userBubble, kind: payload.mode === "section" ? "section" : "question" }]);
    setStage("thinking");

    const assistantId = rid();
    setAwaitingAnswerId(assistantId);
    let text = "";
    // Mutable box: these are set from inside the event handler closure, so a
    // plain `let` would be narrowed by TypeScript to its initial value.
    const st = { lang: uiLang as "en" | "zh", avatar: "tts" as "audio" | "video" | "tts" };
    let pendingTts = "";
    const audioClips = new Map<number, NarrationClip>();
    let gotAny = false;

    // Deltas arrive many times a second; paint them once per frame.
    let frame = 0;
    let shown = "";
    const paint = () => {
      frame = 0;
      const snapshot = text;
      if (snapshot === shown) return;
      shown = snapshot;
      setMessages((m) => m.map((x) => (x.id === assistantId ? { ...x, text: snapshot } : x)));
    };
    const appendText = (piece: string) => {
      text += piece;
      if (!gotAny) {
        gotAny = true;
        shown = text;
        setStreaming(true);
        setMessages((m) => [...m, { id: assistantId, role: "assistant", text }]);
      } else if (!frame) {
        frame = requestAnimationFrame(paint);
      }
      if (st.avatar === "tts" && !avatarStream && !silenced()) {
        pendingTts += piece;
        const { chunks, rest } = takeSentences(pendingTts);
        pendingTts = rest;
        chunks.forEach((c) => speak(c, /[一-鿿]/.test(c) ? "zh" : st.lang));
      }
    };

    // Runs as soon as the text is complete (audio clips may still trail).
    let finalized = false;
    const finalize = async (doneText: string, doneLang: "en" | "zh", chunks: number) => {
      if (finalized || !alive()) return;
      finalized = true;
      if (frame) cancelAnimationFrame(frame);
      text = doneText.trim() || text;
      shown = text;
      setMessages((m) => m.map((x) => (x.id === assistantId ? { ...x, text } : x)));
      st.lang = doneLang;
      setStreaming(false);
      setLastText(text);
      setLastLang(st.lang);
      lastAudioTotalRef.current = chunks;
      if (silenced()) {
        setStage("ready");
        return;
      }
      if (streamUsable) {
        setStage("ready");
        const ok = await sayStream(text, st.lang);
        if (!ok && alive() && !silenced()) speakAll(text, st.lang);
      } else if (avatarStream) {
        speakAll(text, st.lang);
      } else if (st.avatar === "audio") {
        setStage("ready");
        queueFinish(chunks);
        if (chunks === 0) speakAll(text, st.lang);
      } else if (st.avatar === "video") {
        await renderVideo(text, st.lang, ac, alive, silenced);
      } else {
        const { chunks: tail } = takeSentences(pendingTts, true);
        pendingTts = "";
        tail.forEach((c) => speak(c, /[一-鿿]/.test(c) ? "zh" : st.lang));
        if (ttsCountRef.current === 0) setStage("ready");
      }
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          personId: person.id,
          mode: payload.mode,
          sectionId: payload.mode === "section" ? payload.sectionId : currentSectionId ?? undefined,
          question: payload.mode === "followup" ? payload.question : undefined,
          history: historyTurns(),
          uiLang,
          previewToken,
          stream: true,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await readJson(res);
        throw new Error(data.error || "AI error");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      const handle = (ev: any) => {
        if (!alive()) return;
        switch (ev.type) {
          case "meta":
            st.lang = ev.lang === "zh" ? "zh" : "en";
            st.avatar = ev.avatar === "audio" || ev.avatar === "video" ? ev.avatar : "tts";
            break;
          case "delta":
            appendText(String(ev.text || ""));
            break;
          case "audio":
            const clip = { seq: Number(ev.seq), url: typeof ev.url === "string" ? ev.url : null, text: String(ev.text || "") };
            setLastAudio(rememberNarration(audioClips, clip));
            if (!silenced()) queueAdd(clip.seq, clip.url, clip.text);
            break;
          case "suggestions":
            if (Array.isArray(ev.items)) setSuggestions(ev.items.filter((x: unknown) => typeof x === "string"));
            break;
          case "done":
            finished = true;
            void finalize(typeof ev.text === "string" ? ev.text : "", ev.lang === "zh" ? "zh" : "en", Number(ev.chunks) || 0);
            break;
          case "error":
            throw new Error(String(ev.message || t.error));
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!alive()) return;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line));
        }
      }
      if (buf.trim()) handle(JSON.parse(buf.trim()));
      if (!alive()) return;
      if (!finished) {
        if (!text.trim()) throw new Error(t.error);
        await finalize(text, st.lang, narration().size);
      }
    } catch (e) {
      if (!alive() || (e instanceof DOMException && e.name === "AbortError")) return;
      setAwaitingVoice(false);
      if (frame) cancelAnimationFrame(frame);
      setStreaming(false);
      const raw = e instanceof Error ? e.message : "";
      const message = raw && raw !== "AI error" ? raw : t.error;
      // The failure becomes the latest turn (so the caption never shows the
      // previous answer as if it were the reply); the question is restored.
      setMessages((m) => [...m.filter((x) => x.id !== assistantId), { id: assistantId, role: "assistant", text: message, kind: "error" }]);
      if (payload.mode === "followup") setInput(payload.question);
      setVideoLoading(false);
      setStage("ready");
    }
  }

  /** Per-answer video render (A2E precise / D-ID): starts after the text. */
  async function renderVideo(
    text: string,
    lang: "en" | "zh",
    ac: AbortController,
    alive: () => boolean,
    silenced: () => boolean
  ) {
    setStage("ready");
    setVideoLoading(true);
    try {
      const avRes = await fetch("/api/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({ personId: person.id, text, lang, previewToken }),
      });
      const av = await readJson(avRes);
      if (!alive()) return;
      if (avRes.ok && av.avatar?.kind === "video-pending") {
        const url = await pollForVideo(av.avatar.id);
        if (!alive()) return;
        setVideoLoading(false);
        if (url && !silenced()) {
          setVideoUrl(url);
          setStage("speaking");
        } else if (!silenced()) {
          speakAll(text, lang);
        }
      } else if (avRes.ok && av.avatar?.kind === "audio") {
        setVideoLoading(false);
        const clips = [{ seq: 0, url: av.avatar.audioUrl as string, text }];
        setLastAudio(clips);
        lastAudioTotalRef.current = 1;
        if (!silenced()) playNarration(clips, text, lang);
      } else {
        setVideoLoading(false);
        if (!silenced()) speakAll(text, lang);
      }
    } catch {
      if (!alive()) return;
      setVideoLoading(false);
      if (!silenced()) speakAll(text, lang);
    }
  }

  function retry() {
    const p = lastPayloadRef.current;
    if (p) run(p);
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

  const busy = stage === "thinking" || streaming || videoLoading;

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
  const canReplay = !awaitingVoice && !audioRecovery && !streaming && stage !== "thinking" && !talking && !videoLoading && !!lastText;
  const showSuggestions = !awaitingVoice && !streaming && stage !== "thinking" && !talking && !videoLoading && messages.length > 0;

  const statusLabel = awaitingVoice
    ? t.preparing
    : videoLoading
    ? t.rendering
    : stage === "thinking"
      ? t.thinking
      : talking || streaming
        ? t.speaking
        : t.ready;
  const statusMeta =
    currentSection && currentIndex >= 0 ? `${pad(currentIndex)} · ${currentSection.title}` : t.exhibition;

  const fixedLanguage = person.language === "en" || person.language === "zh";
  const langToggle = fixedLanguage ? null : (
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
      {(suggestions.length ? suggestions : t.suggestions).map((s, i) => (
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

  const audioNotice = audioRecovery ? (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2" role="status">
      <p className="min-w-0 flex-1 text-[14px] text-ink-2">
        {audioRecovery === "blocked" ? t.soundBlocked : audioRecovery === "paused" ? t.soundPaused : t.soundFailed}
      </p>
      <button type="button" className="btn-primary min-h-[44px] shrink-0" onClick={() => narration().retry()}>
        {audioRecovery === "blocked" ? t.playSound : audioRecovery === "paused" ? t.resumeSound : t.retrySound}
      </button>
    </div>
  ) : null;

  return (
    <div
      className="visitor-shell text-ink"
      style={viewportStyle}
      data-conversation={messages.length > 0 ? "true" : undefined}
      data-editing={isKeyboardOpen ? "true" : undefined}
      data-short-keyboard={isKeyboardOpen && Number.parseFloat(viewportStyle?.["--visitor-height"] ?? "0") < 240 ? "true" : undefined}
    >
      {/* Attempt-scoped listeners belong to narration-player, including errors
          and pause recovery. Silent priming never changes the talking state. */}
      <audio ref={audioRef} playsInline hidden />

      {/* ── Header ── */}
      <header className="visitor-header [grid-area:header] flex items-start justify-between gap-4 px-4 pb-3 pt-3 lg:h-16 lg:items-center lg:border-b lg:border-line lg:px-0 lg:py-0">
        {/* phone: identity block */}
        <div className="min-w-0 lg:hidden">
          <h1 className="truncate font-display text-[22px] font-semibold leading-tight tracking-[-0.01em]">{person.name}</h1>
          {person.subtitle && <p className="visitor-identity-detail line-clamp-2 text-[14px] leading-snug text-ink-2">“{person.subtitle}”</p>}
          <p className="visitor-identity-detail mt-1 text-[13px] leading-snug text-ink-3">
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
        {langToggle && <div className="shrink-0">{langToggle}</div>}
      </header>

      {/* ── Stage: the digital human ── */}
      <section
        className={`visitor-stage [grid-area:stage] relative mx-4 flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-2 transition-shadow duration-200 ease-out lg:mx-0 ${
          talking ? "animate-speaking-ring" : ""
        }`}
      >
        {(stage === "thinking" || videoLoading) && <TopProgress />}
        <div className="visitor-media relative min-h-0 flex-1 overflow-hidden">
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
              onPlaying={() => setAwaitingVoice(false)}
              onError={() => {
                setStage("ready");
                if (lastText) speakAll(lastText, lastLang);
              }}
              ref={(el) => {
                // Autoplay with sound can be refused outside a gesture: fall back to the voice.
                el?.play().catch(() => {
                  setVideoUrl(null);
                  setStage("ready");
                  if (lastText) speakAll(lastText, lastLang);
                });
              }}
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
                preload={warmMedia ? "auto" : "metadata"}
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
        <div className="visitor-status z-10 flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface px-3 py-2">
          <div className="visitor-status-copy flex min-w-0 items-center gap-2.5">
            <span
              className={`dot ${
                stage === "thinking" || videoLoading
                  ? "bg-warning animate-pulse-dot"
                  : talking || streaming
                    ? "bg-accent animate-pulse-dot"
                    : "bg-success"
              }`}
            />
            <span className="visitor-status-label shrink-0 text-[13px] text-accent">{statusLabel}</span>
            <span className="visitor-status-meta truncate text-[13px] text-ink-3">{statusMeta}</span>
          </div>
          {talking && !avatarStream ? (
            <button type="button" onClick={stopSpeaking} className="chip min-h-[44px] text-ink-2">
              <IconStop size={15} /> {t.stop}
            </button>
          ) : canReplay ? (
            <button type="button" onClick={replay} className="chip min-h-[44px] text-ink-3">
              <IconReplay size={15} /> {t.replay}
            </button>
          ) : null}
        </div>
      </section>

      <div className="visitor-content" ref={phoneContentRef}>
      {audioNotice && <div className="mx-4 mt-3 lg:hidden">{audioNotice}</div>}
      {/* ── Caption (phone only) ── */}
      <div className="visitor-caption px-4 pt-3 lg:hidden">
        {person.status === "pending" && (
          <p className="mb-3 rounded-lg bg-warning-soft px-3 py-2 text-[13px] leading-snug text-warning">
            {t.preview}
          </p>
        )}
        <div key={lastAssistant?.id ?? "greeting"}>
          {lastUser?.kind === "question" && (
            <p className="mb-2 break-words text-[14px] leading-relaxed text-ink-3">
              {uiLang === "zh" ? "你问" : "You asked"}：{lastUser.text}
            </p>
          )}
          {awaitingVoice || (stage === "thinking" && !streaming) ? (
            <p className="flex items-center gap-2 text-[16px] text-ink-3" role="status">
              <ThinkingDots /> {awaitingVoice ? t.preparing : t.thinking}…
            </p>
          ) : lastAssistant?.kind === "error" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[14px] text-danger">{lastAssistant.text}</p>
              <button type="button" onClick={retry} className="chip min-h-[44px]">
                <IconReplay size={14} /> {t.retry}
              </button>
            </div>
          ) : (
            <p className="break-words text-[17px] leading-[1.65] text-ink [text-wrap:pretty]">
              {caption}
              {streaming && <span className="caret" aria-hidden />}
            </p>
          )}
          {messages.length === 0 && (
            <p className="visitor-sound-hint mt-1.5 text-[13px] leading-snug text-ink-3">
              {t.soundHint}
              {fixedLanguage || person.language === "bilingual" ? ` · ${t.speaksIn(person.language as "en" | "zh" | "bilingual")}` : ""}
            </p>
          )}
          {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
        </div>
        {showSuggestions && <div className="visitor-phone-suggestions mt-4">{suggestionChips}</div>}
      </div>

      {/* ── Index (parts) ── */}
      <nav aria-label={uiLang === "zh" ? "讲解目录" : "Exhibition parts"} className="visitor-index [grid-area:index] flex min-h-0 flex-col px-4 pb-4 pt-4 lg:px-0 lg:pb-0 lg:pt-6">
        {messages.length > 0 && (
          <button
            type="button"
            className="visitor-parts-toggle flex min-h-[48px] w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3.5 text-left text-[15px] font-medium lg:hidden"
            aria-expanded={partsOpen}
            aria-controls="visitor-parts"
            onClick={() => setPartsOpen((open) => !open)}
          >
            <span>{t.other} · {t.parts(person.sections.length)}</span>
            <IconChevronDown size={18} className={partsOpen ? "rotate-180" : ""} />
          </button>
        )}
        <div className="mb-4 hidden lg:block">
          <h1 className="font-display text-[30px] font-semibold leading-[1.05] tracking-[-0.015em]">{person.name}</h1>
          {person.subtitle && <p className="mt-2 text-[15px] leading-snug text-ink-2 [text-wrap:pretty]">“{person.subtitle}”</p>}
        </div>
        <div id="visitor-parts" className={`visitor-parts card min-h-0 flex-col overflow-hidden lg:max-h-[calc(100dvh-300px)] lg:flex ${messages.length > 0 && !partsOpen ? "hidden" : "flex"} ${messages.length > 0 ? "mt-2 lg:mt-0" : ""}`}>
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="text-[13px] text-ink-3">{t.index}</span>
            <span className="text-[13px] text-ink-3">{messages.length === 0 ? t.pick : t.other}</span>
          </div>
          <div className="stagger min-h-0 lg:overflow-y-auto">
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
                    <span className={`block text-[16px] font-medium leading-snug lg:text-[14px] ${active ? "text-ink" : "text-ink-2"}`}>{s.title}</span>
                    {s.hint && <span className="mt-1 block text-[13px] leading-snug text-ink-3 lg:mt-0 lg:truncate lg:text-[12px]">{s.hint}</span>}
                  </span>
                  {active && <span className="dot bg-accent" />}
                </button>
              );
            })}
            {person.sections.length === 0 && (
              <p className="px-3.5 py-6 text-center text-[13px] text-ink-3">{t.noParts}</p>
            )}
          </div>
        </div>
        <p className="mt-3 hidden text-[12px] leading-relaxed text-ink-3 lg:block">{t.empty}</p>
      </nav>
      </div>

      {/* ── Transcript (desktop only) ── */}
      <section className="[grid-area:transcript] card hidden min-h-0 flex-col overflow-hidden lg:flex lg:mt-6">
        {person.status === "pending" && (
          <p className="shrink-0 bg-warning-soft px-3 py-2 text-[13px] leading-snug text-warning">
            {t.preview}
          </p>
        )}
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <span className="eyebrow">{t.conversation}</span>
          <span className="eyebrow">{t.turns(messages.length)}</span>
        </div>
        {audioNotice && <div className="shrink-0 px-3 pt-3">{audioNotice}</div>}
        <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <p className="text-[15px] leading-[1.6] text-ink-2 animate-rise">
              {t.greeting(person.name)} {t.pick}
            </p>
          )}
          {messages.map((m) =>
            m.kind === "error" ? (
              <div key={m.id} className="flex flex-wrap items-center gap-2 animate-rise">
                <p className="text-[14px] text-danger">{m.text}</p>
                <button type="button" onClick={retry} className="chip"><IconReplay size={14} /> {t.retry}</button>
              </div>
            ) : m.role === "user" ? (
              <div key={m.id} className="max-w-[85%] self-end rounded-lg bg-accent-soft px-3 py-1.5 text-[13px] text-accent animate-rise">
                {m.text}
              </div>
            ) : awaitingVoice && m.id === awaitingAnswerId ? (
              <p key={m.id} className="flex items-center gap-2 text-[15px] text-ink-3" role="status">
                <ThinkingDots /> {t.preparing}…
              </p>
            ) : (
              <p key={m.id} className="text-[15px] leading-[1.6] text-ink [text-wrap:pretty] animate-rise">
                {m.text}
                {streaming && m.id === lastAssistant?.id && <span className="caret" aria-hidden />}
              </p>
            )
          )}
          {stage === "thinking" && !streaming && (
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
        className="visitor-ask [grid-area:ask] flex flex-col gap-2.5 border-t border-line bg-bg px-4 pb-3 pt-2 lg:border-t-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-4"
      >
        <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface p-1 pl-3.5 transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-accent focus-within:shadow-ring">
          <input
            ref={questionRef}
            className="min-w-0 flex-1 bg-transparent py-2 text-[16px] text-ink outline-none placeholder:text-ink-3"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setQuestionFocused(true)}
            onBlur={() => setQuestionFocused(false)}
            placeholder={t.askPlaceholder(person.name)}
            aria-label={t.askPlaceholder(person.name)}
            enterKeyHint="send"
            inputMode="text"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent text-accent-on transition-[background-color,opacity,transform] duration-200 ease-out hover:bg-accent-hover active:scale-95 disabled:opacity-40"
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
