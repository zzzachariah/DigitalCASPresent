// ─────────────────────────────────────────────────────────────────────
// Data layer entry point.
//
// Picks a storage driver PER REQUEST (not at module load):
//   • Vercel Blob  — when a Blob read-write token is present in the runtime
//     environment (resolved by value, so a non-standard env var name still
//     works, and a runtime-only secret is never baked to undefined at build).
//   • Filesystem   — otherwise (local dev, or a single always-on server).
// ─────────────────────────────────────────────────────────────────────

import * as fsDriver from "./store-fs";
import * as blobDriver from "./store-blob";
import { blobConfigured } from "./store-shared";
import type { Person } from "./types";

function driver() {
  return blobConfigured() ? blobDriver : fsDriver;
}

export function listPeople(): Promise<Person[]> {
  return driver().listPeople();
}
export function getPerson(idOrSlug: string): Promise<Person | null> {
  return driver().getPerson(idOrSlug);
}
export function createPerson(
  input: Pick<Person, "name" | "subtitle" | "script" | "sections" | "language">
): Promise<Person> {
  return driver().createPerson(input);
}
export function updatePerson(
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>
): Promise<Person | null> {
  return driver().updatePerson(id, patch);
}
export function deletePerson(id: string): Promise<boolean> {
  return driver().deletePerson(id);
}
export function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  return driver().savePhoto(id, buffer, ext);
}
export function readPhoto(
  id: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  return driver().readPhoto(id);
}

export { toPublic } from "./store-shared";

export function storageDriverName(): "vercel-blob" | "filesystem" {
  return blobConfigured() ? "vercel-blob" : "filesystem";
}

/** Guard for write endpoints: the filesystem driver can't write on Vercel
 *  (read-only FS), so surface a clear, actionable message instead of a crash. */
export function storageWritable(): { ok: true } | { ok: false; reason: string } {
  if (!blobConfigured() && process.env.VERCEL) {
    return {
      ok: false,
      reason:
        "线上还没有连接持久化存储,无法保存。请在 Vercel 项目里 Storage → Create → Blob,连接到本项目后 Redeploy,再重试。 / No storage connected: create & connect a Vercel Blob store, then redeploy.",
    };
  }
  return { ok: true };
}
