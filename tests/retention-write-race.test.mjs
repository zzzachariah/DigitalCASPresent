import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(file, mocks, env, cwd) {
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (key) => { if (!(key in mocks)) throw new Error(`Missing mock ${key}`); return mocks[key]; }, process: { env, cwd: () => cwd }, Date, Set, Map, Buffer });
  return mod.exports;
}

function fixture(intercept = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-retention-race-'));
  const env = { EVENT_ENDS_AT: '2100-01-01T00:00:00Z' };
  const retention = load('src/lib/event-retention.ts', {}, env, cwd);
  let serial = 0;
  const driver = load('src/lib/store-fs.ts', {
    fs: { promises: { ...fs.promises, ...intercept } }, path,
    './event-retention': retention,
    './store-shared': {
      newId: () => `temporary-${serial++}`,
      safeId: (id) => /^[A-Za-z0-9_-]+$/.test(id),
      uniqueSlug: async () => 'synthetic-student',
      buildPerson: (input, slug) => ({ ...input, id: 'synthetic-id', slug, createdAt: 1, updatedAt: 1 }),
      contentTypeForExt: () => 'audio/mpeg',
    },
  }, env, cwd);
  return { cwd, env, driver, expire: () => { env.EVENT_ENDS_AT = '2000-01-01T00:00:00Z'; }, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}
function gate() {
  let resume, entered;
  return { entered: new Promise((r) => { entered = r; }), wait: new Promise((r) => { resume = r; }), enter: () => entered(), resume: () => resume() };
}
const input = { name: 'Synthetic student', script: 'Synthetic manuscript', sections: [], language: 'en' };

test('filesystem late media write is removed even when it finishes after the expired-event purge', async () => {
  const barrier = gate();
  const f = fixture({ writeFile: async (...args) => {
    barrier.enter(); await barrier.wait; return fs.promises.writeFile(...args);
  } });
  try {
    const write = f.driver.saveAudio('synthetic-id', 'section-en', Buffer.from('synthetic narration'), 'mp3');
    const rejected = assert.rejects(write, /Event data is closed/);
    await barrier.entered;
    f.expire();
    assert.equal((await f.driver.purgeEventData({ dryRun: false })).remaining, 0);
    barrier.resume();
    await rejected;
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, 'data/uploads')), []);
  } finally { barrier.resume(); f.cleanup(); }
});

test('filesystem record rename crossing the event deadline removes the completed record and temp file', async () => {
  const barrier = gate();
  const f = fixture({ rename: async (...args) => {
    barrier.enter(); await barrier.wait; return fs.promises.rename(...args);
  } });
  try {
    const rejected = assert.rejects(f.driver.createPerson(input), /Event data is closed/);
    await barrier.entered;
    f.expire(); barrier.resume();
    await rejected;
    assert.deepEqual(fs.readdirSync(path.join(f.cwd, 'data/people')), []);
  } finally { barrier.resume(); f.cleanup(); }
});

test('filesystem write after expiry refuses before emitting any event content', async () => {
  let writes = 0;
  const f = fixture({ writeFile: async (...args) => { writes++; return fs.promises.writeFile(...args); } });
  try {
    f.expire();
    await assert.rejects(f.driver.createPerson(input), /Event data is closed/);
    await assert.rejects(f.driver.saveAudio('synthetic-id', 'section-en', Buffer.from('synthetic'), 'mp3'), /Event data is closed/);
    assert.equal(writes, 0);
  } finally { f.cleanup(); }
});
