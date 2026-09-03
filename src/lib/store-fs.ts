import { promises as fs } from "fs";
import path from "path";
import type { Person } from "./types";
import {
  buildPerson,
  contentTypeForExt,
  newId,
  safeId,
  uniqueSlug,
  type CreatePersonInput,
} from "./store-shared";

// Filesystem driver — default for local dev (zero external setup) and for a
// single always-on server. One JSON file per person under ./data/people so
// concurrent writes to different people never clobber each other.
// NOT used on Vercel (read-only FS); see store-blob.ts.

const DATA_DIR = path.join(process.cwd(), "data");
const PEOPLE_DIR = path.join(DATA_DIR, "people");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
/** Pre-refactor single-file store; migrated to per-person files on first use. */
const LEGACY_DB = path.join(DATA_DIR, "people.json");
const LEGACY_DONE = path.join(DATA_DIR, "people.legacy.json");

const personFile = (id: string) => path.join(PEOPLE_DIR, `${id}.json`);

async function ensureDirs() {
  await fs.mkdir(PEOPLE_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

async function readPersonFile(file: string): Promise<Person | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Person;
  } catch {
    return null;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written record. */
async function writePerson(p: Person): Promise<void> {
  await ensureDirs();
  const file = personFile(p.id);
  const tmp = `${file}.${newId()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(p, null, 2), "utf8");
  await fs.rename(tmp, file);
}

let migration: Promise<void> | null = null;
/** One-time split of the old data/people.json into per-person files. */
function migrateLegacy(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      await ensureDirs();
      let raw: string;
      try {
        raw = await fs.readFile(LEGACY_DB, "utf8");
      } catch {
        return; // nothing to migrate
      }
      let people: Person[] = [];
      try {
        people = JSON.parse(raw) as Person[];
      } catch {
        console.error("[store-fs] legacy people.json is not valid JSON; leaving it alone");
        return;
      }
      for (const p of people) {
        if (!safeId(p?.id)) continue;
        const exists = await readPersonFile(personFile(p.id));
        if (!exists) await writePerson(p);
      }
      await fs.rename(LEGACY_DB, LEGACY_DONE);
      console.log(`[store-fs] migrated ${people.length} people from people.json → data/people/`);
    })().catch((err) => {
      migration = null; // let the next request retry
      throw err;
    });
  }
  return migration;
}

async function readAll(): Promise<Person[]> {
  await migrateLegacy();
  let files: string[];
  try {
    files = await fs.readdir(PEOPLE_DIR);
  } catch {
    return [];
  }
  const people = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readPersonFile(path.join(PEOPLE_DIR, f)))
  );
  return people.filter((p): p is Person => !!p);
}

export async function listPeople(): Promise<Person[]> {
  return (await readAll()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  if (!safeId(idOrSlug)) return null;
  await migrateLegacy();
  const byId = await readPersonFile(personFile(idOrSlug));
  if (byId) return byId;
  return (await readAll()).find((p) => p.slug === idOrSlug) ?? null;
}

export async function createPerson(input: CreatePersonInput): Promise<Person> {
  const taken = new Set((await readAll()).map((p) => p.slug));
  const slug = await uniqueSlug(input.name, async (s) => taken.has(s));
  const person = buildPerson(input, slug);
  await writePerson(person);
  return person;
}

export async function updatePerson(
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>
): Promise<Person | null> {
  if (!safeId(id)) return null;
  await migrateLegacy();
  const current = await readPersonFile(personFile(id));
  if (!current) return null;
  const next: Person = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() };
  await writePerson(next);
  return next;
}

async function removeUploads(id: string) {
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(id + ".")).map((f) => fs.unlink(path.join(UPLOAD_DIR, f)))
    );
  } catch {
    /* ignore */
  }
}

export async function deletePerson(id: string): Promise<boolean> {
  if (!safeId(id)) return false;
  await migrateLegacy();
  try {
    await fs.unlink(personFile(id));
  } catch {
    return false;
  }
  await removeUploads(id);
  return true;
}

async function unlinkMatching(prefix: string) {
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(prefix)).map((f) => fs.unlink(path.join(UPLOAD_DIR, f)))
    );
  } catch {
    /* ignore */
  }
}

function cleanExt(ext: string, fallback: string): string {
  return ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback;
}

export async function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  await ensureDirs();
  const safeExt = cleanExt(ext, "jpg");
  // Remove the previous photo (any extension) but keep cartoon/loop files.
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith(id + ".") && !f.includes(".cartoon.") && !f.includes(".loop."))
        .map((f) => fs.unlink(path.join(UPLOAD_DIR, f)))
    );
  } catch {
    /* ignore */
  }
  await fs.writeFile(path.join(UPLOAD_DIR, `${id}.${safeExt}`), buffer);
  // Version the URL so browsers/CDNs don't keep showing the replaced photo.
  const photoUrl = `/api/photo/${id}?v=${Date.now()}`;
  await updatePerson(id, { photoUrl });
  return photoUrl;
}

export async function saveCartoon(id: string, buffer: Buffer, ext: string): Promise<string> {
  await ensureDirs();
  const safeExt = cleanExt(ext, "png");
  await unlinkMatching(`${id}.cartoon.`);
  await fs.writeFile(path.join(UPLOAD_DIR, `${id}.cartoon.${safeExt}`), buffer);
  const cartoonUrl = `/api/photo/${id}.cartoon?v=${Date.now()}`;
  await updatePerson(id, { cartoonUrl });
  return cartoonUrl;
}

export async function saveLoopVideo(id: string, buffer: Buffer, ext: string): Promise<string> {
  await ensureDirs();
  const safeExt = cleanExt(ext, "mp4");
  await unlinkMatching(`${id}.loop.`);
  await fs.writeFile(path.join(UPLOAD_DIR, `${id}.loop.${safeExt}`), buffer);
  const loopVideoUrl = `/api/photo/${id}.loop?v=${Date.now()}`;
  await updatePerson(id, { loopVideoUrl });
  return loopVideoUrl;
}

/** Pre-generated narration for one section + language. `key` is
 *  "<sectionId>-<lang>"; served from /api/photo/<id>.audio.<key>. */
export async function saveAudio(id: string, key: string, buffer: Buffer, ext: string): Promise<string> {
  await ensureDirs();
  const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "");
  const safeExt = cleanExt(ext, "mp3");
  await unlinkMatching(`${id}.audio.${safeKey}.`);
  await fs.writeFile(path.join(UPLOAD_DIR, `${id}.audio.${safeKey}.${safeExt}`), buffer);
  return `/api/photo/${id}.audio.${safeKey}?v=${Date.now()}`;
}

/** Filesystem media is overwritten in place by save*(); nothing to delete. */
export async function deleteMediaUrl(_url: string): Promise<void> {}

export async function readPhoto(
  id: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!/^[A-Za-z0-9_-]{1,40}(\.(cartoon|loop|audio\.[A-Za-z0-9_-]{1,80}))?$/.test(id)) return null;
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    const base = id.split(".")[0];
    const wantCartoon = id.endsWith(".cartoon");
    const wantLoop = id.endsWith(".loop");
    const audioKey = id.includes(".audio.") ? id.slice(id.indexOf(".audio.") + 7) : null;
    const marker = wantCartoon ? ".cartoon." : wantLoop ? ".loop." : audioKey ? `.audio.${audioKey}.` : null;
    const file = files.find(
      (f) =>
        f.startsWith(base + ".") &&
        !f.endsWith(".tmp") &&
        (marker ? f.includes(marker) : !f.includes(".cartoon.") && !f.includes(".loop.") && !f.includes(".audio."))
    );
    if (!file) return null;
    const buffer = await fs.readFile(path.join(UPLOAD_DIR, file));
    const ext = file.split(".").pop()!.toLowerCase();
    return { buffer, contentType: contentTypeForExt(ext) };
  } catch {
    return null;
  }
}
