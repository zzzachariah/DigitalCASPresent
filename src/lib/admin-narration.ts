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
  results?: NarrationResult[];
  code?: unknown;
}
interface NarrationResult {
  sectionId?: string;
  language?: string;
  status?: string;
  reason?: unknown;
  phase?: unknown;
  reviewReason?: unknown;
  rejectedCriteria?: unknown;
}
export interface NarrationDependencies {
  request: (body: NarrationRequest) => Promise<{ ok: boolean; status: number; data: unknown }>;
  onProgress?: (progress: NarrationProgress) => void;
  onUpdate?: (person: Person) => void;
}

const FAILURE_REASONS: Record<string, string> = {
  answer_not_approved: "讲解未通过内容审核，或审核结果尚未确认",
  generation_failed: "文字讲解生成未完成",
  empty_answer: "未生成有效的讲解文字",
  tts_failed: "配音合成失败",
  download_failed: "生成的音频下载失败",
  audio_save_failed: "音频保存失败",
  audio_verification_failed: "保存后的音频校验未通过",
  audio_preparation_failed: "音频准备未完成",
  existing_audio_unverified: "已有音频暂时无法核验，未自动重新生成",
  source_recheck_failed: "保存前未能复核讲解内容",
  source_changed: "讲解或资料在准备期间发生变化，请刷新后核对",
  audio_changed_during_preparation: "音频在准备期间发生变化，请刷新后核对",
  persist_failed: "讲解或音频记录保存失败",
  persist_verification_failed: "保存后的讲解记录未能核验",
  persist_unverified: "保存后的讲解或音频记录未能核验",
  read_failed: "读取资料失败",
  person_missing: "该同学的资料已不存在",
  section_missing: "该讲解部分已不存在",
  person_or_section_missing: "该同学或讲解部分已不存在",
  cached_text_missing: "缺少已有讲解，请先准备文字",
  request_time_budget: "服务端时间不足，此项尚未完成",
};
const FAILURE_PHASES: Record<string, string> = {
  generation: "文字生成", review: "内容审核", tts: "配音合成", download: "音频下载",
  audio_save: "音频保存", audio_verification: "音频校验", source_recheck: "资料复核",
  persist: "记录保存", persist_verification: "记录校验", read: "资料读取", audio_preparation: "音频准备",
};
const REVIEW_REASONS: Record<string, string> = {
  local_rejection: "本地内容检查未通过",
  model_rejection: "审核模型未批准这段讲解",
  review_format: "审核结果格式不符合要求",
  review_timeout: "内容审核超时，结果尚未确认",
  review_upstream_error: "审核服务暂不可用",
};
const REVIEW_CRITERIA: Record<string, string> = {
  safe: "校园适宜性", grounded: "依据充分性", private: "保密要求", relevant: "展览相关性", respectful: "礼貌与中立",
};
const FAILURE_CODES: Record<string, string> = {
  read_failed: "资料暂时读取失败，请刷新核对已保存结果后重试",
  a2e_privacy_disabled: "这位同学的配音尚未获准",
  a2e_provider_missing: "配音服务尚未启用或配置不完整",
  a2e_key_missing: "配音服务密钥尚未配置",
};
const HTTP_FAILURES: Record<string, string> = {
  "400": "准备请求无效，请刷新后重试", "401": "登录已失效，请重新登录",
  "403": "该操作尚未获准或无访问权限", "404": "相关资料已不存在，请刷新核对",
  "409": "该同学已有准备任务正在运行，请等待完成",
  "428": "请先确认所需的隐私协议授权",
  "429": "请求过于频繁，请稍后重试", "503": "服务当前不可用，请检查配置和授权状态",
};
function fixedMessage(value: unknown, messages: Record<string, string>): string | undefined {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(messages, value) ? messages[value] : undefined;
}

/** Render only local allowlisted labels. Provider/error messages, URLs,
 * credentials, manuscript text and unknown diagnostic values never enter UI. */
function narrationFailureReason(result: NarrationResult | undefined, data: ResponseData, status: number): string {
  const base = fixedMessage(result?.reason, FAILURE_REASONS) || fixedMessage(data.code, FAILURE_CODES) ||
    fixedMessage(String(status), HTTP_FAILURES) || "此项未完成或保存结果尚未确认";
  const details: string[] = [];
  const phase = fixedMessage(result?.phase, FAILURE_PHASES);
  if (phase) details.push(`环节：${phase}`);
  const review = fixedMessage(result?.reviewReason, REVIEW_REASONS);
  if (review) details.push(review);
  if (result?.reviewReason === "model_rejection" && Array.isArray(result.rejectedCriteria)) {
    const criteria = Object.keys(REVIEW_CRITERIA).filter((key) => (result.rejectedCriteria as unknown[]).includes(key)).map((key) => REVIEW_CRITERIA[key]);
    if (criteria.length) details.push(`未通过：${criteria.join("、")}`);
  }
  return details.length ? `${base}（${details.join("；")}）` : base;
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
        failure = narrationFailureReason(result, data, response.status);
        if ([401, 403, 404, 409, 428, 503].includes(response.status)) stopReason = "服务暂不可用或权限待确认，后续部分未发起";
      }
      break;
    }
    if (failure) failures.push({ ...variant, reason: failure });
  }
  return { person: current, completed, total: variants.length, failures };
}
