import type { AnswerLang, Section } from "./types";

/** A changed answer invalidates only its own derived audio and questions.
 * Other languages, source text and stored media files remain untouched. */
export function editCachedAnswer(section: Section, language: AnswerLang, text: string): Section {
  if ((section.cachedAnswers?.[language] ?? "") === text) return section;
  const cachedAudio = { ...section.cachedAudio };
  const cachedSuggestions = { ...section.cachedSuggestions };
  delete cachedAudio[language];
  delete cachedSuggestions[language];
  return {
    ...section,
    cachedAnswers: { ...section.cachedAnswers, [language]: text },
    cachedAudio,
    cachedSuggestions,
  };
}

/** Normalize optional caches so saving an empty map does not create a change. */
export function serializeSectionDraft(sections: Section[]): string {
  const languages: AnswerLang[] = ["en", "zh", "bilingual"];
  return JSON.stringify(sections.map((section) => [
    section.id, section.title, section.hint || "", section.content,
    ...languages.map((language) => [
      section.cachedAnswers?.[language] || "",
      section.cachedAudio?.[language] || "",
      section.cachedSuggestions?.[language] || [],
    ]),
  ]));
}
