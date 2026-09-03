import { createHash } from "crypto";
import type { Person } from "./types";
import { isAdmin, safeEqual } from "./auth";
import { isPublished } from "./store-shared";

// Who may see a person's visitor page / spend AI credits on them:
//   • anyone, once the person is approved (published)
//   • the submitting student, via their edit token (preview before approval)
//   • a logged-in admin

export function ownerTokenValid(person: Person, token: string | null | undefined): boolean {
  return !!person.editToken && safeEqual(token, person.editToken);
}

/** A view-only token derived from the edit token, so a student can share
 *  their preview link without handing out the right to edit. */
export function previewTokenFor(person: Person): string | null {
  if (!person.editToken) return null;
  return createHash("sha256").update(`preview:${person.editToken}`).digest("base64url").slice(0, 24);
}

export function canView(person: Person, token?: string | null): boolean {
  if (isPublished(person)) return true;
  if (!token) return isAdmin();
  if (ownerTokenValid(person, token)) return true;
  if (safeEqual(token, previewTokenFor(person))) return true;
  return isAdmin();
}
