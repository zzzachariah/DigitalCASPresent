import { NextRequest, NextResponse } from "next/server";
import { getPerson, toPublic } from "@/lib/store";

// Public person data for the visitor page (no script leakage beyond section titles).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const person = await getPerson(params.id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ person: toPublic(person) });
}
