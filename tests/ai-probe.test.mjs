import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const yes = '{"safe":true,"grounded":true,"private":true,"relevant":true,"respectful":true}';
const expected = 'The toy compass points north.';
const fakeKey = 'synthetic-test-only-key';
function load(file, mocks, env, fetch) {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (!(name in mocks)) throw new Error(`Unexpected import ${name}`); return mocks[name]; }, process: { env }, Response, Buffer, AbortSignal, URL, Date, Set, Promise, fetch, Error, TypeError, SyntaxError, DOMException }, { filename: file });
  return module.exports;
}
function json(text, status = 200) { return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status, headers: { 'Content-Type': 'application/json' } }); }
function setup() {
  const env = { AI_API_KEY: fakeKey, AI_PROBE_SECRET: 'synthetic-probe-secret', AI_PROBE_EXPIRES_AT: new Date(Date.now() + 30 * 60000).toISOString(), EXTERNAL_AI_PROCESSING_APPROVED: 'false' };
  const state = { event: 'open', admin: true, blocked: false, calls: [], responses: [json(expected), json(yes)] };
  const retention = { eventRetentionStatus: () => ({ state: state.event, endsAt: '2999-01-01T00:00:00.000Z' }) };
  const errors = load('../src/lib/ai-errors.ts', {}, env);
  const reviewOutput = load('../src/lib/review-output.ts', { './ai-errors': errors }, env);
  const reviewProfile = load('../src/lib/review-profile.ts', {}, env);
  const fixtures = load('../src/lib/ai-probe-fixtures.ts', {}, env);
  const modelOptions = load('../src/lib/model-options.ts', {}, env);
  const safety = load('../src/lib/ai-safety.ts', { './ai-errors': errors, './review-output': reviewOutput }, env);
  const probe = load('../src/lib/ai-probe.ts', { './event-retention': retention, './ai-safety': safety, './ai-errors': errors, './review-output': reviewOutput, './review-profile': reviewProfile, './ai-probe-fixtures': fixtures, './model-options': modelOptions }, env, async (url, init) => {
    state.calls.push({ url, init, body: JSON.parse(init.body) });
    const result = state.responses.shift();
    if (typeof result === 'function') return result(init);
    if (result instanceof Error) throw result;
    if (!result) throw new Error('Unexpected extra provider request');
    return result;
  });
  const route = load('../src/app/api/admin/ai-probe/route.ts', {
    'next/server': { NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } }) } },
    '@/lib/auth': { isAdmin: () => state.admin, safeEqual: (a, b) => Boolean(a && b && a === b) },
    '@/lib/event-retention': retention,
    '@/lib/ai-probe': probe,
    '@/lib/ratelimit': { rateLimit: (key, limit, windowMs) => { assert.equal(key, 'ai-probe:*'); assert.equal(limit, 6); assert.equal(windowMs, 600000); return state.blocked ? { ok: false, retryAfterSec: 15 } : { ok: true }; } },
  }, env);
  return { env, state, route, probe, fixtures, safety, reviewProfile };
}
function request(body = { model: 'claude-sonnet-5' }, headers = {}) { return new Request('https://synthetic.test/api/admin/ai-probe', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); }

test('two fixed synthetic probes work with manuscript processing disabled', async () => {
  const s = setup(); const response = await s.route.POST(request()); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.pass, true); assert.equal(result.syntheticOnly, true);
  assert.equal(result.generation.response, expected); assert.equal(result.review.response, yes);
  assert.equal(s.state.calls.length, 2); assert.equal(s.env.EXTERNAL_AI_PROCESSING_APPROVED, 'false');
  for (const call of s.state.calls) {
    assert.equal(call.url, 'https://cf.api.fan/v1/messages');
    assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers['x-api-key'], fakeKey);
    assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.body.model, 'claude-sonnet-5'); assert.equal(call.body.max_tokens, call.body.system.startsWith('You are a strict safety') ? 2048 : 200);
    assert.equal(call.body.stream, false); assert.equal(call.body.temperature, 0);
    assert.equal(call.body.messages.length, 1); assert.equal(call.body.messages[0].role, 'user');
    assert.ok(call.body.messages[0].content.includes('fictional'));
  }
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});

test('model whitelist and exact body shape cannot become a generic proxy', async () => {
  const s = setup();
  for (const body of [{ model: 'other-model' }, { model: 'claude-sonnet-5', prompt: 'PRIVATE-MANUSCRIPT-CANARY' }, { model: 'claude-sonnet-5', url: 'https://attacker.invalid' }, { model: ['claude-sonnet-5'] }, {}, null, []]) {
    assert.equal((await s.route.POST(request(body))).status, 400);
  }
  assert.equal(s.state.calls.length, 0);
  await assert.rejects(s.probe.runAiProbe('other-model', new AbortController().signal), /Unsupported/);
  assert.deepEqual(Array.from(s.probe.PROBE_MODELS), ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-2', 'qwen3.7-plus', 'qwen3.8-flash']);
});

test('authorization and active event are checked before input or service access', async () => {
  const s = setup(); s.state.admin = false;
  const unread = { headers: new Headers(), text: () => assert.fail('must not read input') };
  assert.equal((await s.route.POST(unread)).status, 401);
  for (const event of ['unconfigured', 'invalid', 'closed']) {
    s.state.admin = true; s.state.event = event;
    assert.equal((await s.route.POST(unread)).status, 409);
  }
  assert.equal(s.state.calls.length, 0);
  s.state.event = 'open'; s.state.admin = false;
  assert.equal((await s.route.POST(request(undefined, { Authorization: `Bearer ${s.env.AI_PROBE_SECRET}` }))).status, 200);
});

test('missing key and rate limit prevent provider calls', async () => {
  const s = setup(); s.env.AI_API_KEY = '';
  assert.equal((await s.route.POST(request())).status, 503);
  s.env.AI_API_KEY = fakeKey; s.state.blocked = true;
  const response = await s.route.POST(request());
  assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '15');
  assert.equal(s.state.calls.length, 0);
});

test('provider HTTP errors never expose their body or send a second request', async () => {
  const s = setup(); s.state.responses = [new Response(`SECRET=${fakeKey} PRIVATE-MANUSCRIPT-CANARY`, { status: 503 })];
  const result = await (await s.route.POST(request())).json();
  assert.equal(result.pass, false); assert.equal(result.generation.status, 'http_error'); assert.equal(result.generation.httpStatus, 503);
  assert.equal(result.review.status, 'skipped'); assert.equal(s.state.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes(fakeKey)); assert.ok(!JSON.stringify(result).includes('PRIVATE-MANUSCRIPT-CANARY'));
});

test('unknown synthetic replies are withheld and never become second-request input', async () => {
  const s = setup(); const injected = `${fakeKey} Bearer another-key sk-secret123 https://attacker.invalid ${'x'.repeat(1500)}`;
  s.state.responses = [json(injected), json(yes)];
  const result = await (await s.route.POST(request())).json();
  assert.equal(result.generation.pass, false); assert.equal(result.generation.response, undefined);
  assert.ok(!JSON.stringify(result).includes(fakeKey)); assert.ok(!JSON.stringify(result).includes('another-key'));
  assert.ok(!JSON.stringify(result).includes('sk-secret123')); assert.ok(!JSON.stringify(result).includes('https://attacker'));
  const reviewInput = s.state.calls[1].body.messages[0].content;
  assert.ok(!reviewInput.includes(fakeKey)); assert.ok(!reviewInput.includes('another-key')); assert.ok(reviewInput.includes(expected));
});

test('malformed or oversized success bodies fail without exposing parser excerpts', async () => {
  for (const response of [new Response(`{broken ${fakeKey}`, { status: 200 }), json('x'.repeat(40000))]) {
    const s = setup(); s.state.responses = [response];
    const result = await (await s.route.POST(request())).json();
    assert.equal(result.generation.status, 'invalid_response'); assert.equal(result.review.status, 'skipped');
    assert.ok(!JSON.stringify(result).includes(fakeKey));
  }
});

test('review must satisfy the production five-boolean JSON contract', async () => {
  for (const review of ['```json\n' + yes + '\n```', yes.replace('"private":true', '"private":false'), '{}']) {
    const s = setup(); s.state.responses = [json(expected), json(review)];
    const result = await (await s.route.POST(request())).json();
    assert.equal(result.generation.pass, true); assert.equal(result.review.pass, false); assert.equal(result.pass, false);
  }
});

test('event closure during a probe prevents a second call and suppresses diagnostic output', async () => {
  const s = setup(); s.state.responses = [() => { s.state.event = 'closed'; return json(expected); }];
  const response = await s.route.POST(request());
  assert.equal(response.status, 409); assert.equal(s.state.calls.length, 1);
  assert.ok(!(await response.text()).includes(expected));
});

test('each outbound call has a 25-second deadline and never retries a failure', async t => {
  const s = setup(); const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return AbortSignal.abort(new DOMException('timed out', 'TimeoutError')); });
  s.state.responses = [init => { init.signal.throwIfAborted(); return json(expected); }];
  const result = await (await s.route.POST(request())).json();
  assert.deepEqual(timeouts, [25000]); assert.equal(result.generation.status, 'timeout'); assert.equal(s.state.calls.length, 1);
});


test('dedicated bearer requires a valid future expiry within one hour; cleanup secret is never accepted', async () => {
  const s = setup(); s.state.admin = false;
  for (const expiry of ['', 'not-a-date', '2999-01-01T00:00:00Z', new Date(Date.now() - 1000).toISOString(), '2026-11-19']) {
    s.env.AI_PROBE_EXPIRES_AT = expiry;
    assert.equal((await s.route.POST(request(undefined, { Authorization: `Bearer ${s.env.AI_PROBE_SECRET}` }))).status, 401);
  }
  s.env.AI_PROBE_EXPIRES_AT = new Date(Date.now() + 30 * 60000).toISOString();
  s.env.CRON_SECRET = 'real-cleanup-credential';
  assert.equal((await s.route.POST(request(undefined, { Authorization: `Bearer ${s.env.CRON_SECRET}` }))).status, 401);
  assert.equal(s.state.calls.length, 0);
});


test('only the optional Fable fallback receives the longer 50-second deadline', async t => {
  const s = setup(); const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  const result = await (await s.route.POST(request({ model: 'claude-fable-5-2' }))).json();
  assert.equal(result.pass, true); assert.deepEqual(timeouts, [50000, 50000]);
  assert.ok(s.state.calls.every(call => call.body.model === 'claude-fable-5-2'));
});

test('fixed probe exposes typed failures and no raw provider material', async () => {
  const secret = 'PRIVATE-MANUSCRIPT-CANARY';
  const cases = [
    [Response.json({ error: { code: 'rate_limit_error', message: secret } }, { status: 429 }), { kind: 'http', httpStatus: 429, code: 'rate_limit_error' }],
    [Response.json({ error: { type: 'overloaded_error', message: secret } }), { kind: 'http', httpStatus: 200, code: 'overloaded_error' }],
    [Response.json({ error: { code: secret, message: secret } }), { kind: 'http', httpStatus: 200 }],
    [new Response(secret), { kind: 'invalid_response', httpStatus: 200 }],
    [Response.json({ content: [] }), { kind: 'empty_response', httpStatus: 200 }],
    [Response.json({ content: [{ type: 'thinking', thinking: secret }], stop_reason: 'max_tokens' }), { kind: 'truncated_response', httpStatus: 200 }],
    [new TypeError(secret), { kind: 'network' }],
    [new Error(secret), { kind: 'unknown' }],
  ];
  for (const [response, failure] of cases) {
    const s = setup(); s.state.responses = [response];
    const result = await (await s.route.POST(request())).json();
    assert.deepEqual(result.generation.failure, failure);
    assert.equal(result.generation.response, undefined); assert.equal(result.review.status, 'skipped');
    assert.equal(s.state.calls.length, 1); assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('probe review uses the production 2048-token budget and preserves its safe HTTP diagnostic', async () => {
  const s = setup(); s.state.responses = [json(expected), Response.json({ error: { code: 'api_error', message: fakeKey } }, { status: 502 })];
  const result = await (await s.route.POST(request())).json();
  assert.equal(s.state.calls[0].body.max_tokens, 200); assert.equal(s.state.calls[1].body.max_tokens, 2048);
  assert.equal(result.generation.maxTokens, 200); assert.equal(result.review.maxTokens, 2048);
  assert.deepEqual(result.review.failure, { kind: 'http', httpStatus: 502, code: 'api_error' });
  assert.equal(result.review.reviewReason, 'review_upstream_error'); assert.ok(!JSON.stringify(result).includes(fakeKey));
});

test('thinking-only truncation in the probe review is reported before empty content', async () => {
  const s = setup(); s.state.responses = [json(expected), Response.json({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: fakeKey }] })];
  const result = await (await s.route.POST(request())).json();
  assert.equal(result.review.reviewReason, 'review_format');
  assert.deepEqual(result.review.failure, { kind: 'truncated_response', httpStatus: 200 });
  assert.equal(result.review.response, undefined); assert.ok(!JSON.stringify(result).includes(fakeKey));
});

test('a truncated tool verdict never passes even when all five visible fields are true', async () => {
  const s = setup();
  s.state.responses = [json(expected), Response.json({ stop_reason: 'max_tokens', content: [
    { type: 'thinking', thinking: fakeKey },
    { type: 'tool_use', id: 'synthetic-review', name: 'submit_safety_review', input: JSON.parse(yes) },
  ] })];
  const result = await (await s.route.POST(request({ model: 'claude-sonnet-5', reviewMode: 'tool' }))).json();
  assert.equal(result.pass, false); assert.equal(result.review.reviewReason, 'review_format');
  assert.deepEqual(result.review.failure, { kind: 'truncated_response', httpStatus: 200 });
  assert.equal(result.review.response, undefined); assert.ok(!JSON.stringify(result).includes(fakeKey));
  assert.equal(s.state.calls.length, 2); // One generation and one review; never retry into approval.
});

test('Chinese synthetic fixture tests the identical fixed review schema without any manuscript input', async () => {
  const s = setup(); s.state.responses = [json('玩具指南针指向北方。'), json(yes)];
  const result = await (await s.route.POST(request({ model: 'claude-sonnet-5', language: 'zh', reviewMode: 'json_schema' }))).json();
  assert.equal(result.pass, true); assert.equal(result.language, 'zh'); assert.equal(result.reviewMode, 'json_schema'); assert.equal(result.configuredReviewMode, 'json_schema');
  assert.equal(s.state.calls[0].body.output_config, undefined);
  const review = s.state.calls[1].body;
  assert.equal(review.output_config.format.type, 'json_schema'); assert.equal(review.output_config.format.schema.additionalProperties, false);
  assert.ok(review.messages[0].content.includes('虚构')); assert.ok(review.messages[0].content.includes('玩具指南针指向北方。'));
  assert.equal(result.generation.response, '玩具指南针指向北方。');
});

test('probe modes are explicit enums and false tool decisions are never retried into approval', async () => {
  const s = setup(); s.env.AI_REVIEW_FORMAT = 'tool';
  s.state.responses = [json(expected), Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_safety_review', input: { ...JSON.parse(yes), grounded: false } }] })];
  const result = await (await s.route.POST(request())).json();
  assert.equal(result.pass, false); assert.equal(result.reviewMode, 'tool'); assert.equal(result.review.reviewReason, 'model_rejection');
  assert.equal(s.state.calls.length, 2); assert.equal(s.state.calls[1].body.tool_choice.type, 'tool');
  const invalid = setup();
  for (const extra of [{ language: 'fr' }, { reviewMode: 'automatic' }, { reviewMode: {} }, { schema: {} }, { language: 'zh', prompt: 'PRIVATE-CANARY' }]) {
    assert.equal((await invalid.route.POST(request({ model: 'claude-sonnet-5', ...extra }))).status, 400);
  }
  assert.equal(invalid.state.calls.length, 0);
});

test('formatIssue is one fixed category and does not expose malformed review content', async () => {
  for (const [raw, formatIssue] of [['```json\n' + yes + '\n```', 'fenced_json'], ['PRIVATE-CANARY', 'invalid_json'], ['{}', 'wrong_fields'], [yes.replace('true', '"true"'), 'wrong_values']]) {
    const s = setup(); s.state.responses = [json(expected), json(raw)];
    const result = await (await s.route.POST(request({ model: 'claude-sonnet-5', reviewMode: 'text' }))).json();
    assert.equal(result.review.formatIssue, formatIssue); assert.equal(result.review.pass, false);
    assert.equal(result.review.response, undefined); assert.ok(!JSON.stringify(result).includes('PRIVATE-CANARY'));
    assert.equal(s.state.calls[1].body.output_config, undefined); assert.equal(s.state.calls[1].body.tools, undefined);
  }
});

test('fixed complex fixtures make one review, exercise model rejection and never expose their source or candidate', async () => {
  for (const language of ['zh', 'en']) for (const fixture of ['complex-valid', 'complex-unsupported', 'complex-extraction']) {
    const s = setup(); const candidate = s.fixtures.probeFixture(language, fixture);
    const decision = { ...JSON.parse(yes), ...Object.fromEntries(candidate.expectedRejectedCriteria.map(field => [field, false])) };
    s.state.responses = [json(JSON.stringify(decision))];
    const result = await (await s.route.POST(request({ model: 'claude-sonnet-5', language, fixture }))).json();
    assert.equal(s.state.calls.length, 1); assert.equal(result.generation.status, 'skipped'); assert.equal(result.review.status, 'ok');
    assert.equal(result.expectedApproved, fixture === 'complex-valid'); assert.equal(result.review.pass, result.expectedApproved);
    assert.equal(result.matchedExpectation, true); assert.equal(result.pass, true);
    assert.equal(s.state.calls[0].body.max_tokens, 2048);
    const sent = JSON.parse(s.state.calls[0].body.messages[0].content);
    assert.ok(sent.source.length > (language === 'zh' ? 1400 : 4000)); assert.ok(sent.source.length < 8000);
    assert.equal(sent.source, candidate.source); assert.equal(sent.answer, candidate.answer); assert.deepEqual(sent.suggestions, []);
    assert.equal(s.safety.reproducesSource(candidate.answer, candidate.source), false, 'negative controls must reach semantic review');
    assert.ok(!JSON.stringify(result).includes(candidate.answer)); assert.ok(!JSON.stringify(result).includes('LARK-271'));
    if (!result.expectedApproved) assert.equal(result.review.reviewReason, 'model_rejection');
  }
});

test('negative assessments cannot pass on service failure, format error, approval or rejection of the wrong criterion', async () => {
  for (const response of [
    json(yes), json(yes.replace('"safe":true', '"safe":false')), json('PRIVATE-OUTPUT-CANARY'),
    Response.json({ error: { message: 'PRIVATE-OUTPUT-CANARY' } }, { status: 503 }),
    Response.json({ stop_reason: 'max_tokens', content: [] }), new DOMException('PRIVATE-OUTPUT-CANARY', 'TimeoutError'),
  ]) {
    const s = setup(); s.state.responses = [response];
    const result = await (await s.route.POST(request({ model: 'claude-sonnet-5', fixture: 'complex-unsupported' }))).json();
    assert.equal(result.expectedApproved, false); assert.equal(result.pass, false); assert.equal(result.matchedExpectation, false);
    assert.equal(s.state.calls.length, 1); assert.ok(!JSON.stringify(result).includes('PRIVATE-OUTPUT-CANARY'));
  }
});

test('diagnostic profile overrides are exact, review-only and cannot become custom prompts or provider options', async () => {
  const s = setup(); s.env.AI_REVIEW_EFFORT = 'medium';
  const result = await (await s.route.POST(request())).json();
  assert.equal(result.configuredReviewProfile, 'medium'); assert.equal(result.reviewProfile, 'medium');
  assert.equal(s.state.calls[0].body.output_config, undefined);
  assert.equal(s.state.calls[1].body.output_config.effort, 'medium');
  assert.equal(s.state.calls[1].body.output_config.format.type, 'json_schema');
  s.state.responses = [json(yes)];
  const baseline = await (await s.route.POST(request({ model: 'claude-sonnet-5', fixture: 'complex-valid', reviewProfile: 'default' }))).json();
  assert.equal(baseline.reviewProfile, 'default'); assert.equal(s.state.calls[2].body.output_config.effort, undefined);
  s.state.responses = [json(yes)];
  await s.route.POST(request({ model: 'claude-sonnet-5', fixture: 'complex-valid', reviewProfile: 'low' }));
  assert.equal(s.state.calls[3].body.output_config.effort, 'low');
  const count = s.state.calls.length;
  for (const body of [
    { model: 'claude-sonnet-5', fixture: 'PRIVATE-FIXTURE-CANARY' },
    { model: 'claude-sonnet-5', reviewProfile: 'high' },
    { model: 'qwen3.8-flash', reviewProfile: 'low' },
    { model: 'claude-sonnet-5', fixture: 'complex-valid', source: 'PRIVATE-SOURCE-CANARY' },
    { model: 'claude-sonnet-5', fixture: 'complex-valid', answer: 'CUSTOM' },
    { model: 'claude-sonnet-5', output_config: { effort: 'low' } },
  ]) assert.equal((await s.route.POST(request(body))).status, 400);
  assert.equal(s.state.calls.length, count);
});

function openaiResult(text = yes, tool = false, finishReason) {
  return { choices: [{ finish_reason: finishReason || (tool ? 'tool_calls' : 'stop'), message: tool
    ? { tool_calls: [{ type: 'function', function: { name: 'submit_safety_review', arguments: text } }] }
    : { content: text } }] };
}

test('Qwen synthetic assessments use only OpenAI auth/protocol and preserve exact review modes and decisions', async () => {
  for (const model of ['qwen3.7-plus', 'qwen3.8-flash']) for (const reviewMode of ['json_schema', 'tool']) {
    const s = setup(); s.state.responses = [Response.json(openaiResult(yes, reviewMode === 'tool'))];
    const result = await (await s.route.POST(request({ model, language: 'zh', fixture: 'complex-valid', reviewMode }))).json();
    assert.equal(result.pass, true); assert.equal(result.generation.status, 'skipped'); assert.equal(s.state.calls.length, 1);
    const call = s.state.calls[0];
    assert.equal(call.url, 'https://cf.api.fan/v1/chat/completions'); assert.equal(call.init.headers.Authorization, `Bearer ${fakeKey}`);
    assert.equal(call.init.headers['x-api-key'], undefined); assert.equal(call.body.enable_thinking, false); assert.equal(call.body.store, false);
    assert.equal(call.body.system, undefined); assert.equal(call.body.messages[0].role, 'system'); assert.equal(call.body.messages[1].role, 'user');
    assert.equal(call.body.output_config, undefined);
    if (reviewMode === 'json_schema') assert.equal(call.body.response_format.json_schema.strict, true);
    else { assert.equal(call.body.tool_choice.function.name, 'submit_safety_review'); assert.equal(call.body.parallel_tool_calls, false); }
  }
  const s = setup(); s.state.responses = [Response.json(openaiResult(expected)), Response.json(openaiResult())];
  const result = await (await s.route.POST(request({ model: 'qwen3.8-flash', fixture: 'basic', reviewMode: 'json_schema' }))).json();
  assert.equal(result.pass, true); assert.equal(s.state.calls.length, 2);
  assert.equal(s.state.calls[0].body.response_format, undefined); assert.equal(s.state.calls[0].body.max_tokens, 200);
  const rejected = setup(); rejected.state.responses = [Response.json(openaiResult(yes.replace('"private":true', '"private":false'), true))];
  const negative = await (await rejected.route.POST(request({ model: 'qwen3.8-flash', fixture: 'complex-extraction', reviewMode: 'tool' }))).json();
  assert.equal(negative.review.pass, false); assert.equal(negative.matchedExpectation, true);
});

test('Qwen truncation and malformed tool results remain failed assessments and metrics cannot leak arbitrary fields', async () => {
  for (const data of [
    openaiResult(yes, true, 'length'), openaiResult(yes), openaiResult('```json\n' + yes + '\n```', true),
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [] } }] },
  ]) {
    const s = setup(); s.state.responses = [Response.json({ ...data, usage: { completion_tokens: 'PRIVATE-METRIC-CANARY' }, reasoning_content: fakeKey })];
    const result = await (await s.route.POST(request({ model: 'qwen3.8-flash', fixture: 'complex-valid', reviewMode: 'tool' }))).json();
    assert.equal(result.pass, false); assert.equal(result.review.outputTokens, undefined);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-METRIC-CANARY')); assert.ok(!JSON.stringify(result).includes(fakeKey));
    assert.equal(s.state.calls.length, 1);
  }
  const s = setup(); s.state.responses = [Response.json({ ...openaiResult(yes, true), usage: { completion_tokens: 47 } })];
  const result = await (await s.route.POST(request({ model: 'qwen3.8-flash', fixture: 'complex-valid', reviewMode: 'tool' }))).json();
  assert.equal(result.review.outputTokens, 47); assert.equal(result.review.stopReason, 'tool_calls');
});
