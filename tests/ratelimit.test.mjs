import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const filename = fileURLToPath(new URL('../src/lib/ratelimit.ts', import.meta.url));
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = new Module(filename);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(compiled, filename);
const { rateLimit, _resetRateLimits } = mod.exports;

test('the hourly live-answer allowance remains enforced after the cleanup interval', () => {
  _resetRateLimits();
  const start = 1_800_000_000_000;
  const hour = 60 * 60_000;
  for (let i = 0; i < 600; i++) {
    assert.equal(rateLimit('chatLive:school', 600, hour, start).ok, true);
  }
  assert.equal(rateLimit('chatLive:school', 600, hour, start + 1).ok, false);
  assert.equal(rateLimit('chatLive:school', 600, hour, start + 16 * 60_000).ok, false);
  assert.equal(rateLimit('chatLive:school', 600, hour, start + hour).ok, true);
});

test('minute windows still expire without waiting for the hourly cleanup', () => {
  _resetRateLimits();
  const start = 1_800_000_000_000;
  assert.equal(rateLimit('chat:school', 1, 60_000, start).ok, true);
  assert.equal(rateLimit('chat:school', 1, 60_000, start + 59_999).ok, false);
  assert.equal(rateLimit('chat:school', 1, 60_000, start + 60_000).ok, true);
});
