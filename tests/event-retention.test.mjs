import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(file, mocks = {}, env = {}) {
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (key) => { if (!(key in mocks)) throw new Error(`Missing mock ${key}`); return mocks[key]; }, process: { env }, Date, Set, console: { info() {}, error() {} } });
  return mod.exports;
}
const server = { NextResponse: class extends Response {
  static json(data, init) { return new this(JSON.stringify(data), init); }
  static next() { return new this(null); }
} };

test('event expiry is exact at configured timezone and malformed date fails closed', () => {
  const env = { EVENT_ENDS_AT: '2027-01-01T00:00:00+08:00' };
  const retention = load('src/lib/event-retention.ts', {}, env);
  assert.equal(retention.eventRetentionStatus(Date.parse('2026-12-31T15:59:59.999Z')).state, 'open');
  const closed = retention.eventRetentionStatus(Date.parse('2026-12-31T16:00:00Z'));
  assert.equal(closed.state, 'closed'); assert.equal(closed.endsAt, '2026-12-31T16:00:00.000Z');
  for (const invalid of ['January 1 2027', '2027-01-01', '2027-01-01T00:00:00', '2027-13-01T00:00:00Z', '2027-02-30T00:00:00Z']) {
    env.EVENT_ENDS_AT = invalid;
    assert.equal(retention.eventRetentionStatus().state, 'invalid');
    assert.equal(retention.eventDataClosed(), true);
    assert.throws(() => retention.assertEventOpen(), /closed/);
  }
  delete env.EVENT_ENDS_AT;
  assert.equal(retention.eventRetentionStatus().state, 'unconfigured');
  assert.equal(retention.eventDataClosed(), false);
});

test('middleware closes every event interaction after expiry and preserves only maintenance/auth', async () => {
  const retention = load('src/lib/event-retention.ts', {}, { EVENT_ENDS_AT: '2000-01-01T00:00:00Z' });
  const middleware = load('src/middleware.ts', { 'next/server': server, './lib/event-retention': retention });
  for (const path of ['/submit', '/submit/id', '/p/student', '/api/p/id', '/api/chat', '/api/avatar', '/api/avatar/status', '/api/photo/id', '/api/admin/people', '/api/admin/storage-migrate', '/api/admin/storage-privatize', '/api/submit/parse']) {
    const result = middleware.middleware({ nextUrl: { pathname: path } });
    assert.equal(result.status, 410, path);
    assert.match(result.headers.get('cache-control'), /no-store/);
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  }
  for (const path of ['/privacy', '/api/admin/login', '/api/admin/health', '/api/admin/retention', '/api/cron/retention']) {
    assert.equal(middleware.middleware({ nextUrl: { pathname: path } }).status, 200, path);
  }
});

test('admin physical purge requires authentication, past expiry and exact explicit confirmation', async () => {
  let admin = false;
  const env = { EVENT_ENDS_AT: '2000-01-01T00:00:00Z' };
  const retention = load('src/lib/event-retention.ts', {}, env);
  const calls = [];
  const route = load('src/app/api/admin/retention/route.ts', {
    'next/server': server,
    '@/lib/auth': { isAdmin: () => admin },
    '@/lib/event-retention': retention,
    '@/lib/store': { purgeEventData: async (options) => { calls.push(options); return { ...options, remaining: 0 }; } },
  }, env);
  const req = (body) => ({ json: async () => body });
  assert.equal((await route.GET()).status, 401);
  assert.equal((await route.POST(req({ dryRun: false }))).status, 401);
  assert.equal(calls.length, 0);
  admin = true;
  await route.POST(req({})); assert.equal(calls[0].dryRun, true);
  assert.equal((await route.POST(req({ dryRun: false }))).status, 409);
  assert.equal((await route.POST(req({ dryRun: false, confirmEndsAt: 'wrong' }))).status, 409);
  assert.equal(calls.length, 1);
  const confirmEndsAt = retention.eventRetentionStatus().endsAt;
  assert.equal((await route.POST(req({ dryRun: false, confirmEndsAt }))).status, 200);
  assert.equal(calls[1].dryRun, false);
  env.EVENT_ENDS_AT = '2100-01-01T00:00:00Z';
  assert.equal((await route.POST(req({ dryRun: false, confirmEndsAt: retention.eventRetentionStatus().endsAt }))).status, 409);
  assert.equal(calls.length, 2);
});

test('cron does not delete without valid bearer secret or before expiry; partial cleanup fails', async () => {
  const env = { CRON_SECRET: 'synthetic-secret', EVENT_ENDS_AT: '2100-01-01T00:00:00Z' };
  const retention = load('src/lib/event-retention.ts', {}, env);
  let count = 0; let remaining = 0;
  const route = load('src/app/api/cron/retention/route.ts', {
    'next/server': server,
    '@/lib/auth': { safeEqual: (a, b) => !!a && a === b },
    '@/lib/event-retention': retention,
    '@/lib/store': { purgeEventData: async () => { count++; return { deleted: 2, remaining }; } },
  }, env);
  const req = (token) => ({ headers: new Headers(token ? { authorization: token } : {}) });
  assert.equal((await route.GET(req())).status, 401);
  assert.equal((await route.GET(req('Bearer wrong'))).status, 401);
  await route.GET(req('Bearer synthetic-secret')); assert.equal(count, 0);
  env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z';
  assert.equal((await route.GET(req('Bearer synthetic-secret'))).status, 200); assert.equal(count, 1);
  remaining = 1;
  assert.equal((await route.GET(req('Bearer synthetic-secret'))).status, 503); assert.equal(count, 2);
  delete env.CRON_SECRET;
  assert.equal((await route.GET(req('Bearer undefined'))).status, 401); assert.equal(count, 2);
});

test('legacy privatization endpoint is admin-only, dry-run by default and requires explicit action', async () => {
  let admin = false; const calls = [];
  const route = load('src/app/api/admin/storage-privatize/route.ts', {
    'next/server': server,
    '@/lib/auth': { isAdmin: () => admin },
    '@/lib/store': { privatizeLegacyRecords: async (options) => { calls.push(options); return options; } },
  });
  const req = (body) => ({ json: async () => body });
  assert.equal((await route.POST(req({ dryRun: false, confirm: 'MOVE_LEGACY_TO_PRIVATE' }))).status, 401);
  admin = true;
  await route.POST(req({})); assert.equal(calls[0].dryRun, true);
  assert.equal((await route.POST(req({ dryRun: false }))).status, 409);
  assert.equal((await route.POST(req({ dryRun: false, confirm: 'MOVE_LEGACY_TO_PRIVATE' }))).status, 200);
  assert.equal(calls.length, 2); assert.equal(calls[1].dryRun, false);
});


test('privacy maintenance authenticates before parsing, GET is read-only, expiry blocks all archival writes', async () => {
  const env = { CRON_SECRET: 'synthetic-secret', EVENT_ENDS_AT: '2100-01-01T00:00:00Z' };
  const retention = load('src/lib/event-retention.ts', {}, env);
  const calls = []; let parses = 0;
  const route = load('src/app/api/cron/privacy/route.ts', {
    'next/server': server,
    '@/lib/auth': { safeEqual: (a, b) => !!a && a === b },
    '@/lib/event-retention': retention,
    '@/lib/store': { privatizeLegacyRecords: async (options) => { calls.push(options); return { ...options, candidates: 2, moved: options.dryRun ? 0 : 2 }; } },
  }, env);
  const req = (auth, body = {}) => ({ headers: new Headers(auth ? { authorization: auth } : {}), url: 'https://example.invalid/api/cron/privacy?dryRun=false', json: async () => { parses++; return body; } });
  assert.equal((await route.GET(req())).status, 401);
  assert.equal((await route.POST(req('Bearer wrong', { dryRun: false }))).status, 401);
  assert.equal(parses, 0); assert.equal(calls.length, 0);
  await route.GET(req('Bearer synthetic-secret')); assert.equal(calls[0].dryRun, true);
  await route.POST(req('Bearer synthetic-secret')); assert.equal(calls[1].dryRun, true);
  assert.equal((await route.POST(req('Bearer synthetic-secret', { dryRun: false }))).status, 409);
  assert.equal(calls.length, 2);
  assert.equal((await route.POST(req('Bearer synthetic-secret', { dryRun: false, confirm: 'MOVE_LEGACY_TO_PRIVATE' }))).status, 200);
  assert.equal(calls[2].dryRun, false);
  for (const end of ['2000-01-01T00:00:00Z', '', 'invalid']) {
    env.EVENT_ENDS_AT = end;
    assert.equal((await route.GET(req('Bearer synthetic-secret'))).status, 409);
    assert.equal((await route.POST(req('Bearer synthetic-secret', { dryRun: false, confirm: 'MOVE_LEGACY_TO_PRIVATE' }))).status, 409);
  }
  assert.equal(calls.length, 3);
  delete env.CRON_SECRET;
  assert.equal((await route.GET(req('Bearer undefined'))).status, 401);
});
