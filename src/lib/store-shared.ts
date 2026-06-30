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

export function toPublic(p: Person): PublicPerson {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    photoUrl: p.photoUrl,
    language: p.language,
    sections: p.sections.map((s) => ({ id: s.id, title: s.title, hint: s.hint })),
  };
}
