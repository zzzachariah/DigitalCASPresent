import { put, list, del, head, BlobNotFoundError } from "@vercel/blob";
import type { Person } from "./types";
import { blobAuth, buildPerson, safeId, uniqueSlug, type CreatePersonInput } from "./store-shared";

// Vercel Blob driver — used in production (Vercel's filesystem is read-only).
//
// Layout (one blob per record, so concurrent writes never clobber each other):
//   people/<id>.json   the person record (source of truth)
//   slugs/<slug>.txt   contains the id — lets /p/<slug> resolve without a
//                      shared index file (and makes slug uniqueness a cheap
//                      existence check)
//   photos/…, cartoons/…, loops/…  media, public CDN URLs (also fetchable by
//                      the avatar providers). Uploaded with a random suffix so
//                      a replaced photo gets a NEW url — overwriting the same
//                      path would leave the CDN serving the old image.
//
// The token is resolved at call time (by value, so a non-standard env var name
// still works) and passed explicitly to every Blob call.

const PERSON_PREFIX = "people/";
const SLUG_PREFIX = "slugs/";
/** Pre-refactor single-file store; split into per-person blobs on first use. */
const LEGACY_PATH = "data/people.json";

const personPath = (id: string) => `${PERSON_PREFIX}${id}.json`;
const slugPath = (slug: string) => `${SLUG_PREFIX}${slug}.txt`;

/** Blob CDN caches aggressively; a unique query string guarantees a fresh read. */
async function fetchFresh(url: string): Promise<string | null> {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.text();
}

/** Public URL of a blob by pathname, or null when it doesn't exist. */
async function urlFor(pathname: string): Promise<string | null> {
  try {
    return (await head(pathname, blobAuth())).url;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
}

async function readPersonAt(url: string): Promise<Person | null> {
  const text = await fetchFresh(url);
  if (!text) return null;
  try {
    return JSON.parse(text) as Person;
  } catch {
    return null;
  }
}

const smallBlobOptions = {
  access: "public" as const,
  addRandomSuffix: false,
  allowOverwrite: true,
  cacheControlMaxAge: 60, // the minimum; reads cache-bust anyway
};

async function writePerson(p: Person): Promise<void> {
  await put(personPath(p.id), JSON.stringify(p), {
    ...smallBlobOptions,
    contentType: "application/json",
    ...blobAuth(),
  });
}

async function writeSlug(slug: string, id: string): Promise<void> {
  await put(slugPath(slug), id, { ...smallBlobOptions, contentType: "text/plain", ...blobAuth() });
}

async function listAll(prefix: string): Promise<{ pathname: string; url: string }[]> {
  const out: { pathname: string; url: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, ...blobAuth() });
    out.push(...page.blobs.map((b) => ({ pathname: b.pathname, url: b.url })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

let migration: Promise<void> | null = null;
/** One-time split of the old data/people.json blob into per-person blobs.
 *  Checked once per instance; existing per-person blobs are never overwritten
 *  (so two instances migrating at once can't roll back a fresh edit). */
function migrateLegacy(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      const url = await urlFor(LEGACY_PATH);
      if (!url) return;
      const text = await fetchFresh(url);
      if (!text) return;
      let people: Person[] = [];
      try {
        people = JSON.parse(text) as Person[];
      } catch {
        console.error("[store-blob] legacy data/people.json is not valid JSON; leaving it alone");
        return;
      }
      for (const p of people) {
        if (!safeId(p?.id) || !safeId(p?.slug)) continue;
        if (!(await urlFor(personPath(p.id)))) await writePerson(p);
        if (!(await urlFor(slugPath(p.slug)))) await writeSlug(p.slug, p.id);
      }
      await del(LEGACY_PATH, blobAuth());
      console.log(`[store-blob] migrated ${people.length} people from data/people.json → people/*`);
    })().catch((err) => {
      migration = null; // let the next request retry
      throw err;
    });
  }
  return migration;
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

export async function listPeople(): Promise<Person[]> {
  await migrateLegacy();
  const blobs = await listAll(PERSON_PREFIX);
  const people = await mapLimit(blobs, 8, (b) => readPersonAt(b.url));
  return people.filter((p): p is Person => !!p).sort((a, b) => a.createdAt - b.createdAt);
}

async function readById(id: string): Promise<Person | null> {
  const url = await urlFor(personPath(id));
  return url ? readPersonAt(url) : null;
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  if (!safeId(idOrSlug)) return null;
  await migrateLegacy();
  const byId = await readById(idOrSlug);
  if (byId) return byId;
  const slugUrl = await urlFor(slugPath(idOrSlug));
  if (!slugUrl) return null;
  const id = (await fetchFresh(slugUrl))?.trim();
  return safeId(id) ? readById(id) : null;
}

export async function createPerson(input: CreatePersonInput): Promise<Person> {
  await migrateLegacy();
  const slug = await uniqueSlug(input.name, async (s) => !!(await urlFor(slugPath(s))));
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
  await migrateLegacy();
  const current = await readById(id);
  if (!current) return null;
  const next: Person = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() };
  await writePerson(next);
  return next;
}

async function delQuiet(urlOrPath: string | undefined) {
  if (!urlOrPath) return;
  try {
    await del(urlOrPath, blobAuth());
  } catch {
    /* ignore */
  }
}

export async function deletePerson(id: string): Promise<boolean> {
  if (!safeId(id)) return false;
  await migrateLegacy();
  const target = await readById(id);
  if (!target) return false;
  await del(personPath(id), blobAuth());
  await delQuiet(slugPath(target.slug));
  for (const u of [target.photoUrl, target.cartoonUrl, target.loopVideoUrl]) {
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
