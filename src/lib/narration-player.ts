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
  /** Return a cancellation function; handlers belong only to this attempt. */
  speak: (text: string, handlers: { ended: () => void; failed: (reason?: string) => void }) => (() => void) | undefined;
}

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
  const element = () => {
    lastElement = options.audio() ?? lastElement;
    return lastElement;
  };

  const notify = (playing = false, narrating = false) => options.state({ playing, narrating, recovery });
  const detach = () => { const cleanup = clean; clean = undefined; cleanup?.(); };

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
      try {
        const cancel = options.speak(clip.text, {
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
      const onEnded = () => { if (sourceMatches() && audio.ended) ended(); };
      const onError = () => { if (current() && sourceMatches() && audio.error) { loaded = undefined; fail("error"); } };
      const onPause = () => {
        if (!current() || !sourceMatches() || !audio.paused || audio.ended) return;
        if (audio.error) loaded = undefined;
        fail(audio.error ? "error" : "paused");
      };
      const onPlaying = () => { if (current() && sourceMatches() && !audio.paused) notify(true, true); };
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("playing", onPlaying);
      clean = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("playing", onPlaying);
      };
      // Keep this call in the button/event stack; do not await anything first.
      const started = audio.play();
      Promise.resolve(started).then(() => {
        if (!current() || !sourceMatches()) return;
        unlocked = true;
        if (!audio.paused) notify(true, true);
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
