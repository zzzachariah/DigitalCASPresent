import { NextRequest, NextResponse } from "next/server";
import { getPerson } from "@/lib/store";
import { createAvatar } from "@/lib/avatar";
import { canView } from "@/lib/access";
import { limitRequest } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60; // queues the render (A2E upload+tts+start); polled separately

function baseUrlFrom(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host");
  return `${proto}://${host}`;
}

// Queue a talking-avatar render for the answer text (or return TTS instructions
// for the browser in mock mode). The browser then polls /api/avatar/status.
export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "avatar");
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as {
    personId?: string;
    text?: string;
    lang?: "en" | "zh";
    previewToken?: string;
  };

  const person = body.personId ? await getPerson(body.personId) : null;
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canView(person, body.previewToken)) {
    return NextResponse.json({ error: "尚未发布 / Not published yet" }, { status: 403 });
  }
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: "no text" }, { status: 400 });
  if (text.length > 4000) return NextResponse.json({ error: "text too long" }, { status: 400 });

  // Prefer the cartoon portrait when available (the talking avatar should be the
  // cartoon). Blob stores absolute URLs; filesystem stores /api/photo/<id>.
  const src = person.cartoonUrl || person.photoUrl;
  const photoPublicUrl = src
    ? src.startsWith("http")
      ? src
      : `${baseUrlFrom(req)}${src}`
    : undefined;

  const result = await createAvatar({
    text,
    lang: body.lang === "zh" ? "zh" : "en",
    photoPublicUrl,
    gender: person.gender,
  });

  return NextResponse.json({ avatar: result });
}
