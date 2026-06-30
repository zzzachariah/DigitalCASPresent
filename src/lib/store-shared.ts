import { nanoid } from "nanoid";
import type { Person, PublicPerson } from "./types";

// Helpers shared by every storage driver (filesystem, Vercel Blob, …).

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 24);
  return base || "guest";
}

export function uniqueSlug(name: string, taken: Set<string>): string {
  let slug = slugify(name);
  if (taken.has(slug)) slug = `${slug}-${nanoid(4)}`;
  return slug;
}

export function extOf(file: { type?: string; name?: string }): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  const fromName = file.name?.split(".").pop()?.toLowerCase();
  return (fromName && /^[a-z0-9]+$/.test(fromName) ? fromName : "jpg");
}

export function contentTypeForExt(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/jpeg";
  }
}

/** Resolve the Vercel Blob read-write token regardless of the exact env var
 *  name. Vercel usually injects BLOB_READ_WRITE_TOKEN, but some setups use a
 *  prefixed name (e.g. MYSTORE_READ_WRITE_TOKEN). Blob tokens always start with
 *  "vercel_blob_", so we fall back to detecting by value. Evaluated at request
 *  time so a runtime-only secret is never baked to undefined at build. */
export function resolveBlobToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const [k, v] of Object.entries(process.env)) {
    if (
      typeof v === "string" &&
      v.startsWith("vercel_blob_") &&
      /token/i.test(k)
    ) {
      return v;
    }
  }
  return undefined;
}

/** True when Blob can authenticate: either a static read-write token, or
 *  Vercel's OIDC token + a Blob store id (the SDK uses these automatically,
 *  so no manually-copied token is required). */
export function blobConfigured(): boolean {
  if (resolveBlobToken()) return true;
  return !!(process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID);
}

/** Auth option to spread into @vercel/blob calls. When there's a static token
 *  we pass it; otherwise we omit `token` so the SDK falls back to OIDC. */
export function blobAuth(): { token?: string } {
  const t = resolveBlobToken();
  return t ? { token: t } : {};
}

export function toPublic(p: Person): PublicPerson {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    photoUrl: p.photoUrl,
    cartoonUrl: p.cartoonUrl,
    language: p.language,
    sections: p.sections.map((s) => ({ id: s.id, title: s.title, hint: s.hint })),
  };
}
