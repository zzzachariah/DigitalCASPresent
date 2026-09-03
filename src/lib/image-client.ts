// ─────────────────────────────────────────────────────────────────────
// Browser-side photo preparation. Phones hand us 8 MB originals; the
// avatar pipeline needs nothing bigger than ~1600 px, and exhibition Wi-Fi
// is slow. Downscale to JPEG before upload; fall back to the original file
// when the browser can't decode it (the server still validates by bytes).
// ─────────────────────────────────────────────────────────────────────

const MAX_EDGE = 1600;
const QUALITY = 0.86;

export async function downscaleImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      bitmap.close();
      return file;
    }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob) throw new Error("encode failed");
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}
