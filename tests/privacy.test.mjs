import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(file, mocks = {}, extra = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error(`Unmocked dependency: ${name}`);
    },
    Response, Request, Headers, Date, console, setTimeout, clearTimeout,
    ...extra,
  }, { filename: file });
  return mod.exports;
}
const privacy = load('src/lib/privacy.ts');
const media = load('src/lib/media-access.ts', {}, { URL });
const server = load('src/lib/privacy-server.ts', {
  'next/server': { NextResponse: Response }, './privacy': privacy,
});
const accepted = () => new Headers({ [privacy.PRIVACY_CONSENT_HEADER]: privacy.PRIVACY_VERSION });

test('missing, outdated and arbitrary consent values cannot authorize processing', () => {
  for (const value of [undefined, '', 'true', '2020-01-01', '2026-11-19', `${privacy.PRIVACY_VERSION}, true`]) {
    const headers = new Headers(value === undefined ? {} : { 'x-privacy-consent': value });
    assert.equal(privacy.acceptsCurrentPrivacy(headers), false);
    assert.equal(privacy.consentReceipt(headers), null);
    assert.equal(server.requirePrivacyConsent({ headers }).status, 428);
  }
  assert.equal(privacy.acceptsCurrentPrivacy(accepted()), true);
});

test('student endpoints reject before touching manuscript bodies, uploads, stores or providers', async () => {
  const never = () => { throw new Error('Private data was touched without consent'); };
  const dependencies = {
    'next/server': { NextResponse: Response },
    '@/lib/privacy-server': server,
    '@/lib/privacy': privacy, '@/lib/media-access': media,
    '@/lib/ratelimit': { limitRequest: never },
    '@/lib/store': new Proxy({}, { get: () => never }),
    '@/lib/store-shared': { newEditToken: never },
    '@/lib/access': { previewTokenFor: never, ownerTokenValid: never },
    '@/lib/validate': { parsePersonInput: never },
    '@/lib/image': { readUploadedImage: never },
    '@/lib/handlers': { handleParse: never, handleAutosection: never },
  };
  for (const [file, methods] of [
    ['route.ts', ['POST']], ['[id]/route.ts', ['GET', 'PUT']],
    ['[id]/photo/route.ts', ['POST']], ['parse/route.ts', ['POST']], ['autosection/route.ts', ['POST']],
  ]) {
    const route = load(`src/app/api/submit/${file}`, dependencies);
    for (const method of methods) {
      const result = await route[method]({ headers: new Headers(), json: never, formData: never }, { params: { id: 'synthetic' } });
      assert.equal(result.status, 428, `${method} ${file}`);
    }
  }
});

test('new submission records current version and server time instead of client supplied receipt', async () => {
  let saved;
  const route = load('src/app/api/submit/route.ts', {
    'next/server': { NextResponse: Response },
    '@/lib/privacy-server': server, '@/lib/privacy': privacy, '@/lib/media-access': media,
    '@/lib/ratelimit': { limitRequest: () => null },
    '@/lib/store': {
      storageWritable: () => ({ ok: true }),
      createPerson: async (input) => { saved = input; return { ...input, id: 'synthetic' }; },
      toOwner: (person) => person,
    },
    '@/lib/store-shared': { newEditToken: () => 'synthetic-token' },
    '@/lib/access': { previewTokenFor: () => 'synthetic-preview' },
    '@/lib/validate': { parsePersonInput: () => ({ ok: true, value: { name: 'Synthetic', script: 'Synthetic only', sections: [] } }) },
  });
  const before = Date.now();
  const result = await route.POST({ headers: accepted(), json: async () => ({ privacyConsent: { version: 'old', acceptedAt: 1 } }) });
  assert.equal(result.status, 200);
  assert.equal(saved.privacyConsent.version, privacy.PRIVACY_VERSION);
  assert.ok(saved.privacyConsent.acceptedAt >= before && saved.privacyConsent.acceptedAt <= Date.now());
  assert.equal(saved.status, 'pending');
});

test('an accepted parse reaches the handler exactly once', async () => {
  let calls = 0;
  const route = load('src/app/api/submit/parse/route.ts', {
    'next/server': { NextResponse: Response }, '@/lib/privacy-server': server,
    '@/lib/ratelimit': { limitRequest: () => null },
    '@/lib/handlers': { handleParse: async () => { calls++; return Response.json({ text: 'Synthetic only' }); } },
  });
  assert.equal((await route.POST({ headers: accepted() })).status, 200);
  assert.equal(calls, 1);
});

const validate = { LIMITS: { sections: 12, script: 40000 }, defaultSectionTitle: (i) => `Part ${i + 1}` };
let nextId = 0;
const local = load('src/lib/local-sections.ts', {
  nanoid: { nanoid: () => `section-${++nextId}` }, './validate': validate,
});

test('local split preserves all paragraphs even beyond the section cap', () => {
  const paragraphs = Array.from({ length: 20 }, (_, i) => `Synthetic paragraph ${i}: keep every word.`);
  const sections = local.localSections(paragraphs.join('\n\n'));
  assert.equal(sections.length, 12);
  assert.equal(sections.map((s) => s.content).join('\n\n'), paragraphs.join('\n\n'));
  assert.equal(new Set(sections.map((s) => s.id)).size, 12);
});

test('confidential local split never calls the external AI', async () => {
  const handlers = load('src/lib/handlers.ts', {
    'next/server': { NextResponse: Response },
    './processing-policy': { aiProcessingAllowed: () => false },
    './local-sections': local,
    './ai': { chat: () => { throw new Error('Unexpected provider request'); } },
    './prompts': {}, './parse': {}, './validate': validate,
    nanoid: { nanoid: () => 'unused' },
  });
  const result = await handlers.handleAutosection({ json: async () => ({ script: 'Synthetic first.\n\nSynthetic second.' }) });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.method, 'local');
  assert.equal(body.sections.length, 2);
  assert.equal(body.sections[1].content, 'Synthetic second.');
});

test('preview tokens stay on relative app media and never leak to provider URLs', () => {
  assert.equal(media.previewMediaUrl('/api/photo/student.audio.section-zh?v=2', 'secret-preview'), '/api/photo/student.audio.section-zh?v=2&preview=secret-preview');
  for (const url of ['https://provider.invalid/image.png', '//provider.invalid/image.png', '/api/other', 'https://app.invalid/api/photo/student']) {
    assert.equal(media.previewMediaUrl(url, 'secret-preview'), url);
  }
});

test('all unpublished media variants require presentation access before reading bytes', async () => {
  let reads = 0;
  const route = load('src/app/api/photo/[id]/route.ts', {
    'next/server': {},
    '@/lib/store': {
      getPerson: async (id) => id === 'student' ? { id, status: 'pending', photoUrl: '/api/photo/student' } : null,
      readPhoto: async () => { reads++; return { buffer: new Uint8Array([1, 2]), contentType: 'image/png' }; },
    },
    '@/lib/access': { canView: (_, token) => token === 'allowed-preview' },
    '@/lib/auth': { isAdmin: () => false },
    '@/lib/media-access': media,
  });
  for (const id of ['student', 'student.cartoon', 'student.loop', 'student.audio.section-zh']) {
    const unauth = await route.GET({ headers: new Headers(), nextUrl: new URL('http://local/api/photo/' + id) }, { params: { id } });
    assert.equal(unauth.status, 404);
  }
  assert.equal(reads, 0);
  const audio = await route.GET({ headers: new Headers(), nextUrl: new URL('http://local/api/photo/student.audio.section-zh?preview=allowed-preview') }, { params: { id: 'student.audio.section-zh' } });
  assert.equal(audio.status, 404);
  assert.equal(reads, 0);
  const valid = await route.GET({ headers: new Headers(), nextUrl: new URL('http://local/api/photo/student?preview=allowed-preview') }, { params: { id: 'student' } });
  assert.equal(valid.status, 200);
  assert.equal(reads, 1);
  assert.match(valid.headers.get('cache-control'), /no-store/);
});

test('published and preview access cannot retrieve replaced media versions', async () => {
  let admin = false;
  let reads = 0;
  const person = { id: 'student', status: 'approved', photoUrl: '/api/photo/student?asset=current.png', cartoonUrl: '/api/photo/student.cartoon?asset=current-cartoon.png', loopVideoUrl: '/api/photo/student.loop?asset=current-loop.mp4' };
  const route = load('src/app/api/photo/[id]/route.ts', {
    'next/server': {}, '@/lib/media-access': media,
    '@/lib/store': {
      getPerson: async () => person,
      readPhoto: async () => { reads++; return { buffer: new Uint8Array([1]), contentType: 'image/png' }; },
    },
    '@/lib/access': { canView: () => true },
    '@/lib/auth': { isAdmin: () => admin },
  });
  const request = (id, query = '') => route.GET({ headers: new Headers(), nextUrl: new URL(`http://local/api/photo/${id}${query}`) }, { params: { id } });
  for (const id of ['student', 'student.cartoon', 'student.loop']) {
    assert.equal((await request(id, '?asset=old-secret.png&preview=valid-preview')).status, 404);
  }
  assert.equal(reads, 0);
  assert.equal((await request('student', '?asset=current.png')).status, 200);
  assert.equal((await request('student.cartoon', '?asset=current-cartoon.png')).status, 200);
  assert.equal((await request('student.loop', '?asset=current-loop.mp4')).status, 200);
  assert.equal((await request('student')).status, 200); // Resolve current in the driver.
  assert.equal(reads, 4);
  person.photoUrl = 'https://old-public-store.invalid/photo.png?asset=old-secret.png';
  assert.equal((await request('student', '?asset=old-secret.png')).status, 404);
  assert.equal(reads, 4);
  person.cartoonUrl = undefined;
  assert.equal((await request('student.cartoon')).status, 404);
  assert.equal(reads, 4);
  admin = true;
  assert.equal((await request('student', '?asset=old-secret.png')).status, 200);
  assert.equal(reads, 5);
});
