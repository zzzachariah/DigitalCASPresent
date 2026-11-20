import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, mocks, env = {}, fetch = () => assert.fail('Unexpected network request')) {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (!(name in mocks)) throw new Error(`Unexpected import ${name}`); return mocks[name]; }, process: { env }, Response, Buffer, AbortSignal, AbortController, ReadableStream, TextEncoder, URL, Date, Set, Promise, fetch, console: { error() {} } });
  return module.exports;
}

test('explicit text approval and explicit text denial remain independent from media approval', () => {
  const env = {}; const policy = load('../src/lib/processing-policy.ts', {}, env);
  for (const [ai, external, textAllowed, mediaAllowed] of [
    [undefined, undefined, false, false], [undefined, 'true', true, true],
    ['true', 'false', true, false], ['false', 'true', false, true],
    ['', 'true', false, true], ['true', '', true, false], ['invalid', 'false', false, false],
  ]) {
    if (ai === undefined) delete env.AI_PROCESSING_APPROVED; else env.AI_PROCESSING_APPROVED = ai;
    if (external === undefined) delete env.EXTERNAL_AI_PROCESSING_APPROVED; else env.EXTERNAL_AI_PROCESSING_APPROVED = external;
    assert.equal(policy.aiProcessingAllowed(), textAllowed);
    assert.equal(policy.externalProcessingAllowed(), mediaAllowed);
  }
});

test('AI-only approval never enables D-ID photo upload or spoken text forwarding', async () => {
  const env = { AI_PROCESSING_APPROVED: 'true', EXTERNAL_AI_PROCESSING_APPROVED: 'false', AVATAR_PROVIDER: 'did', DID_API_KEY: 'synthetic-key' };
  const policy = load('../src/lib/processing-policy.ts', {}, env);
  const did = load('../src/lib/did-stream.ts', { './processing-policy': policy }, env);
  assert.equal(policy.aiProcessingAllowed(), true); assert.equal(did.didStreamEnabled(), false);
  await assert.rejects(did.createStream('https://synthetic.invalid/photo.png'), /disabled/);
  await assert.rejects(did.speak('synthetic-stream', 'synthetic-session', 'synthetic narration', 'en'), /disabled/);
});

test('admin auto-sectioning stays local because anonymous drafts have no participant receipt', async () => {
  let calls = 0;
  const handler = load('../src/lib/handlers.ts', {
    'next/server': { NextResponse: { json: body => new Response(JSON.stringify(body)) } },
    nanoid: { nanoid: () => 'synthetic-section' },
    './processing-policy': { aiProcessingAllowed: () => true },
    './local-sections': { localSections: script => [{ id: 'synthetic-section', title: 'Part', content: script }] },
    './ai': { chat: () => { calls++; throw new Error('must not forward old draft'); } },
    './prompts': {}, './parse': {}, './validate': { LIMITS: { script: 40000 } },
  });
  const route = load('../src/app/api/admin/autosection/route.ts', {
    'next/server': {}, '@/lib/auth': { isAdmin: () => true }, '@/lib/handlers': handler,
  });
  const result = await route.POST({ json: async () => ({ script: 'Synthetic old draft.' }) });
  assert.equal((await result.json()).method, 'local'); assert.equal(calls, 0);
});

test('pre-generation requires the participant current receipt even when AI is enabled', async () => {
  const privacy = load('../src/lib/privacy.ts', {});
  const safety = load('../src/lib/ai-safety.ts', { './ai-errors': load('../src/lib/ai-errors.ts', {}) });
  const preparationResponse = load('../src/lib/preparation-response.ts', {});
  const answer = 'The exhibit connects a compass with checking observations.';
  const person = { id: 'synthetic', script: 'A museum compass demonstrates how observation can help people make decisions. Its needle provides a shared point of reference that people can check for themselves.', language: 'en', sections: [{ id: 'part', title: 'Compass', content: 'A museum compass demonstrates how observation can help people make decisions. Its needle provides a shared point of reference that people can check for themselves.', cachedAnswers: { en: answer } }] };
  let calls = 0;
  const route = load('../src/app/api/admin/people/[id]/pregenerate/route.ts', {
    '@/lib/processing-policy': { aiProcessingAllowed: () => true }, '@/lib/privacy': privacy,
    '@/lib/ai-safety': safety,
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/auth': { isAdmin: () => true },
    '@/lib/store': { getPerson: async () => person, storageWritable: () => ({ ok: true }) },
    '@/lib/ai': { chat: async () => { calls++; return '{"safe":true,"grounded":true,"private":true,"relevant":true,"respectful":true}'; } },
    '@/lib/prompts': {}, '@/lib/a2e': { a2eSpeechReadiness: () => ({ ready: false }) }, '@/lib/sentences': {}, '@/lib/preparation-response': preparationResponse,
    '@/lib/prepared-narration': { beginPreparation: () => () => {} },
  });
  const request = () => ({ json: async () => ({ sectionId: 'part', language: 'en' }) });
  for (const receipt of [undefined, { version: '2026-11-19', acceptedAt: 1 }]) {
    person.privacyConsent = receipt;
    assert.equal((await route.POST(request(), { params: { id: 'synthetic' } })).status, 428);
    assert.equal(calls, 0);
  }
  person.privacyConsent = { version: privacy.PRIVACY_VERSION, acceptedAt: Date.now() };
  const response = await route.POST(request(), { params: { id: 'synthetic' } });
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal((await response.json()).results[0].reason, 'text_already_cached');
});

test('admin record edits cannot forge or upgrade a participant consent receipt', async () => {
  const privacy = load('../src/lib/privacy.ts', {});
  const validate = load('../src/lib/validate.ts', { nanoid: { nanoid: () => 'synthetic-id' } });
  let written;
  const oldReceipt = { version: '2026-11-19', acceptedAt: 1 };
  const route = load('../src/app/api/admin/people/[id]/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/auth': { isAdmin: () => true }, '@/lib/validate': validate,
    '@/lib/readiness': {},
    '@/lib/store': {
      storageWritable: () => ({ ok: true }),
      updatePerson: async (id, patch) => { written = patch; return { id, privacyConsent: oldReceipt, ...patch }; },
    },
  });
  const response = await route.PUT({ json: async () => ({ script: 'A normal edited draft.', source: 'student', privacyConsent: { version: privacy.PRIVACY_VERSION, acceptedAt: Date.now() } }) }, { params: { id: 'synthetic' } });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(written, 'privacyConsent'), false); assert.equal(Object.hasOwn(written, 'source'), false);
  assert.deepEqual((await response.json()).person.privacyConsent, oldReceipt);
});
