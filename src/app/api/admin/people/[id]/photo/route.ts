import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, savePhoto, storageWritable } from "@/lib/store";
import { readUploadedImage } from "@/lib/image";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const writable = storageWritable();
  if (!writable.ok) {
    return NextResponse.json({ error: writable.reason }, { status: 503 });
  }

  const person = await getPerson(params.id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "缺少照片 / No photo provided" }, { status: 400 });
  const img = await readUploadedImage(form, "photo");
  if (!img.ok) return NextResponse.json({ error: img.error }, { status: img.status });

  try {
    const photoUrl = await savePhoto(person.id, img.buffer, img.kind.ext);
    return NextResponse.json({ photoUrl });
  } catch (err) {
    console.error("[photo:save] failed:", err);
    return NextResponse.json(
      { error: "照片保存失败 / Photo save failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}
