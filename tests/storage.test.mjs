import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const person = { id: 'test-person', slug: 'original-link', name: 'Synthetic student', script: 'Original script', sections: [{ id: 'part1', title: 'Object', content: 'Original script' }], language: 'auto', createdAt: 1, updatedAt: 1 };
const baseEnv = { BLOB_READ_WRITE_TOKEN: 'public-token', BLOB_RECORDS_READ_WRITE_TOKEN: 'private-token' };

function loadTs(file, mocks, env, cwd = repo) {
  const source = fs.readFileSync(path.join(repo, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    process: { env, cwd: () => cwd }, Response, Buffer, AbortSignal, URL,
    Date, Math, Map, Set, Promise, setTimeout, clearTimeout,
    fetch: mocks.fetch,
    console: { error() {}, log() {} },
  }, { filename: file });
  return mod.exports;
}

function setup(extraEnv = {}) {
  const env = { ...baseEnv, ...extraEnv };
  let serial = 0;
  let requestOidcToken;
  const shared = loadTs('src/lib/store-shared.ts', {
    nanoid: { nanoid: () => `new-id-${++serial}`, customAlphabet: () => () => `abc${++serial}xyz` },
    '@vercel/oidc': { getVercelOidcTokenSync() {
      const token = requestOidcToken ?? env.VERCEL_OIDC_TOKEN;
      if (!token) throw new Error('No current OIDC token');
      return token;
    } },
  }, env);
  const stores = { media: new Map(), records: new Map() };
  const calls = [];
  const failures = new Map();
  let onPut = null;
  class BlobNotFoundError extends Error {}
  function storeFor(options) {
    if (options.token === 'public-token' || options.storeId === 'store_public') return 'media';
    if (options.token === 'private-token' || options.storeId === 'store_private') return 'records';
    throw new Error('Wrong or implicit store credentials');
  }
  function entry(store, pathname) { return { pathname, url: `https://${store}.invalid/${pathname}` }; }
  const api = {
    BlobNotFoundError,
    async list(options) {
      const store = storeFor(options); calls.push({ op: 'list', store, path: options.prefix });
      return { blobs: [...stores[store].keys()].filter((p) => p.startsWith(options.prefix)).map((p) => entry(store, p)), hasMore: false };
    },
    async head(pathname, options) {
      const store = storeFor(options); calls.push({ op: 'head', store, path: pathname });
      if (!stores[store].has(pathname)) throw new BlobNotFoundError();
      return entry(store, pathname);
    },
    async get(pathname, options) {
      const store = storeFor(options); calls.push({ op: 'get', store, path: pathname });
      assert.equal(options.access, 'private'); assert.equal(store, 'records');
      assert.equal(options.useCache, false);
      if (failures.get(pathname) === 'private-read') throw new Error('Temporary private read failure');
      const misses = failures.get(pathname);
      if (typeof misses === 'number' && misses > 0) { failures.set(pathname, misses - 1); return null; }
      if (failures.get(pathname) === 'mismatched-read') return { statusCode: 200, stream: new Response('different-bytes').body };
      const text = stores[store].get(pathname);
      if (text === undefined) return null;
      return { statusCode: 200, stream: new Response(text).body };
    },
    async put(pathname, value, options) {
      const store = storeFor(options);
      calls.push({ op: 'put', store, path: pathname, access: options.access });
      assert.equal(options.access, store === 'records' ? 'private' : 'public');
      if (failures.get('put') === store) throw new Error('Simulated write failure');
      if (onPut) await onPut(pathname, options);
      const finalPath = options.addRandomSuffix ? pathname.replace(/(\.[^.]+)$/, `-random${++serial}$1`) : pathname;
      if (stores[store].has(finalPath) && !options.allowOverwrite) throw new Error('Already exists');
      stores[store].set(finalPath, typeof value === 'string' ? value : Buffer.from(value));
      return entry(store, finalPath);
    },
    async del(pathname, options) {
      const store = storeFor(options); calls.push({ op: 'del', store, path: pathname });
      if (failures.get('del') === store) throw new Error('Simulated delete failure');
      stores[store].delete(pathname);
    },
  };
  async function publicFetch(url) {
    const parsed = new URL(url); const pathname = parsed.pathname.slice(1);
    calls.push({ op: 'fetch', store: 'media', path: pathname });
    const failStatus = failures.get(pathname);
    if (typeof failStatus === 'number') return new Response('temporary error', { status: failStatus });
    const raw = stores.media.get(pathname);
    return new Response(raw ?? 'not found', { status: raw === undefined ? 404 : 200 });
  }
  const retention = loadTs('src/lib/event-retention.ts', {}, env);
  const driver = loadTs('src/lib/store-blob.ts', { '@vercel/blob': api, './store-shared': shared, './event-retention': retention, fetch: publicFetch }, env);
  function seedLegacy(p = person) {
    stores.media.set(`people/${p.id}.json`, JSON.stringify(p));
    stores.media.set(`slugs/${p.slug}.txt`, p.id);
  }
  function seedPrivate(p = person, version = '01700000000000-current.json') {
    stores.records.set(`people/${p.id}/${version}`, JSON.stringify(p));
    stores.records.set(`slugs/${p.slug}`, p.id);
  }
  return { env, shared, stores, calls, failures, driver, seedLegacy, seedPrivate, setOnPut(fn) { onPut = fn; }, setOidcToken(token) { requestOidcToken = token; } };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const writes = (s) => s.calls.filter((c) => c.op === 'put' || c.op === 'del');

test('credentials are explicitly separated; arbitrary tokens cannot select a store', () => {
  const s = setup({ RANDOM_READ_WRITE_TOKEN: 'vercel_blob_private_accident', VERCEL_OIDC_TOKEN: 'oidc', BLOB_STORE_ID: 'store_wrong' });
  assert.deepEqual(plain(s.shared.mediaBlobAuth()), { token: 'public-token' });
  assert.deepEqual(plain(s.shared.recordsBlobAuth()), { token: 'private-token' });
  delete s.env.BLOB_READ_WRITE_TOKEN; delete s.env.BLOB_STORE_ID;
  assert.equal(s.shared.mediaBlobConfigured(), false);
  assert.throws(() => s.shared.mediaBlobAuth(), /not configured/);
  delete s.env.BLOB_RECORDS_READ_WRITE_TOKEN;
  assert.throws(() => s.shared.recordsBlobAuth(), /Private records/);
});

test('OIDC credentials always carry the intended store id and cannot fall back to public', () => {
  const s = setup({ BLOB_READ_WRITE_TOKEN: '', BLOB_RECORDS_READ_WRITE_TOKEN: '', BLOB_MEDIA_STORE_ID: 'store_public', BLOB_RECORDS_STORE_ID: 'store_private', VERCEL_OIDC_TOKEN: 'oidc', BLOB_STORE_ID: 'wrong-default' });
  assert.deepEqual(plain(s.shared.mediaBlobAuth()), { storeId: 'store_public', oidcToken: 'oidc' });
  assert.deepEqual(plain(s.shared.recordsBlobAuth()), { storeId: 'store_private', oidcToken: 'oidc' });
  delete s.env.BLOB_RECORDS_STORE_ID;
  assert.equal(s.shared.recordsBlobConfigured(), false);
  assert.throws(() => s.shared.recordsBlobAuth(), /Private records/);
});

test('OIDC is resolved from each request context and refreshed without an env token', () => {
  const s = setup({ BLOB_READ_WRITE_TOKEN: '', BLOB_RECORDS_READ_WRITE_TOKEN: '', BLOB_MEDIA_STORE_ID: 'store_public', BLOB_RECORDS_STORE_ID: 'store_private' });
  assert.equal(s.shared.hasBlobOidcToken(), false);
  assert.equal(s.shared.recordsBlobConfigured(), false);
  s.setOidcToken('request-token-1');
  assert.equal(s.shared.mediaBlobConfigured(), true);
  assert.equal(s.shared.recordsBlobConfigured(), true);
  assert.deepEqual(plain(s.shared.recordsBlobAuth()), { storeId: 'store_private', oidcToken: 'request-token-1' });
  s.env.VERCEL_OIDC_TOKEN = 'stale-env-token';
  s.setOidcToken('request-token-2');
  assert.deepEqual(plain(s.shared.recordsBlobAuth()), { storeId: 'store_private', oidcToken: 'request-token-2' });
  assert.deepEqual(plain(s.shared.mediaBlobAuth()), { storeId: 'store_public', oidcToken: 'request-token-2' });
  delete s.env.VERCEL_OIDC_TOKEN;
  s.setOidcToken(undefined);
  s.env.BLOB_READ_WRITE_TOKEN = 'public-token';
  assert.equal(s.shared.recordsBlobConfigured(), false);
  assert.throws(() => s.shared.recordsBlobAuth(), /Private records/);
});

test('legacy list and original QR slug work without writing or deleting anything', async () => {
  const s = setup(); s.seedLegacy();
  assert.deepEqual(plain(await s.driver.listPeople()), [person]);
  assert.deepEqual(plain(await s.driver.getPerson(person.slug)), person);
  assert.deepEqual(plain(await s.driver.getPerson(person.id)), person);
  assert.deepEqual(writes(s), []);
});

test('legacy HTTP 503 is an error and never triggers migration or deletion', async () => {
  const s = setup(); s.seedLegacy(); s.failures.set(`people/${person.id}.json`, 503);
  await assert.rejects(s.driver.listPeople(), /HTTP 503/);
  assert.equal(s.stores.media.size, 2); assert.deepEqual(writes(s), []);
});

test('public-only setup reads legacy data but refuses every private write', async () => {
  const s = setup({ BLOB_RECORDS_READ_WRITE_TOKEN: '' }); s.seedLegacy();
  assert.equal((await s.driver.listPeople()).length, 1);
  await assert.rejects(s.driver.createPerson(person), /Private records/);
  await assert.rejects(s.driver.savePhoto(person.id, Buffer.from('photo'), 'png'), /Private records/);
  assert.deepEqual(writes(s), []);
});

test('newest private record wins; stale public records are not fetched', async () => {
  const s = setup(); s.seedLegacy(); s.seedPrivate(person, '01600000000000-old.json');
  const updated = { ...person, script: 'Reviewed new script', updatedAt: 2 };
  s.seedPrivate(updated); s.failures.set(`people/${person.id}.json`, 503);
  assert.deepEqual(plain(await s.driver.listPeople()), [updated]);
  assert.deepEqual(plain(await s.driver.getPerson(person.slug)), updated);
  assert.equal(s.calls.some((c) => c.op === 'fetch'), false);
});

test('private read failure cannot silently fall back to an outdated public record', async () => {
  const s = setup(); s.seedLegacy(); s.seedPrivate();
  s.failures.set(`people/${person.id}/01700000000000-current.json`, 'private-read');
  await assert.rejects(s.driver.getPerson(person.id), /private read failure/);
  assert.equal(s.calls.some((c) => c.op === 'fetch'), false);
});

test('explicit migration defaults can dry-run, then copy and verify without deleting sources', async () => {
  const s = setup(); s.seedLegacy(); const source = new Map(s.stores.media);
  const dry = await s.driver.migrateLegacyRecords({ dryRun: true, ids: [person.id] });
  assert.equal(dry.results[0].status, 'would-copy'); assert.deepEqual(writes(s), []);
  const result = await s.driver.migrateLegacyRecords({ dryRun: false, ids: [person.id] });
  assert.equal(result.copied, 1); assert.equal(result.failed, 0);
  assert.deepEqual(s.stores.media, source);
  assert.deepEqual(plain(await s.driver.getPerson(person.slug)), person);
  assert.ok(s.calls.some((c) => c.op === 'get' && c.path.endsWith('-legacy.json')));
  const putCount = writes(s).length;
  const again = await s.driver.migrateLegacyRecords({ dryRun: false, ids: [person.id] });
  assert.equal(again.results[0].status, 'private-exists'); assert.equal(writes(s).length, putCount);
});

test('failed migration retains source and reports failure rather than success', async () => {
  const s = setup(); s.seedLegacy(); s.failures.set('put', 'records');
  const result = await s.driver.migrateLegacyRecords({ dryRun: false, ids: [person.id] });
  assert.equal(result.copied, 0); assert.equal(result.failed, 1);
  assert.equal(s.stores.media.size, 2); assert.equal(s.calls.some((c) => c.op === 'del'), false);
});

test('migration cannot outrank a private edit created while copy is in flight', async () => {
  const s = setup(); s.seedLegacy();
  const edited = { ...person, script: 'Concurrent reviewed edit' };
  s.setOnPut((pathname) => {
    if (pathname.endsWith('-legacy.json')) s.seedPrivate(edited);
  });
  await s.driver.migrateLegacyRecords({ dryRun: false, ids: [person.id] });
  assert.deepEqual(plain(await s.driver.getPerson(person.id)), edited);
});

test('tombstone prevents deleted legacy students reappearing via list, QR, id or migration', async () => {
  const s = setup(); s.seedLegacy();
  assert.equal(await s.driver.deletePerson(person.id), true);
  assert.equal(await s.driver.getPerson(person.id), null);
  assert.equal(await s.driver.getPerson(person.slug), null);
  assert.deepEqual(plain(await s.driver.listPeople()), []);
  const again = await s.driver.migrateLegacyRecords({ dryRun: false, ids: [person.id] });
  assert.equal(again.results[0].status, 'deleted');
  assert.equal(s.stores.media.size, 2); assert.equal(s.calls.some((c) => c.op === 'del'), false);
});

test('new records and all photo uploads stay private behind immutable proxies', async () => {
  const s = setup();
  const created = await s.driver.createPerson({ name: 'New student', script: 'New text', sections: [], language: 'auto' });
  assert.equal(s.stores.media.size, 0);
  assert.ok(writes(s).every((c) => c.store === 'records' && c.access === 'private'));
  const url = await s.driver.savePhoto(created.id, Buffer.from('photo'), 'png');
  assert.match(url, /^\/api\/photo\/new-id-\d+\?asset=[a-f0-9]{64}\.png$/);
  assert.equal((await s.driver.getPerson(created.slug)).photoUrl, url);
  assert.ok(writes(s).every((c) => c.store === 'records' && c.access === 'private'));
  const version = new URL(url, 'https://local.invalid').searchParams.get('asset');
  assert.ok((await s.driver.readPhoto(created.id, version)).buffer.equals(Buffer.from('photo')));
  await s.driver.updatePerson(created.id, { name: 'Changed name', slug: 'must-not-change' });
  assert.equal((await s.driver.getPerson(created.id)).slug, created.slug);
});

test('write verification retries only missing reads without repeating writes', async () => {
  const s = setup();
  s.setOnPut((pathname) => { s.failures.set(pathname, 2); });
  const created = await s.driver.createPerson({ name: 'New student', script: 'New text', sections: [], language: 'auto' });
  const putCalls = writes(s);
  assert.equal(putCalls.length, 2);
  for (const putCall of putCalls) {
    const afterPut = s.calls.slice(s.calls.indexOf(putCall) + 1);
    assert.equal(afterPut.filter((c) => c.op === 'get' && c.path === putCall.path).length, 3);
  }
  assert.equal((await s.driver.getPerson(created.id)).name, 'New student');
});

test('missing write verification is bounded and never falsely reports a saved record', async () => {
  const s = setup();
  s.setOnPut((pathname) => { s.failures.set(pathname, 99); });
  await assert.rejects(s.driver.createPerson({ name: 'Missing read', script: 'text', sections: [], language: 'auto' }), /Slug verification failed/);
  assert.equal(writes(s).length, 1);
  const putCall = writes(s)[0];
  assert.equal(s.calls.slice(s.calls.indexOf(putCall) + 1).filter((c) => c.op === 'get').length, 3);
  assert.equal([...s.stores.records.keys()].some((key) => key.startsWith('people/')), false);
});

test('write verification never retries different bytes or read errors', async () => {
  for (const failure of ['mismatched-read', 'private-read']) {
    const s = setup();
    s.setOnPut((pathname) => { s.failures.set(pathname, failure); });
    await assert.rejects(s.driver.createPerson({ name: 'Failed read', script: 'text', sections: [], language: 'auto' }), /verification failed|private read failure/);
    const putCall = writes(s)[0];
    assert.equal(writes(s).length, 1);
    assert.equal(s.calls.slice(s.calls.indexOf(putCall) + 1).filter((c) => c.op === 'get').length, 1);
  }
});

test('filesystem reads keep legacy source in place and deletion masks it', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-storage-test-'));
  try {
    fs.mkdirSync(path.join(cwd, 'data'));
    fs.writeFileSync(path.join(cwd, 'data/people.json'), JSON.stringify([person]));
    const s = setup();
    const driver = loadTs('src/lib/store-fs.ts', { './store-shared': s.shared, './event-retention': loadTs('src/lib/event-retention.ts', {}, {}) }, {}, cwd);
    assert.equal((await driver.listPeople()).length, 1);
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'data')), ['people.json']);
    assert.equal(await driver.deletePerson(person.id), true);
    assert.equal(await driver.getPerson(person.slug), null);
    assert.equal((await driver.listPeople()).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'data/people.json'), 'utf8')).length, 1);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('migration endpoint rejects unauthenticated requests and writes only when dryRun is explicitly false', async () => {
  let isAdmin = false; const calls = [];
  const route = loadTs('src/app/api/admin/storage-migrate/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    '@/lib/auth': { isAdmin: () => isAdmin },
    '@/lib/store': { storageWritable: () => ({ ok: true }), migrateLegacyRecords: async (options) => { calls.push(options); return { failed: 0 }; } },
    '@/lib/store-shared': { safeId: (s) => /^[A-Za-z0-9_-]{1,40}$/.test(s) },
  }, {});
  const req = (body) => ({ json: async () => body });
  assert.equal((await route.POST(req({ dryRun: false }))).status, 401);
  assert.equal(calls.length, 0);
  isAdmin = true;
  assert.equal((await route.POST(req({ ids: [person.id] }))).status, 200);
  assert.equal(calls[0].dryRun, true);
  assert.equal((await route.POST(req({ ids: ['../bad'] }))).status, 400);
  await route.POST(req({ dryRun: false, ids: [person.id] }));
  assert.equal(calls[1].dryRun, false);
});


test('event purge includes hidden versions, archived legacy data and orphan media, but no unrelated data', async () => {
  const s = setup({ EVENT_ENDS_AT: '2000-01-01T18:00:00+08:00' });
  s.seedLegacy(); s.seedPrivate();
  s.stores.records.set(`people/${person.id}/01600000000000-old.json`, JSON.stringify(person));
  s.stores.records.set('deleted/removed.json', '{}');
  s.stores.records.set('legacy-archive/data/people.json', JSON.stringify([person]));
  s.stores.records.set('unrelated/file.json', 'KEEP');
  for (const p of ['photos/orphan.jpg', 'cartoons/orphan.png', 'loops/orphan.mp4', 'audio/orphan.mp3', 'data/people.json']) s.stores.media.set(p, 'synthetic');
  s.stores.media.set('unrelated/file.json', 'KEEP');
  const dry = await s.driver.purgeEventData({ dryRun: true });
  assert.equal(dry.candidates, 12); assert.equal(dry.deleted, 0); assert.deepEqual(writes(s), []);
  const result = await s.driver.purgeEventData({ dryRun: false });
  assert.equal(result.deleted, 12); assert.equal(result.remaining, 0);
  assert.deepEqual([...s.stores.records.keys()], ['unrelated/file.json']);
  assert.deepEqual([...s.stores.media.keys()], ['unrelated/file.json']);
  assert.equal((await s.driver.purgeEventData({ dryRun: false })).deleted, 0);
});

test('physical purge refuses absent/future/malformed event end and cannot succeed with a missing store', async () => {
  for (const end of ['', '2100-01-01T00:00:00Z', 'not-a-date']) {
    const s = setup({ EVENT_ENDS_AT: end }); s.seedLegacy();
    await assert.rejects(s.driver.purgeEventData({ dryRun: false }), /valid EVENT_ENDS_AT/);
    assert.deepEqual(writes(s), []);
  }
  const s = setup({ EVENT_ENDS_AT: '2000-01-01T00:00:00Z', BLOB_RECORDS_READ_WRITE_TOKEN: '' }); s.seedLegacy();
  await assert.rejects(s.driver.purgeEventData({ dryRun: false }), /Private records/);
  assert.deepEqual(writes(s), []);
});

test('physical purge failure is retryable and is not reported as completed', async () => {
  const s = setup({ EVENT_ENDS_AT: '2000-01-01T00:00:00Z' }); s.seedLegacy(); s.seedPrivate();
  s.failures.set('del', 'media');
  await assert.rejects(s.driver.purgeEventData({ dryRun: false }), /delete failure/);
  assert.equal(s.stores.media.size, 2);
  s.failures.delete('del');
  assert.equal((await s.driver.purgeEventData({ dryRun: false })).remaining, 0);
});

test('privatizing legacy manuscripts preserves exact historical bytes and newer canonical edits', async () => {
  const s = setup(); s.seedLegacy();
  const current = { ...person, script: 'New private content' }; s.seedPrivate(current);
  const second = { ...person, id: 'second', slug: 'second' };
  const legacyBytes = JSON.stringify([person, second], null, 2);
  s.stores.media.set('data/people.json', legacyBytes);
  const dry = await s.driver.privatizeLegacyRecords({ dryRun: true });
  assert.equal(dry.candidates, 2); assert.equal(dry.moved, 0); assert.deepEqual(writes(s), []);
  const result = await s.driver.privatizeLegacyRecords({ dryRun: false });
  assert.equal(result.moved, 2);
  assert.equal(s.stores.media.has('data/people.json'), false);
  assert.equal(s.stores.media.has(`people/${person.id}.json`), false);
  assert.equal(s.stores.records.get('legacy-archive/data/people.json'), legacyBytes);
  assert.equal((await s.driver.getPerson(person.slug)).script, current.script);
  assert.equal((await s.driver.getPerson(second.slug)).id, second.id);
  assert.equal((await s.driver.privatizeLegacyRecords({ dryRun: false })).moved, 0);
});

test('privatizing never removes an unverified source or a legacy list with an invalid entry', async () => {
  for (const failure of ['put', 'mismatched-read', 'invalid-list']) {
    const s = setup(); s.seedLegacy();
    if (failure === 'put') s.failures.set('put', 'records');
    if (failure === 'mismatched-read') s.setOnPut((pathname) => s.failures.set(pathname, 'mismatched-read'));
    if (failure === 'invalid-list') { s.stores.media.clear(); s.stores.media.set('data/people.json', JSON.stringify([person, { id: '../bad' }])); }
    await assert.rejects(s.driver.privatizeLegacyRecords({ dryRun: false }));
    assert.equal(s.calls.some((c) => c.op === 'del'), false);
  }
});

test('filesystem physical purge removes current, hidden, legacy and media files, not external symlink targets', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-retention-test-'));
  try {
    for (const dir of ['people', 'uploads', 'deleted']) fs.mkdirSync(path.join(cwd, 'data', dir), { recursive: true });
    for (const file of ['people/a.json', 'uploads/a.audio.mp3', 'deleted/a.json', 'people.json']) fs.writeFileSync(path.join(cwd, 'data', file), 'synthetic');
    fs.writeFileSync(path.join(cwd, 'keep.txt'), 'KEEP');
    fs.symlinkSync(path.join(cwd, 'keep.txt'), path.join(cwd, 'data/uploads/link'));
    const env = { EVENT_ENDS_AT: '2000-01-01T00:00:00Z' };
    const s = setup();
    const driver = loadTs('src/lib/store-fs.ts', { './store-shared': s.shared, './event-retention': loadTs('src/lib/event-retention.ts', {}, env) }, env, cwd);
    assert.equal((await driver.purgeEventData({ dryRun: true })).candidates, 5);
    const result = await driver.purgeEventData({ dryRun: false });
    assert.equal(result.deleted, 5); assert.equal(result.remaining, 0);
    assert.equal(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8'), 'KEEP');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});


test('private photo versions preserve binary bytes and never fetch arbitrary public URLs', async () => {
  const s = setup(); s.seedPrivate();
  const bytes = Buffer.from([0, 255, 128, 1, 2, 0]);
  const first = await s.driver.savePhoto(person.id, bytes, 'png');
  const second = await s.driver.savePhoto(person.id, Buffer.from('replacement'), 'png');
  const version = new URL(first, 'https://local.invalid').searchParams.get('asset');
  assert.ok((await s.driver.readPhoto(person.id, version)).buffer.equals(bytes));
  assert.equal((await s.driver.readPhoto(person.id)).buffer.toString(), 'replacement');
  assert.notEqual(first, second);
  assert.equal(s.calls.some(c => c.op === 'fetch'), false);
  assert.equal(s.stores.media.size, 0);
  assert.equal(await s.driver.readPhoto('another-person', version), null);
  assert.equal(await s.driver.readPhoto(person.id, '../bad'), null);
});

test('media privatization copies current, historical and orphan bytes before removing every public origin', async () => {
  const s = setup();
  const photoPath = `photos/${person.id}-old.png`;
  const audioPath = `audio/${person.id}-part1-en-old.mp3`;
  const orphanPath = 'audio/deleted-student-orphan.mp3';
  const photo = Buffer.from([0, 255, 128, 2]);
  const audio = Buffer.from('old manuscript-derived narration');
  const current = { ...person, photoUrl: `https://media.invalid/${photoPath}`, sections: [{ ...person.sections[0], cachedAudio: { en: `https://media.invalid/${audioPath}` } }] };
  s.seedLegacy(current); s.seedPrivate(current);
  s.stores.media.set(photoPath, photo); s.stores.media.set(audioPath, audio); s.stores.media.set(orphanPath, Buffer.from('orphan'));
  const exposedBefore = await s.driver.getPerson(person.id);
  assert.match(exposedBefore.photoUrl, /^\/api\/photo\//);
  assert.ok(!JSON.stringify(exposedBefore).includes('https://media.invalid'));
  assert.ok((await s.driver.readPhoto(person.id)).buffer.equals(photo));
  const dry = await s.driver.privatizeLegacyRecords({ dryRun: true });
  assert.equal(dry.mediaCandidates, 3); assert.equal(dry.mediaMoved, 0);
  assert.equal(writes(s).length, 0);
  const migrated = await s.driver.privatizeLegacyRecords({ dryRun: false });
  assert.equal(migrated.mediaMoved, 3); assert.equal(migrated.remainingPublicMedia, 0);
  assert.ok(s.stores.records.get(`legacy-archive/media/${photoPath}`).equals(photo));
  assert.ok(s.stores.records.get(`legacy-archive/media/${audioPath}`).equals(audio));
  assert.equal(s.stores.records.get(`legacy-archive/media/${orphanPath}`).toString(), 'orphan');
  assert.ok((await s.driver.readPhoto(person.id)).buffer.equals(photo));
  assert.ok((await s.driver.readPhoto(`${person.id}.audio.part1-en`)).buffer.equals(audio));
  // Saving normalized API output later cannot break media resolution.
  await s.driver.updatePerson(person.id, { photoUrl: exposedBefore.photoUrl, sections: exposedBefore.sections });
  assert.ok((await s.driver.readPhoto(person.id)).buffer.equals(photo));
  assert.ok((await s.driver.readPhoto(`${person.id}.audio.part1-en`)).buffer.equals(audio));
  assert.equal((await s.driver.privatizeLegacyRecords({ dryRun: false })).mediaMoved, 0);
});

test('media migration preserves edits made during archival and stops on a failed binary verification', async () => {
  const s = setup(); s.seedPrivate({ ...person, photoUrl: `https://media.invalid/photos/${person.id}-old.png` });
  s.stores.media.set(`photos/${person.id}-old.png`, Buffer.from('original-photo'));
  let edited = false;
  s.setOnPut(pathname => {
    if (!edited && pathname.startsWith('legacy-archive/media/')) {
      edited = true;
      s.seedPrivate({ ...person, script: 'CONCURRENT PRIVATE EDIT', photoUrl: `https://media.invalid/photos/${person.id}-old.png` }, '09999999999999-edit.json');
    }
  });
  await s.driver.privatizeLegacyRecords({ dryRun: false });
  assert.equal((await s.driver.getPerson(person.id)).script, 'CONCURRENT PRIVATE EDIT');
  const broken = setup(); broken.seedPrivate();
  broken.stores.media.set(`photos/${person.id}-old.png`, Buffer.from([0, 255, 128]));
  broken.setOnPut(pathname => { if (pathname.startsWith('legacy-archive/media/')) broken.failures.set(pathname, 'mismatched-read'); });
  await assert.rejects(broken.driver.privatizeLegacyRecords({ dryRun: false }), /verification/);
  assert.equal(broken.calls.some(c => c.op === 'del'), false);
  assert.equal(broken.stores.media.size, 1);
});

test('a private Blob write crossing event expiry removes its newly written bytes', async () => {
  const s = setup({ EVENT_ENDS_AT: '2999-01-01T00:00:00Z' }); s.seedPrivate();
  s.setOnPut(pathname => { if (pathname.startsWith('private-media/')) s.env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z'; });
  await assert.rejects(s.driver.savePhoto(person.id, Buffer.from('late-photo'), 'png'), /closed/);
  assert.equal([...s.stores.records.keys()].some(key => key.startsWith('private-media/')), false);
  assert.equal(s.calls.some(c => c.op === 'del' && c.path.startsWith('private-media/')), true);
});


test('record updates never return legacy public URLs and history aliases are deduplicated', async () => {
  const s = setup();
  const p = { ...person, photoUrl: `https://media.invalid/photos/${person.id}-old.png` };
  for (let i = 0; i < 30; i++) s.seedPrivate(p, `0170000000${String(i).padStart(4, '0')}-history.json`);
  s.stores.media.set(`photos/${person.id}-old.png`, Buffer.from('photo'));
  const updated = await s.driver.updatePerson(person.id, { name: 'New name' });
  assert.match(updated.photoUrl, /^\/api\/photo\//);
  const before = s.calls.length;
  await s.driver.privatizeLegacyRecords({ dryRun: false });
  const reads = s.calls.slice(before).filter(c => c.op === 'get' && c.path.startsWith('private-media/'));
  assert.equal(reads.length, 2); // absence check + post-write verification once
});
