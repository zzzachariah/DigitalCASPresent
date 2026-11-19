/** Never append a private token to a third-party/provider URL. */
export function previewMediaUrl(url: string | undefined, previewToken?: string | null): string | undefined {
  if (!url || !previewToken || !/^\/api\/photo\/[A-Za-z0-9_.-]+(?:\?|$)/.test(url)) return url;
  const parsed = new URL(url, "http://local.invalid");
  parsed.searchParams.set("preview", previewToken);
  return `${parsed.pathname}${parsed.search}`;
}

/** A view-only token lets <img>/<video>/<audio> display unpublished local
 * media without exposing the stronger edit credential or changing stored URLs. */
export function withPreviewMedia<T extends { photoUrl?: string; cartoonUrl?: string; loopVideoUrl?: string }>(person: T, previewToken?: string | null): T {
  return {
    ...person,
    photoUrl: previewMediaUrl(person.photoUrl, previewToken),
    cartoonUrl: previewMediaUrl(person.cartoonUrl, previewToken),
    loopVideoUrl: previewMediaUrl(person.loopVideoUrl, previewToken),
  };
}

export function currentMediaUrl(
  person: { photoUrl?: string; cartoonUrl?: string; loopVideoUrl?: string },
  assetId: string
): string | undefined {
  return assetId.endsWith(".cartoon") ? person.cartoonUrl
    : assetId.endsWith(".loop") ? person.loopVideoUrl : person.photoUrl;
}

/** Bind a requested version to the currently saved media for that person.
 * Knowing a replaced asset's hash does not grant access to historical bytes. */
export function currentMediaVersion(
  person: { photoUrl?: string; cartoonUrl?: string; loopVideoUrl?: string },
  assetId: string
): string | null {
  const url = currentMediaUrl(person, assetId);
  if (!url || !url.startsWith("/api/photo/")) return null;
  try {
    const parsed = new URL(url, "http://local.invalid");
    return parsed.pathname === `/api/photo/${assetId}` ? parsed.searchParams.get("asset") : null;
  } catch {
    return null;
  }
}
