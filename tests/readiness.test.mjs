import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/readiness.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { readinessForPerson } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const section = (overrides = {}) => ({
  id: 'part-1', title: 'Introduction', content: 'Source text',
  cachedAnswers: { zh: '固定讲解' }, cachedAudio: { zh: 'https://blob.example/audio.mp3' },
  ...overrides,
});
const person = (overrides = {}) => ({
  photoUrl: 'https://blob.example/photo.jpg', cartoonUrl: 'https://blob.example/cartoon.jpg',
  loopVideoUrl: 'https://blob.example/loop.mp4', script: 'Source text', sections: [section()], ...overrides,
});

test('a fully prepared person is ready and publishable', () => {
  const result = readinessForPerson(person());
  assert.equal(result.ready, true);
  assert.equal(result.publishable, true);
  assert.equal(result.done, result.total);
});

test('missing source photo or complete parts blocks publication', () => {
  const noPhoto = readinessForPerson(person({ photoUrl: undefined }));
  assert.equal(noPhoto.publishable, false);
  assert.deepEqual(noPhoto.blockers.map((item) => item.key), ['photo']);
  const incomplete = readinessForPerson(person({ sections: [section({ content: '' })] }));
  assert.equal(incomplete.publishable, false);
  assert.ok(incomplete.blockers.some((item) => item.key === 'parts'));
});

test('missing generated assets warn but keep a teacher override available', () => {
  const result = readinessForPerson(person({ cartoonUrl: undefined, loopVideoUrl: undefined, sections: [section({ cachedAudio: undefined })] }));
  assert.equal(result.publishable, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.warnings.map((item) => item.key), ['cartoon', 'loop', 'audio']);
});
