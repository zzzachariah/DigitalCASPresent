import type { Person } from "./types";
import { adminReadinessForPerson } from "./admin-narration";

export type AdminMediaStatus = {
  status: "loading" | "unavailable" | "privacy_disabled" | "provider_missing" | "key_missing" | "ready";
  ready: boolean;
  message: string;
};
export interface AdminMediaHealth {
  speechGlobal: AdminMediaStatus;
  speechApprovedIds: string[];
  speeches: Record<string, AdminMediaStatus>;
  photoGlobal: AdminMediaStatus;
  photoApprovedIds: string[];
  photos: Record<string, AdminMediaStatus>;
}
const loadingStatus: AdminMediaStatus = {
  status: "loading", ready: false, message: "正在检查媒体服务；暂时只准备文字讲解。",
};
const unavailableStatus: AdminMediaStatus = {
  status: "unavailable", ready: false, message: "暂时无法确认媒体服务状态，卡通、视频和外部语音已暂停；可先准备文字讲解，稍后刷新重试。",
};
export const MEDIA_LOADING: AdminMediaHealth = { speechGlobal: loadingStatus, speechApprovedIds: [], speeches: {}, photoGlobal: loadingStatus, photoApprovedIds: [], photos: {} };
export const MEDIA_UNAVAILABLE: AdminMediaHealth = { speechGlobal: unavailableStatus, speechApprovedIds: [], speeches: {}, photoGlobal: unavailableStatus, photoApprovedIds: [], photos: {} };

function readStatus(input: unknown): AdminMediaStatus {
  if (!input || typeof input !== "object") return unavailableStatus;
  const value = input as Record<string, unknown>;
  if (typeof value.message !== "string" || !value.message.trim()) return unavailableStatus;
  if (value.status === "ready" && value.ready === true) {
    return { status: "ready", ready: true, message: value.message };
  }
  if (value.ready === false && (value.status === "privacy_disabled" || value.status === "provider_missing" || value.status === "key_missing")) {
    return { status: value.status, ready: false, message: value.message };
  }
  return unavailableStatus;
}

/** Photo and reviewed-speech readiness remain separate. Only validated scoped
 * health can grant event-wide approval; the legacy a2e flag never grants it. */
export function adminMediaStatus(health: unknown): AdminMediaHealth {
  if (!health || typeof health !== "object") return MEDIA_UNAVAILABLE;
  const root = health as Record<string, unknown>;
  function scoped(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const scope = value as Record<string, unknown>;
    if (!Array.isArray(scope.approvedPersonIds) || !scope.approvedPersonIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id)) ||
        !scope.people || typeof scope.people !== "object" || Array.isArray(scope.people)) return null;
    const global = readStatus(scope.global);
    if (global.status === "unavailable") return null;
    const people: Record<string, AdminMediaStatus> = {};
    for (const id of scope.approvedPersonIds as string[]) people[id] = readStatus((scope.people as Record<string, unknown>)[id]);
    return { global, ids: scope.approvedPersonIds as string[], people };
  }
  const photo = scoped(root.a2ePhoto);
  const speech = scoped(root.a2eSpeech);
  if (!photo || !speech) return MEDIA_UNAVAILABLE;
  return {
    speechGlobal: speech.global, speechApprovedIds: speech.ids, speeches: speech.people,
    photoGlobal: photo.global, photoApprovedIds: photo.ids, photos: photo.people,
  };
}

export function photoStatusForPerson(health: AdminMediaHealth, personId?: string): AdminMediaStatus {
  if (personId && health.photoGlobal.ready) return health.photoGlobal;
  if (personId && health.photoApprovedIds.includes(personId)) return health.photos[personId] ?? unavailableStatus;
  if (health.photoGlobal.status === "loading" || health.photoGlobal.status === "unavailable" || health.photoGlobal.status === "provider_missing" || health.photoGlobal.status === "key_missing") return health.photoGlobal;
  return { status: "privacy_disabled", ready: false, message: "这位同学的照片尚未单独获准发送给形象服务，卡通和视频生成已暂停。" };
}

export function speechStatusForPerson(health: AdminMediaHealth, personId?: string): AdminMediaStatus {
  if (personId && health.speechGlobal.ready) return health.speechGlobal;
  if (personId && health.speechApprovedIds.includes(personId)) return health.speeches[personId] ?? unavailableStatus;
  if (health.speechGlobal.status === "loading" || health.speechGlobal.status === "unavailable" || health.speechGlobal.status === "provider_missing" || health.speechGlobal.status === "key_missing") return health.speechGlobal;
  return { status: "privacy_disabled", ready: false, message: "这位同学的讲解尚未单独获准发送给配音服务；当前仅准备文字。" };
}

export type PreparationStep = "cartoon" | "loop-video" | "pregenerate";
export function preparationSteps(person: Pick<Person, "photoUrl" | "cartoonUrl" | "loopVideoUrl">, mediaReady: boolean): PreparationStep[] {
  const steps: PreparationStep[] = [];
  if (mediaReady && person.photoUrl) {
    if (!person.cartoonUrl) steps.push("cartoon");
    if (!person.loopVideoUrl) steps.push("loop-video");
  }
  steps.push("pregenerate");
  return steps;
}

/** Completion describes the saved record; an HTTP 200 alone is not readiness. */
export function preparationSummary(person: Person, failed: number, textOnly: boolean): string {
  if (failed > 0) return `${person.name}：有 ${failed} 项讲解未完成，请检查后重试`;
  const readiness = adminReadinessForPerson(person);
  const missing = readiness.items.filter((item) => !item.ready).map((item) => item.label);
  if (missing.length) return `本次处理已结束：${person.name}；仍待准备：${missing.join("、")}`;
  return textOnly ? `文字讲解已准备：${person.name}（本次未生成外部语音）` : `素材已就绪：${person.name}`;
}
