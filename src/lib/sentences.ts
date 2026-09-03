// ─────────────────────────────────────────────────────────────────────
// Text helpers shared by the streaming chat route and the visitor page:
// sentence chunking (so narration can start after the first sentence)
// and the "answer + suggested questions" trailer protocol.
// ─────────────────────────────────────────────────────────────────────

/** The model ends its answer with a line of three hyphens, then up to three
 *  questions. Matched without requiring a preceding newline — a stray "---"
 *  never belongs in spoken text anyway. */
export const SUGGESTION_MARKER = "---";

/** Split a completed model response into the spoken answer and the
 *  suggested follow-up questions (if the model included them). */
export function splitAnswer(raw: string): { answer: string; suggestions: string[] } {
  const idx = raw.indexOf(SUGGESTION_MARKER);
  if (idx === -1) return { answer: raw.trim(), suggestions: [] };
  const answer = raw.slice(0, idx).trim();
  const suggestions = parseSuggestions(raw.slice(idx + SUGGESTION_MARKER.length));
  return { answer, suggestions };
}

export function parseSuggestions(tail: string): string[] {
  return tail
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-–•*?？]+/, "").replace(/^(?:q\d*|\d+)\s*[.)、:：]\s*/i, "").trim())
    .filter((l) => l.length > 1 && l.length <= 120)
    .slice(0, 3);
}

/** How many trailing characters of `buf` could be the start of the marker
 *  (so a streaming emitter holds them back instead of showing "--"). */
export function markerHoldback(buf: string): number {
  for (let n = Math.min(SUGGESTION_MARKER.length - 1, buf.length); n > 0; n--) {
    if (SUGGESTION_MARKER.startsWith(buf.slice(-n))) return n;
  }
  return 0;
}

const END = /[。！？!?]+["'”’)）]*|[.;；]+(?=\s|$)["'”’)）]*|\n+/g;
const MIN = 12;
const MAX = 140;

/** Pull complete sentences off the front of `buf`. Returns the chunks ready
 *  for TTS and the remainder still being written. Short sentences are merged
 *  so we don't fire TTS for "Yes." alone; very long runs are cut at a comma. */
export function takeSentences(buf: string, flush = false): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let rest = buf;
  let current = "";
  while (true) {
    END.lastIndex = 0;
    const m = END.exec(rest);
    if (!m) break;
    const end = m.index + m[0].length;
    current += rest.slice(0, end);
    rest = rest.slice(end);
    if (current.trim().length >= MIN) {
      chunks.push(current.trim());
      current = "";
    }
  }
  // Left-over partial sentence goes back to the front of the remainder.
  rest = (current + rest).replace(/^\s+/, "");
  // A long sentence still in progress: cut at the last comma past MAX.
  if (!flush && rest.length > MAX) {
    const cut = Math.max(rest.lastIndexOf("，"), rest.lastIndexOf(", "), rest.lastIndexOf("、"));
    if (cut > MIN) {
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
  }
  if (flush && rest.trim()) {
    chunks.push(rest.trim());
    rest = "";
  }
  return { chunks, rest };
}
