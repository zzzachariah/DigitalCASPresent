import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(file, mocks = {}, env = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports,
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error(`Unexpected import ${name}`); },
    process: { env }, Date, Buffer, URL, Set,
    fetch() { throw new Error('Private source resolution must never use fetch'); },
  });
  return mod.exports;
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const version = `${'a'.repeat(64)}.jpg`;
const base = { id: 'synthetic-student', photoUrl: `/api/photo/synthetic-student?asset=${version}` };
function fixture(read) {
  const env = { EVENT_ENDS_AT: '2100-01-01T00:00:00Z' };
  const calls = [];
  const images = load('src/lib/image.ts');
  const retention = load('src/lib/event-retention.ts', {}, env);
  const source = load('src/lib/avatar-source.ts', {
    './image': images, './event-retention': retention,
    './store': { readPhoto: async (...args) => { calls.push(args); return read ? read(...args) : { buffer: jpeg, contentType: 'text/html' }; } },
  }, env);
  return { ...source, calls, env };
}

test('private source is read directly with its exact owner/version, and MIME comes from bytes', async () => {
  const f = fixture();
  const result = await f.readAvatarSource(base, 'photo');
  assert.deepEqual(f.calls, [[base.id, version]]);
  assert.equal(result.buffer, jpeg);
  assert.equal(result.contentType, 'image/jpeg');
});

test('loop source selects the same student cartoon, or their photo if no cartoon exists', async () => {
  const f = fixture(() => ({ buffer: png, contentType: 'image/jpeg' }));
  const cartoonVersion = `${'b'.repeat(64)}.png`;
  const result = await f.readAvatarSource({ ...base, cartoonUrl: `/api/photo/${base.id}.cartoon?asset=${cartoonVersion}` }, 'cartoon-or-photo');
  assert.deepEqual(f.calls[0], [`${base.id}.cartoon`, cartoonVersion]);
  assert.equal(result.contentType, 'image/png');
  await f.readAvatarSource(base, 'cartoon-or-photo');
  assert.deepEqual(f.calls[1], [base.id, version]);
  await f.readAvatarSource({ ...base, cartoonUrl: `/api/photo/${base.id}.cartoon?asset=${cartoonVersion}` }, 'photo');
  assert.deepEqual(f.calls[2], [base.id, version]);
});

test('filesystem media uses the internal reader without anonymously fetching its cache URL', async () => {
  const f = fixture();
  await f.readAvatarSource({ ...base, photoUrl: `/api/photo/${base.id}?v=1795200000000` }, 'photo');
  assert.deepEqual(f.calls, [[base.id, undefined]]);
});

test('foreign owners, remote URLs, credentials, traversal and malformed versions fail before storage access', async () => {
  const f = fixture();
  for (const photoUrl of [
    'https://example.invalid/photo.jpg', '//example.invalid/photo.jpg',
    '/api/photo/another-student', `/api/photo/${base.id}.cartoon`,
    `/api/photo/${base.id}/../another-student`, `/api/photo/${base.id}%2f..%2fanother-student`,
    `/api/photo/${base.id}?asset=../private.json`, `/api/photo/${base.id}?asset=`,
    `/api/photo/${base.id}?asset=${version}&asset=${version}`,
    `/api/photo/${base.id}?preview=private-token`, `/api/photo/${base.id}?token=private-token`,
    `/api/photo/${base.id}?v=123#private-token`, `/api/photo/${base.id}?v=not-a-version`,
  ]) await assert.rejects(f.readAvatarSource({ ...base, photoUrl }, 'photo'), /Invalid photo source/);
  await assert.rejects(f.readAvatarSource({ id: '../invalid', photoUrl: '/api/photo/../invalid' }, 'photo'), /Invalid photo source/);
  assert.equal(f.calls.length, 0);
});

test('an invalid existing cartoon does not silently upload the raw photo instead', async () => {
  const f = fixture();
  await assert.rejects(f.readAvatarSource({ ...base, cartoonUrl: '/api/photo/another-student.cartoon' }, 'cartoon-or-photo'), /Invalid photo source/);
  assert.equal(f.calls.length, 0);
});

test('missing, oversized or unsupported private images cannot become provider upload sources', async () => {
  for (const image of [null, { buffer: Buffer.alloc(4 * 1024 * 1024 + 1), contentType: 'image/jpeg' }, { buffer: Buffer.from('<svg/>'), contentType: 'image/png' }]) {
    const f = fixture(() => image);
    await assert.rejects(f.readAvatarSource(base, 'photo'), /Photo unavailable|Photo too large|Only JPG/);
  }
});

test('expiry blocks reads and prevents a completed in-flight image read from being released', async () => {
  const f = fixture(); f.env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z';
  await assert.rejects(f.readAvatarSource(base, 'photo'), /Event data is closed/);
  assert.equal(f.calls.length, 0);
  const crossing = fixture(() => {
    crossing.env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z';
    return { buffer: jpeg, contentType: 'image/jpeg' };
  });
  await assert.rejects(crossing.readAvatarSource(base, 'photo'), /Event data is closed/);
  assert.equal(crossing.calls.length, 1);
});
