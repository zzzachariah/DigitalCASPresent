import type { ChatTurn } from "./types";

// ─────────────────────────────────────────────────────────────────────
// AI client — supports Anthropic Messages and OpenAI Chat Completions.
//
// If AI_API_KEY is empty we fall back to MOCK mode so the whole product
// works end-to-end for a demo without any key or cost.
// ─────────────────────────────────────────────────────────────────────

const API_KEY = process.env.AI_API_KEY?.trim() || "";
const BASE_URL = (process.env.AI_BASE_URL || "https://www.packyapi.com/v1").replace(/\/$/, "");
/** Model for offline work (auto-sectioning, pre-generation): quality first. */
const MODEL = process.env.AI_MODEL || "claude-opus-4-8";
/** Model for live answers while a visitor waits: set AI_MODEL_LIVE to a
 *  faster model to cut first-token latency; defaults to AI_MODEL. */
const MODEL_LIVE = process.env.AI_MODEL_LIVE?.trim() || MODEL;
/** `auto` chooses Messages for Claude and Chat Completions for other models.
 *  Set explicitly when a relay uses a model alias that hides its provider. */
const PROTOCOL = process.env.AI_API_PROTOCOL?.trim().toLowerCase() || "auto";
type Protocol = "anthropic" | "openai";

function protocolFor(model: string): Protocol {
  if (PROTOCOL === "anthropic" || PROTOCOL === "openai") return PROTOCOL;
  if (PROTOCOL !== "auto") throw new Error("AI_API_PROTOCOL must be auto, anthropic, or openai.");
  return /(?:^|[/:])claude(?:-|$)/i.test(model) ? "anthropic" : "openai";
}

export function aiIsMock(): boolean {
  return !API_KEY;
}

export interface ChatOptions {
  system: string;
  messages: ChatTurn[];
  temperature?: number;
  maxTokens?: number;
  /** Use the faster live model (default: the quality model). */
  live?: boolean;
  /** Aborted when the visitor leaves or taps something else. */
  signal?: AbortSignal;
}

/** Upstream request signal: the caller's abort, plus a hard timeout. */
function upstreamSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function request(opts: ChatOptions, stream: boolean) {
  const model = opts.live ? MODEL_LIVE : MODEL;
  const protocol = protocolFor(model);
  const common = {
    model,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 600,
    stream,
  };
  const turns = opts.messages.map((m) => ({ role: m.role, content: m.content }));
  const headers: Record<string, string> = protocol === "anthropic"
    ? { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };
  return {
    protocol,
    // AI_BASE_URL may include /v1 (the existing configuration) or be an
    // Anthropic SDK-style origin. Keep requests on the configured host.
    url: protocol === "anthropic"
      ? `${BASE_URL.replace(/\/v1$/, "")}/v1/messages`
      : `${BASE_URL}/chat/completions`,
    headers,
    body: JSON.stringify(protocol === "anthropic" ? {
      ...common,
      system: opts.system,
      messages: turns,
    } : {
      ...common,
      messages: [
        { role: "system", content: opts.system },
        ...turns,
      ],
    }),
  };
}

type Completion = {
  content?: { type?: string; text?: string }[];
  choices?: { message?: { content?: string }; delta?: { content?: string }; finish_reason?: string | null }[];
  type?: string;
  delta?: { type?: string; text?: string };
  content_block?: { type?: string; text?: string };
  error?: { type?: string; code?: string; message?: string };
};

/** Only structured error details reach server logs; never an arbitrary
 *  upstream HTML/body that could echo request headers or the full script. */
function upstreamError(status: number, data?: Completion): Error {
  const error = data?.error;
  let code = String(error?.code || error?.type || "");
  if (API_KEY) code = code.split(API_KEY).join("redacted");
  code = code.replace(/[^\w-]/g, "").slice(0, 80);
  let detail = typeof error?.message === "string" ? error.message : "";
  if (API_KEY) detail = detail.split(API_KEY).join("[redacted]");
  detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk-[\w-]+/g, "[redacted]").slice(0, 240);
  return new Error(`AI request failed (${status}${code ? `; ${code}` : ""})${detail ? `: ${detail}` : "."}`);
}

async function checkResponse(res: Response): Promise<void> {
  if (res.ok) return;
  const data = await res.json().catch(() => undefined) as Completion | undefined;
  throw upstreamError(res.status, data);
}

async function readCompletion(res: Response, signal: AbortSignal): Promise<Completion> {
  try {
    const data = await res.json() as Completion;
    signal.throwIfAborted();
    return data;
  } catch {
    signal.throwIfAborted();
    // JSON parser errors can include fragments of the upstream body.
    throw new Error("AI returned an invalid JSON response.");
  }
}

function completionText(data: Completion, protocol: Protocol): string {
  if (!data || typeof data !== "object") throw new Error("AI returned an invalid response.");
  if (data.error) throw upstreamError(200, data);
  const text = protocol === "anthropic"
    ? (Array.isArray(data.content) ? data.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("") : "")
    : data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI returned an empty response.");
  return text.trim();
}

export async function chat(opts: ChatOptions): Promise<string> {
  opts.signal?.throwIfAborted();
  if (aiIsMock()) return mockChat(opts);
  const req = request(opts, false);
  const signal = upstreamSignal(opts.signal, 90_000);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal,
  });
  await checkResponse(res);
  const data = await readCompletion(res, signal);
  return completionText(data, req.protocol);
}

/** SSE records can span transport chunks and use LF, CRLF, or CR lines.
 *  Flush a final unterminated record and cancel the body when a caller stops. */
async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  let dataLines: string[] = [];
  let dataSize = 0;

  function line(value: string): string | undefined {
    if (!value) {
      const payload = dataLines.length ? dataLines.join("\n") : undefined;
      dataLines = [];
      dataSize = 0;
      return payload;
    }
    if (value.startsWith("data:")) {
      const data = value.slice(5).replace(/^ /, "");
      dataSize += data.length;
      if (dataSize > 1_000_000) throw new Error("AI streaming event is too large.");
      dataLines.push(data);
    }
    return undefined;
  }

  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error("AI streaming event is too large.");
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== "\n" && buffer[i] !== "\r") continue;
        if (buffer[i] === "\r" && i + 1 === buffer.length && !done) break;
        const payload = line(buffer.slice(start, i));
        if (payload !== undefined) yield payload;
        if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer) line(buffer);
        const payload = line("");
        if (payload !== undefined) yield payload;
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Streaming variant: yields text deltas as the model produces them. */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string> {
  opts.signal?.throwIfAborted();
  if (aiIsMock()) {
    // Simulate token streaming so the UI path is exercised without a key.
    const text = mockChat(opts);
    const words = text.match(/\S+\s*|\s+/g) || [text];
    for (const w of words) {
      await new Promise((r) => setTimeout(r, 24));
      opts.signal?.throwIfAborted();
      yield w;
    }
    return;
  }

  const req = request(opts, true);
  const signal = upstreamSignal(opts.signal, 60_000);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal,
  });
  await checkResponse(res);
  if (!res.body) throw new Error("AI returned an empty response.");
  // Some relays ignore `stream: true` and reply with a normal JSON completion.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const data = await readCompletion(res, signal);
    yield completionText(data, req.protocol);
    return;
  }

  let yielded = false;
  let completed = false;
  for await (const payload of sseData(res.body, signal)) {
    if (payload.trim() === "[DONE]") {
      completed = true;
      break;
    }
    let event: Completion;
    try {
      event = JSON.parse(payload) as Completion;
    } catch {
      throw new Error("AI returned an invalid streaming event.");
    }
    if (!event || typeof event !== "object") throw new Error("AI returned an invalid streaming event.");
    if (event.error || event.type === "error") throw upstreamError(200, event);
    if (event.type === "message_stop") {
      completed = true;
      break;
    }
    const delta = req.protocol === "anthropic"
      ? event.type === "content_block_delta" && event.delta?.type === "text_delta"
        ? event.delta.text
        : event.type === "content_block_start" && event.content_block?.type === "text"
          ? event.content_block.text : undefined
      : event.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      yielded ||= Boolean(delta.trim());
      yield delta;
    }
    if (req.protocol === "openai" && event.choices?.[0]?.finish_reason) completed = true;
  }
  if (!yielded) throw new Error("AI returned an empty response.");
  if (!completed) throw new Error("AI response ended before it was complete.");
}

/** Parse a JSON object out of a model response that may be wrapped in prose/fences. */
export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found.");
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

// ─── Mock mode ───────────────────────────────────────────────────────

function looksChinese(s: string): boolean {
  return /[一-鿿]/.test(s);
}

function mockChat(opts: ChatOptions): string {
  const last = [...opts.messages].reverse().find((m) => m.role === "user");
  const q = last?.content ?? "";
  const zh = looksChinese(q) || looksChinese(opts.system.slice(0, 200));

  // Auto-section request? Return a tiny valid JSON so the upload flow works offline.
  if (/Return ONLY valid JSON/i.test(opts.system) || /"sections"/.test(q)) {
    const para = (opts.system.match(/=== SCRIPT ===([\s\S]*?)=== END/i)?.[1] || q)
      .trim()
      .split(/\n\s*\n/)
      .filter(Boolean);
    const chunks = para.length >= 3 ? para : [q];
    const sections = chunks.slice(0, 5).map((c, i) => ({
      title: i === 0 ? "Introduction" : `Part ${i + 1}`,
      hint: c.slice(0, 40).replace(/\s+/g, " ") + "…",
      content: c,
    }));
    return JSON.stringify({ sections });
  }

  if (zh) {
    return "（演示模式）这是一段示例讲解。我的展品围绕一个核心知识问题展开，它让我重新思考我们如何获得知识。接好真实的 packyapi key 后，这里会换成 AI 依据讲稿生成的真实回答。\n---\n能举个例子吗？\n这个物品为什么打动你？\n它和知识问题有什么关系？";
  }
  return "(Demo mode) Here's a sample explanation. My exhibit explores one core knowledge question about how we come to trust what we know. Once a real packyapi key is connected, this will be replaced by a genuine answer grounded in the script.\n---\nCan you give an example?\nWhy did you choose this object?\nHow does it connect to the knowledge question?";
}

export { MODEL as AI_MODEL_NAME, MODEL_LIVE as AI_MODEL_LIVE_NAME, BASE_URL as AI_BASE_URL_RESOLVED, PROTOCOL as AI_API_PROTOCOL_NAME };
