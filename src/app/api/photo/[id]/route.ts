import { NextRequest } from "next/server";
import { readPhoto } from "@/lib/store";

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
      "Cache-Control": "public, max-age=3600",
    },
  });
}
