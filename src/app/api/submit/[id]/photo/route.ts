import { NextRequest, NextResponse } from "next/server";
import { getPerson, savePhoto, storageWritable, updatePerson } from "@/lib/store";
import { ownerTokenValid } from "@/lib/access";
import { readUploadedImage } from "@/lib/image";
import { limitRequest } from "@/lib/ratelimit";

export const runtime = "nodejs";

const NOT_FOUND = { error: "链接无效或已失效 / This link is invalid or has expired" };

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const limited = limitRequest(req, "submitWrite");
  if (limited) return limited;

  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });

  const person = await getPerson(params.id);
  const token = req.headers.get("x-edit-token") || req.nextUrl.searchParams.get("token");
  if (!person || person.source !== "student" || !ownerTokenValid(person, token)) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "缺少照片 / No photo provided" }, { status: 400 });
  const img = await readUploadedImage(form, "photo");
  if (!img.ok) return NextResponse.json({ error: img.error }, { status: img.status });

  try {
    const photoUrl = await savePhoto(person.id, img.buffer, img.kind.ext);
    // A new face invalidates the cartoon / loop video generated from the old
    // one, and needs another look from the admin.
    await updatePerson(person.id, {
      cartoonUrl: undefined,
      loopVideoUrl: undefined,
      status: "pending",
      submittedAt: Date.now(),
    });
    return NextResponse.json({ photoUrl });
  } catch (err) {
    console.error("[submit:photo] failed:", err);
    return NextResponse.json(
      { error: "照片保存失败 / Photo save failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}
