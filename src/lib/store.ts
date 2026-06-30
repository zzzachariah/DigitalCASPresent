// ─────────────────────────────────────────────────────────────────────
// Data layer entry point.
//
// Picks a storage driver at load time:
//   • Vercel Blob  — when BLOB_READ_WRITE_TOKEN is set (Vercel injects it once
//     you connect a Blob store). Production-ready, persistent.
//   • Filesystem   — otherwise (local dev, or a single always-on server).
//
// The rest of the app imports only from here, so switching drivers needs no
// changes anywhere else.
// ─────────────────────────────────────────────────────────────────────

import * as fsDriver from "./store-fs";
import * as blobDriver from "./store-blob";

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const driver = useBlob ? blobDriver : fsDriver;

export const listPeople = driver.listPeople;
export const getPerson = driver.getPerson;
export const createPerson = driver.createPerson;
export const updatePerson = driver.updatePerson;
export const deletePerson = driver.deletePerson;
export const savePhoto = driver.savePhoto;
export const readPhoto = driver.readPhoto;

export { toPublic } from "./store-shared";

export function storageDriverName(): "vercel-blob" | "filesystem" {
  return useBlob ? "vercel-blob" : "filesystem";
}

/** Guard for write endpoints: the filesystem driver can't write on Vercel
 *  (read-only FS), so surface a clear, actionable message instead of a crash. */
export function storageWritable(): { ok: true } | { ok: false; reason: string } {
  if (!useBlob && process.env.VERCEL) {
    return {
      ok: false,
      reason:
        "线上还没有连接持久化存储,无法保存。请在 Vercel 项目里 Storage → Create → Blob,连接到本项目后 Redeploy,再重试。 / No storage connected: create & connect a Vercel Blob store, then redeploy.",
    };
  }
  return { ok: true };
}
