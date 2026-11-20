import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function helper(extra = {}) {
  const source = fs.readFileSync(new URL('../src/lib/preparation-response.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Response, ReadableStream, TextEncoder, AbortController, AbortSignal, Set, ...extra });
  return module.exports;
}
const { preparationResponse, wantsPreparationStream } = helper();
const progress = { sectionId: 'part-1', language: 'en', phase: 'review' };
function gate() { let resolve; return { promise: new Promise((r) => { resolve = r; }), release: () => resolve() }; }
const readEvents = async (response) => (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);

test('NDJSON is opt-in; absent, wildcard, other types and q=0 preserve JSON', () => {
  for (const accept of [null, '', '*/*', 'application/json', 'application/x-ndjsonx', 'application/x-ndjson; q=0.0']) assert.equal(wantsPreparationStream(accept), false);
  for (const accept of ['application/x-ndjson', 'application/json, application/x-ndjson;q=0.5', 'Application/X-Ndjson']) assert.equal(wantsPreparationStream(accept), true);
});

test('default JSON preserves final status and exact response body and invokes work once', async () => {
  let runs = 0, releases = 0;
  const data = { mode: 'audio-only', results: [{ status: 'failed', phase: 'review' }], failed: 1 };
  const response = await preparationResponse({ stream: false, release: () => { releases++; }, run: async (_signal, report) => {
    runs++; report(progress); return { status: 502, data };
  } });
  assert.equal(response.status, 502); assert.deepEqual(await response.json(), data);
  assert.equal(runs, 1); assert.equal(releases, 1);
});

test('phases arrive while work is active; lock releases only after one authoritative final result', async () => {
  const finish = gate(); let releases = 0;
  const response = await preparationResponse({ stream: true, release: () => { releases++; }, run: async (_signal, report) => {
    report({ ...progress, rawProviderText: 'PRIVATE-CANARY' });
    report({ ...progress, phase: 'PRIVATE-CANARY' });
    await finish.promise;
    return { status: 502, data: { failed: 1, results: [{ status: 'failed', phase: 'review' }] } };
  } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value)), { type: 'phase', ...progress });
  assert.equal(releases, 0);
  finish.release();
  const result = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(result.type, 'result'); assert.equal(result.status, 502);
  assert.equal((await reader.read()).done, true); assert.equal(releases, 1);
});

test('stream cancellation aborts work and holds the lock until in-flight cleanup settles', async () => {
  const entered = gate(), cleanup = gate(), finished = gate(); let signalSeen, releases = 0, laterCalls = 0;
  const response = await preparationResponse({ stream: true, release: () => { releases++; finished.release(); }, run: async (signal, report) => {
    signalSeen = signal; report(progress); entered.release();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise;
    signal.throwIfAborted(); laterCalls++;
    return { status: 200, data: {} };
  } });
  await entered.promise;
  const reader = response.body.getReader(); await reader.read();
  await reader.cancel();
  assert.equal(signalSeen.aborted, true); assert.equal(releases, 0);
  cleanup.release(); await finished.promise;
  assert.equal(releases, 1); assert.equal(laterCalls, 0);
});

test('shared deadline stays at 100 seconds and failure may still be delivered after timeout', async () => {
  const deadline = new AbortController(); let requested;
  const streamHelper = helper({ AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: (ms) => { requested = ms; return deadline.signal; } } });
  const response = await streamHelper.preparationResponse({ stream: true, release() {}, run: async (signal, report) => {
    report(progress); deadline.abort(new DOMException('deadline', 'TimeoutError'));
    return { status: 502, data: { failed: 1, reason: signal.aborted ? 'request_time_budget' : 'unexpected' } };
  } });
  assert.equal(requested, 100_000);
  const events = await readEvents(response);
  assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).data.reason, 'request_time_budget');
});

test('unexpected stream exceptions produce one safe final failure with no raw error text', async () => {
  let releases = 0;
  const response = await preparationResponse({ stream: true, release: () => { releases++; }, run: async () => { throw new Error('PRIVATE-CANARY: token and manuscript'); } });
  const events = await readEvents(response);
  assert.deepEqual(events, [{ type: 'result', status: 503, data: { error: 'preparation_failed', code: 'preparation_failed' } }]);
  assert.equal(releases, 1);
});

const preparedCode = ts.transpileModule(fs.readFileSync(new URL('../src/lib/prepared-narration.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { prepareExistingNarration } = await import(`data:text/javascript;base64,${Buffer.from(preparedCode).toString('base64')}`);
const wav = Buffer.from('RIFF0000WAVEsynthetic-audio-fixture');
function narrationFixture() {
  let person = { id: 'synthetic', script: 'synthetic source', sections: [{ id: 'part', title: 'Object', content: 'synthetic source', cachedAnswers: { en: 'Reviewed synthetic explanation.' } }] };
  const calls = [];
  return { calls, deps: {
    onPhase: (phase) => calls.push(`phase:${phase}`),
    getPerson: async () => { calls.push('read'); return structuredClone(person); },
    updatePerson: async (_id, patch) => { calls.push('persist'); person = { ...person, ...structuredClone(patch) }; return person; },
    tts: async () => { calls.push('tts'); return 'https://provider.invalid/audio.wav'; },
    readAudio: async () => { calls.push('readAudio'); return { buffer: wav, contentType: 'audio/wav' }; },
    saveAudio: async () => { calls.push('saveAudio'); return '/api/photo/synthetic.audio.part?asset=synthetic'; },
  } };
}

test('narration hooks report real stages before each corresponding awaited operation', async () => {
  const f = narrationFixture();
  const result = await prepareExistingNarration('synthetic', 'part', 'en', f.deps);
  assert.equal(result.status, 'prepared');
  assert.deepEqual(f.calls, [
    'phase:read', 'read', 'phase:audio_preparation', 'phase:tts', 'tts', 'phase:download', 'readAudio',
    'phase:audio_save', 'saveAudio', 'phase:audio_verification', 'readAudio', 'phase:source_recheck', 'read',
    'phase:persist', 'persist', 'phase:persist_verification', 'read',
  ]);
});

test('cancelling at a reported boundary prevents subsequent storage mutation', async () => {
  const f = narrationFixture(); const controller = new AbortController(); f.deps.signal = controller.signal;
  f.deps.onPhase = (phase) => { f.calls.push(`phase:${phase}`); if (phase === 'audio_save') controller.abort(); };
  const result = await prepareExistingNarration('synthetic', 'part', 'en', f.deps);
  assert.equal(result.status, 'failed'); assert.equal(result.phase, 'audio_save');
  assert.equal(f.calls.includes('saveAudio'), false); assert.equal(f.calls.includes('persist'), false);
});

function routeFixture(admin) {
  let reads = 0, providerCalls = 0, writes = 0, releases = 0;
  const sourceCanary = 'PRIVATE-SOURCE-CANARY';
  const candidateCanary = 'UNREVIEWED-CANDIDATE-CANARY';
  const person = { id: 'synthetic', language: 'en', privacyConsent: { version: 'synthetic-policy' }, script: sourceCanary, sections: [{ id: 'part', title: 'Object', content: sourceCanary }] };
  const mocks = {
    'next/server': { NextResponse: Response },
    '@/lib/auth': { isAdmin: () => admin },
    '@/lib/processing-policy': { aiProcessingAllowed: () => true },
    '@/lib/privacy': { PRIVACY_VERSION: 'synthetic-policy' },
    '@/lib/store': {
      storageWritable: () => ({ ok: true }),
      getPerson: async () => { reads++; return structuredClone(person); },
      updatePerson: async () => { writes++; throw new Error('Unexpected write'); },
      readPhoto: async () => { throw new Error('Unexpected media read'); },
      saveAudio: async () => { throw new Error('Unexpected media save'); },
    },
    '@/lib/ai-safety': { reviewExhibitionAnswer: async (_input, _reviewer, diagnostic) => { diagnostic({ reason: 'criteria_rejected', rejectedCriteria: ['grounded'] }); return false; } },
    '@/lib/ai': { chat: async () => candidateCanary },
    '@/lib/prompts': { systemPrompt: () => 'Synthetic', explainSectionPrompt: () => 'Synthetic' },
    '@/lib/a2e': { a2eSpeechReadiness: () => ({ ready: true }), a2eTts: async () => { providerCalls++; throw new Error('Unreviewed text reached TTS'); } },
    '@/lib/sentences': { splitAnswer: (answer) => ({ answer, suggestions: [] }) },
    '@/lib/preparation-response': { preparationResponse, wantsPreparationStream },
    '@/lib/prepared-narration': { beginPreparation: () => () => { releases++; } },
  };
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/app/api/admin/people/[id]/pregenerate/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => { if (!(name in mocks)) throw new Error(`Unexpected import ${name}`); return mocks[name]; }, Response, AbortSignal, Buffer, URL, Date });
  return {
    run: () => module.exports.POST({ headers: new Headers({ Accept: 'application/x-ndjson' }), json: async () => ({ sectionId: 'part', language: 'en', textOnly: true }), signal: new AbortController().signal }, { params: { id: 'synthetic' } }),
    counts: () => ({ reads, writes, providerCalls, releases }), sourceCanary, candidateCanary,
  };
}

test('stream opt-in does not move authentication behind the response or access source data', async () => {
  const f = routeFixture(false); const response = await f.run();
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.deepEqual(f.counts(), { reads: 0, writes: 0, providerCalls: 0, releases: 0 });
});

test('route sends generation/review stages but never candidate text or TTS before approval', async () => {
  const f = routeFixture(true); const response = await f.run(); const events = await readEvents(response);
  assert.deepEqual(events.slice(0, 2), [
    { type: 'phase', sectionId: 'part', language: 'en', phase: 'generation' },
    { type: 'phase', sectionId: 'part', language: 'en', phase: 'review' },
  ]);
  assert.equal(events.length, 3); assert.equal(events[2].type, 'result'); assert.equal(events[2].status, 502);
  assert.equal(events[2].data.results[0].reason, 'answer_not_approved');
  assert.ok(!JSON.stringify(events.slice(0, 2)).includes(f.sourceCanary));
  assert.ok(!JSON.stringify(events).includes(f.candidateCanary));
  assert.deepEqual(f.counts(), { reads: 2, writes: 0, providerCalls: 0, releases: 1 });
});
