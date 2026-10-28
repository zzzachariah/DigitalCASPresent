import type { Person } from "./types";

export type ReadinessKey = "photo" | "parts" | "cartoon" | "loop" | "answers" | "audio";

export interface ReadinessItem {
  key: ReadinessKey;
  label: string;
  detail: string;
  ready: boolean;
  required: boolean;
}

export interface PersonReadiness {
  items: ReadinessItem[];
  done: number;
  total: number;
  percent: number;
  blockers: ReadinessItem[];
  warnings: ReadinessItem[];
  publishable: boolean;
  ready: boolean;
}

/** The event-readiness contract used by both the admin UI and publish API.
 *  Missing source material blocks publication. Generated assets are warnings:
 *  the teacher may deliberately publish with the reliable static/browser
 *  fallbacks when a provider is unavailable. */
export function readinessForPerson(person: Pick<Person, "photoUrl" | "cartoonUrl" | "loopVideoUrl" | "script" | "sections">): PersonReadiness {
  const sections = Array.isArray(person.sections) ? person.sections : [];
  const completeParts = sections.length > 0 && sections.every((section) => section.title.trim() && section.content.trim());
  const answersReady = completeParts && sections.every((section) => !!section.cachedAnswers && Object.values(section.cachedAnswers).some((text) => !!text?.trim()));
  const audioReady = completeParts && sections.every((section) => !!section.cachedAudio && Object.values(section.cachedAudio).some(Boolean));

  const items: ReadinessItem[] = [
    { key: "photo", label: "本人照片", detail: "访客页面和数字人形象需要一张清晰照片", ready: !!person.photoUrl, required: true },
    { key: "parts", label: "讲稿与分段", detail: "讲稿存在，且每个部分都有标题和内容", ready: !!person.script.trim() && completeParts, required: true },
    { key: "cartoon", label: "卡通形象", detail: "没有时会使用本人照片", ready: !!person.cartoonUrl, required: false },
    { key: "loop", label: "动态视频", detail: "没有时仍可播放语音，但人物不会循环说话", ready: !!person.loopVideoUrl, required: false },
    { key: "answers", label: "固定讲解", detail: "每个部分至少有一种预生成讲解文字", ready: answersReady, required: false },
    { key: "audio", label: "固定语音", detail: "每个部分至少有一种可直接播放的语音", ready: audioReady, required: false },
  ];
  const blockers = items.filter((item) => item.required && !item.ready);
  const warnings = items.filter((item) => !item.required && !item.ready);
  const done = items.filter((item) => item.ready).length;
  return {
    items,
    done,
    total: items.length,
    percent: Math.round((done / items.length) * 100),
    blockers,
    warnings,
    publishable: blockers.length === 0,
    ready: blockers.length === 0 && warnings.length === 0,
  };
}
