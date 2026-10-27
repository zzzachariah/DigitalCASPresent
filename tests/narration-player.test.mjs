import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/narration-player.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { createNarrationPlayer, rememberNarration } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const clip = (seq, url = `https://audio.example/${seq}.mp3`, text = `Sentence ${seq}`) => ({ seq, url, text });

class Audio {
  source = '';
  currentSrc = '';
  currentTime = 0;
  paused = true;
  ended = false;
  error = null;
  calls = [];
  listeners = new Map();
  pauseCount = 0;
  get src() { return this.source; }
  set src(value) {
    this.source = this.currentSrc = value;
    this.paused = true;
    this.ended = false;
    this.error = null;
  }
  play() {
    this.paused = false;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.calls.push({ src: this.src, resolve, reject: error => { this.paused = true; reject(error); } });
    return promise;
  }
  pause() { this.pauseCount++; this.paused = true; this.emit('pause'); }
  load() { this.currentTime = 0; this.ended = false; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name) { for (const handler of [...(this.listeners.get(name) || [])]) handler(); }
  finish() { this.ended = true; this.paused = true; this.emit('ended'); }
}

function fixture() {
  const audio = new Audio();
  const states = [];
  const spoken = [];
  const reference = { current: audio };
  const player = createNarrationPlayer({
    audio: () => reference.current,
    state: value => states.push(value),
    speak: (text, handlers) => {
      const record = { text, handlers, cancelled: false };
      spoken.push(record);
      return () => { record.cancelled = true; handlers.ended(); };
    },
  });
  return { audio, player, states, spoken, reference, state: () => states.at(-1) };
}

test('A rejected first sentence is retained; later clips do not retry or skip it', async () => {
  const f = fixture();
  f.player.add(clip(0));
  f.audio.calls[0].reject(new DOMException('Tap required', 'NotAllowedError'));
  await tick();
  assert.equal(f.state().recovery, 'blocked');
  f.player.add(clip(1));
  f.player.finish(2);
  assert.equal(f.audio.calls.length, 1);
  f.player.retry();
  // Synchronous assertion proves the click stack calls real play directly.
  assert.equal(f.audio.calls.length, 2);
  assert.equal(f.audio.calls[1].src, clip(0).url);
  f.player.retry();
  assert.equal(f.audio.calls.length, 2, 'double tap cannot start another attempt');
  f.audio.calls[1].resolve();
  await tick();
  f.audio.finish();
  assert.equal(f.audio.calls[2].src, clip(1).url);
  f.audio.finish();
  assert.equal(f.state().narrating, false);
});

test('A second rejection and media error both keep the same sentence for explicit retry', async () => {
  const f = fixture();
  f.player.add(clip(0));
  f.player.add(clip(1));
  f.audio.calls[0].reject(new Error('network failure'));
  await tick();
  assert.equal(f.state().recovery, 'error');
  f.player.retry();
  f.audio.error = { code: 2 };
  f.audio.emit('error');
  assert.equal(f.state().recovery, 'error');
  assert.equal(f.audio.calls.length, 2);
  f.player.retry();
  assert.equal(f.audio.calls[2].src, clip(0).url);
});

test('Unexpected pause is recoverable at the existing playback position', async () => {
  const f = fixture();
  f.player.add(clip(0));
  f.audio.calls[0].resolve();
  await tick();
  f.audio.currentTime = 3.25;
  f.audio.pause();
  assert.equal(f.state().recovery, 'paused');
  assert.equal(f.state().narrating, false);
  f.player.retry();
  assert.equal(f.audio.currentTime, 3.25);
  assert.equal(f.audio.calls[1].src, clip(0).url);
});

test('A resource error arriving after pause reloads on the first recovery tap', () => {
  const f = fixture();
  f.player.add(clip(0));
  f.audio.currentTime = 3;
  f.audio.pause();
  assert.equal(f.state().recovery, 'paused');
  f.audio.error = { code: 2 }; // the native error can arrive after listeners detach
  f.player.retry();
  assert.equal(f.audio.calls.length, 2);
  assert.equal(f.audio.error, null, 'assigning src reloads the failed resource');
  assert.equal(f.audio.currentTime, 0);
  assert.equal(f.audio.calls[1].src, clip(0).url);
});

test('Reset invalidates old play rejection and ended callbacks before a new answer', async () => {
  const f = fixture();
  f.player.add(clip(0, 'https://audio.example/old.mp3'));
  const oldEnded = [...f.audio.listeners.get('ended')][0];
  f.player.reset();
  f.player.add(clip(0, 'https://audio.example/new.mp3'));
  f.player.add(clip(1));
  const afterNew = f.states.length;
  f.audio.calls[0].reject(new DOMException('Old request aborted', 'AbortError'));
  oldEnded();
  await tick();
  assert.equal(f.states.length, afterNew);
  assert.equal(f.audio.calls.length, 2);
  assert.equal(f.audio.src, 'https://audio.example/new.mp3');
});

test('Reset invalidates old play success, and queued ended with ended=false cannot advance', async () => {
  const f = fixture();
  f.player.add(clip(0));
  f.player.reset();
  f.player.add(clip(0, 'https://audio.example/new.mp3'));
  f.player.add(clip(1));
  const count = f.states.length;
  f.audio.calls[0].resolve();
  f.audio.emit('ended');
  await tick();
  assert.equal(f.states.length, count);
  assert.equal(f.audio.calls.length, 2);
});

test('Browser-voice cancellation and old onend cannot advance a replacement queue', () => {
  const f = fixture();
  f.player.add(clip(0, null));
  f.player.add(clip(1));
  const old = f.spoken[0];
  f.player.reset(); // cancellation invokes onend synchronously in this mock
  assert.equal(f.audio.calls.length, 0);
  f.player.add(clip(0, 'https://audio.example/new.mp3'));
  old.handlers.ended();
  old.handlers.failed('not-allowed');
  assert.equal(f.audio.calls.length, 1);
  assert.equal(f.state().recovery, null);
});

test('Backgrounding while waiting for audio does not start newly arriving clips', () => {
  const f = fixture();
  f.player.suspend();
  assert.equal(f.states.length, 0, 'no phantom notice before any narration exists');
  f.player.finish(2);
  f.player.add(clip(1));
  f.player.add(clip(0));
  assert.equal(f.audio.calls.length, 0);
  assert.equal(f.state().recovery, 'paused');
  f.player.retry();
  assert.equal(f.audio.calls.length, 1);
  assert.equal(f.audio.calls[0].src, clip(0).url);
});

test('Backgrounding active audio stops it and never resumes without a tap', () => {
  const f = fixture();
  f.player.add(clip(0));
  f.audio.currentTime = 2;
  f.player.suspend();
  assert.equal(f.audio.paused, true);
  f.player.add(clip(1));
  assert.equal(f.audio.calls.length, 1);
  f.player.retry();
  assert.equal(f.audio.currentTime, 2);
  assert.equal(f.audio.calls[1].src, clip(0).url);
});

test('Silent unlock resolving after real playback cannot pause the real clip', async () => {
  const f = fixture();
  f.player.prime('data:audio/wav;base64,silence');
  f.player.add(clip(0));
  const pauses = f.audio.pauseCount;
  f.audio.calls[0].resolve();
  await tick();
  assert.equal(f.audio.pauseCount, pauses);
  assert.equal(f.audio.src, clip(0).url);
  assert.equal(f.audio.paused, false);
});

test('A failed silent unlock is retried on a later gesture; only success marks it unlocked', async () => {
  const f = fixture();
  f.player.prime('data:audio/wav;base64,silence');
  f.audio.calls[0].reject(new DOMException('Tap required', 'NotAllowedError'));
  await tick();
  f.player.prime('data:audio/wav;base64,silence');
  assert.equal(f.audio.calls.length, 2);
  f.audio.calls[1].resolve();
  await tick();
  f.player.prime('data:audio/wav;base64,silence');
  assert.equal(f.audio.calls.length, 2);
});

test('Out-of-order replay retains null audio sentences, and a partial replay can accept later clips', () => {
  const f = fixture();
  const stored = new Map();
  rememberNarration(stored, clip(2));
  rememberNarration(stored, clip(1, null));
  const replay = rememberNarration(stored, clip(0));
  assert.deepEqual(replay.map(item => item.seq), [0, 1, 2]);
  assert.equal(replay[1].url, null);
  assert.equal(replay[1].text, 'Sentence 1');
  f.player.finish(3);
  assert.equal(f.audio.calls.length, 0);
  assert.equal(f.spoken.length, 0, 'an empty replay waits for clips instead of speaking the full answer');
  f.player.add(replay[0]);
  f.audio.finish();
  assert.equal(f.audio.calls.length, 1);
  f.player.add(replay[1]);
  assert.equal(f.spoken[0].text, 'Sentence 1');
  f.player.add(replay[2]);
  f.spoken[0].handlers.ended();
  assert.equal(f.audio.calls[1].src, clip(2).url);
});

test('Unmount cleanup pauses the retained element after its React ref is cleared', async () => {
  const f = fixture();
  f.player.add(clip(0));
  f.reference.current = null;
  const stateCount = f.states.length;
  f.player.reset(false);
  f.audio.calls[0].resolve();
  await tick();
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.src, '');
  assert.equal(f.states.length, stateCount);
  assert.ok([...f.audio.listeners.values()].every(set => set.size === 0));
});
