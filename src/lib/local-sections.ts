import { nanoid } from "nanoid";
import { LIMITS, defaultSectionTitle } from "./validate";
import type { Section } from "./types";

/** Deterministic paragraph split: no provider, generated facts, or rewritten prose. */
export function localSections(script: string): Section[] {
  const parts = script.trim().split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > LIMITS.sections) {
    parts.splice(LIMITS.sections - 1, parts.length, parts.slice(LIMITS.sections - 1).join("\n\n"));
  }
  return parts.map((content, index) => ({ id: nanoid(8), title: defaultSectionTitle(index, content), content }));
}
