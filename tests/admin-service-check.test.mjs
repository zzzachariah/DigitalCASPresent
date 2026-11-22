import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(fileURLToPath(new URL('../src/components/AdminServiceCheck.tsx', import.meta.url)), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
function setup({ data, props = {}, status = 200 } = {}) {
  const values = []; let cursor = 0; const calls = [];
  const module = { exports: {} };
  const imports = {
    'react': { useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], (value) => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
    } },
    'react/jsx-runtime': jsxRuntime,
    'next/link': { __esModule: true, default: ({ children, ...attributes }) => React.createElement('a', attributes, children) },
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name) => {
    if (Object.hasOwn(imports, name)) return imports[name]; throw new Error(`Unexpected import ${name}`);
  }, fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  } });
  function tree() { cursor = 0; return module.exports.default({ configuredModel: 'claude-sonnet-5', configuredReviewMode: 'json_schema', configuredReviewProfile: 'default', ...props }); }
  function find(predicate, node = tree()) {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of React.Children.toArray(node.props?.children)) { const match = find(predicate, child); if (match) return match; }
  }
  return {
    calls,
    html: () => renderToStaticMarkup(tree()),
    select: (label) => find((node) => node.type === 'select' && (node.props['aria-label'] === label || node.props.id === label)),
    change(label, value) { this.select(label).props.onChange({ target: { value } }); },
    click: async () => { await find((node) => node.type === 'button').props.onClick(); },
  };
}
const complex = (extra = {}) => ({ syntheticOnly: true, fixture: 'complex-unsupported', reviewProfile: 'medium', expectedApproved: false, matchedExpectation: true, pass: true,
  generation: { status: 'skipped', pass: false, elapsedMs: 0 },
  review: { status: 'ok', pass: false, reviewReason: 'model_rejection', rejectedCriteria: ['grounded'], elapsedMs: 2300 }, ...extra });

test('default basic check retains the basic workflow and posts only fixed selections', async () => {
  const ui = setup({ data: { syntheticOnly: true, pass: true, generation: { status: 'ok', pass: true }, review: { status: 'ok', pass: true } } });
  await ui.click();
  assert.deepEqual(ui.calls, [{ url: '/api/admin/ai-probe', body: { model: 'claude-sonnet-5', language: 'zh', reviewMode: 'json_schema', fixture: 'basic', reviewProfile: 'default' } }]);
  assert.match(ui.html(), /文字生成和审核检查均通过/);
});

test('complex negative case treats correct refusal as success and shows expected versus actual decisions', async () => {
  const ui = setup({ data: complex({ pass: false }) });
  ui.change('测试案例', 'complex-unsupported'); ui.change('本次审核强度', 'medium');
  await ui.click();
  assert.equal(ui.calls[0].body.fixture, 'complex-unsupported'); assert.equal(ui.calls[0].body.reviewProfile, 'medium');
  const html = ui.html();
  assert.match(html, /审核结果符合测试预期/); assert.match(html, /预期结果：应拒绝。实际结果：已拒绝/);
  assert.match(html, /本案例无需生成/); assert.match(html, /未满足：依据充分性/);
  assert.doesNotMatch(html, /文字生成和审核检查均通过/);
});

test('complex positive case and an unexpected approval use the expectation match, not the raw approval alone', async () => {
  for (const expectedApproved of [true, false]) {
    const fixture = expectedApproved ? 'complex-valid' : 'complex-extraction';
    const ui = setup({ data: complex({ fixture, expectedApproved, matchedExpectation: expectedApproved, pass: true, review: { status: 'ok', pass: true } }) });
    ui.change('测试案例', fixture); await ui.click();
    assert.match(ui.html(), /实际结果：已通过审核/);
    assert.ok(ui.html().includes(expectedApproved ? '审核结果符合测试预期' : '本次检查未符合全部预期'));
  }
});

test('fixed introduction and exhibit cases retain exact IDs and expected approval or refusal', async () => {
  for (const [fixture, label, expectedApproved] of [
    ['section-introduction', '极简引言 · 应通过', true],
    ['exhibit-identification', '物件识别 · 应通过', true],
    ['exhibit-wrong-object', '错认物件 · 应拒绝', false],
    ['section-reconstruction', '重构论证 · 应拒绝', false],
  ]) {
    const ui = setup({ data: complex({ fixture, expectedApproved, matchedExpectation: true, review: { status: 'ok', pass: expectedApproved, ...(expectedApproved ? {} : { reviewReason: 'model_rejection' }) } }) });
    const option = React.Children.toArray(ui.select('测试案例').props.children).find((item) => item.props.value === fixture);
    assert.equal(option.props.children, label);
    ui.change('测试案例', fixture); await ui.click();
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].body.fixture, fixture);
    assert.equal(ui.calls[0].body.model, 'claude-sonnet-5');
    assert.match(ui.html(), /审核结果符合测试预期/); assert.match(ui.html(), /本案例无需生成/);
    assert.ok(ui.html().includes(expectedApproved ? '预期结果：应通过审核。实际结果：已通过审核' : '预期结果：应拒绝。实际结果：已拒绝'));
  }
});

test('source ambiguity fixtures preserve expected approval for common facts and refusal for taking sides', async () => {
  for (const [fixture, label, expectedApproved] of [
    ['source-ambiguity-common', '原稿歧义 · 共有事实 · 应通过', true],
    ['source-ambiguity-disputed', '原稿歧义 · 擅自选边 · 应拒绝', false],
  ]) {
    for (const language of ['zh', 'en']) {
      const ui = setup({ data: complex({ fixture, expectedApproved, matchedExpectation: true, review: { status: 'ok', pass: expectedApproved, ...(expectedApproved ? {} : { reviewReason: 'model_rejection' }) } }) });
      const option = React.Children.toArray(ui.select('测试案例').props.children).find((item) => item.props.value === fixture);
      assert.equal(option.props.children, label);
      ui.change('测试案例', fixture); ui.change('检查语言', language); await ui.click();
      assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].body.fixture, fixture); assert.equal(ui.calls[0].body.language, language);
      assert.match(ui.html(), /审核结果符合测试预期/); assert.match(ui.html(), /本案例无需生成/);
      assert.ok(ui.html().includes(expectedApproved ? '预期结果：应通过审核。实际结果：已通过审核' : '预期结果：应拒绝。实际结果：已拒绝'));
    }
  }
});

test('review service errors never count as an expected denial and show only canonical failure labels', async () => {
  const ui = setup({ data: complex({ pass: false, matchedExpectation: false, review: { status: 'http_error', pass: false, reviewReason: 'review_upstream_error', failure: { kind: 'http', httpStatus: 503, code: 'insufficient_quota', message: 'PRIVATE-UPSTREAM' }, response: 'PRIVATE-MODEL-CONTENT' } }) });
  ui.change('测试案例', 'complex-unsupported'); await ui.click();
  const html = ui.html();
  assert.match(html, /本次检查未符合全部预期/); assert.match(html, /实际结果：未获得有效审核结论/);
  assert.match(html, /服务额度不足/); assert.match(html, /HTTP 503/);
  assert.doesNotMatch(html, /PRIVATE|实际结果：已拒绝/);
});

test('unknown diagnostics, freeform output and non-allowlisted criteria are never rendered', async () => {
  const ui = setup({ data: complex({ response: 'PRIVATE-ROOT', review: { status: 'ok', pass: false, reviewReason: 'model_rejection', rejectedCriteria: ['private', '__proto__', 'PRIVATE-CRITERION'], response: 'PRIVATE-MODEL', formatIssue: 'PRIVATE-FORMAT', failure: { code: '__proto__', kind: 'PRIVATE-KIND', message: 'PRIVATE-ERROR' } } }) });
  ui.change('测试案例', 'complex-unsupported'); await ui.click();
  assert.match(ui.html(), /未满足：保密要求/); assert.doesNotMatch(ui.html(), /PRIVATE|__proto__/);
});

test('non-Sonnet models reset and disable nondefault effort without changing server configuration', async () => {
  const ui = setup({ data: { syntheticOnly: true, pass: true }, props: { configuredReviewProfile: 'medium' } });
  assert.equal(ui.select('本次审核强度').props.value, 'medium');
  ui.change('check-model', 'claude-haiku-4-5-20251001');
  assert.equal(ui.select('本次审核强度').props.value, 'default'); assert.equal(ui.select('本次审核强度').props.disabled, true);
  await ui.click(); assert.equal(ui.calls[0].body.reviewProfile, 'default');
  assert.match(ui.html(), /当前审核强度：中等强度/);
});

test('both Qwen models select native structured review and default effort while retaining complex fixtures', async () => {
  for (const model of ['qwen3.7-plus', 'qwen3.8-flash']) {
    const ui = setup({ data: complex(), props: { configuredReviewProfile: 'medium' } });
    ui.change('check-model', model); ui.change('测试案例', 'complex-unsupported');
    assert.equal(ui.select('审核方式').props.value, 'json_schema');
    assert.equal(ui.select('本次审核强度').props.value, 'default'); assert.equal(ui.select('本次审核强度').props.disabled, true);
    const schemaOption = React.Children.toArray(ui.select('审核方式').props.children).find((option) => option.props.value === 'json_schema');
    assert.notEqual(schemaOption.props.disabled, true);
    await ui.click();
    assert.deepEqual(ui.calls[0].body, { model, language: 'zh', reviewMode: 'json_schema', fixture: 'complex-unsupported', reviewProfile: 'default' });
    assert.match(ui.html(), /审核结果符合测试预期/);
  }
});

test('configured Qwen keeps the configured review mode and permits all supported review formats', async () => {
  for (const reviewMode of ['json_schema', 'tool', 'text']) {
    const ui = setup({ data: { syntheticOnly: true, pass: true }, props: { configuredModel: 'qwen3.7-plus', configuredReviewMode: reviewMode, configuredReviewProfile: 'low' } });
    assert.equal(ui.select('check-model').props.value, 'qwen3.7-plus');
    assert.equal(ui.select('审核方式').props.value, reviewMode); assert.equal(ui.select('本次审核强度').props.value, 'default');
    await ui.click(); assert.equal(ui.calls[0].body.reviewMode, reviewMode); assert.equal(ui.calls[0].body.reviewProfile, 'default');
  }
});

test('fixture and profile are fixed enums; unsupported client values never make a request', async () => {
  for (const selection of ['测试案例', '本次审核强度']) {
    const ui = setup(); ui.change(selection, 'PRIVATE-ARBITRARY'); await ui.click();
    assert.equal(ui.calls.length, 0); assert.match(ui.html(), /请选择列表中的检查选项/);
  }
});

test('a complex result requires matching fixture and explicit expectation fields', async () => {
  for (const data of [{ syntheticOnly: true, pass: true }, complex({ fixture: 'complex-valid' }), complex({ matchedExpectation: undefined })]) {
    const ui = setup({ data }); ui.change('测试案例', 'complex-unsupported'); await ui.click();
    assert.match(ui.html(), /未收到与本次案例对应的检查结果/);
    assert.doesNotMatch(ui.html(), /审核结果符合测试预期/);
  }
});
