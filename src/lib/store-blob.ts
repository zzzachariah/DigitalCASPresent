import { put, list, del } from "@vercel/blob";
import { nanoid } from "nanoid";
import type { Person } from "./types";
import { uniqueSlug, blobAuth } from "./store-shared";

// Vercel Blob driver — used in production (Vercel's filesystem is read-only).
// Both the photos and the people metadata live in Blob, so only one Vercel
// resource is needed; photo URLs are public CDN links (also fetchable by D-ID).
//
// The token is resolved at call time (by value, so a non-standard env var name
// still works) and passed explicitly to every Blob call.

const META_PATH = "data/people.json";

// The metadata blob URL is stable once created; cache it per instance.
let metaUrl: string | null = null;

async function getMetaUrl(): Promise<string | null> {
  if (metaUrl) return metaUrl;
  const { blobs } = await list({ prefix: META_PATH, limit: 1, ...blobAuth() });
  metaUrl = blobs[0]?.url ?? null;
  return metaUrl;
}

async function readDb(): Promise<Person[]> {
  try {
    const url = await getMetaUrl();
    if (!url) return [];
    // Cache-bust + no-store so admin edits are visible immediately.
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as Person[];
  } catch {
    return [];
  }
}

async function writeDb(people: Person[]): Promise<void> {
  const { url } = await put(META_PATH, JSON.stringify(people), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    ...blobAuth(),
  });
  metaUrl = url;
}

export async function listPeople(): Promise<Person[]> {
  return (await readDb()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPerson(idOrSlug: string): Promise<Person | null> {
  const people = await readDb();
  return people.find((p) => p.id === idOrSlug || p.slug === idOrSlug) ?? null;
}

export async function createPerson(
  input: Pick<Person, "name" | "subtitle" | "script" | "sections" | "language">
): Promise<Person> {
  const people = await readDb();
  const now = Date.now();
  const person: Person = {
    id: nanoid(10),
    slug: uniqueSlug(input.name, new Set(people.map((p) => p.slug))),
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
  const target = people.find((p) => p.id === id);
  if (!target) return false;
  await writeDb(people.filter((p) => p.id !== id));
  if (target.photoUrl?.startsWith("http")) {
    try {
      await del(target.photoUrl, { ...blobAuth() });
    } catch {
      /* ignore */
    }
  }
  return true;
}

export async function savePhoto(id: string, buffer: Buffer, ext: string): Promise<string> {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  const person = await getPerson(id);
  if (person?.photoUrl?.startsWith("http")) {
    try {
      await del(person.photoUrl, { ...blobAuth() });
    } catch {
      /* ignore */
    }
  }
  const { url } = await put(`photos/${id}.${safeExt}`, buffer, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000,
    ...blobAuth(),
  });
  await updatePerson(id, { photoUrl: url });
  return url;
}

// Photos are served directly from the Blob CDN (absolute photoUrl), so the
// /api/photo route is never hit in Blob mode. Signature mirrors the fs driver.
export async function readPhoto(
  _id: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  return null;
}
