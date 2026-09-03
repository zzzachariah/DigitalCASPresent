import { NextRequest } from "next/server";
import { handleParse } from "@/lib/handlers";
import { limitRequest } from "@/lib/ratelimit";

export const runtime = "nodejs";

// Student upload of a .txt / .pdf / .docx script → extracted text.
export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "submitAi");
  if (limited) return limited;
  return handleParse(req);
}
