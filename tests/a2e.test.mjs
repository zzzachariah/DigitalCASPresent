import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/a2e.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
let moduleId = 0;

async function client(overrides = {}) {
  const config = {
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
