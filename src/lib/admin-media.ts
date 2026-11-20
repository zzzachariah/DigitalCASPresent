import type { Person } from "./types";
import { readinessForPerson } from "./readiness";

export type AdminMediaStatus = {
  status: "loading" | "unavailable" | "privacy_disabled" | "provider_missing" | "key_missing" | "ready";
  ready: boolean;
  message: string;
};
export interface AdminMediaHealth {
  speech: AdminMediaStatus;
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
export const MEDIA_LOADING: AdminMediaHealth = { speech: loadingStatus, photoGlobal: loadingStatus, photoApprovedIds: [], photos: {} };
export const MEDIA_UNAVAILABLE: AdminMediaHealth = { speech: unavailableStatus, photoGlobal: unavailableStatus, photoApprovedIds: [], photos: {} };

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

/** Text, one person's photo and speech approvals are independent. Older or
 * incomplete health payloads never broaden the approval to other people. */
export function adminMediaStatus(health: unknown): AdminMediaHealth {
  if (!health || typeof health !== "object") return MEDIA_UNAVAILABLE;
  const root = health as Record<string, unknown>;
  const photo = root.a2ePhoto as Record<string, unknown> | undefined;
  if (!photo || typeof photo !== "object" || !Array.isArray(photo.approvedPersonIds) ||
      !photo.approvedPersonIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id)) ||
      !photo.people || typeof photo.people !== "object" || Array.isArray(photo.people)) return MEDIA_UNAVAILABLE;
  const speech = readStatus(root.a2e);
  const photoGlobal = readStatus(photo.global);
  if (speech.status === "unavailable" || photoGlobal.status === "unavailable") return MEDIA_UNAVAILABLE;
  const photos: Record<string, AdminMediaStatus> = {};
  for (const id of photo.approvedPersonIds as string[]) {
    photos[id] = readStatus((photo.people as Record<string, unknown>)[id]);
  }
  return { speech, photoGlobal, photoApprovedIds: photo.approvedPersonIds as string[], photos };
}

export function photoStatusForPerson(health: AdminMediaHealth, personId?: string): AdminMediaStatus {
  if (personId && health.photoApprovedIds.includes(personId)) return health.photos[personId] ?? unavailableStatus;
  if (health.photoGlobal.status === "loading" || health.photoGlobal.status === "unavailable") return health.photoGlobal;
  return { status: "privacy_disabled", ready: false, message: "这位同学的照片尚未单独获准发送给形象服务，卡通和视频生成已暂停。" };
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
  const readiness = readinessForPerson(person);
  const missing = readiness.items.filter((item) => !item.ready).map((item) => item.label);
  if (missing.length) return `本次准备已完成：${person.name}；仍待准备：${missing.join("、")}`;
  return textOnly ? `文字讲解已准备：${person.name}（本次未生成外部语音）` : `素材已就绪：${person.name}`;
}
