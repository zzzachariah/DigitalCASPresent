import { NextRequest, NextResponse } from "next/server";
import { pollAvatar } from "@/lib/avatar";

export const runtime = "nodejs";
export const maxDuration = 30;

// Poll a queued D-ID render: { status: "pending" | "done" | "error", videoUrl? }
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ status: "error" }, { status: 400 });
  const result = await pollAvatar(id);
  return NextResponse.json(result);
}
