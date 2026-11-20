import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Compile only this dependency-free module: no real key, model, or network.
const source = await readFile(new URL('../src/lib/ai.ts', import.meta.url), 'utf8');
const policy = ts.transpileModule(await readFile(new URL('../src/lib/processing-policy.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const policyUrl = `data:text/javascript;base64,${Buffer.from(policy).toString('base64')}`;
const errors = ts.transpileModule(await readFile(new URL('../src/lib/ai-errors.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const errorsUrl = `data:text/javascript;base64,${Buffer.from(errors).toString('base64')}`;
const reviewSource = ts.transpileModule(await readFile(new URL('../src/lib/review-output.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('"./ai-errors"', JSON.stringify(errorsUrl));
const reviewUrl = `data:text/javascript;base64,${Buffer.from(reviewSource).toString('base64')}`;
const profileSource = ts.transpileModule(await readFile(new URL('../src/lib/review-profile.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const profileUrl = `data:text/javascript;base64,${Buffer.from(profileSource).toString('base64')}`;
const modelOptions = ts.transpileModule(await readFile(new URL('../src/lib/model-options.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const modelOptionsUrl = `data:text/javascript;base64,${Buffer.from(modelOptions).toString('base64')}`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace('"./processing-policy"', JSON.stringify(policyUrl)).replaceAll('"./ai-errors"', JSON.stringify(errorsUrl)).replace('"./review-output"', JSON.stringify(reviewUrl)).replace('"./review-profile"', JSON.stringify(profileUrl)).replace('"./model-options"', JSON.stringify(modelOptionsUrl));
const beforeApproval = process.env.EXTERNAL_AI_PROCESSING_APPROVED;
const beforeAiApproval = process.env.AI_PROCESSING_APPROVED;
process.env.EXTERNAL_AI_PROCESSING_APPROVED = 'false';
process.env.AI_PROCESSING_APPROVED = 'true';
after(() => {
  if (beforeApproval === undefined) delete process.env.EXTERNAL_AI_PROCESSING_APPROVED; else process.env.EXTERNAL_AI_PROCESSING_APPROVED = beforeApproval;
  if (beforeAiApproval === undefined) delete process.env.AI_PROCESSING_APPROVED; else process.env.AI_PROCESSING_APPROVED = beforeAiApproval;
});
let moduleId = 0;
const fakeKey = 'test-only-not-a-real-key';
const opts = { system: 'Use only the supplied exhibit.', messages: [{ role: 'user', content: 'Explain it.' }] };

async function client(overrides = {}) {
  const config = { AI_API_KEY: fakeKey, AI_BASE_URL: 'https://relay.example/v1/', AI_MODEL: 'claude-opus-test', AI_MODEL_LIVE: '', AI_API_PROTOCOL: 'auto', AI_REVIEW_EFFORT: undefined, EXTERNAL_AI_PROCESSING_APPROVED: 'false', AI_PROCESSING_APPROVED: 'true', ...overrides };
  const before = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(config)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    return await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// case ${moduleId++}`).toString('base64')}`);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function stream(text, split = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset += split));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(generator) {
  let result = '';
  for await (const delta of generator) result += delta;
  return result;
}

test('Claude defaults to Messages: top-level system, native headers, all text blocks', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://relay.example/v1/messages');
    assert.equal(init.headers['x-api-key'], fakeKey);
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(init.body);
    assert.equal(body.system, opts.system);
    assert.deepEqual(body.messages, opts.messages);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 600);
    return json({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'world.' }] });
  });
  assert.equal(await ai.chat(opts), 'Hello world.');
});

test('Anthropic origin-style base URL gets exactly one /v1', async (t) => {
  const ai = await client({ AI_BASE_URL: 'https://relay.example' });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://relay.example/v1/messages');
    return json({ content: [{ type: 'text', text: 'Ready' }] });
  });
  assert.equal(await ai.chat(opts), 'Ready');
});

test('Explicit OpenAI preserves Chat Completions for a Claude-compatible relay', async (t) => {
  const ai = await client({ AI_API_PROTOCOL: 'openai' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://relay.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, `Bearer ${fakeKey}`);
    assert.deepEqual(JSON.parse(init.body).messages, [{ role: 'system', content: opts.system }, ...opts.messages]);
    return json({ choices: [{ message: { content: 'Compatible.' } }] });
  });
  assert.equal(await ai.chat(opts), 'Compatible.');
});

test('Auto selects the live model protocol separately', async (t) => {
  const ai = await client({ AI_MODEL_LIVE: 'gpt-test' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://relay.example/v1/chat/completions');
    assert.equal(JSON.parse(init.body).model, 'gpt-test');
    return json({ choices: [{ message: { content: 'Fast.' } }] });
  });
  assert.equal(await ai.chat({ ...opts, live: true }), 'Fast.');
});

test('Anthropic SSE survives byte splits, UTF-8, CRLF and final unterminated event', async (t) => {
  const ai = await client();
  const events = [
    ': keepalive', '',
    'event: message_start', 'data: {"type":"message_start"}', '',
    'data: {"type":"content_block_start","content_block":{"type":"text","text":"你"}}', '',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden"}}', '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好 🌍"}}', '',
    'data: {"type":"message_stop"}',
  ].join('\r\n');
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return stream(events, 1);
  });
  assert.equal(await collect(ai.chatStream(opts)), '你好 🌍');
});

test('OpenAI SSE accepts CR lines and ignores role/usage events', async (t) => {
  const ai = await client({ AI_MODEL: 'gpt-test' });
  t.mock.method(globalThis, 'fetch', async () => stream([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}', '',
    'data: {"choices":[{"delta":{"content":"Ready."}}]}', '',
    'data: {"choices":[],"usage":{"completion_tokens":1}}', '',
    'data: [DONE]', '', '',
  ].join('\r'), 3));
  assert.equal(await collect(ai.chatStream(opts)), 'Ready.');
});

test('Streaming request tolerates a relay returning ordinary JSON', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => json({ content: [{ type: 'text', text: 'Fallback response.' }] }));
  assert.equal(await collect(ai.chatStream(opts)), 'Fallback response.');
});

test('Upstream errors retain useful error codes but redact credentials', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => json({ error: { code: 'protocol_not_supported', message: `Rejected ${fakeKey}; Bearer another-secret` } }, 400));
  await assert.rejects(ai.chat(opts), (error) => {
    assert.match(error.message, /protocol_not_supported/);
    assert.ok(!error.message.includes(fakeKey));
    assert.ok(!error.message.includes('another-secret'));
    return true;
  });
});

test('Non-JSON HTTP errors do not log raw upstream content', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => new Response(`<html>${fakeKey}</html>`, { status: 502 }));
  await assert.rejects(ai.chat(opts), (error) => error.message === 'AI request failed (502).');
});

test('Malformed JSON success bodies never leak parser excerpts', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => new Response(fakeKey, { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(ai.chat(opts), { message: 'AI returned an invalid JSON response.' });
  await assert.rejects(collect(ai.chatStream(opts)), { message: 'AI returned an invalid JSON response.' });
});

test('Error events are not swallowed after partial streaming text', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => stream([
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}', '',
    `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: fakeKey } })}`, '', '',
  ].join('\n')));
  await assert.rejects(collect(ai.chatStream(opts)), (error) => error.message.includes('overloaded_error') && !error.message.includes(fakeKey));
});

test('Empty and incomplete streams fail instead of looking successful', async (t) => {
  const ai = await client();
  const responses = [
    stream('data: {"type":"message_stop"}\n\n'),
    stream('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" "}}\n\ndata: {"type":"message_stop"}\n\n'),
    stream('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n'),
    stream('data: {broken}\n\n'),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(collect(ai.chatStream(opts)), /empty response/);
  await assert.rejects(collect(ai.chatStream(opts)), /empty response/);
  await assert.rejects(collect(ai.chatStream(opts)), /before it was complete/);
  await assert.rejects(collect(ai.chatStream(opts)), /invalid streaming event/);
});

test('Caller abort cancels a pending stream read', async (t) => {
  const ai = await client();
  const controller = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"First"}}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const generator = ai.chatStream({ ...opts, signal: controller.signal });
  assert.equal((await generator.next()).value, 'First');
  const next = generator.next();
  controller.abort();
  await assert.rejects(next, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('Hard timeout reaches the request and cancels a pending body', async (t) => {
  const ai = await client();
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 60_000);
    return timeout.signal;
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.signal, timeout.signal);
    return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const result = collect(ai.chatStream(opts));
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(result, { name: 'TimeoutError' });
});

test('An already aborted request never calls fetch', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected fetch'));
  await assert.rejects(ai.chat({ ...opts, signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('Mock mode still works without calling any service', async (t) => {
  const ai = await client({ AI_API_KEY: '' });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected fetch'));
  assert.equal(ai.aiIsMock(), true);
  assert.match(await ai.chat(opts), /Demo mode/);
});


test('Privacy gate blocks real and mock calls, including streaming, before fetch', async (t) => {
  const real = await client();
  const mock = await client({ AI_API_KEY: '' });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Privacy gate must prevent fetch'));
  process.env.EXTERNAL_AI_PROCESSING_APPROVED = 'false';
  process.env.AI_PROCESSING_APPROVED = 'false';
  try {
    await assert.rejects(real.chat(opts), /privacy approval/);
    await assert.rejects(mock.chat(opts), /privacy approval/);
    await assert.rejects(collect(real.chatStream(opts)), /privacy approval/);
    await assert.rejects(collect(mock.chatStream(opts)), /privacy approval/);
  } finally { process.env.AI_PROCESSING_APPROVED = 'true'; }
});

test('Provider error fields cannot echo confidential manuscript text into logs', async (t) => {
  const ai = await client();
  t.mock.method(globalThis, 'fetch', async () => json({ error: { code: 'private-manuscript', message: 'CONFIDENTIAL source text' } }, 500));
  await assert.rejects(ai.chat(opts), { message: 'AI request failed (500).' });
});

test('typed request failures retain only safe status and code, including 200 error envelopes', async t => {
  const ai = await client();
  const secret = 'PRIVATE-MANUSCRIPT-CANARY token=secret';
  const cases = [
    [json({ error: { type: 'rate_limit_error', message: secret } }, 429), { kind: 'http', httpStatus: 429, code: 'rate_limit_error' }],
    [json({ error: { code: 'overloaded_error', message: secret } }), { kind: 'http', httpStatus: 200, code: 'overloaded_error' }],
    [json({ error: { code: secret, type: secret, message: secret } }, 503), { kind: 'http', httpStatus: 503 }],
    [new Response(secret), { kind: 'invalid_response', httpStatus: 200 }],
    [json({ content: [] }), { kind: 'empty_response', httpStatus: 200 }],
    [json({ content: [{ type: 'thinking', thinking: secret }], stop_reason: 'max_tokens' }), { kind: 'truncated_response', httpStatus: 200 }],
  ];
  let current;
  t.mock.method(globalThis, 'fetch', async () => current);
  for (const [response, diagnostic] of cases) {
    current = response;
    await assert.rejects(ai.chat(opts), error => {
      assert.ok(error instanceof ai.AiRequestError);
      assert.deepEqual(ai.safeAiFailure(error), diagnostic);
      assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('OpenAI length termination is a typed truncation even when no content was emitted', async t => {
  const ai = await client({ AI_MODEL: 'gpt-test' });
  t.mock.method(globalThis, 'fetch', async () => json({ choices: [{ message: {}, finish_reason: 'length' }] }));
  await assert.rejects(ai.chat(opts), error => {
    assert.deepEqual(ai.safeAiFailure(error), { kind: 'truncated_response', httpStatus: 200 }); return true;
  });
});

test('Anthropic truncation rejects an apparently complete tool verdict without retrying', async t => {
  const ai = await client(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({
    stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'synthetic-review', name: 'submit_safety_review',
      input: { safe: true, grounded: true, private: true, relevant: true, respectful: true } }],
  }); });
  await assert.rejects(ai.chat({ ...opts, maxTokens: 2048, reviewOutput: 'tool' }), error => {
    assert.deepEqual(ai.safeAiFailure(error), { kind: 'truncated_response', httpStatus: 200 }); return true;
  });
  assert.equal(calls, 1);
});

test('network, timeout, cancellation and unrelated local errors stay distinct without echoing their messages', async t => {
  const ai = await client(); const secret = 'PRIVATE-MANUSCRIPT-CANARY';
  let raised = new TypeError(secret); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw raised; });
  await assert.rejects(ai.chat(opts), error => { assert.deepEqual(ai.safeAiFailure(error), { kind: 'network' }); assert.ok(!error.message.includes(secret)); return true; });
  raised = new Error(secret);
  await assert.rejects(ai.chat(opts), error => { assert.deepEqual(ai.safeAiFailure(error), { kind: 'unknown' }); assert.ok(!error.message.includes(secret)); return true; });
  for (const [reason, kind] of [[new DOMException(secret, 'TimeoutError'), 'timeout'], [new Error(secret), 'aborted']]) {
    await assert.rejects(ai.chat({ ...opts, signal: AbortSignal.abort(reason) }), error => {
      assert.deepEqual(ai.safeAiFailure(error), { kind }); assert.ok(!error.message.includes(secret)); return true;
    });
  }
  assert.equal(calls, 2); // No retry or request after cancellation.
  assert.deepEqual(ai.safeAiFailure({ name: 'AiRequestError', diagnostic: { kind: 'http', httpStatus: 503, code: secret }, message: secret }), { kind: 'unknown' });
  const forged = new ai.AiRequestError({ kind: secret, httpStatus: 999, code: secret });
  assert.deepEqual(ai.safeAiFailure(forged), { kind: 'unknown' }); assert.ok(!forged.message.includes(secret));
});

test('native structured review sends only the fixed five-boolean schema using output_config.format', async t => {
  const ai = await client(); let calls = 0;
  const decision = { safe: true, grounded: true, private: true, relevant: true, respectful: true };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; const body = JSON.parse(init.body);
    assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: {
      type: 'object', properties: Object.fromEntries(Object.keys(decision).map(key => [key, { type: 'boolean' }])),
      required: Object.keys(decision), additionalProperties: false,
    } } });
    assert.equal(body.tools, undefined); assert.equal(body.output_format, undefined);
    return json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(decision) }] });
  });
  assert.equal(await ai.chat({ ...opts, reviewOutput: 'json_schema' }), JSON.stringify(decision));
  assert.equal(calls, 1);
});

test('tool review requires exactly one named five-boolean tool input and never accepts text as a decision', async t => {
  const ai = await client();
  const decision = { safe: true, grounded: true, private: false, relevant: true, respectful: true };
  const tool = { type: 'tool_use', name: 'submit_safety_review', input: decision };
  let current = { stop_reason: 'tool_use', content: [tool] }; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; const body = JSON.parse(init.body);
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_safety_review', disable_parallel_tool_use: true });
    assert.equal(body.tools.length, 1); assert.equal(body.tools[0].name, 'submit_safety_review');
    assert.equal(body.tools[0].input_schema.additionalProperties, false); assert.equal(body.output_config, undefined);
    return json(current);
  });
  assert.deepEqual(JSON.parse(await ai.chat({ ...opts, reviewOutput: 'tool' })), decision); // false stays false.
  for (const content of [
    [{ type: 'text', text: JSON.stringify(decision) }],
    [{ ...tool, name: 'different_tool' }], [tool, tool],
    [{ ...tool, input: { ...decision, secret: fakeKey } }],
    [{ ...tool, input: { ...decision, safe: 'true' } }],
  ]) {
    current = { stop_reason: 'tool_use', content };
    await assert.rejects(ai.chat({ ...opts, reviewOutput: 'tool' }), error => {
      assert.deepEqual(ai.safeAiFailure(error), { kind: 'invalid_response', httpStatus: 200 });
      assert.ok(!error.message.includes(fakeKey)); return true;
    });
  }
  assert.equal(calls, 6);
});

test('unsupported structured requests fail closed without silently falling back or making another call', async t => {
  const ai = await client(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ error: { type: 'invalid_request_error', message: fakeKey } }, 400); });
  await assert.rejects(ai.chat({ ...opts, reviewOutput: 'json_schema' }), error => ai.safeAiFailure(error).httpStatus === 400);
  assert.equal(calls, 1);
  const openai = await client({ AI_MODEL: 'gpt-test' });
  await assert.rejects(openai.chat({ ...opts, reviewOutput: 'json_schema' }), error => ai.safeAiFailure(error).httpStatus === 400);
  await assert.rejects(collect(ai.chatStream({ ...opts, reviewOutput: 'tool' })), /non-streaming/);
  assert.equal(calls, 2);
});

test('effort applies only to Sonnet 5 review, preserves schemas, and never alters ordinary generation', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return json({ content: [{ type: 'text', text: 'fixture' }] }); });
  for (const effort of ['medium', 'low']) {
    const ai = await client({ AI_MODEL: 'claude-sonnet-5', AI_REVIEW_EFFORT: effort });
    await ai.chat(opts); assert.equal(body.output_config, undefined); assert.equal(body.thinking, undefined);
    await ai.chat({ ...opts, reviewOutput: 'json_schema' });
    assert.equal(body.output_config.effort, effort); assert.equal(body.output_config.format.type, 'json_schema');
  }
  const invalid = await client({ AI_MODEL: 'claude-sonnet-5', AI_REVIEW_EFFORT: 'PRIVATE-CONFIG-CANARY' });
  await invalid.chat(opts); // Invalid review configuration cannot alter ordinary generation.
  await assert.rejects(invalid.chat({ ...opts, reviewOutput: 'text' }), { message: 'Invalid AI review effort configuration' });
  const unsupported = await client({ AI_MODEL: 'claude-fable-5-2', AI_REVIEW_EFFORT: 'low' });
  await assert.rejects(unsupported.chat({ ...opts, reviewOutput: 'text' }), /Unsupported review effort/);
});

test('Qwen uses native OpenAI schema/tool requests with exact model non-thinking options', async t => {
  const decision = { safe: true, grounded: true, private: true, relevant: true, respectful: true };
  let mode = 'generation';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://relay.example/v1/chat/completions'); assert.equal(init.headers.Authorization, `Bearer ${fakeKey}`);
    assert.equal(body.enable_thinking, false); assert.equal(body.output_config, undefined); assert.equal(body.store, false);
    if (mode === 'generation') { assert.equal(body.tools, undefined); assert.equal(body.response_format, undefined); }
    if (mode === 'schema') {
      assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    }
    if (mode === 'tool') {
      assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_safety_review' } });
      assert.equal(body.parallel_tool_calls, false); assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].function.parameters.additionalProperties, false);
      return json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'submit_safety_review', arguments: JSON.stringify(decision) } }] } }] });
    }
    return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] });
  });
  for (const model of ['qwen3.7-plus', 'qwen3.8-flash']) {
    const ai = await client({ AI_MODEL: model });
    mode = 'generation'; await ai.chat(opts);
    mode = 'schema'; assert.equal(await ai.chat({ ...opts, reviewOutput: 'json_schema' }), JSON.stringify(decision));
    mode = 'tool'; assert.equal(await ai.chat({ ...opts, reviewOutput: 'tool' }), JSON.stringify(decision));
  }
});

test('OpenAI tool review rejects text, truncation, extra or ambiguous calls and malformed arguments without retries', async t => {
  const ai = await client({ AI_MODEL: 'qwen3.8-flash' });
  const decision = { safe: true, grounded: false, private: true, relevant: true, respectful: true };
  const tool = { type: 'function', function: { name: 'submit_safety_review', arguments: JSON.stringify(decision) } };
  const choice = { finish_reason: 'tool_calls', message: { tool_calls: [tool] } };
  let current = { choices: [choice] }; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json(current); });
  assert.deepEqual(JSON.parse(await ai.chat({ ...opts, reviewOutput: 'tool' })), decision);
  const cases = [
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] },
    { choices: [{ ...choice, finish_reason: 'stop' }] }, { choices: [choice, choice] },
    ...[
      [tool, tool], [{ ...tool, type: 'other' }],
      [{ ...tool, function: { ...tool.function, name: 'other' } }],
      ...['```json\n' + JSON.stringify(decision) + '\n```', 'PRIVATE-ARGUMENT-CANARY', JSON.stringify({ ...decision, extra: true }), JSON.stringify({ ...decision, safe: 'true' }), '{"safe":false,' + JSON.stringify(decision).slice(1)].map(arguments_ => [{ ...tool, function: { ...tool.function, arguments: arguments_ } }]),
    ].map(tool_calls => ({ choices: [{ ...choice, message: { tool_calls } }] })),
  ];
  for (const data of cases) {
    current = data;
    await assert.rejects(ai.chat({ ...opts, reviewOutput: 'tool' }), error => {
      assert.deepEqual(ai.safeAiFailure(error), { kind: 'invalid_response', httpStatus: 200 }); assert.ok(!error.message.includes('PRIVATE')); return true;
    });
  }
  current = { choices: [{ ...choice, finish_reason: 'length' }] };
  await assert.rejects(ai.chat({ ...opts, reviewOutput: 'tool' }), error => ai.safeAiFailure(error).kind === 'truncated_response');
  assert.equal(calls, cases.length + 2);
});
