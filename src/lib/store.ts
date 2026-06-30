import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Person, PublicPerson } from "./types";

// ─────────────────────────────────────────────────────────────────────
// Data layer.
//
// This is a small pluggable store. The default implementation persists to
// the local filesystem (./data) so the app runs with ZERO external setup.
//
// For Vercel (serverless = read-only filesystem) swap this module's body for
// Vercel Blob (photos) + Postgres/KV (metadata). The exported function
// signatures below are the contract the rest of the app depends on, so the
// swap is contained to this file. See README "Deploy to Vercel".
// ─────────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "people.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

async function ensureDirs() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

async function readDb(): Promise<Person[]> {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    return JSON.parse(raw) as Person[];
  } catch {
    return [];
  }
}

async function writeDb(people: Person[]): Promise<void> {
  await ensureDirs();
  await fs.writeFile(DB_FILE, JSON.stringify(people, null, 2), "utf8");
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 24);
  return base || "guest";
}

export async function listPeople(): Promise<Person[]> {
  const people = await readDb();
  return people.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  const people = await readDb();
  return (
    people.find((p) => p.id === idOrSlug || p.slug === idOrSlug) ?? null
  );
}

export async function createPerson(
  input: Pick<Person, "name" | "subtitle" | "script" | "sections" | "language">
): Promise<Person> {
  const people = await readDb();
  const id = nanoid(10);

  // Ensure unique slug.
  let slug = slugify(input.name);
  const taken = new Set(people.map((p) => p.slug));
  if (taken.has(slug)) slug = `${slug}-${nanoid(4)}`;

  const now = Date.now();
  const person: Person = {
    id,
    slug,
    name: input.name,
    subtitle: input.subtitle,
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
  // best-effort photo cleanup
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

// ─── Photos ──────────────────────────────────────────────────────────

export async function savePhoto(
  id: string,
  buffer: Buffer,
  ext: string
): Promise<string> {
  await ensureDirs();
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  // remove any old photo with a different extension
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
    const contentType =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "svg"
              ? "image/svg+xml"
              : "image/jpeg";
    return { buffer, contentType };
  } catch {
    return null;
  }
}

// ─── Projections ─────────────────────────────────────────────────────

export function toPublic(p: Person): PublicPerson {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    photoUrl: p.photoUrl,
    language: p.language,
    sections: p.sections.map((s) => ({
      id: s.id,
      title: s.title,
      hint: s.hint,
    })),
  };
}
