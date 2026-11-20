import type { AnswerLang, Person, Section } from "./types";
import { readinessForPerson, type PersonReadiness } from "./readiness";

export function narrationLanguages(language: Person["language"]): AnswerLang[] {
  return language === "auto" ? ["zh", "en"] : [language];
}
export interface NarrationVariant { sectionId: string; title: string; language: AnswerLang }
export function narrationVariants(person: Pick<Person, "language" | "sections">): NarrationVariant[] {
  return person.sections.flatMap((section) => narrationLanguages(person.language).map((language) => ({ sectionId: section.id, title: section.title, language })));
}

/** 'Auto' requires both languages; a single cached translation is not ready. */
export function adminReadinessForPerson(person: Person): PersonReadiness {
  const result = readinessForPerson(person);
  const variants = narrationVariants(person);
  const complete = variants.length > 0;
  const items = result.items.map((item) => item.key === "answers" || item.key === "audio" ? {
    ...item,
    detail: item.key === "answers" ? "每个部分的全部目标语言均需有固定讲解" : "每个部分的全部目标语言均需有固定语音",
    ready: complete && variants.every((v) => {
      const section = person.sections.find((s) => s.id === v.sectionId);
      return !!section?.cachedAnswers?.[v.language]?.trim() && (item.key !== "audio" || !!section.cachedAudio?.[v.language]);
    }),
  } : item);
  const done = items.filter((item) => item.ready).length;
  const warnings = items.filter((item) => !item.required && !item.ready);
  return { ...result, items, done, percent: Math.round(done / items.length * 100), warnings, ready: result.blockers.length === 0 && warnings.length === 0 };
}

export interface NarrationRequest {
  sectionId: string;
  language: AnswerLang;
  textOnly?: boolean;
  audioOnly?: boolean;
}
export interface NarrationProgress { current: number; total: number; variant: NarrationVariant; retry: boolean }
export interface NarrationFailure extends NarrationVariant { reason: string }
export interface NarrationRun {
  person: Person;
  completed: number;
  total: number;
  failures: NarrationFailure[];
}
interface ResponseData {
  sections?: Section[];
  results?: { sectionId?: string; language?: string; status?: string; reason?: string }[];
  error?: string;
}
export interface NarrationDependencies {
  request: (body: NarrationRequest) => Promise<{ ok: boolean; status: number; data: unknown }>;
  onProgress?: (progress: NarrationProgress) => void;
  onUpdate?: (person: Person) => void;
}

/** One section/language per request avoids the server's batch time budget.
 * Only an explicit pre-work budget skip gets one retry. A network failure or
 * a failed generation is never retried automatically (it may have cost money). */
export async function prepareNarrationVariants(
  person: Person,
  options: { textOnly: boolean; audioOnly?: boolean },
  dependencies: NarrationDependencies,
): Promise<NarrationRun> {
  if (options.audioOnly && options.textOnly) throw new Error("Audio-only preparation requires speech approval");
  const variants = narrationVariants(person);
  let current = person;
  let completed = 0;
  let stopReason = "";
  const failures: NarrationFailure[] = [];
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    if (stopReason) { failures.push({ ...variant, reason: stopReason }); continue; }
    let failure = "未收到可确认的准备结果";
    for (let attempt = 0; attempt < 2; attempt++) {
      dependencies.onProgress?.({ current: index + 1, total: variants.length, variant, retry: attempt > 0 });
      const section = current.sections.find((s) => s.id === variant.sectionId);
      const hasText = !!section?.cachedAnswers?.[variant.language]?.trim();
      if (options.audioOnly && !hasText) { failure = "缺少已有讲解，请先准备文字"; break; }
      const body: NarrationRequest = {
        sectionId: variant.sectionId, language: variant.language,
        ...(options.textOnly ? { textOnly: true } : (options.audioOnly || hasText) ? { audioOnly: true } : {}),
      };
      let response;
      try { response = await dependencies.request(body); }
      catch {
        failure = "请求未完成，请刷新核对保存结果后重试";
        stopReason = "前一请求状态未确认，后续部分未发起";
        break;
      }
      const data = response.data && typeof response.data === "object" ? response.data as ResponseData : {};
      const validSections = Array.isArray(data.sections) && data.sections.every((s) => s && typeof s.id === "string" && typeof s.title === "string" && typeof s.content === "string");
      if (validSections) {
        current = { ...current, sections: data.sections! };
        dependencies.onUpdate?.(current);
      }
      const result = Array.isArray(data.results) ? data.results.find((r) => r && r.sectionId === variant.sectionId && r.language === variant.language) : undefined;
      if (response.ok && result?.status === "skipped" && result.reason === "request_time_budget" && attempt === 0) continue;
      const saved = current.sections.find((s) => s.id === variant.sectionId);
      const savedText = !!saved?.cachedAnswers?.[variant.language]?.trim();
      const savedAudio = !!saved?.cachedAudio?.[variant.language];
      const accepted = result?.status === "prepared" || (result?.status === "skipped" &&
        (options.textOnly ? result.reason === "text_already_cached" : result.reason === "healthy_audio"));
      if (response.ok && validSections && accepted && savedText && (options.textOnly || savedAudio)) {
        completed++;
        failure = "";
      } else {
        failure = (typeof data.error === "string" ? data.error : "") || (result?.reason === "request_time_budget" ? "服务端时间不足，此项尚未完成" : result?.reason === "cached_text_missing" ? "缺少已有讲解，请先准备文字" : "此项未完成或保存结果尚未确认");
        if ([401, 403, 404, 409, 428, 503].includes(response.status)) stopReason = "服务暂不可用或权限待确认，后续部分未发起";
      }
      break;
    }
    if (failure) failures.push({ ...variant, reason: failure });
  }
  return { person: current, completed, total: variants.length, failures };
}
