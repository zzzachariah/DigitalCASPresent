import { NextRequest, NextResponse } from "next/server";
import { pollAvatar } from "@/lib/avatar";
import { limitRequest } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 30;

// Poll a queued D-ID render: { status: "pending" | "done" | "error", videoUrl? }
export async function GET(req: NextRequest) {
  const limited = limitRequest(req, "avatar");
  if (limited) return limited;
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return NextResponse.json({ status: "error" }, { status: 400 });
  const result = await pollAvatar(id);
  return NextResponse.json(result);
}
