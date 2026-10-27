import { put, get, list, del, head, BlobNotFoundError } from "@vercel/blob";
import type { Person } from "./types";
import {
  buildPerson, safeId, uniqueSlug, mediaBlobAuth, mediaBlobConfigured,
  recordsBlobAuth, recordsBlobConfigured, type CreatePersonInput,
} from "./store-shared";

// Two stores, explicitly routed: private records and public media. Legacy
// public records are READ ONLY. Ordinary reads never migrate, write or delete.
// Explicit migration copies records and verifies them, retaining every source.
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
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  if (process.env.VERCEL && !recordsBlobConfigured()) recordsBlobAuth();
  if (!safeId(idOrSlug)) return null;
  if (await isDeleted(idOrSlug)) return null;
  const direct = await readById(idOrSlug);
  if (direct) return direct;
  const id = await privateSlugId(idOrSlug) ?? await legacySlugId(idOrSlug);
  return id ? readById(id) : null;
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
  return next;
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
async function putMedia(pathname: string, buffer: Buffer): Promise<string> {
  const { url } = await put(pathname, buffer, {
    access: "public", addRandomSuffix: true, cacheControlMaxAge: 31536000, ...mediaBlobAuth(),
  });
  return url;
}

/** Only explicit cleanup calls remove media. Replacing a portrait must not
 *  destroy the original files retained for recovery. */
export async function deleteMediaUrl(url: string): Promise<void> {
  if (url.startsWith("http")) await del(url, mediaBlobAuth());
}

export async function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  recordsBlobAuth();
  if (!(await getPerson(id))) throw new Error("person not found");
  const url = await putMedia(`photos/${id}.${cleanExt(ext, "jpg")}`, buffer);
  if (!(await updatePerson(id, { photoUrl: url }))) throw new Error("person not found");
  return url;
}
export async function saveCartoon(id: string, buffer: Buffer, ext: string): Promise<string> {
  recordsBlobAuth();
  if (!(await getPerson(id))) throw new Error("person not found");
  const url = await putMedia(`cartoons/${id}.${cleanExt(ext, "png")}`, buffer);
  if (!(await updatePerson(id, { cartoonUrl: url }))) throw new Error("person not found");
  return url;
}
export async function saveLoopVideo(id: string, buffer: Buffer, ext: string): Promise<string> {
  recordsBlobAuth();
  if (!(await getPerson(id))) throw new Error("person not found");
  const url = await putMedia(`loops/${id}.${cleanExt(ext, "mp4")}`, buffer);
  if (!(await updatePerson(id, { loopVideoUrl: url }))) throw new Error("person not found");
  return url;
}
export async function saveAudio(id: string, key: string, buffer: Buffer, ext: string): Promise<string> {
  return putMedia(`audio/${id}-${key.replace(/[^A-Za-z0-9_-]/g, "")}.${cleanExt(ext, "mp3")}`, buffer);
}
export async function readPhoto(_id: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  return null;
}
