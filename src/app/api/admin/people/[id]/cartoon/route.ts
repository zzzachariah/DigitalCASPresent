import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, saveCartoon, storageWritable } from "@/lib/store";
import { a2eConfigured, a2eCartoonify } from "@/lib/a2e";

export const runtime = "nodejs";
export const maxDuration = 120;

function baseUrlFrom(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${req.headers.get("host")}`;
}

// Generate a light cartoon portrait from the person's photo (A2E Nano Banana),
// download it, and store it permanently in our own storage.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!a2eConfigured()) {
    return NextResponse.json(
      { error: "未配置 A2E（需要 AVATAR_PROVIDER=a2e 和 A2E_API_KEY）" },
      { status: 400 }
    );
  }
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });

  const person = await getPerson(params.id);
  if (!person?.photoUrl) {
    return NextResponse.json({ error: "请先上传照片" }, { status: 400 });
  }
  const srcUrl = person.photoUrl.startsWith("http")
    ? person.photoUrl
    : `${baseUrlFrom(req)}${person.photoUrl}`;

  try {
    const cartoonRemoteUrl = await a2eCartoonify(srcUrl);
    if (!cartoonRemoteUrl) {
      return NextResponse.json({ error: "卡通生成失败（额度/接口）" }, { status: 502 });
    }
    // Download the (3-day) A2E result and store it permanently.
    const img = await fetch(cartoonRemoteUrl);
    if (!img.ok) throw new Error(`download cartoon failed: ${img.status}`);
    const buffer = Buffer.from(await img.arrayBuffer());
    const ct = img.headers.get("content-type") || "image/png";
    const ext = ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : ct.includes("webp") ? "webp" : "png";
    const cartoonUrl = await saveCartoon(params.id, buffer, ext);
    return NextResponse.json({ cartoonUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "cartoon error" },
      { status: 500 }
    );
  }
}
