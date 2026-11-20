import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, imports = {}) {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected import: ${name}`);
  } });
  return module.exports;
}
const readiness = load('../src/lib/readiness.ts');
const { adminMediaStatus, MEDIA_LOADING, MEDIA_UNAVAILABLE, photoStatusForPerson, preparationSteps, preparationSummary } = load('../src/lib/admin-media.ts', { './readiness': readiness });
const person = (extra = {}) => ({
  id: 'synthetic', name: 'Synthetic student', photoUrl: '/api/photo/synthetic', script: 'Synthetic source',
  sections: [{ id: 'one', title: 'Synthetic object', content: 'Synthetic source', cachedAnswers: { zh: '合成测试讲解' } }], ...extra,
});

const ready = { status: 'ready', ready: true, message: '已配置并获准' };
const disabled = { status: 'privacy_disabled', ready: false, message: '外部媒体处理尚未获隐私授权' };
const health = (overrides = {}) => ({
  a2e: disabled,
  a2ePhoto: { global: disabled, approvedPersonIds: ['anna'], people: { anna: ready } },
  ...overrides,
});

test('Anna photo approval enables only her cartoon/video while speech stays disabled', () => {
  const status = adminMediaStatus(health({ a2eKeySet: true }));
  const anna = photoStatusForPerson(status, 'anna');
  assert.equal(anna.ready, true);
  assert.equal(status.speech.ready, false);
  assert.deepEqual(Array.from(preparationSteps(person(), anna.ready)), ['cartoon', 'loop-video', 'pregenerate']);
  const other = photoStatusForPerson(status, 'another-student');
  assert.equal(other.ready, false);
  assert.deepEqual(Array.from(preparationSteps(person(), other.ready)), ['pregenerate']);
});

test('a ready person entry or legacy global approval cannot bypass the explicit photo list', () => {
  const status = adminMediaStatus(health({ a2e: ready, a2ePhoto: { global: ready, approvedPersonIds: [], people: { anna: ready } } }));
  assert.equal(status.speech.ready, true);
  assert.equal(photoStatusForPerson(status, 'anna').ready, false);
});

test('approved photo still requires a fully configured and ready photo service', () => {
  const missing = { status: 'key_missing', ready: false, message: 'A2E密钥尚未配置' };
  const status = adminMediaStatus(health({ a2ePhoto: { global: disabled, approvedPersonIds: ['anna'], people: { anna: missing } } }));
  assert.equal(photoStatusForPerson(status, 'anna').ready, false);
  assert.match(photoStatusForPerson(status, 'anna').message, /密钥/);
});

test('unknown, failed, stale or inconsistent health enables neither photos nor speech', () => {
  for (const status of [MEDIA_LOADING, MEDIA_UNAVAILABLE, ...[
    null, {}, { a2eKeySet: true }, { a2e: ready },
    health({ a2e: { status: 'ready', ready: 'true', message: 'ready' } }),
    health({ a2ePhoto: { global: ready, approvedPersonIds: 'anna', people: { anna: ready } } }),
  ].map(adminMediaStatus)]) {
    assert.equal(status.speech.ready, false);
    assert.equal(photoStatusForPerson(status, 'anna').ready, false);
    assert.deepEqual(Array.from(preparationSteps(person(), photoStatusForPerson(status, 'anna').ready)), ['pregenerate']);
  }
});

test('an approved photo prepares only absent media before text', () => {
  const status = photoStatusForPerson(adminMediaStatus(health()), 'anna');
  assert.deepEqual(Array.from(preparationSteps(person({ cartoonUrl: '/api/photo/synthetic.cartoon' }), status.ready)), ['loop-video', 'pregenerate']);
  assert.deepEqual(Array.from(preparationSteps(person({ photoUrl: undefined }), status.ready)), ['pregenerate']);
});

test('text success with missing media never claims all assets are ready', () => {
  const result = preparationSummary(person(), 0, true);
  assert.doesNotMatch(result, /素材已就绪|全部就绪|讲解与语音已就绪/);
  for (const label of ['卡通形象', '动态视频', '固定语音']) assert.ok(result.includes(label));
});

test('partial failures are not overwritten by readiness of existing assets', () => {
  const complete = person({ cartoonUrl: '/cartoon', loopVideoUrl: '/loop', sections: [{ id: 'one', title: 'Object', content: 'Synthetic source', cachedAnswers: { zh: '合成测试' }, cachedAudio: { zh: '/audio' } }] });
  assert.match(preparationSummary(complete, 2, false), /2 项讲解未完成/);
  assert.doesNotMatch(preparationSummary(complete, 2, false), /素材已就绪/);
  assert.match(preparationSummary(complete, 0, true), /本次未生成外部语音/);
  assert.match(preparationSummary(complete, 0, false), /素材已就绪/);
});
