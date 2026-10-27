import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Compile only this dependency-free module: no real key, model, or network.
const source = await readFile(new URL('../src/lib/ai.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
let moduleId = 0;
const fakeKey = 'test-only-not-a-real-key';
const opts = { system: 'Use only the supplied exhibit.', messages: [{ role: 'user', content: 'Explain it.' }] };

async function client(overrides = {}) {
  const config = { AI_API_KEY: fakeKey, AI_BASE_URL: 'https://relay.example/v1/', AI_MODEL: 'claude-opus-test', AI_MODEL_LIVE: '', AI_API_PROTOCOL: 'auto', ...overrides };
  const before = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, config);
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
