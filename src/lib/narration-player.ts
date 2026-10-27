export interface NarrationClip {
  seq: number;
  url: string | null;
  text: string;
}

export type AudioRecovery = "blocked" | "paused" | "error" | null;
export interface NarrationState {
  playing: boolean;
  narrating: boolean;
  recovery: AudioRecovery;
}

interface NarrationOptions {
  audio: () => HTMLAudioElement | null;
  state: (state: NarrationState) => void;
  /** Injectable so recovery deadlines can be tested without real waiting. */
  clock?: {
    setTimeout: (callback: () => void, delay: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Return a cancellation function; handlers belong only to this attempt. */
  speak: (text: string, handlers: {
    started: () => void;
    progress: (charIndex: number) => void;
    ended: () => void;
    failed: (reason?: string) => void;
  }) => (() => void) | undefined;
}

const START_OR_STALL_TIMEOUT = 20_000;
// Some voices never emit boundary events. Allow slow speech plus a generous
// margin before treating a missing end/error event as a recoverable failure.
const speechCompletionTimeout = (text: string) => Math.max(45_000, Array.from(text).length * 700 + 30_000);

/** Preserve seq and null URLs so replay includes browser-voice fallbacks too. */
export function rememberNarration(clips: Map<number, NarrationClip>, clip: NarrationClip): NarrationClip[] {
  if (Number.isInteger(clip.seq) && clip.seq >= 0) clips.set(clip.seq, clip);
  return Array.from(clips.values()).sort((a, b) => a.seq - b.seq);
}

/** Ordered, retryable playback of already-generated clips. It never fetches
 *  an answer or synthesizes server audio. Retry calls play() synchronously so
 *  a button's user activation is retained on mobile browsers. */
export function createNarrationPlayer(options: NarrationOptions) {
  let clips = new Map<number, NarrationClip>();
  let next = 0;
  let total: number | null = null;
  let generation = 0;
  let attempt = 0;
  let busy = false;
  let suspended = false;
  let recovery: AudioRecovery = null;
  let clean: (() => void) | undefined;
  let loaded: { seq: number; url: string; source: string } | undefined;
  let unlocked = false;
  let priming = 0;
  let lastElement: HTMLAudioElement | null = null;
  const clock = options.clock ?? {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let watchdog: unknown;
  const element = () => {
    lastElement = options.audio() ?? lastElement;
    return lastElement;
  };

  const notify = (playing = false, narrating = false) => options.state({ playing, narrating, recovery });
  const clearWatchdog = () => {
    if (watchdog !== undefined) clock.clearTimeout(watchdog);
    watchdog = undefined;
  };
  const detach = () => { clearWatchdog(); const cleanup = clean; clean = undefined; cleanup?.(); };

  function pump() {
    const audio = element();
    if (!audio || busy || recovery || (total !== null && next >= total)) return;
    const clip = clips.get(next);
    if (!clip) return;
    if (suspended) { recovery = "paused"; notify(); return; }
    busy = true;
    const forGeneration = generation;
    const forAttempt = ++attempt;
    const current = () => generation === forGeneration && attempt === forAttempt && busy;
    const watch = (delay: number, expired: () => void) => {
      clearWatchdog();
      watchdog = clock.setTimeout(() => { if (current()) expired(); }, delay);
    };
    const fail = (reason: AudioRecovery) => {
      if (!current()) return;
      busy = false;
      attempt++;
      detach();
      recovery = reason;
      notify();
    };
    const ended = () => {
      if (!current()) return;
      busy = false;
      attempt++;
      detach();
      next++;
      loaded = undefined;
      notify();
      pump();
    };
    notify(false, true);

    if (!clip.url) {
      let started = false;
      let lastCharIndex = 0;
      const onStarted = () => {
        if (!current() || started) return;
        started = true;
        notify(true, true);
        watch(speechCompletionTimeout(clip.text), () => fail("error"));
      };
      try {
        watch(START_OR_STALL_TIMEOUT, () => fail("error"));
        const cancel = options.speak(clip.text, {
          started: onStarted,
          progress: (charIndex) => {
            if (!current() || !Number.isFinite(charIndex)) return;
            onStarted();
            const nextCharIndex = Math.max(0, Math.min(Math.floor(charIndex), clip.text.length));
            if (nextCharIndex <= lastCharIndex) return;
            lastCharIndex = nextCharIndex;
            watch(speechCompletionTimeout(clip.text.slice(lastCharIndex)), () => fail("error"));
          },
          ended,
          failed: (reason) => fail(reason === "not-allowed" ? "blocked" : "error"),
        });
        if (current()) {
          clean = cancel;
          if (!cancel) fail("error");
        } else cancel?.();
      } catch { fail("error"); }
      return;
    }

    try {
      // A blocked/pause retry retains the current position. A failed resource
      // is reloaded only on an explicit retry, never on incoming queue events.
      if (!loaded || loaded.seq !== clip.seq || loaded.url !== clip.url || audio.src !== loaded.source) {
        audio.src = clip.url;
        audio.currentTime = 0;
        loaded = { seq: clip.seq, url: clip.url, source: audio.src };
      }
      const source = loaded.source;
      const sourceMatches = () => audio.src === source && (!audio.currentSrc || audio.currentSrc === source);
      let lastTime = audio.currentTime;
      let started = false;
      const armMediaWatchdog = () => watch(START_OR_STALL_TIMEOUT, () => {
        // Check the element too: timeupdate events may be throttled while
        // audio itself continues. A long recording has no total-time limit.
        if (sourceMatches() && !audio.paused && audio.currentTime > lastTime + 0.01) {
          lastTime = audio.currentTime;
          armMediaWatchdog();
          return;
        }
        fail("error");
        // Invalidate/detach first so pause or a late play promise cannot
        // replace the recovery state or advance this unfinished sentence.
        audio.pause();
      });
      const onProgress = () => {
        if (!current() || !sourceMatches() || audio.paused || audio.currentTime <= lastTime + 0.01) return;
        lastTime = audio.currentTime;
        armMediaWatchdog();
      };
      const onEnded = () => { if (sourceMatches() && audio.ended) ended(); };
      const onError = () => { if (current() && sourceMatches() && audio.error) { loaded = undefined; fail("error"); } };
      const onPause = () => {
        if (!current() || !sourceMatches() || !audio.paused || audio.ended) return;
        if (audio.error) loaded = undefined;
        fail(audio.error ? "error" : "paused");
      };
      const onPlaying = () => {
        if (!current() || !sourceMatches() || audio.paused) return;
        if (!started) { started = true; armMediaWatchdog(); }
        notify(true, true);
      };
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("playing", onPlaying);
      audio.addEventListener("timeupdate", onProgress);
      clean = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("timeupdate", onProgress);
      };
      armMediaWatchdog();
      // Keep this call in the button/event stack; do not await anything first.
      const playback = audio.play();
      Promise.resolve(playback).then(() => {
        if (!current() || !sourceMatches()) return;
        unlocked = true;
        onPlaying();
      }).catch((error: unknown) => {
        if (!current()) return;
        const name = error && typeof error === "object" && "name" in error ? error.name : "";
        if (name !== "NotAllowedError") loaded = undefined;
        fail(name === "NotAllowedError" ? "blocked" : "error");
      });
    } catch { loaded = undefined; fail("error"); }
  }

  function reset(notifyState = true) {
    // Invalidate callbacks before pause/cancel can dispatch their own events.
    generation++;
    attempt++;
    priming++;
    busy = false;
    suspended = false;
    recovery = null;
    detach();
    clips = new Map();
    next = 0;
    total = null;
    loaded = undefined;
    const audio = element();
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    if (notifyState) notify();
  }

  return {
    reset,
    get size() { return clips.size; },
    add(clip: NarrationClip) {
      if (!Number.isInteger(clip.seq) || clip.seq < next) return;
      clips.set(clip.seq, clip);
      pump();
    },
    finish(count: number) { total = Math.max(0, Math.floor(count)); pump(); },
    retry() {
      if (!recovery || busy) return;
      // Some engines emit pause before error. Inspect the element again so a
      // recovered network resource reloads on this first tap, not a second one.
      if (element()?.error) loaded = undefined;
      recovery = null;
      suspended = false;
      pump();
    },
    suspend() {
      suspended = true;
      if (!busy) return;
      // Page hiding may pause the element without an ended event. Returning
      // never auto-resumes; a visitor can continue the same clip by tapping.
      attempt++;
      busy = false;
      detach();
      element()?.pause();
      recovery = "paused";
      notify();
    },
    prime(silentUrl: string) {
      if (unlocked || busy) return;
      const audio = element();
      if (!audio) return;
      const forGeneration = generation;
      const forPrime = ++priming;
      try {
        audio.src = silentUrl;
        const source = audio.src;
        Promise.resolve(audio.play()).then(() => {
          if (generation !== forGeneration || priming !== forPrime || busy || audio.src !== source) return;
          unlocked = true;
          audio.pause();
        }).catch(() => { /* Not unlocked: real playback still has a retry button. */ });
      } catch { /* A future tap may retry the unlock. */ }
    },
  };
}
