import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/narration-cache-edit.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { editCachedAnswer, serializeSectionDraft } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const fixture = () => ({
  id: 'fixed-section', title: 'Synthetic exhibit', content: 'Unchanged confidential source.', hint: 'Unchanged hint.',
  cachedAnswers: { zh: '原讲解', en: 'Original explanation.', bilingual: 'Original bilingual explanation.' },
  cachedAudio: { zh: '/api/photo/student.audio.zh', en: '/api/photo/student.audio.en', bilingual: '/api/photo/student.audio.bilingual' },
  cachedSuggestions: { zh: ['旧问题'], en: ['Existing question?'], bilingual: ['Existing bilingual question?'] },
});

test('manual narration edits invalidate only that language audio and questions, preserving source and other languages', () => {
  for (const language of ['zh', 'en', 'bilingual']) {
    const original = fixture(); const before = structuredClone(original);
    const changed = editCachedAnswer(original, language, 'Manually revised explanation.');
    assert.notEqual(changed, original);
    assert.equal(changed.cachedAnswers[language], 'Manually revised explanation.');
    assert.equal(Object.hasOwn(changed.cachedAudio, language), false);
    assert.equal(Object.hasOwn(changed.cachedSuggestions, language), false);
    for (const other of ['zh', 'en', 'bilingual'].filter(key => key !== language)) {
      assert.equal(changed.cachedAnswers[other], before.cachedAnswers[other]);
      assert.equal(changed.cachedAudio[other], before.cachedAudio[other]);
      assert.deepEqual(changed.cachedSuggestions[other], before.cachedSuggestions[other]);
    }
    for (const key of ['id', 'title', 'content', 'hint']) assert.equal(changed[key], before[key]);
    assert.deepEqual(original, before);
  }
});

test('same-text edits are identity-preserving no-ops and cannot discard healthy caches', () => {
  const original = fixture();
  for (const language of ['zh', 'en', 'bilingual']) {
    assert.equal(editCachedAnswer(original, language, original.cachedAnswers[language]), original);
  }
  const uncached = { id: 'new-section', title: 'New exhibit', content: 'Source.' };
  assert.equal(editCachedAnswer(uncached, 'en', ''), uncached);
});

test('clearing a narration also removes its stale audio and suggestions without touching other languages', () => {
  const original = fixture();
  const cleared = editCachedAnswer(original, 'zh', '');
  assert.equal(cleared.cachedAnswers.zh, '');
  assert.equal(cleared.cachedAudio.zh, undefined); assert.equal(cleared.cachedSuggestions.zh, undefined);
  assert.equal(cleared.cachedAnswers.en, original.cachedAnswers.en);
  assert.equal(cleared.cachedAudio.en, original.cachedAudio.en);
  assert.deepEqual(cleared.cachedSuggestions.en, original.cachedSuggestions.en);
});

test('unsaved-change comparison detects answer, audio and suggestion edits in every language', () => {
  const original = fixture();
  const saved = serializeSectionDraft([original]);
  for (const language of ['zh', 'en', 'bilingual']) {
    assert.notEqual(serializeSectionDraft([editCachedAnswer(original, language, 'Revised explanation.')]), saved);
    for (const field of ['cachedAnswers', 'cachedAudio', 'cachedSuggestions']) {
      const changed = structuredClone(original);
      delete changed[field][language];
      assert.notEqual(serializeSectionDraft([changed]), saved, `${field}.${language} invalidation must be tracked`);
    }
  }
  assert.equal(serializeSectionDraft([structuredClone(original)]), saved);
});

test('optional empty caches and language key order do not create an unsaved change', () => {
  const uncached = { id: 'new-section', title: 'New exhibit', content: 'Source.' };
  assert.equal(serializeSectionDraft([uncached]), serializeSectionDraft([{ ...uncached, hint: '', cachedAnswers: { zh: '' }, cachedAudio: {}, cachedSuggestions: { en: [] } }]));
  const original = fixture();
  const reordered = structuredClone(original);
  for (const field of ['cachedAnswers', 'cachedAudio', 'cachedSuggestions']) {
    reordered[field] = Object.fromEntries(Object.entries(reordered[field]).reverse());
  }
  assert.equal(serializeSectionDraft([reordered]), serializeSectionDraft([original]));
});

test('section comparison still tracks source edits and order', () => {
  const original = fixture();
  for (const field of ['id', 'title', 'hint', 'content']) {
    assert.notEqual(serializeSectionDraft([{ ...original, [field]: 'Changed' }]), serializeSectionDraft([original]));
  }
  const second = { ...original, id: 'second-section' };
  assert.notEqual(serializeSectionDraft([original, second]), serializeSectionDraft([second, original]));
});
