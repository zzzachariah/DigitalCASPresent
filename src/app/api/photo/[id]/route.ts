import { currentMediaUrl, currentMediaVersion } from "@/lib/media-access";
import { isAdmin } from "@/lib/auth";
import { NextRequest } from "next/server";
import { canView } from "@/lib/access";
import { getPerson, readPhoto } from "@/lib/store";

export const runtime = "nodejs";

// Serves locally stored photos / cartoons / loop videos (filesystem driver).
// Do not retain event media in browser or intermediary caches.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // All asset variants inherit the owning presentation's visibility.
  if (!/^[A-Za-z0-9_-]{1,40}(\.(cartoon|loop|audio\.[A-Za-z0-9_-]{1,80}))?$/.test(params.id)) {
    return new Response("Not found", { status: 404 });
  }
  const admin = isAdmin();
  // Historical narration may contain unreviewed manuscript-derived text.
  // Published status or a preview token must never make that audio public.
  if (params.id.includes(".audio.") && !admin) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  const person = await getPerson(params.id.split(".")[0]);
  const token = req.headers.get("x-edit-token") || req.nextUrl.searchParams.get("preview");
  if (!person || !canView(person, token)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  const asset = req.nextUrl.searchParams.get("asset") || undefined;
  if (!admin && (!currentMediaUrl(person, params.id) || (asset && asset !== currentMediaVersion(person, params.id)))) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  const photo = await readPhoto(params.id, asset);
  if (!photo) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(photo.buffer as BodyInit, {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
