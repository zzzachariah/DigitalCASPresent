import type { Person } from "./types";
import type { AdminMediaStatus } from "./admin-media";
import { narrationLanguageLabels, narrationVariants, type NarrationOptions } from "./admin-narration";

export type PreparationEntry = {
  key: string;
  kind: "cartoon" | "loop-video" | "narration";
  label: string;
  status: "pending" | "running" | "complete" | "failed" | "blocked";
  detail: string;
  narration?: NarrationOptions;
};
export function narrationEntryKey(sectionId: string, language: string): string {
  return `narration:${sectionId}:${language}`;
}

/** Missing, unapproved assets stay visible in the plan but never become requests. */
export function preparationEntries(person: Person, options: { includeMedia: boolean; photo: AdminMediaStatus; textOnly: boolean; audioOnly?: boolean; regenerateRejectedText?: boolean }): PreparationEntry[] {
  const entries: PreparationEntry[] = [];
  if (options.includeMedia) {
    for (const [kind, label, saved] of [["cartoon", "卡通形象", person.cartoonUrl], ["loop-video", "动态视频", person.loopVideoUrl]] as const) {
      if (saved) continue;
      const detail = !person.photoUrl ? "尚缺本人照片，待补齐后处理" : !options.photo.ready ? options.photo.message : "等待处理";
      entries.push({ key: kind, kind, label, status: person.photoUrl && options.photo.ready ? "pending" : "blocked", detail });
    }
  }
  const target = options.textOnly ? "文字讲解" : options.audioOnly ? "补齐语音" : "讲解与语音";
  for (const variant of narrationVariants(person)) {
    entries.push({
      key: narrationEntryKey(variant.sectionId, variant.language), kind: "narration",
      label: `${variant.title}（${narrationLanguageLabels[variant.language]}）· ${target}`, status: "pending",
      detail: options.regenerateRejectedText ? "等待审核；仅因依据或保密问题未通过时尝试一次修订" : "等待处理",
      narration: { textOnly: options.textOnly, audioOnly: options.audioOnly, regenerateRejectedText: options.regenerateRejectedText, variant: { sectionId: variant.sectionId, language: variant.language } },
    });
  }
  return entries;
}

/** Preserve completed results if a client request ends unexpectedly. */
export function interruptPreparation(entries: PreparationEntry[]): PreparationEntry[] {
  return entries.map((entry) => entry.status === "running" ? { ...entry, status: "failed", detail: "请求未完成，请刷新核对保存结果后重试" } : entry.status === "pending" ? { ...entry, status: "blocked", detail: "前一步状态未确认，此项未发起" } : entry);
}
