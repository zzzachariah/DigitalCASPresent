import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, savePhoto, storageWritable } from "@/lib/store";

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

  const form = await req.formData();
  const file = form.get("photo");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少照片 / No photo provided" }, { status: 400 });
  }
  if (file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "照片过大（<8MB）/ Photo too large" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : file.name.split(".").pop()?.toLowerCase() || "jpg";

  try {
    const photoUrl = await savePhoto(params.id, buffer, ext);
    return NextResponse.json({ photoUrl });
  } catch (err) {
    console.error("[photo:save] failed:", err);
    return NextResponse.json(
      { error: "照片保存失败 / Photo save failed: " + (err instanceof Error ? err.message : "unknown") },
      { status: 500 }
    );
  }
}
