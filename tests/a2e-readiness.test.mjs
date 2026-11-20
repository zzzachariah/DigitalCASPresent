import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

function load(file, mocks, env = {}) {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => { if (name === 'node:crypto') return crypto; if (!(name in mocks)) throw new Error(`Unexpected import ${name}`); return mocks[name]; },
    process: { env }, Response, Buffer, AbortSignal, AbortController, ReadableStream, TextEncoder, URL, Date, Set, Map, Promise,
    fetch: () => assert.fail('No real external requests are permitted in this test'),
    console: { error() {} },
  });
  return module.exports;
}
const next = { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } };
function setup() {
  const env = { AI_PROCESSING_APPROVED: 'true', EXTERNAL_AI_PROCESSING_APPROVED: 'false', AVATAR_PROVIDER: 'a2e', A2E_API_KEY: 'synthetic-private-key' };
  const policy = load('../src/lib/processing-policy.ts', {}, env);
  const retention = load('../src/lib/event-retention.ts', {}, env);
  const a2e = load('../src/lib/a2e.ts', { './processing-policy': policy, './event-retention': retention }, env);
  const state = { admin: true, reads: 0, writes: 0, providerCalls: 0, writableChecks: 0, readinessChecks: 0 };
  const api = {
    ...a2e,
    a2eReadiness: () => { state.readinessChecks++; return a2e.a2eReadiness(); },
    a2ePhotoReadiness: personId => { state.readinessChecks++; return a2e.a2ePhotoReadiness(personId); },
    a2eSpeechReadiness: personId => { state.readinessChecks++; return a2e.a2eSpeechReadiness(personId); },
    a2eUploadImageBytes: async () => { state.providerCalls++; return 'https://synthetic-provider.invalid/photo.png'; },
    a2eCartoonStart: async () => { state.providerCalls++; return { taskId: 'synthetic-task' }; },
    a2eCartoonPoll: async () => { state.providerCalls++; return { pending: true }; },
    a2eLoopVideoStart: async () => { state.providerCalls++; return { taskId: 'synthetic-task' }; },
    a2eLoopVideoPoll: async () => { state.providerCalls++; return { pending: true }; },
  };
  const store = {
    getPerson: async () => { state.reads++; return { id: 'synthetic', photoUrl: '/api/photo/synthetic' }; },
    storageWritable: () => { state.writableChecks++; return { ok: true }; },
    saveCartoon: () => { state.writes++; assert.fail('Unexpected save'); },
    saveLoopVideo: () => { state.writes++; assert.fail('Unexpected save'); },
  };
  const routes = ['cartoon', 'loop-video'].map(name => load(`../src/app/api/admin/people/[id]/${name}/route.ts`, {
    'next/server': next, '@/lib/auth': { isAdmin: () => state.admin }, '@/lib/store': store, '@/lib/a2e': api,
    '@/lib/avatar-source': { readAvatarSource: async () => ({ buffer: Buffer.from('synthetic-bytes'), contentType: 'image/png' }) },
  }, env));
  return { env, policy, a2e, api, state, store, routes };
}
const req = (taskId = 'synthetic-task') => ({ headers: new Headers({ host: 'synthetic.invalid' }), nextUrl: new URL('https://synthetic.invalid/?taskId=' + encodeURIComponent(taskId)) });
const params = { params: { id: 'synthetic' } };

const conditions = [
  [{ EXTERNAL_AI_PROCESSING_APPROVED: 'false' }, 'privacy_disabled', 403],
  [{ EXTERNAL_AI_PROCESSING_APPROVED: 'true', AVATAR_PROVIDER: 'mock', A2E_PHOTO_APPROVED_PERSON_IDS: 'synthetic', A2E_SPEECH_APPROVED_PERSON_IDS: 'synthetic' }, 'provider_missing', 503],
  [{ EXTERNAL_AI_PROCESSING_APPROVED: 'true', AVATAR_PROVIDER: 'a2e', A2E_API_KEY: '  ', A2E_PHOTO_APPROVED_PERSON_IDS: 'synthetic', A2E_SPEECH_APPROVED_PERSON_IDS: 'synthetic' }, 'key_missing', 503],
];

test('readiness distinguishes deliberate privacy blocking, provider selection, missing key and ready locally', () => {
  for (const [config, status] of conditions) {
    const s = setup(); Object.assign(s.env, config);
    const readiness = s.a2e.a2eReadiness();
    assert.equal(readiness.status, status); assert.equal(readiness.ready, false); assert.equal(s.a2e.a2eConfigured(), false);
    assert.ok(!JSON.stringify(readiness).includes('synthetic-private-key'));
  }
  const s = setup(); s.env.EXTERNAL_AI_PROCESSING_APPROVED = 'true';
  assert.equal(s.a2e.a2eReadiness().status, 'ready'); assert.equal(s.a2e.a2eConfigured(), true);
  s.env.EXTERNAL_AI_PROCESSING_APPROVED = 'false'; s.env.A2E_API_KEY = '';
  assert.equal(s.a2e.a2eReadiness().status, 'privacy_disabled');
});

test('activity A2E approval includes future participants but still needs provider configuration', () => {
  const s = setup();
  for (const value of ['', 'false', '1', '*']) {
    s.env.A2E_PROCESSING_APPROVED = value;
    assert.equal(s.a2e.a2ePhotoReadiness('future-participant').ready, false);
    assert.equal(s.a2e.a2eSpeechReadiness('future-participant').ready, false);
  }
  s.env.A2E_PROCESSING_APPROVED = 'true';
  for (const id of [undefined, 'current-participant', 'future-participant']) {
    assert.equal(s.a2e.a2ePhotoReadiness(id).ready, true);
    assert.equal(s.a2e.a2eSpeechReadiness(id).ready, true);
  }
  assert.equal(s.a2e.a2eReadiness().ready, false);
  assert.equal(s.policy.externalProcessingAllowed(), false);
  for (const id of ['', '../bad', '*']) {
    assert.equal(s.a2e.a2ePhotoReadiness(id).ready, false);
    assert.equal(s.a2e.a2eSpeechReadiness(id).ready, false);
  }
  s.env.A2E_API_KEY = '';
  assert.equal(s.a2e.a2eSpeechReadiness('future-participant').status, 'key_missing');
  s.env.AVATAR_PROVIDER = 'did';
  assert.equal(s.a2e.a2ePhotoReadiness('future-participant').status, 'provider_missing');
});

test('cartoon and loop POST/GET return exact disabled reason before reading any student data or polling', async () => {
  for (const [config, status, http] of conditions) {
    const s = setup(); Object.assign(s.env, config);
    for (const route of s.routes) for (const method of ['POST', 'GET']) {
      const response = await route[method](req(), params); const body = await response.json();
      assert.equal(response.status, http); assert.equal(body.code, `a2e_${status}`);
      assert.equal(body.a2e.status, status); assert.equal(body.a2e.ready, false); assert.equal(body.error, body.a2e.message);
      if (status === 'privacy_disabled') assert.ok(!body.error.includes('未配置'));
    }
    assert.equal(s.state.reads, 0); assert.equal(s.state.writes, 0); assert.equal(s.state.providerCalls, 0); assert.equal(s.state.writableChecks, 0);
  }
});

test('media status is never exposed before administrator authentication', async () => {
  const s = setup(); s.state.admin = false;
  for (const route of s.routes) for (const method of ['POST', 'GET']) {
    const response = await route[method](req(), params);
    assert.equal(response.status, 401); assert.equal((await response.json()).a2e, undefined);
  }
  assert.equal(s.state.readinessChecks, 0); assert.equal(s.state.providerCalls, 0); assert.equal(s.state.reads, 0);
});

test('ready media configuration retains start/poll behavior using mocked synthetic data only', async () => {
  const s = setup(); s.env.A2E_PHOTO_APPROVED_PERSON_IDS = 'synthetic';
  for (const route of s.routes) {
    const taskId = (await (await route.POST(req(), params)).json()).taskId;
    assert.ok(taskId.includes('.'));
    assert.equal((await (await route.GET(req(taskId), params)).json()).pending, true);
  }
  assert.equal(s.state.providerCalls, 6);
});

function preparationSetup() {
  const s = setup();
  const privacy = load('../src/lib/privacy.ts', {});
  const errors = load('../src/lib/ai-errors.ts', {});
  const safety = load('../src/lib/ai-safety.ts', { './ai-errors': errors, './review-output': load('../src/lib/review-output.ts', { './ai-errors': errors }) });
  const sentences = load('../src/lib/sentences.ts', {});
  const answer = 'The exhibit connects a compass with checking observations.';
  let person = { id: 'synthetic', privacyConsent: { version: privacy.PRIVACY_VERSION, acceptedAt: 1 }, language: 'en', script: 'Synthetic source', sections: [{ id: 'part', title: 'Compass', content: 'A museum compass demonstrates how observation can help people make decisions. Its needle provides a shared point of reference that people can check for themselves.' }] };
  const state = { aiCalls: 0, mediaCalls: 0, jsonCalls: 0 };
  let replies = [answer, '{"safe":true,"grounded":true,"private":true,"relevant":true,"respectful":true}'];
  const route = load('../src/app/api/admin/people/[id]/pregenerate/route.ts', {
    '@/lib/processing-policy': s.policy, '@/lib/privacy': privacy, '@/lib/ai-safety': safety,
    '@/lib/preparation-response': load('../src/lib/preparation-response.ts', {}),
    'next/server': next, '@/lib/auth': { isAdmin: () => s.state.admin },
    '@/lib/store': { ...s.store, getPerson: async () => { s.state.reads++; return structuredClone(person); }, updatePerson: async (_id, patch) => { person = { ...person, ...patch }; return structuredClone(person); } },
    '@/lib/ai': { chat: async () => { state.aiCalls++; return replies.shift(); } },
    '@/lib/prompts': { systemPrompt: () => 'Synthetic test', explainSectionPrompt: () => 'Explain this synthetic exhibit' },
    '@/lib/a2e': { ...s.api, a2eTts: () => { state.mediaCalls++; assert.fail('Unexpected narration'); } },
    '@/lib/sentences': sentences,
    '@/lib/prepared-narration': { beginPreparation: () => () => {}, createPermanentNarration: () => { state.mediaCalls++; assert.fail('Unexpected media generation'); }, prepareExistingNarration: () => { state.mediaCalls++; assert.fail('Unexpected media repair'); } },
  }, s.env);
  return { ...s, prepState: state, route, answer, request: body => ({ json: async () => { state.jsonCalls++; return body; } }), setCached: () => { person.sections[0].cachedAnswers = { en: answer }; replies = [replies[1]]; } };
}

test('audio-only preparation reports the same readiness before student reads, AI review or narration', async () => {
  for (const [config, status, http] of conditions) {
    const s = preparationSetup(); Object.assign(s.env, config);
    const response = await s.route.POST(s.request({ audioOnly: true }), params); const body = await response.json();
    assert.equal(response.status, http); assert.equal(body.code, `a2e_${status}`); assert.equal(body.a2e.status, status);
    assert.equal(s.state.reads, 0); assert.equal(s.prepState.aiCalls, 0); assert.equal(s.prepState.mediaCalls, 0); assert.equal(s.state.writableChecks, 0);
  }
  const s = preparationSetup(); s.state.admin = false;
  assert.equal((await s.route.POST(s.request({ audioOnly: true }), params)).status, 401);
  assert.equal(s.prepState.jsonCalls, 0); assert.equal(s.state.readinessChecks, 0);
});

test('textOnly guarantees no media even when A2E is ready, for both new text and existing answers', async () => {
  for (const cached of [false, true]) {
    const s = preparationSetup(); s.env.A2E_SPEECH_APPROVED_PERSON_IDS = 'synthetic'; if (cached) s.setCached();
    const response = await s.route.POST(s.request({ textOnly: true, sectionId: 'part', language: 'en' }), params);
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.mode, 'text-only'); assert.equal(s.prepState.mediaCalls, 0);
    assert.equal(body.sections[0].cachedAnswers.en, s.answer);
    assert.equal(body.results[0].reason, cached ? 'text_already_cached' : 'text_saved');
    assert.equal(s.prepState.aiCalls, cached ? 1 : 2);
  }
  const s = preparationSetup();
  assert.equal((await s.route.POST(s.request({ audioOnly: true, textOnly: true }), params)).status, 400);
  assert.equal((await s.route.POST(s.request({ textOnly: 'true' }), params)).status, 400);
  assert.equal(s.state.reads, 0); assert.equal(s.prepState.aiCalls, 0);
});

test('admin health exposes readiness without implying a configured key is missing', async () => {
  const s = setup();
  const route = load('../src/app/api/admin/health/route.ts', {
    '@/lib/processing-policy': s.policy, 'next/server': next, '@/lib/a2e': s.api,
    '@/lib/auth': { isAdmin: () => s.state.admin, adminConfigured: () => true },
    '@/lib/store': { ...s.store, storageDriverName: () => 'filesystem' },
    '@/lib/store-shared': { resolveBlobToken: () => undefined, mediaBlobConfigured: () => false, recordsBlobConfigured: () => false, hasBlobOidcToken: () => false },
  }, s.env);
  const body = await (await route.GET()).json();
  assert.equal(body.a2eKeySet, true); assert.equal(body.a2e.status, 'privacy_disabled');
  assert.equal(body.a2ePhoto.approvedPersonIds.length, 0); assert.equal(body.a2e.ready, false);
  assert.equal(body.a2eSpeech.approvedPersonIds.length, 0); assert.equal(body.a2eSpeech.global.ready, false);
  s.env.A2E_SPEECH_APPROVED_PERSON_IDS = 'synthetic';
  const scoped = await (await route.GET()).json();
  assert.deepEqual(scoped.a2eSpeech.approvedPersonIds, ['synthetic']);
  assert.equal(scoped.a2eSpeech.people.synthetic.ready, true);
  assert.equal(scoped.a2ePhoto.approvedPersonIds.length, 0); assert.equal(scoped.a2e.ready, false);
  assert.ok(!JSON.stringify(body).includes('synthetic-private-key'));
  s.state.admin = false;
  assert.equal((await route.GET()).status, 401);
});


test('photo approval is exact per person and never enables global narration', async () => {
  const s = setup(); s.env.A2E_PHOTO_APPROVED_PERSON_IDS = 'Anna-id, Anna-id, *, ../bad';
  assert.deepEqual(Array.from(s.a2e.a2ePhotoApprovedPersonIds()), ['Anna-id']);
  assert.equal(s.a2e.a2ePhotoReadiness('Anna-id').ready, true);
  assert.equal(s.a2e.a2ePhotoReadiness('another-student').status, 'privacy_disabled');
  assert.equal(s.a2e.a2eReadiness().status, 'privacy_disabled');
  assert.equal(s.a2e.a2eConfigured(), false);
  await assert.rejects(s.a2e.a2eTts('Synthetic narration'), /disabled pending/);
  await assert.rejects(s.a2e.a2e('/api/v1/video/send_tts', 'POST', { msg: 'Synthetic' }, undefined, 'Anna-id'), /outside photo-only/);
  await assert.rejects(s.a2e.a2e('/api/v1/userNanoBanana/start', 'POST', {}, undefined, 'another-student'), /approval/);
});

test('photo tasks are signed and bound to a person, purpose, key and lifetime', async () => {
  const s = setup(); s.env.A2E_PHOTO_APPROVED_PERSON_IDS = 'synthetic,another';
  const token = s.a2e.issueA2ePhotoTask('synthetic', 'cartoon', 'task-123');
  assert.equal(s.a2e.verifyA2ePhotoTask(token, 'synthetic', 'cartoon'), 'task-123');
  assert.equal(s.a2e.verifyA2ePhotoTask(token, 'another', 'cartoon'), null);
  assert.equal(s.a2e.verifyA2ePhotoTask(token, 'synthetic', 'loop'), null);
  assert.equal(s.a2e.verifyA2ePhotoTask(token + 'x', 'synthetic', 'cartoon'), null);
  assert.equal(s.a2e.verifyA2ePhotoTask('task-123', 'synthetic', 'cartoon'), null);
  const payload = Buffer.from(JSON.stringify(['synthetic', 'cartoon', 'task-123', Date.now() - 25 * 3600000])).toString('base64url');
  const signature = crypto.createHmac('sha256', s.env.A2E_API_KEY).update('a2e-photo-task:' + payload).digest('base64url');
  assert.equal(s.a2e.verifyA2ePhotoTask(payload + '.' + signature, 'synthetic', 'cartoon'), null);
  for (const [route, supplied] of [[s.routes[0], token + 'x'], [s.routes[1], token]]) {
    assert.equal((await route.GET(req(supplied), params)).status, 400);
  }
  assert.equal(s.state.providerCalls, 0);
  s.env.A2E_API_KEY = 'changed-key';
  assert.equal(s.a2e.verifyA2ePhotoTask(token, 'synthetic', 'cartoon'), null);
});
