// ─────────────────────────────────────────────────────────────────────
// Data layer entry point.
//
// Picks a storage driver PER REQUEST (not at module load):
//   • Vercel Blob  — explicit public-media and private-record configuration.
//   • Filesystem   — otherwise (local dev, or a single always-on server).
//
// Both drivers keep ONE record per person, so many people can be created or
// edited at the same time (e.g. a class submitting at once) without one
// write overwriting another. Two simultaneous edits of the SAME person still
// race (last write wins) — acceptable for this tool.
// ─────────────────────────────────────────────────────────────────────

import * as fsDriver from "./store-fs";
import * as blobDriver from "./store-blob";
import { blobConfigured, recordsBlobConfigured, type CreatePersonInput } from "./store-shared";
import type { Person } from "./types";
import { assertEventOpen, eventDataClosed, type PurgeResult } from "./event-retention";

function driver() {
  return blobConfigured() || process.env.VERCEL ? blobDriver : fsDriver;
}

export function listPeople(): Promise<Person[]> {
  return eventDataClosed() ? Promise.resolve([]) : driver().listPeople();
}
export function getPerson(idOrSlug: string): Promise<Person | null> {
  return eventDataClosed() ? Promise.resolve(null) : driver().getPerson(idOrSlug);
}
export function createPerson(input: CreatePersonInput): Promise<Person> {
  assertEventOpen();
  return driver().createPerson(input);
}
export function updatePerson(
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>
): Promise<Person | null> {
  assertEventOpen();
  return driver().updatePerson(id, patch);
}
export function deletePerson(id: string): Promise<boolean> {
  return driver().deletePerson(id);
}
export function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  assertEventOpen();
  return driver().savePhoto(id, buffer, ext);
}
export function saveCartoon(id: string, buffer: Buffer, ext: string): Promise<string> {
  assertEventOpen();
  return driver().saveCartoon(id, buffer, ext);
}
export function saveLoopVideo(id: string, buffer: Buffer, ext: string): Promise<string> {
  assertEventOpen();
  return driver().saveLoopVideo(id, buffer, ext);
}
/** Store pre-generated narration audio; returns a permanent URL. */
export function saveAudio(id: string, key: string, buffer: Buffer, ext: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  assertEventOpen();
  return driver() === blobDriver ? blobDriver.saveAudio(id, key, buffer, ext, signal) : fsDriver.saveAudio(id, key, buffer, ext);
}
/** Delete a stored media file by its URL (no-op for local files). */
export function deleteMediaUrl(url: string): Promise<void> {
  return driver().deleteMediaUrl(url);
}
export function readPhoto(
  id: string, version?: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  return eventDataClosed() ? Promise.resolve(null) : driver().readPhoto(id, version);
}

export { toPublic, toOwner, isPublished } from "./store-shared";
export type { CreatePersonInput } from "./store-shared";

export function storageDriverName(): "vercel-blob" | "filesystem" {
  return blobConfigured() || process.env.VERCEL ? "vercel-blob" : "filesystem";
}

/** Guard for write endpoints: the filesystem driver can't write on Vercel
 *  (read-only FS), so surface a clear, actionable message instead of a crash. */
export function storageWritable(): { ok: true } | { ok: false; reason: string } {
  if ((blobConfigured() || process.env.VERCEL) && !recordsBlobConfigured()) {
    return {
      ok: false,
      reason:
        "私有资料存储尚未配置，暂时无法保存，请联系管理员。 / Private records storage is not configured; contact the administrator.",
    };
  }
  return { ok: true };
}

/** Explicit admin migration only; ordinary reads never invoke this. */
export async function migrateLegacyRecords(options: { dryRun: boolean; ids?: string[] }) {
  assertEventOpen();
  if (storageDriverName() !== "vercel-blob") throw new Error("Blob migration is unavailable for the filesystem driver");
  return blobDriver.migrateLegacyRecords(options);
}

/** Only authenticated retention routes may call this; both drivers also require expiry. */
export function purgeEventData(options: { dryRun: boolean }): Promise<PurgeResult> {
  return driver().purgeEventData(options);
}

export async function privatizeLegacyRecords(options: { dryRun: boolean }) {
  assertEventOpen();
  if (storageDriverName() !== "vercel-blob") throw new Error("Legacy Blob cleanup is unavailable for filesystem storage");
  return blobDriver.privatizeLegacyRecords(options);
}
