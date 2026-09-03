import type { ChatTurn } from "./types";

// ─────────────────────────────────────────────────────────────────────
// AI client — talks to packyapi (or any OpenAI-compatible relay).
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

function requestBody(opts: ChatOptions, stream: boolean) {
  return JSON.stringify({
    model: opts.live ? MODEL_LIVE : MODEL,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 600,
    stream,
    messages: [
      { role: "system", content: opts.system },
      ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  });
}

const HEADERS = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` });

export async function chat(opts: ChatOptions): Promise<string> {
  if (aiIsMock()) return mockChat(opts);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: HEADERS(),
    body: requestBody(opts, false),
    signal: upstreamSignal(opts.signal, 90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI returned an empty response.");
  return text;
}

/** Streaming variant: yields text deltas as the model produces them. */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string> {
  if (aiIsMock()) {
    // Simulate token streaming so the UI path is exercised without a key.
    const text = mockChat(opts);
    const words = text.match(/\S+\s*|\s+/g) || [text];
    for (const w of words) {
      await new Promise((r) => setTimeout(r, 24));
      yield w;
    }
    return;
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: HEADERS(),
    body: requestBody(opts, true),
    signal: upstreamSignal(opts.signal, 60_000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 400)}`);
  }
  // Some relays ignore `stream: true` and reply with a normal JSON completion.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("AI returned an empty response.");
    yield text;
    return;
  }

  // OpenAI-style SSE: lines of `data: {json}` ending with `data: [DONE]`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let yielded = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          yielded = true;
          yield delta;
        }
      } catch {
        /* ignore keep-alives / partial lines */
      }
    }
  }
  if (!yielded) throw new Error("AI returned an empty response.");
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

export { MODEL as AI_MODEL_NAME, MODEL_LIVE as AI_MODEL_LIVE_NAME, BASE_URL as AI_BASE_URL_RESOLVED };
