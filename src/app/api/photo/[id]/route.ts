import { NextRequest } from "next/server";
import { readPhoto } from "@/lib/store";

export const runtime = "nodejs";

// Serves locally stored photos / cartoons / loop videos (filesystem driver).
// URLs carry a ?v=<timestamp> that changes on every replacement, so a long
// cache lifetime is safe.
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const photo = await readPhoto(params.id);
  if (!photo) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(photo.buffer as BodyInit, {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
