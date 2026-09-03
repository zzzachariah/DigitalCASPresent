// ─────────────────────────────────────────────────────────────────────
// Uploaded-image validation. Only raster formats a browser can show and the
// avatar providers accept are allowed; the type is decided by the file's
// magic bytes, never by its name or the client-supplied MIME type (an SVG
// renamed to .jpg would otherwise be served from our origin with script).
// ─────────────────────────────────────────────────────────────────────

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

export type ImageKind = { ext: "jpg" | "png" | "webp"; contentType: string };

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { ext: "png", contentType: "image/png" };
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

export const IMAGE_TYPE_ERROR =
  "只支持 JPG / PNG / WebP 图片（iPhone 的 HEIC 请先转成 JPG 或截图）/ Only JPG, PNG or WebP images are accepted";

/** Pull the photo out of a multipart form and validate it. */
export async function readUploadedImage(
  form: FormData,
  field = "photo"
): Promise<{ ok: true; buffer: Buffer; kind: ImageKind } | { ok: false; error: string; status: number }> {
  const file = form.get(field);
  if (!(file instanceof File)) {
    return { ok: false, error: "缺少照片 / No photo provided", status: 400 };
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return { ok: false, error: "照片过大（≤8MB）/ Photo too large (max 8MB)", status: 400 };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const kind = sniffImage(buffer);
  if (!kind) return { ok: false, error: IMAGE_TYPE_ERROR, status: 415 };
  return { ok: true, buffer, kind };
}
