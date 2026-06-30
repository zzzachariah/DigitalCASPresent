import type { Person, Section } from "./types";

// ─── Language handling ───────────────────────────────────────────────

function languageRule(personLang: Person["language"]): string {
  switch (personLang) {
    case "en":
      return "Always answer in English.";
    case "zh":
      return "Always answer in Simplified Chinese (简体中文).";
    case "bilingual":
      return "Answer first in English, then give a Simplified Chinese translation on a new line prefixed with “中文：”.";
    case "auto":
    default:
      return "Detect the language of the visitor's latest message and answer in that same language. If it is unclear, match the language of the script.";
  }
}

// Shared style guardrails — keep it natural, spoken, non-repetitive, simple.
const STYLE = `You are speaking out loud as a friendly museum-style guide standing next to the exhibit.
Style rules:
- Speak naturally and warmly, in the first person, as if you ARE the student presenting.
- Keep it concise: 2–5 short sentences for a section; 1–3 for a follow-up. Never pad.
- Do NOT repeat points you already made earlier in the conversation.
- Avoid jargon and over-complex phrasing; explain ideas plainly.
- Never invent facts that aren't supported by the script. If asked something the
  script doesn't cover, say so briefly and offer what you can speak to.
- No markdown, no bullet symbols, no stage directions — just plain spoken sentences.`;

// ─── System prompt builder ───────────────────────────────────────────

export function systemPrompt(person: Person): string {
  return [
    `You are the digital voice of ${person.name}, presenting their IBDP TOK Exhibition.`,
    person.subtitle ? `Context: ${person.subtitle}` : "",
    STYLE,
    languageRule(person.language),
    "",
    "=== FULL SCRIPT (your single source of truth) ===",
    person.script.trim(),
    "=== END SCRIPT ===",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Prompt for the initial spoken explanation of a chosen section. */
export function explainSectionPrompt(section: Section): string {
  return [
    `The visitor chose to hear this part of your exhibition: “${section.title}”.`,
    "",
    "Here is the relevant portion of your script for this part:",
    `"""${section.content.trim()}"""`,
    "",
    "Give your spoken explanation of THIS part now. Make it engaging and clear,",
    "drawing only on the script. End naturally — do not list what else you could cover.",
  ].join("\n");
}

/** Prompt for a free-text follow-up question. */
export function followUpPrompt(
  question: string,
  currentSectionTitle?: string
): string {
  return [
    currentSectionTitle
      ? `(The visitor was just hearing about “${currentSectionTitle}”.)`
      : "",
    `Visitor asks: “${question.trim()}”`,
    "",
    "Answer their question directly and briefly, grounded in your script.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Auto-sectioning prompt (used at upload time) ────────────────────

export function autoSectionPrompt(script: string): string {
  return [
    "You are helping prepare an IBDP TOK Exhibition talk for an interactive guide.",
    "Split the following script into a small number of logical PARTS a visitor",
    "could choose to hear (typically: an introduction, one part per object/example,",
    "and a short conclusion — usually 3 to 6 parts total).",
    "",
    "Return ONLY valid JSON, no prose, in exactly this shape:",
    `{"sections":[{"title":"short title (≤4 words)","hint":"one short teaser line","content":"the verbatim portion of the script for this part"}]}`,
    "",
    "Rules:",
    "- Use the script's own language for titles/hints/content.",
    "- 'content' must be copied from the script (you may lightly trim), covering it fully across all parts with no overlap.",
    "- Titles should be human and specific (e.g. 'Object 1: The Passport', not 'Part 2').",
    "",
    "=== SCRIPT ===",
    script.trim(),
    "=== END ===",
  ].join("\n");
}
