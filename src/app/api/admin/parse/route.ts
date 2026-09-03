import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { handleParse } from "@/lib/handlers";

export const runtime = "nodejs";

// Upload a .txt / .pdf / .docx and get back the extracted plain text,
// so the admin can review/edit it before saving.
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return handleParse(req);
}
