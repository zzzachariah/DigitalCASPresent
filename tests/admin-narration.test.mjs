import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, imports = {}) {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    if (Object.hasOwn(imports, name)) return imports[name]; throw new Error(`Unexpected import ${name}`);
  } });
  return module.exports;
}
const readiness = load('../src/lib/readiness.ts');
const { prepareNarrationVariants, adminReadinessForPerson } = load('../src/lib/admin-narration.ts', { './readiness': readiness });
const source = (count = 3, overrides = {}) => ({
  id: 'synthetic', name: 'Synthetic', language: 'auto', script: 'Synthetic private source',
  photoUrl: '/photo', cartoonUrl: '/cartoon', loopVideoUrl: '/video',
  sections: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Synthetic object ${i}`, content: `Synthetic section ${i}`, cachedAnswers: { zh: `Synthetic Chinese ${i}`, en: `Synthetic English ${i}` } })),
  ...overrides,
});
function success(person, body, { status = 'prepared', reason = 'audio_saved', audio = true } = {}) {
  person.sections = person.sections.map((s) => s.id === body.sectionId ? {
    ...s, cachedAnswers: { ...s.cachedAnswers, [body.language]: s.cachedAnswers?.[body.language] || 'Synthetic new explanation' },
    ...(audio ? { cachedAudio: { ...s.cachedAudio, [body.language]: `/api/photo/synthetic.audio.${s.id}-${body.language}` } } : {}),
  } : s);
  return { ok: true, status: 200, data: { sections: structuredClone(person.sections), results: [{ sectionId: body.sectionId, language: body.language, status, reason }] } };
}

test('auto-language multi-section work is sequential, complete and reuses text via audioOnly', async () => {
  const p = source(); const calls = []; const updates = []; const progress = []; let active = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, {
    request: async (body) => {
      assert.equal(++active, 1); calls.push(body); await Promise.resolve(); active--;
      return success(p, body);
    }, onUpdate: (value) => updates.push(value), onProgress: (value) => progress.push(value),
  });
  assert.equal(result.total, 6); assert.equal(result.completed, 6); assert.equal(result.failures.length, 0);
  assert.deepEqual(calls.map((c) => `${c.sectionId}/${c.language}`), ['s0/zh', 's0/en', 's1/zh', 's1/en', 's2/zh', 's2/en']);
  assert.ok(calls.every((c) => c.audioOnly === true && !c.regenerateText && !c.textOnly && !('script' in c)));
  assert.equal(updates.length, 6); assert.deepEqual(progress.map((x) => x.current), [1, 2, 3, 4, 5, 6]);
  assert.equal(adminReadinessForPerson(result.person).ready, true);
});

test('unapproved speech never requests audio, including when cached text exists', async () => {
  const p = source(1); const calls = [];
  const result = await prepareNarrationVariants(p, { textOnly: true }, { request: async (body) => {
    calls.push(body); return success(p, body, { status: 'skipped', reason: 'text_already_cached', audio: false });
  } });
  assert.ok(calls.every((c) => c.textOnly === true && c.audioOnly === undefined));
  assert.equal(result.completed, 2);
  assert.equal(adminReadinessForPerson(result.person).ready, false);
});

test('audio-only mode never generates missing text and still prepares other existing variants', async () => {
  const p = source(1); delete p.sections[0].cachedAnswers.zh; const calls = [];
  const result = await prepareNarrationVariants(p, { textOnly: false, audioOnly: true }, { request: async (body) => { calls.push(body); return success(p, body); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].language, 'en'); assert.equal(calls[0].audioOnly, true);
  assert.equal(result.completed, 1); assert.equal(result.failures.length, 1); assert.equal(result.failures[0].language, 'zh');
});

test('missing text in normal preparation uses one exact variant without forcing regeneration', async () => {
  const p = source(1, { language: 'zh' }); delete p.sections[0].cachedAnswers.zh; let payload;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => { payload = body; return success(p, body); } });
  assert.equal(payload.sectionId, 's0'); assert.equal(payload.language, 'zh');
  assert.equal(payload.audioOnly, undefined); assert.equal(payload.regenerateText, undefined);
  assert.equal(result.completed, 1);
});

test('only request_time_budget is retried once and repeated skips remain incomplete', async () => {
  const p = source(1, { language: 'zh' }); let calls = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    calls++; return { ok: true, status: 200, data: { sections: p.sections, results: [{ ...body, status: 'skipped', reason: 'request_time_budget' }] } };
  } });
  assert.equal(calls, 2); assert.equal(result.completed, 0); assert.equal(result.failures.length, 1);
});

test('a budget skip can complete on its bounded single-variant retry', async () => {
  const p = source(1, { language: 'zh' }); let calls = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    if (++calls === 1) return { ok: true, status: 200, data: { sections: p.sections, results: [{ ...body, status: 'skipped', reason: 'request_time_budget' }] } };
    return success(p, body, { status: 'skipped', reason: 'healthy_audio' });
  } });
  assert.equal(calls, 2); assert.equal(result.completed, 1);
});

test('unconfirmed network outcomes stop later calls without an automatic paid retry', async () => {
  let calls = 0;
  const result = await prepareNarrationVariants(source(), { textOnly: false }, { request: async () => { calls++; throw new Error('Connection lost'); } });
  assert.equal(calls, 1); assert.equal(result.completed, 0); assert.equal(result.failures.length, 6);
});

test('an HTTP success or prepared marker without stored audio is not completion', async () => {
  const p = source(1, { language: 'zh' });
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => success(p, body, { audio: false }) });
  assert.equal(result.completed, 0); assert.equal(result.failures.length, 1);
});

test('permission failure stops remaining variants while retaining completed work', async () => {
  const p = source(); let calls = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    if (++calls === 1) return success(p, body);
    return { ok: false, status: 403, data: { error: 'Approval changed' } };
  } });
  assert.equal(calls, 2); assert.equal(result.completed, 1); assert.equal(result.failures.length, 5);
  assert.ok(result.person.sections[0].cachedAudio.zh);
});

test('auto readiness requires saved text and audio in both requested languages', () => {
  const p = source(1); p.sections[0].cachedAudio = { zh: '/api/photo/synthetic.audio.zh' };
  assert.equal(adminReadinessForPerson(p).ready, false);
  p.sections[0].cachedAudio.en = '/api/photo/synthetic.audio.en';
  assert.equal(adminReadinessForPerson(p).ready, true);
});
