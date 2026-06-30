// ─── Core data model ────────────────────────────────────────────────

/** One logical part of a person's talk that a visitor can choose to hear. */
export interface Section {
  id: string;
  /** Short title shown on the section chip, e.g. "Introduction" / "Object 1". */
  title: string;
  /** One-line teaser shown under the title (optional). */
  hint?: string;
  /** The portion of the script this section covers. Used as AI context. */
  content: string;
}

/** A person = one digital human = one QR code. */
export interface Person {
  id: string;
  /** Short, URL-safe public slug used in the QR link (/p/<slug>). */
  slug: string;
  name: string;
  /** Optional subtitle, e.g. "IBDP TOK Exhibition · Theme: Knowledge & Technology". */
  subtitle?: string;
  /** Stored photo URL (served from /api/photo/<id> or a blob URL). */
  photoUrl?: string;
  /** Full raw script text (source of truth for the AI). */
  script: string;
  /** Script divided into the parts a visitor can pick. */
  sections: Section[];
  /** Preferred default answer language: "auto" follows the visitor. */
  language: "auto" | "en" | "zh" | "bilingual";
  createdAt: number;
  updatedAt: number;
}

/** Public-facing shape (never leaks the full script to the browser wholesale
 *  beyond what's needed; we do send section content so the menu can render). */
export interface PublicPerson {
  id: string;
  slug: string;
  name: string;
  subtitle?: string;
  photoUrl?: string;
  language: Person["language"];
  sections: { id: string; title: string; hint?: string }[];
}

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** What the avatar layer returns to the browser for one answer. */
export type AvatarResult =
  | { kind: "video"; videoUrl: string; text: string }
  | { kind: "tts"; text: string; lang: string }; // browser speaks it
