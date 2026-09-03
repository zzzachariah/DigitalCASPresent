import { NextRequest } from "next/server";
import { handleAutosection } from "@/lib/handlers";
import { limitRequest } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// Student-triggered AI sectioning (spends AI tokens → rate-limited).
export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "submitAi");
  if (limited) return limited;
  return handleAutosection(req);
}
