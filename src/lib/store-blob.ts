import { put, get, list, del, head, BlobNotFoundError } from "@vercel/blob";
import type { Person } from "./types";
import { blobAuth, buildPerson, safeId, uniqueSlug, type CreatePersonInput } from "./store-shared";

// Vercel Blob driver — used in production (Vercel's filesystem is read-only).
//
// Layout
//   people/<id>/<version>.json   PRIVATE. One immutable blob per saved
//                                version; the newest wins. Never overwritten,
//                                so no CDN/edge cache can serve a stale copy,
//                                and no public URL exists for a record (it
//                                holds the student's edit token).
//   slugs/<slug>                 PRIVATE, write-once: the id behind /p/<slug>.
//   photos/…, cartoons/…, loops/…, audio/…  PUBLIC media with random suffixes
//                                (served straight to browsers and to A2E).
//
// Older layouts are migrated on first access: the single public
// data/people.json, and the public fixed-path people/<id>.json + slugs/<slug>.txt.
//
// The token is resolved at call time (by value, so a non-standard env var name
// still works) and passed explicitly to every Blob call.

const PERSON_PREFIX = "people/";
const SLUG_PREFIX = "slugs/";
const LEGACY_SINGLE = "data/people.json";

const personDir = (id: string) => `${PERSON_PREFIX}${id}/`;
const slugPath = (slug: string) => `${SLUG_PREFIX}${slug}`;

/** Version names sort lexically by time. `after` is the version being
 *  replaced: the new name is always strictly greater than it, so two writes
 *  in the same millisecond (or from instances with skewed clocks) can never
 *  make an older record look newest. */
function versionName(after?: string): string {
  const prev = after ? Number(after.slice(0, 14)) : 0;
  const t = Math.max(Date.now(), Number.isFinite(prev) ? prev + 1 : 0).toString().padStart(14, "0");
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}.json`;
}
function versionOf(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf("/") + 1);
}

// ── Low-level helpers ──

async function readPrivateText(pathname: string): Promise<string | null> {
  const res = await get(pathname, { access: "private", ...blobAuth() });
  if (!res || res.statusCode !== 200 || !res.stream) return null;
  return new Response(res.stream).text();
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await head(pathname, blobAuth());
    return true;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return false;
    throw e;
  }
}

async function listAll(prefix: string): Promise<{ pathname: string; url: string; uploadedAt: Date }[]> {
  const out: { pathname: string; url: string; uploadedAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, ...blobAuth() });
    out.push(...page.blobs.map((b) => ({ pathname: b.pathname, url: b.url, uploadedAt: b.uploadedAt })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function delQuiet(urlOrPath: string | undefined) {
  if (!urlOrPath) return;
  try {
    await del(urlOrPath, blobAuth());
  } catch {
    /* ignore */
  }
}

// ── Records ──

/** Newest version blob of a person (by name, which embeds the write time). */
function newest<T extends { pathname: string }>(versions: T[]): T | null {
  if (!versions.length) return null;
  return [...versions].sort((a, b) => (a.pathname < b.pathname ? 1 : -1))[0];
}

async function writePerson(p: Person, after?: string): Promise<void> {
  const version = versionName(after ?? cache.get(p.id)?.version);
  const pathname = personDir(p.id) + version;
  await put(pathname, JSON.stringify(p), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
    ...blobAuth(),
  });
  cache.set(p.id, { p, at: Date.now(), version });
  // Keep the two newest versions (a concurrent reader may still be on the
  // previous one); drop the rest.
  const versions = await listAll(personDir(p.id));
  const keep = new Set([...versions].sort((a, b) => (a.pathname < b.pathname ? 1 : -1)).slice(0, 2).map((v) => v.pathname));
  await Promise.all(versions.filter((v) => !keep.has(v.pathname)).map((v) => delQuiet(v.pathname)));
}

// Small per-instance read cache: the visitor page and every chat call read
// the same record; writes on this instance update it immediately.
const CACHE_MS = 5000;
const cache = new Map<string, { p: Person; at: number; version: string }>();

async function readById(id: string, fresh = false): Promise<Person | null> {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const v = newest(await listAll(personDir(id)));
  if (!v) {
    cache.delete(id);
    return null;
  }
  const text = await readPrivateText(v.pathname);
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Person;
    cache.set(id, { p, at: Date.now(), version: versionOf(v.pathname) });
    return p;
  } catch {
    return null;
  }
}

async function writeSlug(slug: string, id: string): Promise<void> {
  await put(slugPath(slug), id, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "text/plain",
    ...blobAuth(),
  });
}

async function idForSlug(slug: string): Promise<string | null> {
  if (!(await exists(slugPath(slug)))) return null;
  const id = (await readPrivateText(slugPath(slug)))?.trim();
  return safeId(id) ? id : null;
}

// ── Migrations (run once per instance, never overwrite newer data) ──

let migration: Promise<void> | null = null;
function migrate(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      await migrateSingleFile();
      await migratePublicRecords();
    })().catch((err) => {
      migration = null; // let the next request retry
      throw err;
    });
  }
  return migration;
}

/** v1: one public data/people.json holding everyone. */
async function migrateSingleFile() {
  if (!(await exists(LEGACY_SINGLE))) return;
  const { url } = await head(LEGACY_SINGLE, blobAuth());
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return;
  let people: Person[] = [];
  try {
    people = (await res.json()) as Person[];
  } catch {
    console.error("[store-blob] legacy data/people.json is not valid JSON; leaving it alone");
    return;
  }
  for (const p of people) {
    if (!safeId(p?.id) || !safeId(p?.slug)) continue;
    if (!(await readById(p.id, true))) await writePerson(p);
    if (!(await exists(slugPath(p.slug)))) await writeSlug(p.slug, p.id);
  }
  await del(LEGACY_SINGLE, blobAuth());
  console.log(`[store-blob] migrated ${people.length} people from data/people.json`);
}

/** v2: public fixed-path people/<id>.json and slugs/<slug>.txt. */
async function migratePublicRecords() {
  const records = (await listAll(PERSON_PREFIX)).filter((b) => /^people\/[A-Za-z0-9_-]+\.json$/.test(b.pathname));
  for (const b of records) {
    const id = b.pathname.slice(PERSON_PREFIX.length, -".json".length);
    try {
      const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const p = (await res.json()) as Person;
        if (safeId(p?.id) && !(await readById(p.id, true))) await writePerson(p);
      }
    } catch (err) {
      console.error(`[store-blob] could not migrate ${b.pathname}:`, err);
      continue;
    }
    await delQuiet(b.pathname);
    void id;
  }
  const markers = (await listAll(SLUG_PREFIX)).filter((b) => b.pathname.endsWith(".txt"));
  for (const b of markers) {
    const slug = b.pathname.slice(SLUG_PREFIX.length, -".txt".length);
    try {
      const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: "no-store" });
      const id = (await res.text()).trim();
      if (res.ok && safeId(slug) && safeId(id) && !(await exists(slugPath(slug)))) await writeSlug(slug, id);
    } catch (err) {
      console.error(`[store-blob] could not migrate ${b.pathname}:`, err);
      continue;
    }
    await delQuiet(b.pathname);
  }
  if (records.length || markers.length) {
    console.log(`[store-blob] moved ${records.length} records and ${markers.length} slug markers to private storage`);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

// ── Public API (mirrors store-fs.ts) ──

export async function listPeople(): Promise<Person[]> {
  await migrate();
  const all = await listAll(PERSON_PREFIX);
  // Group versions by id and read the newest of each.
  const byId = new Map<string, { pathname: string }[]>();
  for (const b of all) {
    const m = b.pathname.match(/^people\/([A-Za-z0-9_-]+)\/[^/]+\.json$/);
    if (!m) continue;
    const arr = byId.get(m[1]) || [];
    arr.push(b);
    byId.set(m[1], arr);
  }
  const people = await mapLimit(Array.from(byId.values()), 8, async (versions) => {
    const v = newest(versions);
    if (!v) return null;
    const text = await readPrivateText(v.pathname);
    if (!text) return null;
    try {
      const p = JSON.parse(text) as Person;
      cache.set(p.id, { p, at: Date.now(), version: versionOf(v.pathname) });
      return p;
    } catch {
      return null;
    }
  });
  return people.filter((p): p is Person => !!p).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  if (!safeId(idOrSlug)) return null;
  await migrate();
  const byId = await readById(idOrSlug);
  if (byId) return byId;
  const id = await idForSlug(idOrSlug);
  return id ? readById(id) : null;
}

export async function createPerson(input: CreatePersonInput): Promise<Person> {
  await migrate();
  const slug = await uniqueSlug(input.name, (s) => exists(slugPath(s)));
  const person = buildPerson(input, slug);
  // Slug marker first: a dangling marker is harmless, an unreachable person is not.
  await writeSlug(slug, person.id);
  await writePerson(person);
  return person;
}

export async function updatePerson(
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>
): Promise<Person | null> {
  if (!safeId(id)) return null;
  await migrate();
  const current = await readById(id, true);
  if (!current) return null;
  const next: Person = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() };
  await writePerson(next, cache.get(id)?.version);
  return next;
}

export async function deletePerson(id: string): Promise<boolean> {
  if (!safeId(id)) return false;
  await migrate();
  const target = await readById(id, true);
  if (!target) return false;
  const versions = await listAll(personDir(id));
  await Promise.all(versions.map((v) => delQuiet(v.pathname)));
  cache.delete(id);
  await delQuiet(slugPath(target.slug));
  const media = [target.photoUrl, target.cartoonUrl, target.loopVideoUrl];
  for (const s of target.sections) for (const u of Object.values(s.cachedAudio || {})) media.push(u);
  for (const u of media) {
    if (u?.startsWith("http")) await delQuiet(u);
  }
  return true;
}

function cleanExt(ext: string, fallback: string): string {
  return ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback;
}

async function putMedia(pathname: string, buffer: Buffer): Promise<string> {
  const { url } = await put(pathname, buffer, {
    access: "public",
    addRandomSuffix: true,
    cacheControlMaxAge: 31536000,
    ...blobAuth(),
  });
  return url;
}

/** Remove a media blob we no longer reference (e.g. regenerated audio). */
export async function deleteMediaUrl(url: string): Promise<void> {
  if (url.startsWith("http")) await delQuiet(url);
}

export async function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  const person = await getPerson(id);
  if (!person) throw new Error("person not found");
  const url = await putMedia(`photos/${id}.${cleanExt(ext, "jpg")}`, buffer);
  await updatePerson(id, { photoUrl: url });
  if (person.photoUrl?.startsWith("http")) await delQuiet(person.photoUrl);
  return url;
}

export async function saveCartoon(id: string, buffer: Buffer, ext: string): Promise<string> {
  const person = await getPerson(id);
  if (!person) throw new Error("person not found");
  const url = await putMedia(`cartoons/${id}.${cleanExt(ext, "png")}`, buffer);
  await updatePerson(id, { cartoonUrl: url });
  if (person.cartoonUrl?.startsWith("http")) await delQuiet(person.cartoonUrl);
  return url;
}

export async function saveAudio(id: string, key: string, buffer: Buffer, ext: string): Promise<string> {
  const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "");
  return putMedia(`audio/${id}-${safeKey}.${cleanExt(ext, "mp3")}`, buffer);
}

export async function saveLoopVideo(id: string, buffer: Buffer, ext: string): Promise<string> {
  const person = await getPerson(id);
  if (!person) throw new Error("person not found");
  const url = await putMedia(`loops/${id}.${cleanExt(ext, "mp4")}`, buffer);
  await updatePerson(id, { loopVideoUrl: url });
  if (person.loopVideoUrl?.startsWith("http")) await delQuiet(person.loopVideoUrl);
  return url;
}

// Media is served directly from the Blob CDN (absolute URLs), so the
// /api/photo route is never hit in Blob mode. Signature mirrors the fs driver.
export async function readPhoto(
  _id: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  return null;
}
