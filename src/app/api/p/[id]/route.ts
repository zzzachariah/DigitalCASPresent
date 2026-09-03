import { NextRequest, NextResponse } from "next/server";
import { getPerson, toPublic } from "@/lib/store";
import { canView } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public person data for the visitor page (no script leakage beyond section
// titles). Unpublished people are visible only with ?preview=<edit token>.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const person = await getPerson(params.id);
  if (!person || !canView(person, req.nextUrl.searchParams.get("preview"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ person: toPublic(person) });
}
