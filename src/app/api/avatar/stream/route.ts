import { NextResponse } from "next/server";

/** Narration is emitted only by /api/chat after server-side answer review. */
export async function POST() {
  return NextResponse.json({ error: "请使用已审核的讲解入口 / Use the reviewed chat narration endpoint" }, { status: 410 });
}
