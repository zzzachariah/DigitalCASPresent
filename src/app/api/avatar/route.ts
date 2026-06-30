import { NextRequest, NextResponse } from "next/server";
import { getPerson } from "@/lib/store";
import { generateAvatar } from "@/lib/avatar";

export const runtime = "nodejs";
export const maxDuration = 120; // video render can take a while

function baseUrlFrom(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host");
  return `${proto}://${host}`;
}

// Turn the answer TEXT into a talking avatar (video via D-ID, or TTS instructions
// for the browser in mock mode).
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    personId?: string;
    text?: string;
    lang?: "en" | "zh";
  };

  const person = body.personId ? await getPerson(body.personId) : null;
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!body.text?.trim()) {
    return NextResponse.json({ error: "no text" }, { status: 400 });
  }

  // Blob mode stores an absolute CDN URL; filesystem mode stores /api/photo/<id>.
  const photoPublicUrl = person.photoUrl
    ? person.photoUrl.startsWith("http")
      ? person.photoUrl
      : `${baseUrlFrom(req)}${person.photoUrl}`
    : undefined;

  const result = await generateAvatar({
    text: body.text,
    lang: body.lang || "en",
    photoPublicUrl,
  });

  return NextResponse.json({ avatar: result });
}
