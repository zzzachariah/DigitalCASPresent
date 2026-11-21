import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';

function load(file, imports) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected import ${name}`);
  } });
  return module.exports;
}
const react = { useRef: (current) => ({ current }), useEffect: () => {}, useState: (value) => [value, () => {}] };
const Icon = () => null;
const common = { react, 'react/jsx-runtime': jsxRuntime, './Loading': { Spinner: () => null, LoadingOverlay: () => null }, './icons': new Proxy({}, { get: () => Icon }) };
const SectionList = load('../src/components/SectionList.tsx', { ...common, '@/lib/format': { pad2: (value) => String(value).padStart(2, '0') } }).default;
function findAll(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap((child) => findAll(child, predicate))];
}
const section = (extra = {}) => ({ id: 'synthetic-section', title: 'Synthetic exhibit', content: 'Source stays unchanged.', ...extra });
function setup({ current = section(), targetLanguages = ['zh', 'en'], isAdmin = true, open = false } = {}) {
  const edits = []; const sourceEdits = []; const toggles = [];
  const admin = {
    targetLanguages, pregenerate: () => {}, pregenerating: new Set(), bulkPregenerating: false,
    answersOpen: new Set(open ? [current.id] : []),
    toggleAnswersOpen(id) { toggles.push(id); this.answersOpen.has(id) ? this.answersOpen.delete(id) : this.answersOpen.add(id); },
    updateCachedAnswer: (...args) => edits.push(args),
  };
  const tree = () => SectionList({ sections: [current], onUpdate: (...args) => sourceEdits.push(args), onRemove: () => {}, onMove: () => {}, admin: isAdmin ? admin : undefined });
  return { edits, sourceEdits, toggles, tree,
    fields: () => findAll(tree(), (node) => node.type === 'textarea' && node.props['aria-label']),
    toggle: () => findAll(tree(), (node) => node.type === 'button' && node.props['aria-label']?.includes('编写 / 编辑讲解'))[0],
  };
}

test('an entirely failed section can open empty configured-language narration fields', () => {
  const ui = setup();
  assert.equal(ui.fields().length, 0);
  assert.equal(ui.toggle().props['aria-expanded'], false);
  ui.toggle().props.onClick();
  assert.deepEqual(ui.toggles, ['synthetic-section']);
  assert.equal(ui.toggle().props['aria-expanded'], true);
  assert.deepEqual(ui.fields().map((field) => field.props['aria-label']), ['Synthetic exhibit · 中文讲解', 'Synthetic exhibit · English explanation']);
  assert.deepEqual(ui.fields().map((field) => field.props.value), ['', '']);
  ui.fields()[1].props.onChange({ target: { value: 'Manually written explanation.' } });
  assert.deepEqual(ui.edits, [['synthetic-section', 'en', 'Manually written explanation.']]);
  assert.deepEqual(ui.sourceEdits, []);
});

test('a partially prepared section shows missing targets and preserves additional existing languages once', () => {
  const ui = setup({ current: section({ cachedAnswers: { en: 'Existing English.', bilingual: 'Existing bilingual.', unexpected: 'Not an editable language.' } }), open: true });
  assert.deepEqual(ui.fields().map((field) => field.props.value), ['', 'Existing English.', 'Existing bilingual.']);
  assert.equal(ui.fields().length, 3);
  ui.fields()[2].props.onChange({ target: { value: 'Revised bilingual.' } });
  assert.deepEqual(ui.edits, [['synthetic-section', 'bilingual', 'Revised bilingual.']]);
});

test('single-language and bilingual settings expose their missing target, with a stable untitled label', () => {
  for (const [language, label] of [['en', 'English explanation'], ['zh', '中文讲解'], ['bilingual', '双语讲解 · Bilingual']]) {
    const ui = setup({ current: section({ title: '' }), targetLanguages: [language], open: true });
    assert.equal(ui.fields().length, 1);
    assert.equal(ui.fields()[0].props['aria-label'], `第 1 部分 · ${label}`);
    assert.equal(ui.fields()[0].props.value, '');
  }
});

test('student section UI never exposes narration editing even when cached answers exist', () => {
  const ui = setup({ current: section({ cachedAnswers: { zh: 'Cached narration.' } }), isAdmin: false, open: true });
  assert.equal(ui.toggle(), undefined);
  assert.deepEqual(ui.fields(), []);
  assert.equal(findAll(ui.tree(), (node) => node.type === 'textarea').length, 1);
});

test('the admin editor supplies languages from the current draft setting', () => {
  const { narrationLanguages } = load('../src/lib/admin-narration.ts', { './readiness': {} });
  const draft = { isEdit: true, sections: [section()], draft: {}, answersOpen: new Set(), pregenerating: new Set() };
  const Editor = load('../src/components/PersonEditor.tsx', {
    ...common,
    '@/lib/editor-api': { adminApi: {} },
    '@/lib/admin-narration': { narrationLanguages },
    './SectionList': { default: SectionList },
    './usePersonDraft': { PHOTO_ACCEPT: 'image/png', usePersonDraft: () => draft },
  }).default;
  for (const [language, expected] of [['auto', ['zh', 'en']], ['zh', ['zh']], ['en', ['en']], ['bilingual', ['bilingual']]]) {
    draft.language = language;
    const tree = Editor({ person: null, onSaved: () => {}, onCancel: () => {} });
    const list = findAll(tree, (node) => node.type === SectionList)[0];
    assert.ok(list, 'SectionList should receive admin tools');
    assert.deepEqual(Array.from(list.props.admin.targetLanguages), expected);
  }
});
