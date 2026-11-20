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
  const state = { admin: true, reads: 0, aiCalls: [], provider: [], downloads: 0, writes: 0, audio: new Map(), review: () => yes };
  async function fetch(url, init = {}) {
    init.signal?.throwIfAborted();
    if (url === 'https://synthetic-provider.invalid/api/v1/video/send_tts') {
      state.provider.push(JSON.parse(init.body));
      return Response.json({ code: 0, data: 'https://synthetic-provider.invalid/audio.wav' });
    }
    assert.equal(url, 'https://synthetic-provider.invalid/audio.wav');
    state.downloads++;
    return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
  }
  function load(file, mocks = {}) {
    const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require: name => {
      if (name === 'crypto' || name === 'node:crypto') return crypto;
      if (!(name in mocks)) throw new Error(`Unexpected import ${name}`);
      return mocks[name];
    }, process: { env }, Response, Buffer, AbortSignal, URL, Date, Set, Map, Promise, fetch });
    return module.exports;
  }
  const policy = load('../src/lib/processing-policy.ts');
  const retention = load('../src/lib/event-retention.ts');
  const privacy = load('../src/lib/privacy.ts');
  const a2e = load('../src/lib/a2e.ts', { './processing-policy': policy, './event-retention': retention });
  state.person = {
    id: 'anna-fixture', name: 'Synthetic Anna', gender: 'female', language: 'en', script: source,
    privacyConsent: { version: privacy.PRIVACY_VERSION, acceptedAt: 1 },
    sections: [{ id: 'part', title: 'Compass', content: source, ...(cached ? { cachedAnswers: { en: answer }, cachedSuggestions: { en: [] } } : {}) }],
  };
  const store = {
    storageWritable: () => ({ ok: true }),
    getPerson: async () => { state.reads++; return structuredClone(state.person); },
    updatePerson: async (_id, patch) => { state.writes++; state.person = { ...state.person, ...structuredClone(patch) }; return structuredClone(state.person); },
    saveAudio: async (id, key, buffer) => {
      assert.equal(id, 'anna-fixture');
      const assetId = `${id}.audio.${key}`; const asset = crypto.createHash('sha256').update(buffer).digest('hex') + '.wav';
      state.audio.set(`${assetId}?asset=${asset}`, Buffer.from(buffer));
      return `/api/photo/${assetId}?asset=${asset}`;
    },
    readPhoto: async (id, asset) => {
      const buffer = state.audio.get(`${id}?asset=${asset}`);
      return buffer ? { buffer, contentType: 'audio/wav' } : null;
    },
  };
  const route = load('../src/app/api/admin/people/[id]/pregenerate/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/auth': { isAdmin: () => state.admin }, '@/lib/store': store,
    '@/lib/processing-policy': policy, '@/lib/privacy': privacy, '@/lib/a2e': a2e,
    '@/lib/ai-safety': load('../src/lib/ai-safety.ts'), '@/lib/sentences': load('../src/lib/sentences.ts'),
    '@/lib/prepared-narration': load('../src/lib/prepared-narration.ts'),
    '@/lib/prompts': { systemPrompt: () => 'Synthetic test', explainSectionPrompt: () => 'Explain this exhibit' },
    '@/lib/ai': { chat: async options => { state.aiCalls.push(options); return options.maxTokens === 150 ? state.review(options) : answer; } },
  });
  const controller = new AbortController();
  return { env, state, controller, run: (options, id = 'anna-fixture') => route.POST({ json: async () => ({ sectionId: 'part', language: 'en', ...options }), signal: controller.signal }, { params: { id } }) };
}

test('approved audio-only preparation reviews existing text, persists exact audio bytes and preserves text', async () => {
  const s = setup();
  const before = structuredClone(s.state.person.sections[0].cachedAnswers);
  const response = await s.run({ audioOnly: true }); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.mode, 'audio-only'); assert.equal(body.results[0].reason, 'saved_and_verified');
  assert.deepEqual(s.state.person.sections[0].cachedAnswers, before);
  assert.equal(s.state.aiCalls.length, 1); assert.equal(s.state.aiCalls[0].maxTokens, 150);
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
