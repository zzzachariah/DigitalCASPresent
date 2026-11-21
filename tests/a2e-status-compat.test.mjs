import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/a2e.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function client(reply) {
  const calls = []; const module = { exports: {} };
  const imports = {
    'node:crypto': crypto, './event-retention': { assertEventOpen() {} },
    './processing-policy': { externalProcessingAllowed: () => false, requireExternalProcessing() { throw new Error('Unscoped processing disabled'); } },
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: (name) => { if (Object.hasOwn(imports, name)) return imports[name]; throw new Error(`Unexpected import ${name}`); },
    process: { env: { AVATAR_PROVIDER: 'a2e', A2E_API_KEY: 'SECRET-SYNTHETIC-KEY', A2E_PROCESSING_APPROVED: 'true' } },
    Buffer, URL, AbortSignal, Response,
    fetch: async (url, options) => { calls.push({ url, options }); return typeof reply === 'function' ? reply(url, options) : Response.json(reply); },
  });
  return { api: module.exports, calls };
}
const personId = 'synthetic-person';
const image = 'https://example.test/generated.png';
const video = 'https://example.test/generated.mp4?token=synthetic';
const call = (api, method) => api[method](method.endsWith('Start') ? 'https://example.test/uploaded.png' : 'synthetic-task', personId);
const methods = ['a2eCartoonStart', 'a2eCartoonPoll', 'a2eLoopVideoStart', 'a2eLoopVideoPoll'];
const phases = ['cartoon_start', 'cartoon_poll', 'loop_start', 'loop_poll'];

test('every photo start and poll rejects HTTP errors and nonzero business codes even when a task/output is present', async () => {
  for (const [status, code] of [[200, 10000], [503, 0], [401, 0], [200, '0'], [200, undefined]]) {
    for (let i = 0; i < methods.length; i++) {
      const { api, calls } = client(() => Response.json({ code, msg: 'PRIVATE-PROVIDER-BODY', data: { _id: 'synthetic-task', current_status: 'completed', image_urls: [image], result_url: video } }, { status }));
      const result = await call(api, methods[i]);
      assert.equal(typeof result.error, 'string');
      assert.deepEqual(JSON.parse(result.error), { phase: phases[i], httpStatus: status, ...(Number(code) > 0 ? { code } : {}) });
      assert.equal(calls.length, 1, 'no automatic paid retry');
      assert.doesNotMatch(result.error, /PRIVATE|SECRET|https/);
    }
  }
});

test('invalid JSON, arrays and arbitrary upstream code/message values cannot become successes or leak', async () => {
  for (const reply of [() => new Response('<html>PRIVATE-RAW-BODY</html>'), () => Response.json([{ code: 0 }]), () => Response.json({ code: 'SECRET-ARBITRARY-CODE', message: 'PRIVATE-MESSAGE' })]) {
    for (const method of methods) {
      const { api } = client(reply);
      const result = await call(api, method);
      assert.ok(result.error);
      assert.doesNotMatch(result.error, /PRIVATE|SECRET|html/);
      assert.deepEqual(Object.keys(JSON.parse(result.error)).sort(), ['httpStatus', 'phase']);
    }
  }
});

test('failed and blocked states beat output URLs, including legacy failure fields without a status', async () => {
  for (const failure of [{ current_status: 'failed' }, { current_status: 'blocked' }, { current_status: 'block' }, { failed_code: 10000 }, { failed_message: 'PRIVATE-DETAIL' }]) {
    for (const method of methods) {
      const { api } = client({ code: 0, data: { _id: 'synthetic-task', current_status: 'completed', image_urls: [image], result_url: video, ...failure } });
      const result = await call(api, method);
      assert.ok(result.error);
      assert.doesNotMatch(result.error, /PRIVATE|https/);
    }
  }
});

test('failed tasks expose their safe numeric failed_code instead of envelope zero, never arbitrary values', async () => {
  for (const failed_code of [10000, '1005', 0, '0', undefined, 'PRIVATE-SECRET-CODE', '123456789', { code: 'PRIVATE' }]) {
    for (const method of ['a2eCartoonPoll', 'a2eLoopVideoPoll']) {
      const { api } = client({ code: 0, data: { current_status: 'failed', failed_code, failed_message: 'PRIVATE-RESPONSE-BODY' } });
      const result = await call(api, method);
      const diagnostic = JSON.parse(result.error);
      assert.equal(diagnostic.code, failed_code === 10000 || failed_code === '1005' ? failed_code : undefined);
      assert.equal(diagnostic.httpStatus, 200);
      assert.doesNotMatch(result.error, /PRIVATE|SECRET|123456789/);
    }
  }
});

test('known processing states remain pending even when output URLs arrive before completion', async () => {
  for (const [method, states] of [['a2eCartoonPoll', ['initialized', 'processing', 'seedream_fallback']], ['a2eLoopVideoPoll', ['initialized', 'sent', 'pending', 'processing']]]) {
    for (const current_status of states) {
      const { api } = client({ code: 0, data: { current_status, image_urls: [image], result_url: video } });
      const result = await call(api, method);
      assert.equal(result.pending, true); assert.equal(result.done, undefined);
    }
  }
});

test('cartoon result fields work for completed and old status-less records without accepting the input portrait', async () => {
  for (const result of [{ image_urls: [image] }, { result_image_url: image }, { result_image_urls: [image] }]) {
    for (const current_status of ['completed', undefined]) {
      const { api } = client({ code: 0, data: { current_status, ...result } });
      assert.deepEqual(JSON.parse(JSON.stringify(await call(api, 'a2eCartoonPoll'))), { done: true, url: image });
    }
  }
  for (const data of [{ image_url: image }, { input_images: [image] }, { image_urls: image }, { result_image_url: 'javascript:SECRET' }, { result_image_url: 'https://user:SECRET@example.test/image.png' }]) {
    const { api } = client({ code: 0, data: { current_status: 'completed', ...data } });
    const result = await call(api, 'a2eCartoonPoll');
    assert.ok(result.error); assert.doesNotMatch(result.error, /SECRET/);
  }
});

test('video result aliases work for completed and old records, never input/cover image fields', async () => {
  const fields = ['result_url', 'video_url', 'result_video_url', 'hd_video_url', 'output_url', 'output_video_url', 'render_url'];
  for (const result of [...fields.map((field) => ({ [field]: video })), { result: { video_url: video } }, { result: { url: video } }, { video_urls: [video] }, { result_urls: [video] }]) {
    for (const current_status of ['completed', undefined]) {
      const { api } = client({ code: 0, data: { current_status, ...result } });
      assert.deepEqual(JSON.parse(JSON.stringify(await call(api, 'a2eLoopVideoPoll'))), { done: true, url: video });
    }
  }
  for (const data of [{ image_url: image }, { cover_url: image }, { result_url: image }, { result_url: '/private/video.mp4' }]) {
    const { api } = client({ code: 0, data: { current_status: 'completed', ...data } });
    assert.ok((await call(api, 'a2eLoopVideoPoll')).error);
  }
});

test('unknown or completed-without-output states fail safely rather than remaining pending forever', async () => {
  for (const method of ['a2eCartoonPoll', 'a2eLoopVideoPoll']) {
    for (const current_status of ['PRIVATE-UNKNOWN-STATE', 'completed', undefined]) {
      const { api } = client({ code: 0, data: { current_status } });
      const result = await call(api, method);
      assert.ok(result.error); assert.doesNotMatch(result.error, /PRIVATE/);
    }
  }
});

test('loop submission pins the documented five-second silent original model and submits only once', async () => {
  const { api, calls } = client({ code: 0, data: { _id: 'synthetic-task', current_status: 'initialized' } });
  assert.equal((await call(api, 'a2eLoopVideoStart')).taskId, 'synthetic-task');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.video_time, 5); assert.equal(body.model_version, 'a2e');
  assert.equal(body.auto_add_audio, false); assert.equal(body.number_of_images, 1);
  for (const unsupported of ['duration', 'resolution', 'aspect_ratio']) assert.equal(Object.hasOwn(body, unsupported), false);
});

test('cartoon submission retains the documented model and safe task identifier requirement', async () => {
  const { api, calls } = client({ code: 0, data: { _id: 'synthetic-task' } });
  assert.equal((await call(api, 'a2eCartoonStart')).taskId, 'synthetic-task');
  assert.equal(JSON.parse(calls[0].options.body).model, 'nano-banana-pro');
  for (const id of ['../PRIVATE', { unsafe: 'PRIVATE' }, '']) {
    const invalid = client({ code: 0, data: { _id: id } });
    assert.ok((await call(invalid.api, 'a2eCartoonStart')).error);
  }
});

test('TTS 10000 remains a business failure with a safe extractable code and no retry or payload leak', async () => {
  const { api, calls } = client({ code: 10000, msg: 'PRIVATE-STUDENT-SOURCE', data: 'https://SECRET.example/audio.wav' });
  await assert.rejects(api.a2eTts('Synthetic reviewed explanation.', undefined, undefined, personId, 'en'), (error) => {
    assert.deepEqual(JSON.parse(error.message), { phase: 'tts', httpStatus: 200, code: 10000 });
    assert.equal(error.message.match(/"code"\s*:\s*"?(\d+)/)?.[1], '10000');
    assert.doesNotMatch(error.message, /PRIVATE|SECRET|explanation/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('network exceptions never expose secret URLs or provider text from any task phase', async () => {
  for (const method of methods) {
    const { api, calls } = client(() => { throw new Error('PRIVATE failure https://SECRET.example'); });
    if (method.endsWith('Poll')) await assert.rejects(call(api, method), (error) => { assert.deepEqual(Object.keys(JSON.parse(error.message)), ['phase']); return true; });
    else assert.deepEqual(Object.keys(JSON.parse((await call(api, method)).error)), ['phase']);
    assert.equal(calls.length, 1);
  }
});
