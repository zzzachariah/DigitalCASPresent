import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/a2e.ts', import.meta.url), 'utf8');
const policy = await readFile(new URL('../src/lib/processing-policy.ts', import.meta.url), 'utf8');
const retention = await readFile(new URL('../src/lib/event-retention.ts', import.meta.url), 'utf8');
const bundledSource = source.replace('import { assertEventOpen } from "./event-retention";', '').replace(/import \{ externalProcessingAllowed, requireExternalProcessing \} from \".\/processing-policy\";/, '') + '\n' + policy + '\n' + retention;
const compiled = ts.transpileModule(bundledSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
let moduleId = 0;

async function client(overrides = {}) {
  const config = {
    EXTERNAL_AI_PROCESSING_APPROVED: 'true',
    A2E_BASE_URL: 'https://tts.example', A2E_API_KEY: 'test-only-fake-key',
    A2E_TTS_ID_MALE: 'test-male', A2E_TTS_ID_FEMALE: 'test-female', A2E_TTS_ID: 'test-neutral',
    ...overrides,
  };
  const before = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  const ai = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// case ${moduleId++}`).toString('base64')}`);
  return {
    ai,
    restore() {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

for (const [label, text, country, region] of [
  ['Chinese', '这张照片只记录了一个瞬间。', 'zh', 'CN'],
  ['mixed Chinese and English names', 'Zach 的 CAS 项目说明 evidence 会被选择。', 'zh', 'CN'],
  ['short Chinese chunk', '是的。', 'zh', 'CN'],
  ['English', 'A photograph selects one moment.', 'en', 'US'],
  ['non-BMP Han character', '𠮷是用于合成测试的文字。', 'zh', 'CN'],
]) {
  test(`TTS sends explicit ${label} locale and preserves the text`, async t => {
    const { ai, restore } = await client();
    t.after(restore);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls++;
      assert.equal(url, 'https://tts.example/api/v1/video/send_tts');
      assert.equal(init.headers.Authorization, 'Bearer test-only-fake-key');
      assert.deepEqual(JSON.parse(init.body), { msg: text, tts_id: 'test-male', country, region });
      return Response.json({ code: 0, data: 'https://audio.example/result.mp3' });
    });
    assert.equal(await ai.a2eTts(text, 'male'), 'https://audio.example/result.mp3');
    assert.equal(calls, 1);
  });
}

test('Bilingual chunks select their own locale while retaining the female voice', async t => {
  const { ai, restore } = await client();
  t.after(restore);
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ code: 0, data: 'https://audio.example/result.mp3' });
  });
  await ai.a2eTts('证据需要结合背景理解。', 'female');
  await ai.a2eTts('Evidence needs context.', 'female');
  assert.deepEqual(bodies.map(({ country, region, tts_id }) => ({ country, region, tts_id })), [
    { country: 'zh', region: 'CN', tts_id: 'test-female' },
    { country: 'en', region: 'US', tts_id: 'test-female' },
  ]);
});

test('TTS preserves cancellation and configured neutral voice', async t => {
  const { ai, restore } = await client();
  t.after(restore);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    assert.equal(JSON.parse(init.body).tts_id, 'test-neutral');
    return Response.json({ code: 0, data: { audio_url: 'https://audio.example/result.mp3' } });
  });
  assert.equal(await ai.a2eTts('测试。', undefined, controller.signal), 'https://audio.example/result.mp3');
});

test('A2E language selection errors remain failures and do not trigger paid retries', async t => {
  const { ai, restore } = await client();
  t.after(restore);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ code: 1005, msg: 'Language Selection Error' }, { status: 400 });
  });
  await assert.rejects(ai.a2eTts('合成测试。'), /send_tts failed \(400\).*1005/);
  assert.equal(calls, 1);
});

test('Pure punctuation, whitespace and emoji never create TTS requests', async t => {
  const { ai, restore } = await client();
  t.after(restore);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected paid TTS request'));
  for (const text of ['**', '  \n ', '。！？”', '🎉']) {
    await assert.rejects(ai.a2eTts(text), /requires speakable text/);
  }
});


test('Text AI approval cannot enable A2E narration or uploaded images', async t => {
  const { ai, restore } = await client({ AI_PROCESSING_APPROVED: 'true', EXTERNAL_AI_PROCESSING_APPROVED: 'false' });
  t.after(restore);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  await assert.rejects(ai.a2eTts('Confidential fixture'), /disabled pending/);
  await assert.rejects(ai.a2eUploadImage('https://example.test/private-photo'), /disabled pending/);
});


test('approved photo bytes use only presign and upload, never a private application URL or TTS', async t => {
  const { ai, restore } = await client({ EXTERNAL_AI_PROCESSING_APPROVED: 'false', AVATAR_PROVIDER: 'a2e', A2E_PHOTO_APPROVED_PERSON_IDS: 'anna-fixture', EVENT_ENDS_AT: '2999-01-01T00:00:00Z' });
  t.after(restore); const calls = []; const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/upload-presigned-url')) {
      const body = JSON.parse(init.body);
      assert.equal(body.contentType, 'image/png'); assert.equal(body.fileSize, bytes.length);
      assert.match(body.key, /^dcp\/[a-f0-9]{64}\.png$/);
      return Response.json({ code: 0, data: { uploadUrl: 'https://upload.example/signed', cdnUrl: 'https://cdn.example/photo.png' } });
    }
    assert.equal(url, 'https://upload.example/signed'); assert.equal(init.method, 'PUT');
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error');
    assert.ok(Buffer.from(init.body).equals(bytes));
    return new Response(null, { status: 200 });
  });
  assert.equal(await ai.a2eUploadImageBytes(bytes, 'image/png', 'anna-fixture'), 'https://cdn.example/photo.png');
  assert.equal(calls.length, 2);
  await assert.rejects(ai.a2eUploadImageBytes(bytes, 'image/png', 'other-student'), /approval/);
  await assert.rejects(ai.a2eTts('Synthetic narration'), /disabled pending/);
  assert.equal(calls.length, 2);
});

test('photo authorization and event expiry are rechecked after presign before uploading bytes', async t => {
  const { ai, restore } = await client({ EXTERNAL_AI_PROCESSING_APPROVED: 'false', AVATAR_PROVIDER: 'a2e', A2E_PHOTO_APPROVED_PERSON_IDS: 'anna-fixture', EVENT_ENDS_AT: '2999-01-01T00:00:00Z' });
  t.after(restore); let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++; assert.ok(url.endsWith('/upload-presigned-url'));
    process.env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z';
    return Response.json({ code: 0, data: { uploadUrl: 'https://upload.example/signed', cdnUrl: 'https://cdn.example/photo.png' } });
  });
  await assert.rejects(ai.a2eUploadImageBytes(Buffer.from('synthetic bytes'), 'image/png', 'anna-fixture'), /closed/);
  assert.equal(calls, 1);
  await assert.rejects(ai.a2eCartoonPoll('task-fixture', 'anna-fixture'), /closed/);
  assert.equal(calls, 1);
});

test('person-scoped narration sends only TTS and cannot unlock photo, another person or global processing', async t => {
  const { ai, restore } = await client({ EXTERNAL_AI_PROCESSING_APPROVED: 'false', AVATAR_PROVIDER: 'a2e', A2E_SPEECH_APPROVED_PERSON_IDS: 'anna-fixture,anna-fixture,*,../bad', A2E_PHOTO_APPROVED_PERSON_IDS: '', EVENT_ENDS_AT: '2999-01-01T00:00:00Z' });
  t.after(restore); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++; assert.equal(url, 'https://tts.example/api/v1/video/send_tts');
    assert.equal(JSON.parse(init.body).msg, 'Reviewed synthetic narration.');
    return Response.json({ code: 0, data: 'https://audio.example/result.mp3' });
  });
  assert.deepEqual(ai.a2eSpeechApprovedPersonIds(), ['anna-fixture']);
  assert.equal(ai.a2eSpeechReadiness().ready, false);
  assert.equal(ai.a2eSpeechReadiness('anna-fixture').ready, true);
  assert.equal(ai.a2ePhotoReadiness('anna-fixture').ready, false);
  assert.equal(await ai.a2eTts('Reviewed synthetic narration.', 'female', undefined, 'anna-fixture'), 'https://audio.example/result.mp3');
  await assert.rejects(ai.a2eTts('Reviewed synthetic narration.', 'female', undefined, 'other-student'), /separate approval/);
  await assert.rejects(ai.a2eTts('Reviewed synthetic narration.'), /disabled pending/);
  for (const [path, method] of [['/api/v1/userNanoBanana/start', 'POST'], ['/api/v1/video/send_tts', 'GET'], ['/api/v1/video/send_tts/extra', 'POST']]) {
    await assert.rejects(ai.a2e(path, method, {}, undefined, { speechPersonId: 'anna-fixture' }), /outside speech-only/);
  }
  await assert.rejects(ai.a2eUploadImageBytes(Buffer.from('synthetic'), 'image/png', 'anna-fixture'), /separate approval/);
  assert.equal(calls, 1);
  process.env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z';
  await assert.rejects(ai.a2eTts('Reviewed synthetic narration.', 'female', undefined, 'anna-fixture'), /closed/);
  assert.equal(calls, 1);
});
