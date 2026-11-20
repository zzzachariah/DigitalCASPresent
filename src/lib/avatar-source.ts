import { assertEventOpen } from "./event-retention";
import { IMAGE_MAX_BYTES, IMAGE_TYPE_ERROR, sniffImage } from "./image";
import { readPhoto } from "./store";
import type { Person } from "./types";

export interface AvatarSource {
  buffer: Buffer;
  /** Determined from image bytes, never a URL suffix or stored MIME label. */
  contentType: string;
}

const SOURCE_ERROR = "照片来源无效，请重新上传 / Invalid photo source; please upload it again";

/** Called only after the admin route has authorized this person's external
 * photo processing. Read private bytes directly; never fetch a public proxy,
 * forward a cookie/token, or accept a caller-supplied remote source URL. */
export async function readAvatarSource(
  person: Pick<Person, "id" | "photoUrl" | "cartoonUrl">,
  kind: "photo" | "cartoon-or-photo"
): Promise<AvatarSource> {
  assertEventOpen();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(person.id) || (kind !== "photo" && kind !== "cartoon-or-photo")) {
    throw new Error(SOURCE_ERROR);
  }
  const useCartoon = kind === "cartoon-or-photo" && Boolean(person.cartoonUrl);
  const source = useCartoon ? person.cartoonUrl : person.photoUrl;
  const assetId = useCartoon ? `${person.id}.cartoon` : person.id;
  const pathname = `/api/photo/${assetId}`;
  if (typeof source !== "string" || source.length > 500 ||
      (source !== pathname && !source.startsWith(`${pathname}?`))) throw new Error(SOURCE_ERROR);
  const url = new URL(source, "https://internal.invalid");
  if (url.pathname !== pathname || url.hash) throw new Error(SOURCE_ERROR);
  // Only the application's version selectors are valid. In particular,
  // editing/preview credentials never enter the image-processing path.
  url.searchParams.forEach((_value, key) => {
    if (key !== "asset" && key !== "v") throw new Error(SOURCE_ERROR);
  });
  if (url.searchParams.getAll("asset").length > 1 || url.searchParams.getAll("v").length > 1) throw new Error(SOURCE_ERROR);
  const version = url.searchParams.get("asset") ?? undefined;
  if (version !== undefined && !/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(version)) throw new Error(SOURCE_ERROR);
  const cacheVersion = url.searchParams.get("v");
  if (cacheVersion !== null && !/^\d{1,20}$/.test(cacheVersion)) throw new Error(SOURCE_ERROR);

  const image = await readPhoto(assetId, version);
  assertEventOpen(); // A read begun before expiry must not authorize a late upload.
  if (!image) throw new Error("找不到照片，请重新上传 / Photo unavailable; please upload it again");
  if (image.buffer.length > IMAGE_MAX_BYTES) throw new Error("照片过大（≤4MB）/ Photo too large (max 4MB)");
  const detected = sniffImage(image.buffer);
  if (!detected) throw new Error(IMAGE_TYPE_ERROR);
  return { buffer: image.buffer, contentType: detected.contentType };
}
