// ─────────────────────────────────────────────────────────────────────
// A2E (video.a2e.com.cn) — domestic talking-photo / lip-sync provider.
// Responses are wrapped as { code: 0, data: {...} }. Auth: Bearer sk_...
// ─────────────────────────────────────────────────────────────────────

const BASE = (process.env.A2E_BASE_URL || "https://video.a2e.com.cn").replace(/\/$/, "");

function key(): string {
  return process.env.A2E_API_KEY?.trim() || "";
}

export function a2eConfigured(): boolean {
  return (process.env.AVATAR_PROVIDER || "mock").toLowerCase() === "a2e" && !!key();
}

export interface A2eResult {
  httpStatus: number;
  ok: boolean;
  json: any;
}

export async function a2e(path: string, method = "POST", body?: unknown): Promise<A2eResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 800) };
  }
  // A2E uses code:0 for success even on HTTP 200; treat code!==0 as not-ok.
  const ok = res.ok && (json?.code === 0 || json?.code === undefined);
  return { httpStatus: res.status, ok, json };
}

/** Recursively find the first http(s) URL string in an object (handy for
 *  locating result/audio/video URLs whose exact field name we don't yet know). */
export function findUrl(obj: unknown, hint?: RegExp): string | null {
  const urls: { key: string; url: string }[] = [];
  const walk = (o: unknown, k = "") => {
    if (typeof o === "string") {
      if (/^https?:\/\//.test(o)) urls.push({ key: k, url: o });
    } else if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${k}[${i}]`));
    } else if (o && typeof o === "object") {
      for (const [kk, vv] of Object.entries(o)) walk(vv, k ? `${k}.${kk}` : kk);
    }
  };
  walk(obj);
  if (hint) {
    const m = urls.find((u) => hint.test(u.key) || hint.test(u.url));
    if (m) return m.url;
  }
  return urls[0]?.url ?? null;
}

/** Upload an image (from any public URL) into A2E's storage; returns cdnUrl. */
export async function a2eUploadImage(srcUrl: string): Promise<string> {
  const img = await fetch(srcUrl);
  if (!img.ok) throw new Error(`fetch source image failed: ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  const ct = img.headers.get("content-type") || "image/jpeg";
  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  const stamp = `${buf.length}-${ext}`;
  const pres = await a2e("/api/v1/r2/upload-presigned-url", "POST", {
    key: `dcp/${stamp}.${ext}`,
    contentType: ct,
    fileSize: buf.length,
  });
  const up = pres.json?.data;
  if (!up?.uploadUrl) throw new Error("presign failed: " + JSON.stringify(pres.json).slice(0, 200));
  const put = await fetch(up.uploadUrl, { method: "PUT", headers: { "Content-Type": ct }, body: buf });
  if (!put.ok) throw new Error(`PUT upload failed: ${put.status}`);
  return up.cdnUrl as string;
}
