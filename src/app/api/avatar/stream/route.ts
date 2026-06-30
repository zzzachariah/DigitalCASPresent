import { NextRequest, NextResponse } from "next/server";
import { getPerson } from "@/lib/store";
import {
  createStream,
  sendSdp,
  sendIce,
  speak,
  closeStream,
  didStreamEnabled,
} from "@/lib/did-stream";

export const runtime = "nodejs";
export const maxDuration = 30;

function baseUrlFrom(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${req.headers.get("host")}`;
}

// One endpoint, multiple actions, for the D-ID WebRTC handshake + speak.
export async function POST(req: NextRequest) {
  if (!didStreamEnabled()) {
    return NextResponse.json({ error: "streaming-disabled" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as any;
  const action = body.action as string;

  try {
    switch (action) {
      case "start": {
        const person = await getPerson(body.personId);
        if (!person?.photoUrl) {
          return NextResponse.json({ error: "no photo" }, { status: 400 });
        }
        const photo = person.photoUrl.startsWith("http")
          ? person.photoUrl
          : `${baseUrlFrom(req)}${person.photoUrl}`;
        const data = await createStream(photo);
        return NextResponse.json({
          streamId: data.id,
          sessionId: data.session_id,
          offer: data.offer,
          iceServers: data.ice_servers,
        });
      }
      case "sdp":
        await sendSdp(body.streamId, body.sessionId, body.answer);
        return NextResponse.json({ ok: true });
      case "ice":
        await sendIce(body.streamId, body.sessionId, body.candidate);
        return NextResponse.json({ ok: true });
      case "speak":
        await speak(body.streamId, body.sessionId, body.text, body.lang || "en");
        return NextResponse.json({ ok: true });
      case "close":
        await closeStream(body.streamId, body.sessionId);
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "bad action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "stream error" },
      { status: 500 }
    );
  }
}
