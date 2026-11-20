import type { NarrationRequest } from "./admin-narration";

const PHASE_LABELS: Record<string, string> = {
  generation: "正在生成文字讲解", revision: "正在修订讲解", review: "正在审核讲解内容", read: "正在读取已有资料",
  audio_preparation: "正在检查已有配音", tts: "正在合成配音", download: "正在下载配音",
  audio_save: "正在保存配音", audio_verification: "正在校验配音",
  source_recheck: "正在复核讲解与资料", persist: "正在保存讲解与配音记录", persist_verification: "正在核验保存结果",
};

/** Stream events contain only fixed phase labels. Completion still requires
 * the final result and saved records; an interrupted stream never implies success. */
export async function readNarrationResponse(
  response: Response,
  expected: Pick<NarrationRequest, "sectionId" | "language">,
  onPhase: (label: string) => void,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
  }
  if (!response.body) throw new Error("Preparation stream interrupted");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { ok: boolean; status: number; data: unknown } | undefined;
  let events = 0;
  function consume(line: string) {
    if (!line.trim()) return;
    if (++events > 512) throw new Error("Invalid preparation stream");
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Invalid preparation stream"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid preparation stream");
    if (event.type === "phase") {
      if (result) throw new Error("Invalid preparation stream");
      if (event.sectionId === expected.sectionId && event.language === expected.language &&
          typeof event.phase === "string" && Object.prototype.hasOwnProperty.call(PHASE_LABELS, event.phase)) onPhase(PHASE_LABELS[event.phase]);
    } else if (event.type === "result") {
      if (result || !Number.isInteger(event.status) || event.status < 200 || event.status > 599 || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("Invalid preparation stream");
      result = { ok: event.status >= 200 && event.status < 300, status: event.status, data: event.data };
    }
  }
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Invalid preparation stream");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (chunk.done) break;
    }
    consume(buffer);
    if (!result) throw new Error("Preparation stream interrupted");
    return result;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Preparation stream interrupted");
  } finally {
    reader.releaseLock();
  }
}
