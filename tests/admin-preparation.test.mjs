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
  vm.runInNewContext(code, { module, exports: module.exports, TextDecoder, require: (name) => {
    if (Object.hasOwn(imports, name)) return imports[name]; throw new Error(`Unexpected import ${name}`);
  } });
  return module.exports;
}
const narration = load('../src/lib/admin-narration.ts', { './readiness': load('../src/lib/readiness.ts') });
const { preparationEntries, interruptPreparation } = load('../src/lib/admin-preparation.ts', { './admin-narration': narration });
const { readNarrationResponse } = load('../src/lib/admin-narration-stream.ts');
const person = { id: 'synthetic', language: 'auto', photoUrl: '/api/photo/synthetic', sections: [
  { id: 's0', title: 'First', content: 'Synthetic first' }, { id: 's1', title: 'Second', content: 'Synthetic second' },
] };
const ready = { ready: true, status: 'ready', message: 'Ready' };

test('one-click plan includes missing media then each section and language in order', () => {
  const entries = preparationEntries(person, { includeMedia: true, photo: ready, textOnly: false });
  assert.deepEqual(Array.from(entries, (entry) => entry.key), ['cartoon', 'loop-video', 'narration:s0:zh', 'narration:s0:en', 'narration:s1:zh', 'narration:s1:en']);
  assert.ok(entries.every((entry) => entry.status === 'pending'));
});

test('unapproved missing media remains visibly blocked while all text steps remain available', () => {
  const entries = preparationEntries(person, { includeMedia: true, photo: { ready: false, status: 'privacy_disabled', message: '照片未获准，待处理' }, textOnly: true });
  assert.ok(entries.slice(0, 2).every((entry) => entry.status === 'blocked' && entry.detail.includes('未获准')));
  assert.ok(entries.slice(2).every((entry) => entry.status === 'pending' && entry.label.endsWith('文字讲解')));
  const existing = preparationEntries({ ...person, cartoonUrl: '/cartoon', loopVideoUrl: '/loop' }, { includeMedia: true, photo: ready, textOnly: false });
  assert.equal(existing.length, 4); assert.ok(existing.every((entry) => entry.kind === 'narration'));
});

test('interrupting a run retains complete and failed details and explains every unstarted step', () => {
  const entries = preparationEntries(person, { includeMedia: true, photo: ready, textOnly: false });
  entries[0] = { ...entries[0], status: 'complete', detail: 'Saved' };
  entries[1] = { ...entries[1], status: 'failed', detail: 'Known failure' };
  entries[2].status = 'running';
  const result = interruptPreparation(entries);
  assert.equal(result[0].detail, 'Saved'); assert.equal(result[0].status, 'complete');
  assert.equal(result[1].detail, 'Known failure'); assert.equal(result[2].status, 'failed');
  assert.ok(result.slice(3).every((entry) => entry.status === 'blocked' && entry.detail.includes('未发起')));
});

test('retry metadata binds a step to the source variant and retains one-key or audio-only mode', () => {
  for (const mode of [{ regenerateRejectedText: true }, { audioOnly: true }]) {
    const entries = preparationEntries(person, { includeMedia: false, photo: ready, textOnly: false, ...mode });
    const selected = entries[3].narration;
    assert.equal(selected.variant.sectionId, 's1'); assert.equal(selected.variant.language, 'en');
    assert.equal(selected.regenerateRejectedText, mode.regenerateRejectedText);
    assert.equal(selected.audioOnly, mode.audioOnly);
    assert.equal(selected.textOnly, false);
    assert.equal('content' in selected, false);
    assert.equal('script' in selected, false);
    if (mode.regenerateRejectedText) assert.match(entries[3].detail, /尝试一次修订/);
  }
});

const expected = { sectionId: 's0', language: 'zh' };
const phase = (value, extra = {}) => ({ type: 'phase', ...expected, phase: value, ...extra });
function response(events) {
  return new Response(events.map((event) => JSON.stringify(event)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}

test('real phase labels appear before the final result, including split UTF-8 chunks', async () => {
  let controller; const encoder = new TextEncoder(); const labels = []; let phaseArrived;
  const arrived = new Promise((resolve) => { phaseArrived = resolve; });
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = readNarrationResponse(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }), expected, (label) => { labels.push(label); phaseArrived(); });
  const bytes = encoder.encode(JSON.stringify(phase('review', { ignored: '中文不会显示' })) + '\n');
  controller.enqueue(bytes.slice(0, bytes.length - 3)); controller.enqueue(bytes.slice(bytes.length - 3));
  await arrived;
  assert.deepEqual(labels, ['正在审核讲解内容']);
  controller.enqueue(encoder.encode(JSON.stringify({ type: 'result', status: 503, data: { code: 'read_failed' } }) + '\n')); controller.close();
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.status, 503);
});

test('stream ignores other variants, unknown phases and provider text; final payload determines success', async () => {
  const labels = [];
  const result = await readNarrationResponse(response([
    phase('tts', { sectionId: 'other' }), phase('PRIVATE-ERROR'), phase('__proto__'), phase('revision'), phase('persist', { message: 'PRIVATE-MANUSCRIPT' }),
    { type: 'result', status: 200, data: { results: [{ status: 'failed', reason: 'answer_not_approved' }] } },
  ]), expected, (label) => labels.push(label));
  assert.deepEqual(labels, ['正在修订讲解', '正在保存讲解与配音记录']);
  assert.equal(result.data.results[0].status, 'failed');
  assert.doesNotMatch(labels.join(), /PRIVATE|__proto__/);
});

test('missing, malformed or duplicate final stream results never imply completion', async () => {
  for (const events of [[phase('audio_save')], [{ type: 'result', status: 999, data: {} }], [{ type: 'result', status: 200, data: {} }, { type: 'result', status: 200, data: {} }]]) {
    await assert.rejects(readNarrationResponse(response(events), expected, () => {}), /Preparation stream interrupted/);
  }
  await assert.rejects(readNarrationResponse(new Response('PRIVATE invalid JSON\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), expected, () => {}), /Preparation stream interrupted/);
});

test('preflight JSON errors preserve HTTP status and never produce phase events', async () => {
  const result = await readNarrationResponse(new Response(JSON.stringify({ code: 'a2e_privacy_disabled' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), expected, () => assert.fail('No phase for JSON'));
  assert.equal(result.ok, false); assert.equal(result.status, 403); assert.equal(result.data.code, 'a2e_privacy_disabled');
});
