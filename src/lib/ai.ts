import type { ChatTurn } from "./types";

// ─────────────────────────────────────────────────────────────────────
// AI client — talks to packyapi (or any OpenAI-compatible relay).
//
// If AI_API_KEY is empty we fall back to MOCK mode so the whole product
// works end-to-end for a demo without any key or cost.
// ─────────────────────────────────────────────────────────────────────

const API_KEY = process.env.AI_API_KEY?.trim() || "";
const BASE_URL = (process.env.AI_BASE_URL || "https://www.packyapi.com/v1").replace(/\/$/, "");
const MODEL = process.env.AI_MODEL || "claude-3-5-sonnet-20241022";

export function aiIsMock(): boolean {
  return !API_KEY;
}

export interface ChatOptions {
  system: string;
  messages: ChatTurn[];
  temperature?: number;
  maxTokens?: number;
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (aiIsMock()) return mockChat(opts);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: opts.temperature ?? 0.6,
      max_tokens: opts.maxTokens ?? 600,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI returned an empty response.");
  return text;
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
    return "（演示模式）这是一段示例讲解：我的展品围绕一个核心知识问题展开，它让我重新思考“我们如何获得知识”。接好真实的 packyapi key 后，这里会换成 AI 依据讲稿生成的真实回答。你想继续追问，还是听其他部分？";
  }
  return "(Demo mode) Here's a sample explanation: my exhibit explores one core knowledge question about how we come to trust what we know. Once a real packyapi key is connected, this will be replaced by a genuine answer grounded in the script. Would you like to ask a follow-up, or hear another part?";
}

export { MODEL as AI_MODEL_NAME, BASE_URL as AI_BASE_URL_RESOLVED };
