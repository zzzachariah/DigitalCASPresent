import { nanoid } from "nanoid";
import type { AnswerLang, PersonInput, PersonLanguage, Section } from "./types";

// ─────────────────────────────────────────────────────────────────────
// Input validation shared by the admin and the student (self-submission)
// endpoints. Everything a browser sends is untrusted; this trims, bounds
// and whitelists it into a PersonInput.
// ─────────────────────────────────────────────────────────────────────

export const LIMITS = {
  name: 60,
  subtitle: 140,
  script: 40_000,
  sections: 12,
  sectionTitle: 80,
  sectionHint: 160,
  sectionContent: 40_000,
  cachedAnswer: 4_000,
} as const;

const LANGUAGES: PersonLanguage[] = ["auto", "en", "zh", "bilingual"];
const ANSWER_LANGS: AnswerLang[] = ["en", "zh", "bilingual"];

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function sectionFrom(raw: unknown, allowCachedAnswers: boolean): Section | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = str(s.id);
  const section: Section = {
    id: id && /^[A-Za-z0-9_-]{1,32}$/.test(id) ? id : nanoid(8),
    title: (str(s.title) || "").trim().slice(0, LIMITS.sectionTitle) || "Untitled",
    content: (str(s.content) || "").trim().slice(0, LIMITS.sectionContent),
  };
  const hint = (str(s.hint) || "").trim().slice(0, LIMITS.sectionHint);
  if (hint) section.hint = hint;
  if (allowCachedAnswers && s.cachedAnswers && typeof s.cachedAnswers === "object") {
    const cached: Partial<Record<AnswerLang, string>> = {};
    for (const key of ANSWER_LANGS) {
      const text = str((s.cachedAnswers as Record<string, unknown>)[key])?.trim();
      if (text) cached[key] = text.slice(0, LIMITS.cachedAnswer);
    }
    if (Object.keys(cached).length) section.cachedAnswers = cached;
  }
  return section;
}

/** Validate a create (partial=false: name+script required) or an update
 *  (partial=true: only supplied fields are returned). */
export function parsePersonInput(
  body: unknown,
  opts: { partial: boolean; allowCachedAnswers: boolean }
): Validation<Partial<PersonInput>> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: Partial<PersonInput> = {};

  if (b.name !== undefined || !opts.partial) {
    const name = (str(b.name) || "").trim();
    if (!name) return { ok: false, error: "请填写姓名 / Name is required" };
    if (name.length > LIMITS.name) return { ok: false, error: `姓名过长（≤${LIMITS.name} 字）/ Name too long` };
    out.name = name;
  }
  if (b.subtitle !== undefined) {
    const subtitle = (str(b.subtitle) || "").trim();
    if (subtitle.length > LIMITS.subtitle) return { ok: false, error: "副标题过长 / Subtitle too long" };
    out.subtitle = subtitle || undefined;
  }
  if (b.gender !== undefined) {
    out.gender = b.gender === "male" || b.gender === "female" ? b.gender : undefined;
  }
  if (b.script !== undefined || !opts.partial) {
    const script = (str(b.script) || "").trim();
    if (!script) return { ok: false, error: "请提供讲稿 / Script is required" };
    if (script.length > LIMITS.script) {
      return { ok: false, error: `讲稿过长（≤${LIMITS.script} 字）/ Script too long` };
    }
    out.script = script;
  }
  if (b.language !== undefined || !opts.partial) {
    const lang = str(b.language);
    out.language = lang && (LANGUAGES as string[]).includes(lang) ? (lang as PersonLanguage) : "auto";
  }
  if (b.sections !== undefined || !opts.partial) {
    const raw = Array.isArray(b.sections) ? b.sections : [];
    if (raw.length > LIMITS.sections) {
      return { ok: false, error: `分段太多（≤${LIMITS.sections} 个）/ Too many sections` };
    }
    out.sections = raw
      .map((s) => sectionFrom(s, opts.allowCachedAnswers))
      .filter((s): s is Section => !!s);
  }
  return { ok: true, value: out };
}
