import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

const yes = JSON.stringify({ safe: true, grounded: true, private: true, relevant: true, respectful: true });
const answer = 'This exhibit connects a compass with checking observations.';
const source = 'A museum compass demonstrates how observation can help people make decisions. Its needle provides a shared point of reference that people can check for themselves.';
const bytes = Buffer.from('RIFF0000WAVEsynthetic-audio-fixture');

function setup({ cached = true, approved = true } = {}) {
  const env = { AI_PROCESSING_APPROVED: 'true', EXTERNAL_AI_PROCESSING_APPROVED: 'false', AVATAR_PROVIDER: 'a2e', A2E_API_KEY: 'synthetic-key', A2E_BASE_URL: 'https://synthetic-provider.invalid', A2E_SPEECH_APPROVED_PERSON_IDS: approved ? 'anna-fixture' : '', EVENT_ENDS_AT: '2999-01-01T00:00:00Z' };
  const state = { admin: true, reads: 0, aiCalls: [], provider: [], downloads: 0, writes: 0, audio: new Map(), review: () => yes, generate: () => answer, failPhase: '' };
  async function fetch(url, init = {}) {
    init.signal?.throwIfAborted();
    if (url === 'https://synthetic-provider.invalid/api/v1/video/send_tts') {
      state.provider.push(JSON.parse(init.body));
      if (state.failPhase === 'tts') return Response.json({ code: 1005, msg: 'PRIVATE-ERROR-CANARY: upstream echoed text' }, { status: 400 });
      return Response.json({ code: 0, data: 'https://synthetic-provider.invalid/audio.wav' });
    }
    assert.equal(url, 'https://synthetic-provider.invalid/audio.wav');
    state.downloads++;
    if (state.failPhase === 'download') throw new Error('PRIVATE-ERROR-CANARY: failed audio URL');
    return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
  }
  function load(file, mocks = {}) {
    const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require: name => {
      if (name === 'crypto' || name === 'node:crypto') return crypto;
      if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
      return mocks[name];
    }, process: { env }, Response, Buffer, AbortSignal, AbortController, ReadableStream, TextEncoder, URL, Date, Set, Map, Promise, fetch, Error, DOMException });
    return module.exports;
  }
  const policy = load('../src/lib/processing-policy.ts');
  const retention = load('../src/lib/event-retention.ts');
  const privacy = load('../src/lib/privacy.ts');
  const errors = load('../src/lib/ai-errors.ts');
  const reviewOutput = load('../src/lib/review-output.ts', { './ai-errors': errors });
  const a2e = load('../src/lib/a2e.ts', { './processing-policy': policy, './event-retention': retention });
  state.person = {
    id: 'anna-fixture', name: 'Synthetic Anna', gender: 'female', language: 'en', script: source,
    privacyConsent: { version: privacy.PRIVACY_VERSION, acceptedAt: 1 },
    sections: [{ id: 'part', title: 'Compass', content: source, ...(cached ? { cachedAnswers: { en: answer }, cachedSuggestions: { en: [] } } : {}) }],
  };
  const store = {
    storageWritable: () => ({ ok: true }),
    getPerson: async () => {
      state.reads++;
      if (state.failReadAt === state.reads) throw new Error('PRIVATE-ERROR-CANARY: Blob token, manuscript, upstream body');
      return structuredClone(state.person);
    },
    updatePerson: async (_id, patch) => { if (state.failPhase === 'persist') throw new Error('PRIVATE-ERROR-CANARY: storage body'); state.writes++; state.person = { ...state.person, ...structuredClone(patch) }; return structuredClone(state.person); },
    saveAudio: async (id, key, buffer) => {
      if (state.failPhase === 'audio_save') throw new Error('PRIVATE-ERROR-CANARY: credentials');
      assert.equal(id, 'anna-fixture');
      const assetId = `${id}.audio.${key}`; const asset = crypto.createHash('sha256').update(buffer).digest('hex') + '.wav';
      state.audio.set(`${assetId}?asset=${asset}`, Buffer.from(buffer));
      return `/api/photo/${assetId}?asset=${asset}`;
    },
    readPhoto: async (id, asset) => {
      if (state.failPhase === 'audio_verification') throw new Error('PRIVATE-ERROR-CANARY: private URL');
      const buffer = state.audio.get(`${id}?asset=${asset}`);
      return buffer ? { buffer, contentType: 'audio/wav' } : null;
    },
  };
  const route = load('../src/app/api/admin/people/[id]/pregenerate/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/auth': { isAdmin: () => state.admin }, '@/lib/store': store,
    '@/lib/processing-policy': policy, '@/lib/privacy': privacy, '@/lib/a2e': a2e,
    '@/lib/ai-safety': load('../src/lib/ai-safety.ts', { './ai-errors': errors, './review-output': reviewOutput }), '@/lib/sentences': load('../src/lib/sentences.ts'),
    '@/lib/preparation-response': load('../src/lib/preparation-response.ts'),
    '@/lib/prepared-narration': load('../src/lib/prepared-narration.ts'),
    '@/lib/prompts': load('../src/lib/prompts.ts'),
    '@/lib/ai': { chat: async options => { state.aiCalls.push(options); return options.system.startsWith('You are a strict safety') ? state.review(options) : state.generate(options); } },
  });
  const controller = new AbortController();
  return { env, state, controller, run: (options, id = 'anna-fixture', stream = false) => route.POST({ json: async () => ({ sectionId: 'part', language: 'en', ...options }), signal: controller.signal, headers: new Headers(stream ? { accept: 'application/x-ndjson' } : {}) }, { params: { id } }) };
}

test('approved audio-only preparation reviews existing text, persists exact audio bytes and preserves text', async () => {
  const s = setup();
  const before = structuredClone(s.state.person.sections[0].cachedAnswers);
  const response = await s.run({ audioOnly: true }); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.mode, 'audio-only'); assert.equal(body.results[0].reason, 'saved_and_verified');
  assert.deepEqual(s.state.person.sections[0].cachedAnswers, before);
  assert.equal(s.state.aiCalls.length, 1); assert.equal(s.state.aiCalls[0].maxTokens, 2048);
  assert.equal(s.state.provider.length, 1); assert.equal(s.state.provider[0].msg, answer);
  assert.ok(!JSON.stringify(s.state.provider).includes(source));
  assert.equal(s.state.downloads, 1); assert.equal(s.state.writes, 1);
  const stored = s.state.audio.get(body.results[0].audioUrl.slice('/api/photo/'.length));
  assert.ok(stored.equals(bytes));
});

test('no student read, review or TTS occurs for other people or without speech permission', async () => {
  for (const [approved, id] of [[false, 'anna-fixture'], [true, 'other-person']]) {
    const s = setup({ approved }); s.env.A2E_PHOTO_APPROVED_PERSON_IDS = id;
    const response = await s.run({ audioOnly: true }, id);
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'a2e_privacy_disabled');
    assert.equal(s.state.reads, 0); assert.equal(s.state.aiCalls.length, 0); assert.equal(s.state.provider.length, 0);
  }
});

test('failed review, changed source or changed cached answer cannot send narration', async () => {
  for (const change of ['review', 'source', 'answer', 'consent', 'expiry']) {
    const s = setup();
    s.state.review = () => {
      if (change === 'review') return yes.replace('"safe":true', '"safe":false');
      if (change === 'source') s.state.person.sections[0].content = 'Changed synthetic source.';
      if (change === 'answer') s.state.person.sections[0].cachedAnswers.en = 'UNREVIEWED-CHANGED-CANARY';
      if (change === 'consent') delete s.state.person.privacyConsent;
      if (change === 'expiry') s.env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z';
      return yes;
    };
    const response = await s.run({ audioOnly: true });
    assert.equal(response.status, 502, change);
    assert.equal(s.state.provider.length, 0, change); assert.equal(s.state.writes, 0, change);
  }
});

test('new narration shares the generation/review deadline and textOnly skips all A2E requests', async () => {
  for (const textOnly of [false, true]) {
    const s = setup({ cached: false });
    const response = await s.run({ textOnly }); const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.results[0].reason, textOnly ? 'text_saved' : 'text_and_audio_saved');
    assert.equal(s.state.aiCalls.length, 2);
    assert.equal(s.state.aiCalls[0].signal, s.state.aiCalls[1].signal);
    assert.equal(s.state.provider.length, textOnly ? 0 : 1);
    if (!textOnly) assert.equal(s.state.provider[0].msg, answer);
  }
});

test('request cancellation after generation prevents review results reaching TTS or storage', async () => {
  const s = setup({ cached: false });
  s.state.review = () => { s.controller.abort(); return yes; };
  const response = await s.run({}); const body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.results[0].reason, 'request_time_budget');
  assert.equal(s.state.provider.length, 0); assert.equal(s.state.writes, 0);
  assert.equal(s.state.aiCalls[0].signal.aborted, true);
});

test('new generation exposes only fixed failure stages and bounded provider codes, never exception text', async () => {
  for (const phase of ['generation', 'tts', 'download', 'audio_save', 'audio_verification', 'persist']) {
    const s = setup({ cached: false }); s.state.failPhase = phase;
    if (phase === 'generation') s.state.generate = () => { throw new Error('PRIVATE-ERROR-CANARY: upstream manuscript'); };
    const response = await s.run({}); const body = await response.json();
    assert.equal(response.status, 502, phase);
    assert.equal(body.results[0].phase, phase);
    assert.equal(body.results[0].reason, `${phase}_failed`);
    assert.equal(body.results[0].providerCode, phase === 'tts' ? '1005' : undefined);
    assert.ok(!JSON.stringify(body.results).includes('PRIVATE-ERROR-CANARY'));
  }
});

test('new and cached answer failures retain safe review diagnostics without source or upstream output', async () => {
  for (const cached of [false, true]) for (const reason of ['model_rejection', 'review_format', 'review_timeout', 'review_upstream_error']) {
    const s = setup({ cached });
    s.state.review = () => {
      if (reason === 'model_rejection') return yes.replace('"grounded":true', '"grounded":false');
      if (reason === 'review_format') return 'PRIVATE-ERROR-CANARY: malformed result';
      if (reason === 'review_timeout') throw new DOMException('PRIVATE-ERROR-CANARY', 'TimeoutError');
      throw new Error('PRIVATE-ERROR-CANARY');
    };
    const response = await s.run(cached ? { audioOnly: true } : {}); const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.results[0].phase, 'review'); assert.equal(body.results[0].reason, 'answer_not_approved');
    assert.equal(body.results[0].reviewReason, reason);
    assert.deepEqual(body.results[0].rejectedCriteria, reason === 'model_rejection' ? ['grounded'] : undefined);
    assert.ok(!JSON.stringify(body.results).includes('PRIVATE-ERROR-CANARY'));
    assert.ok(!JSON.stringify(body.results).includes(source));
    assert.equal(s.state.provider.length, 0);
  }
});

test('initial and final storage read errors stay structured and never repeat synthesis', async () => {
  const initial = setup(); initial.state.failReadAt = 1;
  const initialResponse = await initial.run({ audioOnly: true });
  assert.equal(initialResponse.status, 503);
  assert.deepEqual(await initialResponse.json(), { error: 'read_failed', code: 'read_failed' });
  assert.equal(initial.state.aiCalls.length, 0); assert.equal(initial.state.provider.length, 0);

  const final = setup(); final.state.failReadAt = 6; // initial, prepare, TTS guard, source, persistence, final read
  const finalResponse = await final.run({ audioOnly: true }); const body = await finalResponse.json();
  assert.equal(finalResponse.status, 503); assert.equal(body.code, 'read_failed');
  assert.equal(body.sections, undefined); assert.equal(body.results[0].status, 'prepared');
  assert.equal(final.state.provider.length, 1); assert.equal(final.state.writes, 1);
  assert.ok(final.state.person.sections[0].cachedAudio.en);
  assert.ok(!JSON.stringify(body).includes('PRIVATE-ERROR-CANARY'));
});

const repairedAnswer = 'The compass offers a reference people can check.';
function rejectedPair(s) {
  const section = s.state.person.sections[0];
  section.cachedAnswers = { en: 'REJECTED-ANSWER-CANARY: This compass resolves every disagreement.' };
  section.cachedSuggestions = { en: ['Which observations can visitors check?'] };
  section.cachedAudio = { en: '/api/photo/anna-fixture.audio.old-en?asset=old.wav' };
  s.state.audio.set('anna-fixture.audio.old-en?asset=old.wav', bytes);
  return structuredClone(section);
}
function rejectThenApprove(s, rejected = ['grounded']) {
  let reviews = 0;
  s.state.review = () => ++reviews === 1 ? JSON.stringify({ ...JSON.parse(yes), ...Object.fromEntries(rejected.map(key => [key, false])) }) : yes;
  s.state.generate = () => repairedAnswer + '\n---\nUNSUPPORTED-SUGGESTION-CANARY';
}

test('explicit rejected-text repair makes one source-only candidate and commits only after independent approval and verified TTS', async () => {
  for (const rejected of [['grounded'], ['private'], ['grounded', 'private']]) {
    const s = setup(); const old = rejectedPair(s); rejectThenApprove(s, rejected);
    s.state.person.subtitle = 'UNSUPPORTED-SUBTITLE-CANARY';
    s.state.person.sections[0].hint = 'UNSUPPORTED-HINT-CANARY';
    s.state.person.sections.push({ id: 'other', title: 'Other', content: 'OTHER-SOURCE-CANARY' });
    const response = await s.run({ regenerateRejectedText: true }); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.mode, 'revise-rejected-text');
    assert.equal(body.results[0].revisionAttempted, true); assert.equal(body.results[0].reason, 'text_and_audio_revised');
    assert.equal(s.state.aiCalls.length, 3);
    const generation = s.state.aiCalls.filter(call => !call.system.startsWith('You are a strict safety'));
    assert.equal(generation.length, 1); assert.equal(generation[0].temperature, 0);
    const sent = JSON.stringify(generation);
    for (const canary of ['REJECTED-ANSWER-CANARY', 'UNSUPPORTED-SUBTITLE-CANARY', 'UNSUPPORTED-HINT-CANARY', 'OTHER-SOURCE-CANARY']) assert.ok(!sent.includes(canary), canary);
    assert.ok(sent.includes(source));
    assert.equal(JSON.parse(s.state.aiCalls[2].messages[0].content).answer, repairedAnswer);
    assert.deepEqual(JSON.parse(s.state.aiCalls[2].messages[0].content).suggestions, []);
    assert.equal(s.state.provider.length, 1); assert.equal(s.state.provider[0].msg, repairedAnswer);
    assert.equal(s.state.writes, 1); assert.equal(s.state.person.sections[0].cachedAnswers.en, repairedAnswer);
    assert.deepEqual(s.state.person.sections[0].cachedSuggestions.en, []);
    assert.notEqual(s.state.person.sections[0].cachedAudio.en, old.cachedAudio.en);
    assert.ok(s.state.audio.has(old.cachedAudio.en.slice('/api/photo/'.length)));
  }
});

test('repair is explicit, incompatible with audioOnly/unconditional regeneration, and leaves approved text alone', async () => {
  const invalid = setup();
  for (const body of [{ regenerateRejectedText: 'true' }, { regenerateRejectedText: true, audioOnly: true }, { regenerateRejectedText: true, regenerateText: true }]) {
    assert.equal((await invalid.run(body)).status, 400);
  }
  assert.equal(invalid.state.reads, 0); assert.equal(invalid.state.aiCalls.length, 0);
  const noFlag = setup(); const old = rejectedPair(noFlag); rejectThenApprove(noFlag);
  const denied = await noFlag.run({});
  assert.equal(denied.status, 502); assert.equal(noFlag.state.aiCalls.length, 1);
  assert.deepEqual(noFlag.state.person.sections[0], old); assert.equal(noFlag.state.provider.length, 0);
  const approved = setup(); const kept = rejectedPair(approved);
  const accepted = await (await approved.run({ regenerateRejectedText: true })).json();
  assert.equal(accepted.results[0].reason, 'healthy_audio'); assert.equal(accepted.results[0].revisionAttempted, undefined);
  assert.deepEqual(approved.state.person.sections[0], kept); assert.equal(approved.state.aiCalls.length, 1);
  assert.equal(approved.state.writes, 0); assert.equal(approved.state.provider.length, 0);
});

test('service/format/timeout/local rejection or other rejected criteria never trigger a revision', async () => {
  for (const reason of ['upstream', 'format', 'timeout', 'local', 'safe', 'relevant', 'respectful']) {
    const s = setup(); const old = rejectedPair(s);
    if (reason === 'local') { s.state.person.sections[0].cachedAnswers.en = source; old.cachedAnswers.en = source; }
    s.state.review = () => {
      if (reason === 'upstream') throw new Error('PRIVATE-ERROR-CANARY');
      if (reason === 'format') return 'PRIVATE-ERROR-CANARY';
      if (reason === 'timeout') throw new DOMException('PRIVATE-ERROR-CANARY', 'TimeoutError');
      return JSON.stringify({ ...JSON.parse(yes), grounded: false, [reason]: false });
    };
    const response = await s.run({ regenerateRejectedText: true }); const body = await response.json();
    assert.equal(response.status, 502, reason); assert.equal(body.results[0].revisionAttempted, undefined);
    assert.equal(s.state.aiCalls.filter(call => !call.system.startsWith('You are a strict safety')).length, 0);
    assert.equal(s.state.provider.length, 0); assert.equal(s.state.writes, 0);
    assert.deepEqual(s.state.person.sections[0], old);
  }
});

test('a rejected repair or later preparation failure preserves the old pair without another attempt', async () => {
  for (const failure of ['review', 'review_format', 'review_upstream', 'revision', 'tts', 'download', 'audio_save', 'audio_verification', 'persist', 'source_changed']) {
    const s = setup(); const old = rejectedPair(s); rejectThenApprove(s);
    let reviews = 0;
    s.state.review = () => {
      if (++reviews === 1 || failure === 'review') return yes.replace('"grounded":true', '"grounded":false');
      if (failure === 'review_format') return 'broken JSON';
      if (failure === 'review_upstream') throw new Error('PRIVATE-CANARY');
      if (failure === 'source_changed') s.state.person.sections[0].content = 'Changed source.';
      return yes;
    };
    if (failure === 'revision') s.state.generate = () => { throw new Error('PRIVATE-CANARY'); };
    else s.state.failPhase = failure;
    const response = await s.run({ regenerateRejectedText: true }); const body = await response.json();
    assert.equal(response.status, 502, failure); assert.equal(body.results[0].revisionAttempted, true, failure);
    assert.equal(s.state.aiCalls.filter(call => !call.system.startsWith('You are a strict safety')).length, 1, failure);
    assert.equal(s.state.writes, 0, failure);
    assert.deepEqual(s.state.person.sections[0].cachedAnswers, old.cachedAnswers, failure);
    assert.deepEqual(s.state.person.sections[0].cachedAudio, old.cachedAudio, failure);
    assert.ok(!JSON.stringify(body.results).includes('PRIVATE-CANARY'));
  }
});

test('new text can be revised once, and textOnly repair never calls TTS', async () => {
  const s = setup({ cached: false }); rejectThenApprove(s);
  const response = await s.run({ regenerateRejectedText: true, textOnly: true }); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.results[0].reason, 'text_revised');
  assert.equal(body.results[0].revisionAttempted, true);
  assert.equal(s.state.aiCalls.filter(call => !call.system.startsWith('You are a strict safety')).length, 2);
  assert.equal(s.state.provider.length, 0); assert.equal(s.state.writes, 1);
  assert.deepEqual(s.state.person.sections[0].cachedSuggestions.en, []);
});

test('streamed repair reports a revision phase without releasing candidate text before the final result', async () => {
  const s = setup(); rejectedPair(s); rejectThenApprove(s);
  const response = await s.run({ regenerateRejectedText: true }, 'anna-fixture', true);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.slice(0, 3).map(event => event.phase), ['review', 'revision', 'review']);
  assert.ok(events.slice(0, -1).every(event => !JSON.stringify(event).includes(repairedAnswer)));
  assert.equal(events.at(-1).data.results[0].revisionAttempted, true);
});
