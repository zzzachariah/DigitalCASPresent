import type { AnswerLang } from "./types";
import type { PreparationPhase } from "./prepared-narration";

export interface PreparationProgress {
  sectionId: string;
  language: AnswerLang;
  phase: PreparationPhase;
}
export interface PreparationOutcome { status: number; data: Record<string, unknown> }
export type PreparationReporter = (progress: PreparationProgress) => void;
const PHASES = new Set<PreparationPhase>([
  "generation", "review", "read", "audio_preparation", "tts", "download",
  "audio_save", "audio_verification", "source_recheck", "persist", "persist_verification",
]);

export function wantsPreparationStream(accept: string | null): boolean {
  return !!accept?.split(",").some((item) => {
    const [media, ...params] = item.trim().toLowerCase().split(";");
    return media.trim() === "application/x-ndjson" && !params.some((param) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param));
  });
}

/** One workflow for both representations. The lock stays held for the entire
 * workflow, including cancellation; stream headers never imply job success. */
export async function preparationResponse(options: {
  stream: boolean;
  requestSignal?: AbortSignal;
  run: (signal: AbortSignal, report: PreparationReporter) => Promise<PreparationOutcome>;
  release: () => void;
}): Promise<Response> {
  const cancellation = new AbortController();
  const deadline = AbortSignal.timeout(100_000);
  const signal = AbortSignal.any([cancellation.signal, deadline, ...(options.requestSignal ? [options.requestSignal] : [])]);
  const headers = { "Cache-Control": "private, no-store, no-transform" };
  let released = false;
  const release = () => { if (!released) { released = true; options.release(); } };
  if (!options.stream) {
    try {
      const result = await options.run(signal, () => {});
      return Response.json(result.data, { status: result.status, headers });
    } finally { release(); }
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        if (closed || cancellation.signal.aborted || options.requestSignal?.aborted) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
        catch { closed = true; cancellation.abort(); }
      };
      const report: PreparationReporter = (progress) => {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(progress.sectionId) || !["en", "zh", "bilingual"].includes(progress.language) || !PHASES.has(progress.phase)) return;
        // Reconstruct the event so no extra fields can leak source/provider text.
        send({ type: "phase", sectionId: progress.sectionId, language: progress.language, phase: progress.phase });
      };
      try {
        const result = await options.run(signal, report);
        send({ type: "result", status: result.status, data: result.data });
      } catch {
        // Unexpected exceptions are never serialized, even for authenticated users.
        send({ type: "result", status: 503, data: { error: "preparation_failed", code: "preparation_failed" } });
      } finally {
        release();
        closed = true;
        try { controller.close(); } catch { /* disconnected */ }
      }
    },
    cancel() {
      closed = true;
      cancellation.abort();
      // The workflow's finally releases the lock after in-flight work settles.
    },
  });
  return new Response(stream, { headers: {
    ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no",
  } });
}
