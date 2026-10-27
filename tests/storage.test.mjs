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
      stores[store].set(finalPath, typeof value === 'string' ? value : Buffer.from(value).toString());
      return entry(store, finalPath);
    },
    async del(pathname, options) {
      const store = storeFor(options); calls.push({ op: 'del', store, path: pathname });
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
  const driver = loadTs('src/lib/store-blob.ts', { '@vercel/blob': api, './store-shared': shared, fetch: publicFetch }, env);
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

test('new saves are private and photo uploads stay in the original public media store', async () => {
  const s = setup();
  const created = await s.driver.createPerson({ name: 'New student', script: 'New text', sections: [], language: 'auto' });
  assert.equal(s.stores.media.size, 0);
  assert.ok(writes(s).every((c) => c.store === 'records' && c.access === 'private'));
  const url = await s.driver.savePhoto(created.id, Buffer.from('photo'), 'png');
  assert.match(url, /^https:\/\/media\.invalid\/photos\//);
  assert.equal((await s.driver.getPerson(created.slug)).photoUrl, url);
  assert.ok(writes(s).some((c) => c.store === 'media' && c.access === 'public'));
  await s.driver.updatePerson(created.id, { name: 'Changed name', slug: 'must-not-change' });
  assert.equal((await s.driver.getPerson(created.id)).slug, created.slug);
});

test('filesystem reads keep legacy source in place and deletion masks it', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-storage-test-'));
  try {
    fs.mkdirSync(path.join(cwd, 'data'));
    fs.writeFileSync(path.join(cwd, 'data/people.json'), JSON.stringify([person]));
    const s = setup();
    const driver = loadTs('src/lib/store-fs.ts', { './store-shared': s.shared }, {}, cwd);
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
