import { put as blobPut, get, list, del, head, BlobError, BlobNotFoundError } from "@vercel/blob";
import { createHash } from "node:crypto";
import type { Person } from "./types";
import { assertEventPurgeAllowed, assertEventOpen, eventDataClosed, type PurgeResult } from "./event-retention";
import {
  buildPerson, safeId, uniqueSlug, mediaBlobAuth, mediaBlobConfigured,
  recordsBlobAuth, recordsBlobConfigured, type CreatePersonInput,
} from "./store-shared";

// All new records and media are private. The old public store is read only
// except for explicit verified migration/cleanup. Ordinary reads never write.
// Legacy URL normalization is pure, so migration cannot overwrite a student edit.
const PERSON_PREFIX = "people/";
const SLUG_PREFIX = "slugs/";
const DELETED_PREFIX = "deleted/";
const LEGACY_SINGLE = "data/people.json";
const personDir = (id: string) => `${PERSON_PREFIX}${id}/`;
const slugPath = (slug: string) => `${SLUG_PREFIX}${slug}`;
const tombstonePath = (id: string) => `${DELETED_PREFIX}${id}.json`;
type Store = "records" | "media";
type BlobEntry = { pathname: string; url: string };
const auth = (store: Store) => store === "records" ? recordsBlobAuth() : mediaBlobAuth();

/** A request begun before expiry must not recreate data after purge. */
const put: typeof blobPut = async (pathname, body, options) => {
  assertEventOpen();
  const result = await blobPut(pathname, body, options);
  if (eventDataClosed()) {
    await del(result.pathname, options);
    throw new Error("Event closed during storage write");
  }
  return result;
};

async function listAll(prefix: string, store: Store): Promise<BlobEntry[]> {
  const out: BlobEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, ...auth(store) });
    out.push(...page.blobs.map(({ pathname, url }) => ({ pathname, url })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function findBlob(pathname: string, store: Store): Promise<BlobEntry | null> {
  try {
    return await head(pathname, auth(store));
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

async function readPrivateText(pathname: string): Promise<string | null> {
  const res = await get(pathname, { access: "private", useCache: false, ...recordsBlobAuth() });
  if (!res) return null;
  if (res.statusCode !== 200 || !res.stream) throw new Error("Private record could not be read");
  return new Response(res.stream).text();
}

/** The SDK must send cache=0 (requires @vercel/blob >=2.6.1). A rare missing
 *  read immediately after a write gets two short read-only retries. Never
 *  repeat the write, retry authorization errors, or accept different bytes. */
async function verifyPrivateWrite(pathname: string, expected: string, message: string): Promise<void> {
  const delays = [100, 300];
  for (let attempt = 0; ; attempt++) {
    const raw = await readPrivateText(pathname);
    if (raw === expected) return;
    if (raw !== null || attempt >= delays.length) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}

async function readPublicText(blob: BlobEntry): Promise<string> {
  const separator = blob.url.includes("?") ? "&" : "?";
  const res = await fetch(`${blob.url}${separator}v=${Date.now()}`, {
    cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  // A network error is not an empty database. In particular, never delete a
  // source because its CDN temporarily returned 403/404/503.
  if (!res.ok) throw new Error(`Legacy record could not be read (HTTP ${res.status})`);
  return res.text();
}

function parsePerson(raw: string): Person {
  const p = JSON.parse(raw) as Person;
  if (!safeId(p?.id) || !safeId(p?.slug) || typeof p.name !== "string" ||
      typeof p.script !== "string" || !Array.isArray(p.sections)) {
    throw new Error("Invalid stored person record");
  }
  return p;
}

function newest(versions: BlobEntry[]): BlobEntry | null {
  return [...versions].sort((a, b) => b.pathname.localeCompare(a.pathname))[0] ?? null;
}

async function isDeleted(id: string): Promise<boolean> {
  return recordsBlobConfigured() && (await readPrivateText(tombstonePath(id))) !== null;
}

async function readPrivatePerson(id: string): Promise<Person | null> {
  if (!recordsBlobConfigured()) return null;
  const version = newest(await listAll(personDir(id), "records"));
  if (!version) return null;
  const raw = await readPrivateText(version.pathname);
  if (raw === null) throw new Error("Stored record version is missing");
  const p = parsePerson(raw);
  if (p.id !== id) throw new Error("Stored person id does not match its path");
  return p;
}

async function readLegacySingle(): Promise<Person[]> {
  if (!mediaBlobConfigured()) return [];
  const blob = await findBlob(LEGACY_SINGLE, "media");
  if (!blob) return [];
  const rows: unknown = JSON.parse(await readPublicText(blob));
  if (!Array.isArray(rows)) throw new Error("Invalid legacy people list");
  return rows.map((p) => parsePerson(JSON.stringify(p)));
}

async function readLegacyPerson(id: string): Promise<Person | null> {
  if (!mediaBlobConfigured()) return null;
  const blob = await findBlob(`${PERSON_PREFIX}${id}.json`, "media");
  if (blob) {
    const p = parsePerson(await readPublicText(blob));
    if (p.id !== id) throw new Error("Legacy person id does not match its path");
    return p;
  }
  return (await readLegacySingle()).find((p) => p.id === id) ?? null;
}

async function readById(id: string): Promise<Person | null> {
  if (await isDeleted(id)) return null;
  // Private is authoritative. An unreadable private version must fail rather
  // than quietly showing an older public copy.
  return await readPrivatePerson(id) ?? await readLegacyPerson(id);
}

async function privateSlugId(slug: string): Promise<string | null> {
  if (!recordsBlobConfigured()) return null;
  const raw = await readPrivateText(slugPath(slug));
  if (raw === null) return null;
  const id = raw.trim();
  if (!safeId(id)) throw new Error("Invalid private slug marker");
  return id;
}

async function legacySlugId(slug: string): Promise<string | null> {
  if (!mediaBlobConfigured()) return null;
  const marker = await findBlob(`${SLUG_PREFIX}${slug}.txt`, "media");
  if (marker) {
    const id = (await readPublicText(marker)).trim();
    if (!safeId(id)) throw new Error("Invalid legacy slug marker");
    return id;
  }
  return (await readLegacySingle()).find((p) => p.slug === slug)?.id ?? null;
}

/** Reserve a slug without overwriting another student's mapping. */
async function writeSlug(slug: string, id: string): Promise<void> {
  const existing = await privateSlugId(slug);
  if (existing !== null) {
    if (existing !== id) throw new Error("This public link is already assigned");
    return;
  }
  try {
    await put(slugPath(slug), id, {
      access: "private", addRandomSuffix: false, allowOverwrite: false,
      contentType: "text/plain", ...recordsBlobAuth(),
    });
  } catch (err) {
    // Another identical migration may have reserved the same mapping.
    try { await verifyPrivateWrite(slugPath(slug), id, "Slug verification failed"); }
    catch { throw err; }
    return;
  }
  await verifyPrivateWrite(slugPath(slug), id, "Slug verification failed");
}

/** Append an immutable private version and verify the exact saved bytes.
 *  Retain all previous versions; cleanup is an explicit separate operation. */
async function writePerson(p: Person): Promise<void> {
  const previous = newest(await listAll(personDir(p.id), "records"));
  const prevTime = previous ? Number(previous.pathname.split("/").at(-1)?.slice(0, 14)) : 0;
  const time = Math.max(Date.now(), Number.isFinite(prevTime) ? prevTime + 1 : 0);
  const version = `${String(time).padStart(14, "0")}-${Math.random().toString(36).slice(2, 10)}.json`;
  const pathname = personDir(p.id) + version;
  const raw = JSON.stringify(p);
  await put(pathname, raw, {
    access: "private", addRandomSuffix: false, allowOverwrite: false,
    contentType: "application/json", ...recordsBlobAuth(),
  });
  await verifyPrivateWrite(pathname, raw, "Saved record verification failed");
}

/** A fixed lowest-priority import version cannot outrank a concurrently saved
 *  private edit. It is write-once and still verified before reporting success. */
async function copyLegacyPerson(p: Person): Promise<void> {
  const pathname = personDir(p.id) + "00000000000000-legacy.json";
  const raw = JSON.stringify(p);
  try {
    await put(pathname, raw, {
      access: "private", addRandomSuffix: false, allowOverwrite: false,
      contentType: "application/json", ...recordsBlobAuth(),
    });
  } catch (err) {
    try { await verifyPrivateWrite(pathname, raw, "Copied record verification failed"); }
    catch { throw err; }
    return;
  }
  await verifyPrivateWrite(pathname, raw, "Copied record verification failed");
}

export async function listPeople(): Promise<Person[]> {
  if (process.env.VERCEL && !recordsBlobConfigured()) recordsBlobAuth();
  const byId = new Map<string, Person>();
  const deleted = new Set<string>();
  if (recordsBlobConfigured()) {
    for (const b of await listAll(DELETED_PREFIX, "records")) {
      const match = b.pathname.match(/^deleted\/([A-Za-z0-9_-]+)\.json$/);
      if (match) deleted.add(match[1]);
    }
    const latest = new Map<string, BlobEntry>();
    for (const b of await listAll(PERSON_PREFIX, "records")) {
      const match = b.pathname.match(/^people\/([A-Za-z0-9_-]+)\/[^/]+\.json$/);
      if (!match || deleted.has(match[1])) continue;
      const prev = latest.get(match[1]);
      if (!prev || b.pathname > prev.pathname) latest.set(match[1], b);
    }
    const people = await mapLimit(Array.from(latest), async ([id, b]) => {
      const raw = await readPrivateText(b.pathname);
      if (raw === null) throw new Error("Stored record version is missing");
      const p = parsePerson(raw);
      if (p.id !== id) throw new Error("Stored person id does not match its path");
      return p;
    });
    for (const p of people) byId.set(p.id, p);
  }
  if (mediaBlobConfigured()) {
    for (const b of await listAll(PERSON_PREFIX, "media")) {
      const match = b.pathname.match(/^people\/([A-Za-z0-9_-]+)\.json$/);
      if (!match || byId.has(match[1]) || deleted.has(match[1])) continue;
      const p = parsePerson(await readPublicText(b));
      if (p.id !== match[1]) throw new Error("Legacy person id does not match its path");
      byId.set(p.id, p);
    }
    for (const p of await readLegacySingle()) {
      if (!byId.has(p.id) && !deleted.has(p.id)) byId.set(p.id, p);
    }
  }
  return Array.from(byId.values()).map(privateMediaView).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  if (process.env.VERCEL && !recordsBlobConfigured()) recordsBlobAuth();
  if (!safeId(idOrSlug)) return null;
  if (await isDeleted(idOrSlug)) return null;
  const direct = await readById(idOrSlug);
  if (direct) return privateMediaView(direct);
  const id = await privateSlugId(idOrSlug) ?? await legacySlugId(idOrSlug);
  const person = id ? await readById(id) : null;
  return person ? privateMediaView(person) : null;
}

export async function createPerson(input: CreatePersonInput): Promise<Person> {
  recordsBlobAuth(); // fail closed before reserving anything if unconfigured
  const slug = await uniqueSlug(input.name, async (s) =>
    (await privateSlugId(s)) !== null || (await legacySlugId(s)) !== null);
  const person = buildPerson(input, slug);
  await writeSlug(slug, person.id);
  await writePerson(person);
  return person;
}

export async function updatePerson(
  id: string, patch: Partial<Omit<Person, "id" | "createdAt">>
): Promise<Person | null> {
  recordsBlobAuth();
  if (!safeId(id)) return null;
  const current = await readById(id);
  if (!current) return null;
  // Public links are stable, including when a student's name is changed.
  const next = { ...current, ...patch, id: current.id, slug: current.slug, createdAt: current.createdAt, updatedAt: Date.now() };
  await writeSlug(next.slug, id);
  await writePerson(next);
  return privateMediaView(next);
}

/** A durable private tombstone hides all versions and legacy fallback copies.
 *  Keep source files and media for recovery; never resurrect a deleted person
 *  merely because their old public record still exists. */
export async function deletePerson(id: string): Promise<boolean> {
  recordsBlobAuth();
  if (!safeId(id)) return false;
  const target = await readById(id);
  if (!target) return false;
  const raw = JSON.stringify({ id, slug: target.slug, deletedAt: Date.now() });
  await put(tombstonePath(id), raw, {
    access: "private", addRandomSuffix: false, allowOverwrite: true,
    contentType: "application/json", ...recordsBlobAuth(),
  });
  await verifyPrivateWrite(tombstonePath(id), raw, "Deletion verification failed");
  return true;
}

export interface MigrationResult {
  dryRun: boolean;
  copied: number;
  skipped: number;
  failed: number;
  results: { id: string; slug?: string; status: "would-copy" | "copied" | "private-exists" | "deleted" | "not-found" | "failed" }[];
}

/** Admin-only caller must explicitly opt into a write. Never remove a source,
 *  replace a newer private record, or regenerate ids/slugs during migration. */
export async function migrateLegacyRecords(options: { dryRun: boolean; ids?: string[] }): Promise<MigrationResult> {
  recordsBlobAuth();
  const ids = options.ids ?? (await listPeople()).map((p) => p.id);
  const report: MigrationResult = { dryRun: options.dryRun, copied: 0, skipped: 0, failed: 0, results: [] };
  for (const id of Array.from(new Set(ids))) {
    try {
      if (!safeId(id)) throw new Error("Invalid person id");
      if (await isDeleted(id)) {
        report.skipped++; report.results.push({ id, status: "deleted" }); continue;
      }
      const current = await readPrivatePerson(id);
      if (current) {
        if (!options.dryRun) await writeSlug(current.slug, id);
        report.skipped++; report.results.push({ id, slug: current.slug, status: "private-exists" }); continue;
      }
      const person = await readLegacyPerson(id);
      if (!person) {
        report.failed++; report.results.push({ id, status: "not-found" }); continue;
      }
      if (options.dryRun) {
        report.results.push({ id, slug: person.slug, status: "would-copy" }); continue;
      }
      await writeSlug(person.slug, id);
      // Recheck immediately before copying; do not overwrite a newer private version.
      if (await readPrivatePerson(id)) {
        report.skipped++; report.results.push({ id, slug: person.slug, status: "private-exists" }); continue;
      }
      await copyLegacyPerson(person);
      report.copied++; report.results.push({ id, slug: person.slug, status: "copied" });
    } catch (err) {
      console.error("[storage-migrate] record failed:", id, err);
      report.failed++; report.results.push({ id, status: "failed" });
    }
  }
  return report;
}

const cleanExt = (ext: string, fallback: string) => ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback;
const MEDIA_PREFIX = "private-media/";
const assetIdPattern = /^[A-Za-z0-9_-]{1,40}(\.(cartoon|loop|audio\.[A-Za-z0-9_-]{1,80}))?$/;
const versionPattern = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function contentType(pathname: string): string {
  const ext = pathname.split(".").at(-1)?.toLowerCase() || "";
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4" } as Record<string, string>)[ext] || "application/octet-stream";
}
function assetUrl(id: string, version: string): string { return `/api/photo/${id}?asset=${version}`; }
function canonicalUrl(url: string): string { const value = new URL(url); value.search = ""; value.hash = ""; return value.toString(); }
function legacyVersion(url: string): string {
  const canonical = canonicalUrl(url);
  const ext = new URL(canonical).pathname.split(".").at(-1) || "bin";
  return `${hash(canonical)}.${cleanExt(ext, "bin").slice(0, 8)}`;
}
function privateMediaView(person: Person): Person {
  const convert = (url: string | undefined, assetId: string) => {
    if (!url || url.startsWith("/api/photo/")) return url;
    try { return assetUrl(assetId, legacyVersion(url)); } catch { return undefined; }
  };
  return { ...person,
    photoUrl: convert(person.photoUrl, person.id),
    cartoonUrl: convert(person.cartoonUrl, `${person.id}.cartoon`),
    loopVideoUrl: convert(person.loopVideoUrl, `${person.id}.loop`),
    sections: person.sections.map((section) => ({ ...section, ...(section.cachedAudio ? {
      cachedAudio: Object.fromEntries(Object.entries(section.cachedAudio).map(([lang, url]) => [lang, convert(url, `${person.id}.audio.${section.id}-${lang}`)])),
    } : {}) })),
  };
}
async function readPrivateBytes(pathname: string): Promise<Buffer | null> {
  const delays = [100, 300];
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await get(pathname, { access: "private", useCache: false, ...recordsBlobAuth() });
      if (!response) return null;
      if (response.statusCode !== 200 || !response.stream) throw new Error("Private media could not be read");
      return await boundedBytes(new Response(response.stream));
    } catch (error) {
      // SDK get() throws BlobError with this fixed prefix for HTTP failures;
      // it has no status property or built-in retries. Only repeat reads for
      // transient service/network failures, never authorization or bad bytes.
      const transientHttp = error instanceof BlobError && /^Vercel Blob: Failed to fetch blob: (?:429|5\d\d)(?:\s|$)/.test(error.message);
      const transientNetwork = error instanceof TypeError && /^(?:fetch failed|Failed to fetch|Network request failed|Load failed|terminated)$/.test(error.message);
      if (attempt >= delays.length || (!transientHttp && !transientNetwork)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
async function boundedBytes(response: Response): Promise<Buffer> {
  const max = 64 * 1024 * 1024;
  if (!response.body || Number(response.headers.get("content-length")) > max) throw new Error("Media exceeds supported size");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > max) throw new Error("Media exceeds supported size");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function copyPrivateBytes(pathname: string, bytes: Buffer): Promise<void> {
  const existing = await readPrivateBytes(pathname);
  if (existing !== null) {
    if (!existing.equals(bytes)) throw new Error("Private media archive differs from source");
    return;
  }
  try {
    await put(pathname, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: contentType(pathname), ...recordsBlobAuth() });
  } catch (error) {
    const current = await readPrivateBytes(pathname);
    if (!current?.equals(bytes)) throw error;
    return;
  }
  for (const delay of [0, 100, 300]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const saved = await readPrivateBytes(pathname);
    if (saved?.equals(bytes)) return;
    if (saved !== null) throw new Error("Private media verification failed");
  }
  throw new Error("Private media verification failed");
}
async function putMedia(assetId: string, buffer: Buffer, ext: string): Promise<string> {
  if (!assetIdPattern.test(assetId)) throw new Error("Invalid media id");
  const version = `${hash(buffer)}.${cleanExt(ext, "bin").slice(0, 8)}`;
  await copyPrivateBytes(`${MEDIA_PREFIX}${assetId}/${version}`, buffer);
  return assetUrl(assetId, version);
}

/** New versions remain available for authorized recovery until event cleanup.
 * Historical public files are removed only by verified privatization. */
export async function deleteMediaUrl(_url: string): Promise<void> {}

export async function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  recordsBlobAuth();
  if (!(await getPerson(id))) throw new Error("person not found");
  const url = await putMedia(id, buffer, cleanExt(ext, "jpg"));
  if (!(await updatePerson(id, { photoUrl: url }))) throw new Error("person not found");
  return url;
}
export async function saveCartoon(id: string, buffer: Buffer, ext: string): Promise<string> {
  recordsBlobAuth();
  if (!(await getPerson(id))) throw new Error("person not found");
  const url = await putMedia(`${id}.cartoon`, buffer, cleanExt(ext, "png"));
  if (!(await updatePerson(id, { cartoonUrl: url }))) throw new Error("person not found");
  return url;
}
export async function saveLoopVideo(id: string, buffer: Buffer, ext: string): Promise<string> {
  recordsBlobAuth();
  if (!(await getPerson(id))) throw new Error("person not found");
  const url = await putMedia(`${id}.loop`, buffer, cleanExt(ext, "mp4"));
  if (!(await updatePerson(id, { loopVideoUrl: url }))) throw new Error("person not found");
  return url;
}
export async function saveAudio(id: string, key: string, buffer: Buffer, ext: string): Promise<string> {
  if (!(await getPerson(id))) throw new Error("person not found");
  return putMedia(`${id}.audio.${key.replace(/[^A-Za-z0-9_-]/g, "")}`, buffer, cleanExt(ext, "mp3"));
}

/** Raw reference lookup is internal only; public/owner records use proxies. */
function storedAsset(person: Person, assetId: string): string | undefined {
  if (assetId === person.id) return person.photoUrl;
  if (assetId === `${person.id}.cartoon`) return person.cartoonUrl;
  if (assetId === `${person.id}.loop`) return person.loopVideoUrl;
  for (const section of person.sections) {
    for (const [lang, url] of Object.entries(section.cachedAudio ?? {})) {
      if (assetId === `${person.id}.audio.${section.id}-${lang}` || url?.startsWith(`/api/photo/${assetId}?`)) return url;
    }
  }
  return undefined;
}
async function readPublicBytes(blob: BlobEntry): Promise<Buffer> {
  const response = await fetch(`${blob.url}${blob.url.includes("?") ? "&" : "?"}v=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Legacy media could not be read (HTTP ${response.status})`);
  return boundedBytes(response);
}
export async function readPhoto(assetId: string, version?: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!assetIdPattern.test(assetId) || (version !== undefined && !versionPattern.test(version))) return null;
  recordsBlobAuth();
  const personId = assetId.split(".")[0];
  if (await isDeleted(personId)) return null;
  const person = await readById(personId); if (!person) return null;
  const original = storedAsset(person, assetId);
  if (!version && original?.startsWith("/api/photo/")) version = new URL(original, "https://local.invalid").searchParams.get("asset") ?? undefined;
  if (version) {
    const bytes = await readPrivateBytes(`${MEDIA_PREFIX}${assetId}/${version}`);
    if (bytes) return { buffer: bytes, contentType: contentType(version) };
  }
  if (!original || original.startsWith("/api/photo/")) return null;
  let url: URL;
  try { url = new URL(original); } catch { return null; }
  if (url.protocol !== "https:" || (version && legacyVersion(original) !== version)) return null;
  const pathname = url.pathname.replace(/^\//, "");
  const prefix = assetId.includes(".audio.") ? "audio" : assetId.endsWith(".cartoon") ? "cartoons" : assetId.endsWith(".loop") ? "loops" : "photos";
  if (!pathname.startsWith(`${prefix}/${personId}.`) && !pathname.startsWith(`${prefix}/${personId}-`)) return null;
  const archived = await readPrivateBytes(`legacy-archive/media/${pathname}`);
  if (archived) return { buffer: archived, contentType: contentType(pathname) };
  // Transition-only fallback: fetch only an exact entry in OUR legacy store.
  // Never redirect a client to an old public URL or fetch arbitrary input URLs.
  if (!mediaBlobConfigured()) return null;
  const legacy = await findBlob(pathname, "media");
  if (!legacy || canonicalUrl(legacy.url) !== canonicalUrl(original)) return null;
  return { buffer: await readPublicBytes(legacy), contentType: contentType(pathname) };
}


/** Enumerate every version/orphan in application-owned namespaces, rather
 *  than only live people (tombstones hide the records needing deletion too). */
async function eventBlobs(): Promise<{ store: Store; blob: BlobEntry }[]> {
  // Missing one credential must not be reported as complete erasure.
  recordsBlobAuth(); mediaBlobAuth();
  const out: { store: Store; blob: BlobEntry }[] = [];
  for (const store of ["records", "media"] as const) {
    const prefixes = store === "records"
      ? ["people/", "slugs/", "deleted/", "legacy-archive/", "private-media/"]
      : ["people/", "slugs/", "photos/", "cartoons/", "loops/", "audio/"];
    for (const prefix of prefixes) {
      for (const blob of await listAll(prefix, store)) out.push({ store, blob });
    }
    const single = await findBlob(LEGACY_SINGLE, store);
    if (single) out.push({ store, blob: single });
  }
  return out;
}

/** Irreversible removal of event-owned data, possible only after event end.
 *  Repeat safely after timeout/partial failure; errors never imply success. */
export async function purgeEventData({ dryRun }: { dryRun: boolean }): Promise<PurgeResult> {
  if (!dryRun) assertEventPurgeAllowed();
  const entries = await eventBlobs();
  if (dryRun) return { dryRun: true, candidates: entries.length, deleted: 0, remaining: entries.length };
  await mapLimit(entries, async ({ store, blob }) => { await del(blob.pathname, auth(store)); });
  const remaining = (await eventBlobs()).length;
  return { dryRun: false, candidates: entries.length, deleted: entries.length, remaining };
}

/** Populate exact owner-scoped private aliases for every historical record.
 * URL normalization can then be saved by an editor without losing the origin
 * lookup. No Person is rewritten, so concurrent manuscript edits cannot lose. */
async function createLegacyMediaAliases(media: BlobEntry[], sources: BlobEntry[]): Promise<void> {
  const originals = new Map(media.map((blob) => [canonicalUrl(blob.url), blob]));
  const versions = new Map(media.map((blob) => [legacyVersion(blob.url), blob]));
  const people: Person[] = [];
  for (const blob of await listAll(PERSON_PREFIX, "records")) {
    if (!/^people\/[A-Za-z0-9_-]+\/[^/]+\.json$/.test(blob.pathname)) continue;
    const raw = await readPrivateText(blob.pathname);
    if (raw === null) throw new Error("Private history is missing during media migration");
    people.push(parsePerson(raw));
  }
  for (const blob of sources) {
    const raw = await readPublicText(blob);
    if (blob.pathname === LEGACY_SINGLE) {
      const rows: unknown = JSON.parse(raw); if (!Array.isArray(rows)) throw new Error("Invalid legacy list");
      people.push(...rows.map((row) => parsePerson(JSON.stringify(row))));
    } else people.push(parsePerson(raw));
  }
  const copiedAliases = new Set<string>();
  for (const person of people) {
    const refs: [string, string | undefined, string][] = [
      [person.id, person.photoUrl, "photos"], [`${person.id}.cartoon`, person.cartoonUrl, "cartoons"], [`${person.id}.loop`, person.loopVideoUrl, "loops"],
    ];
    for (const section of person.sections) for (const [lang, url] of Object.entries(section.cachedAudio ?? {})) refs.push([`${person.id}.audio.${section.id}-${lang}`, url, "audio"]);
    for (const [defaultId, url, prefix] of refs) {
      if (!url) continue;
      let blob: BlobEntry | undefined; let assetId = defaultId;
      if (url.startsWith("/api/photo/")) {
        const proxy = new URL(url, "https://local.invalid");
        assetId = proxy.pathname.slice("/api/photo/".length);
        blob = versions.get(proxy.searchParams.get("asset") || "");
      } else {
        try { blob = originals.get(canonicalUrl(url)); } catch { continue; }
      }
      if (!blob) continue;
      if (!assetIdPattern.test(assetId) || assetId.split(".")[0] !== person.id ||
          (!blob.pathname.startsWith(`${prefix}/${person.id}.`) && !blob.pathname.startsWith(`${prefix}/${person.id}-`))) throw new Error("Legacy media ownership mismatch");
      const aliasPath = `${MEDIA_PREFIX}${assetId}/${legacyVersion(blob.url)}`;
      if (copiedAliases.has(aliasPath)) continue;
      const bytes = await readPrivateBytes(`legacy-archive/media/${blob.pathname}`);
      if (!bytes) throw new Error("Verified media archive is missing");
      await copyPrivateBytes(aliasPath, bytes);
      copiedAliases.add(aliasPath);
    }
  }
}

/** Move plaintext legacy sources into private archives after exact readback,
 *  while preserving the authoritative current record and stable QR mapping.
 *  This is a separate explicit maintenance action, never a read-side effect. */
export async function privatizeLegacyRecords({ dryRun }: { dryRun: boolean }) {
  recordsBlobAuth(); mediaBlobAuth();
  const sources = (await listAll(PERSON_PREFIX, "media")).filter((b) => /^people\/[A-Za-z0-9_-]+\.json$/.test(b.pathname));
  const single = await findBlob(LEGACY_SINGLE, "media");
  if (single) sources.push(single);
  const media: BlobEntry[] = [];
  for (const prefix of ["photos/", "cartoons/", "loops/", "audio/"]) media.push(...await listAll(prefix, "media"));
  let mediaMoved = 0;
  if (!dryRun) {
    // Copy every version/orphan first. A failure retains all public media.
    for (const blob of media) {
      const bytes = await readPublicBytes(blob);
      await copyPrivateBytes(`legacy-archive/media/${blob.pathname}`, bytes);
    }
    await createLegacyMediaAliases(media, sources);
  }
  let moved = 0;
  for (const source of sources) {
    const raw = await readPublicText(source);
    const people = source.pathname === LEGACY_SINGLE
      ? (() => { const rows: unknown = JSON.parse(raw); if (!Array.isArray(rows)) throw new Error("Invalid legacy list"); return rows.map((p) => parsePerson(JSON.stringify(p))); })()
      : [parsePerson(raw)];
    if (dryRun) continue;
    // Archive all historical bytes even if a newer private edit exists.
    const archivePath = `legacy-archive/${source.pathname}`;
    const existing = await readPrivateText(archivePath);
    if (existing === null) {
      await put(archivePath, raw, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json", ...recordsBlobAuth() });
    }
    await verifyPrivateWrite(archivePath, raw, "Private archive verification failed");
    for (const person of people) {
      if (await isDeleted(person.id)) continue;
      if (!(await readPrivatePerson(person.id))) await copyLegacyPerson(person);
      await writeSlug(person.slug, person.id);
    }
    await del(source.pathname, mediaBlobAuth());
    moved++;
  }
  if (!dryRun) {
    // Pure read-time URL normalization keeps current concurrent edits intact.
    // New uploads are private, so no new public assets can race this inventory.
    for (const blob of media) { await del(blob.pathname, mediaBlobAuth()); mediaMoved++; }
  }
  let remainingPublicMedia = 0;
  for (const prefix of ["photos/", "cartoons/", "loops/", "audio/"]) remainingPublicMedia += (await listAll(prefix, "media")).length;
  return { dryRun, candidates: sources.length, moved, mediaCandidates: media.length, mediaMoved, remainingPublicMedia };
}
