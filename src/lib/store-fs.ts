import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Person } from "./types";
import { contentTypeForExt, uniqueSlug } from "./store-shared";

// Filesystem driver — default for local dev (zero external setup).
// Persists to ./data. NOT used on Vercel (read-only FS); see store-blob.ts.

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "people.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

async function ensureDirs() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

async function readDb(): Promise<Person[]> {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8")) as Person[];
  } catch {
    return [];
  }
}

async function writeDb(people: Person[]): Promise<void> {
  await ensureDirs();
  await fs.writeFile(DB_FILE, JSON.stringify(people, null, 2), "utf8");
}

export async function listPeople(): Promise<Person[]> {
  return (await readDb()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  const people = await readDb();
  return people.find((p) => p.id === idOrSlug || p.slug === idOrSlug) ?? null;
}

export async function createPerson(
  input: Pick<Person, "name" | "subtitle" | "gender" | "script" | "sections" | "language">
): Promise<Person> {
  const people = await readDb();
  const now = Date.now();
  const person: Person = {
    id: nanoid(10),
    slug: uniqueSlug(input.name, new Set(people.map((p) => p.slug))),
    name: input.name,
    subtitle: input.subtitle,
    gender: input.gender,
    script: input.script,
    sections: input.sections,
    language: input.language,
    createdAt: now,
    updatedAt: now,
  };
  people.push(person);
  await writeDb(people);
  return person;
}

export async function updatePerson(
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>
): Promise<Person | null> {
  const people = await readDb();
  const idx = people.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  people[idx] = { ...people[idx], ...patch, updatedAt: Date.now() };
  await writeDb(people);
  return people[idx];
}

export async function deletePerson(id: string): Promise<boolean> {
  const people = await readDb();
  const next = people.filter((p) => p.id !== id);
  if (next.length === people.length) return false;
  await writeDb(next);
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith(id + "."))
        .map((f) => fs.unlink(path.join(UPLOAD_DIR, f)))
    );
  } catch {
    /* ignore */
  }
  return true;
}

export async function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  await ensureDirs();
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith(id + "."))
        .map((f) => fs.unlink(path.join(UPLOAD_DIR, f)))
    );
  } catch {
    /* ignore */
  }
  await fs.writeFile(path.join(UPLOAD_DIR, `${id}.${safeExt}`), buffer);
  const photoUrl = `/api/photo/${id}`;
  await updatePerson(id, { photoUrl });
  return photoUrl;
}

export async function readPhoto(
  id: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    const file = files.find((f) => f.startsWith(id + "."));
    if (!file) return null;
    const buffer = await fs.readFile(path.join(UPLOAD_DIR, file));
    const ext = file.split(".").pop()!.toLowerCase();
    return { buffer, contentType: contentTypeForExt(ext) };
  } catch {
    return null;
  }
}
