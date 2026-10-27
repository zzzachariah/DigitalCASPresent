import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/prepared-narration.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const { audioExtension, prepareExistingNarration, AudioReadError, beginPreparation } = mod;

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(24)]);
const person = () => ({
  id: 'student-1', slug: 'student-1', name: 'Student', language: 'auto', status: 'published', script: 'original script',
  sections: [{ id: 'section-1', title: 'Introduction', content: 'source', cachedAnswers: { zh: '原有讲解文字' }, cachedAudio: {}, cachedSuggestions: {} }],
});

test('audio payload validation uses bytes rather than trusting a MIME label', () => {
  assert.equal(audioExtension({ buffer: wav, contentType: 'audio/wav' }), 'wav');
  assert.throws(() => audioExtension({ buffer: Buffer.from('not audio at all'), contentType: 'audio/mpeg' }), AudioReadError);
});

test('audio-only preparation saves and verifies bytes without changing cached text', async () => {
  let current = person();
  let ttsCalls = 0;
  const deps = {
    getPerson: async () => structuredClone(current),
    updatePerson: async (_id, patch) => { current = { ...current, ...structuredClone(patch) }; return structuredClone(current); },
    tts: async text => { ttsCalls++; assert.equal(text, '原有讲解文字'); return 'https://provider.example/new.wav'; },
    readAudio: async url => ({ buffer: wav, contentType: url.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream' }),
    saveAudio: async (_id, _key, bytes, ext) => { assert.ok(bytes.equals(wav)); assert.equal(ext, 'wav'); return 'https://blob.example/permanent.wav'; },
  };
  const before = current.sections[0].cachedAnswers.zh;
  const result = await prepareExistingNarration(current.id, 'section-1', 'zh', deps);
  assert.equal(result.status, 'prepared');
  assert.equal(ttsCalls, 1);
  assert.equal(current.sections[0].cachedAnswers.zh, before);
  assert.equal(current.sections[0].cachedAudio.zh, 'https://blob.example/permanent.wav');
});

test('a healthy permanent narration is skipped without paid synthesis', async () => {
  const current = person();
  current.sections[0].cachedAudio.zh = 'https://blob.example/existing.wav';
  let calls = 0;
  const result = await prepareExistingNarration(current.id, 'section-1', 'zh', {
    getPerson: async () => structuredClone(current), updatePerson: async () => { throw new Error('must not write'); },
    tts: async () => { calls++; return ''; }, readAudio: async () => ({ buffer: wav, contentType: 'audio/wav' }),
    saveAudio: async () => { throw new Error('must not save'); },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'healthy_audio');
  assert.equal(calls, 0);
});

test('provider or verification failure preserves the record and old audio', async () => {
  let current = person();
  current.sections[0].cachedAudio.zh = 'https://blob.example/missing.wav';
  const snapshot = structuredClone(current);
  let writes = 0;
  const result = await prepareExistingNarration(current.id, 'section-1', 'zh', {
    getPerson: async () => structuredClone(current), updatePerson: async () => { writes++; return current; },
    tts: async () => { throw new Error('send_tts failed (400): {"code":1005}'); },
    readAudio: async () => { throw new AudioReadError('missing'); }, saveAudio: async () => '',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.providerCode, '1005');
  assert.equal(writes, 0);
  assert.deepEqual(current, snapshot);
});

test('a concurrent source edit prevents a prepared URL from being attached', async () => {
  let current = person();
  let reads = 0;
  const result = await prepareExistingNarration(current.id, 'section-1', 'zh', {
    getPerson: async () => {
      reads++;
      if (reads === 2) current.sections[0].cachedAnswers.zh = '老师刚刚修改的文字';
      return structuredClone(current);
    },
    updatePerson: async () => { throw new Error('must not write'); }, tts: async () => 'https://provider.example/new.wav',
    readAudio: async () => ({ buffer: wav, contentType: 'audio/wav' }), saveAudio: async () => 'https://blob.example/new.wav',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'source_changed');
  assert.equal(current.sections[0].cachedAnswers.zh, '老师刚刚修改的文字');
});

test('preparation lock is scoped to one person and always releasable', () => {
  const release = beginPreparation('student-1');
  assert.equal(typeof release, 'function');
  assert.equal(beginPreparation('student-1'), null);
  const releaseOther = beginPreparation('student-2');
  assert.equal(typeof releaseOther, 'function');
  release(); releaseOther();
  assert.equal(typeof beginPreparation('student-1'), 'function');
});
