import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { handleAutosection } from "@/lib/handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

// Ask the AI to split a script into logical parts the visitor can pick.
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return handleAutosection(req);
}
