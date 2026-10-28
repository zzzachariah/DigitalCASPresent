import { nanoid, customAlphabet } from "nanoid";
import { getVercelOidcTokenSync } from "@vercel/oidc";
import type { Person, PersonInput, PersonSource, PersonStatus, PublicPerson } from "./types";

// Helpers shared by every storage driver (filesystem, Vercel Blob, …).

/** Lowercase, unambiguous alphabet for public slugs (no 0/o/1/l/i). */
const shortId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 6);

/** Slug from a name. Latin names keep a readable slug ("emma-lin"); names
 *  with no latin letters (张伟) get a short random one instead of all
 *  collapsing to the same empty string. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents left by NFKD
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "");
  return base.length >= 2 ? base : shortId();
}

/** Find a slug that `isTaken` rejects. */
export async function uniqueSlug(
  name: string,
  isTaken: (slug: string) => Promise<boolean>
): Promise<string> {
  const base = slugify(name);
  if (!(await isTaken(base))) return base;
  for (let i = 0; i < 6; i++) {
    const candidate = `${base}-${shortId().slice(0, 4)}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base}-${shortId()}`;
}

/** Ids / slugs are used in file paths and blob pathnames — keep them tame. */
export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export function safeId(s: string | undefined | null): s is string {
  return typeof s === "string" && ID_RE.test(s);
}

export function newId(): string {
  return nanoid(10);
}

/** Secret handed to a self-submitting student (URL-safe). */
export function newEditToken(): string {
  return nanoid(24);
}

export interface CreatePersonInput extends PersonInput {
  source?: PersonSource;
  status?: PersonStatus;
  editToken?: string;
}

/** Assemble a fresh Person record (drivers only decide where to put it). */
export function buildPerson(input: CreatePersonInput, slug: string): Person {
  const now = Date.now();
  const source = input.source ?? "admin";
  const person: Person = {
    id: newId(),
    slug,
    name: input.name,
    cohort: input.cohort,
    subtitle: input.subtitle,
    gender: input.gender,
    script: input.script,
    sections: input.sections,
    language: input.language,
    status: input.status ?? (source === "student" ? "pending" : "approved"),
    source,
    editToken: input.editToken,
    createdAt: now,
    updatedAt: now,
  };
  if (source === "student") person.submittedAt = now;
  return person;
}

/** Visitors may only see approved people. Records that predate the status
 *  field count as approved. */
export function isPublished(p: Pick<Person, "status">): boolean {
  return p.status !== "pending";
}

export function contentTypeForExt(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    default:
      return "image/jpeg";
  }
}

/** Public media credentials. Never scan arbitrary environment variables: a
 *  second connected store may contain private records, not public media. */
export function resolveBlobToken(): string | undefined {
  return process.env.BLOB_MEDIA_READ_WRITE_TOKEN?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
}

/** Resolve for each operation: Vercel injects the current token into request
 *  context, which must take precedence over a potentially stale env token. */
function currentBlobOidcToken(): string | undefined {
  try {
    return getVercelOidcTokenSync()?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function hasBlobOidcToken(): boolean {
  return !!currentBlobOidcToken();
}

export function mediaBlobConfigured(): boolean {
  if (resolveBlobToken()) return true;
  return !!((process.env.BLOB_MEDIA_STORE_ID?.trim() || process.env.BLOB_STORE_ID?.trim()) && hasBlobOidcToken());
}

export function recordsBlobConfigured(): boolean {
  return !!(process.env.BLOB_RECORDS_READ_WRITE_TOKEN?.trim() ||
    (process.env.BLOB_RECORDS_STORE_ID?.trim() && hasBlobOidcToken()));
}

export function blobConfigured(): boolean {
  return mediaBlobConfigured() || recordsBlobConfigured();
}

type BlobAuth = { token: string } | { storeId: string; oidcToken: string };

/** Every call gets explicit credentials, including storeId on the OIDC path.
 *  An unconfigured private store must never fall through to the public token. */
export function mediaBlobAuth(): BlobAuth {
  const token = resolveBlobToken();
  if (token) return { token };
  const storeId = process.env.BLOB_MEDIA_STORE_ID?.trim() || process.env.BLOB_STORE_ID?.trim();
  const oidcToken = currentBlobOidcToken();
  if (storeId && oidcToken) return { storeId, oidcToken };
  throw new Error("Public media storage is not configured");
}

export function recordsBlobAuth(): BlobAuth {
  const token = process.env.BLOB_RECORDS_READ_WRITE_TOKEN?.trim();
  if (token) return { token };
  const storeId = process.env.BLOB_RECORDS_STORE_ID?.trim();
  const oidcToken = currentBlobOidcToken();
  if (storeId && oidcToken) return { storeId, oidcToken };
  throw new Error("Private records storage is not configured (BLOB_RECORDS_READ_WRITE_TOKEN or BLOB_RECORDS_STORE_ID + OIDC)");
}

/** What a visitor's browser receives. */
export function toPublic(p: Person): PublicPerson {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    photoUrl: p.photoUrl,
    cartoonUrl: p.cartoonUrl,
    loopVideoUrl: p.loopVideoUrl,
    language: p.language,
    status: p.status ?? "approved",
    sections: p.sections.map((s) => ({ id: s.id, title: s.title, hint: s.hint })),
  };
}

/** What the submitting student receives about their own record: everything
 *  they can edit, plus status — but no secret and no admin-generated assets. */
export function toOwner(p: Person): Person {
  const { editToken: _t, cartoonUrl: _c, loopVideoUrl: _l, ...rest } = p;
  return {
    ...rest,
    status: p.status ?? "approved",
    sections: p.sections.map(({ cachedAnswers: _a, cachedAudio: _b, cachedSuggestions: _c, ...s }) => s),
  };
}
