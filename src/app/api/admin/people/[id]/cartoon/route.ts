import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, saveCartoon, storageWritable } from "@/lib/store";
import { a2eConfigured, a2eCartoonStart, a2eCartoonPoll } from "@/lib/a2e";

export const runtime = "nodejs";
export const maxDuration = 60;

function baseUrlFrom(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${req.headers.get("host")}`;
}

// POST = start a cartoon-ify task → { taskId }. (Fast; render happens async.)
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
  if (!person?.photoUrl) return NextResponse.json({ error: "请先上传照片" }, { status: 400 });

  const srcUrl = person.photoUrl.startsWith("http")
    ? person.photoUrl
    : `${baseUrlFrom(req)}${person.photoUrl}`;

  const res = await a2eCartoonStart(srcUrl);
  if ("error" in res) {
    return NextResponse.json({ error: "卡通发起失败: " + res.error }, { status: 502 });
  }
  return NextResponse.json({ taskId: res.taskId });
}

// GET ?taskId=… = poll. When ready, download the (3-day) A2E image and store
// it permanently → { cartoonUrl }. Otherwise { pending: true } or { error }.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "no taskId" }, { status: 400 });

  const poll = await a2eCartoonPoll(taskId);
  if ("error" in poll) return NextResponse.json({ error: "卡通生成失败: " + poll.error }, { status: 502 });
  if ("pending" in poll) return NextResponse.json({ pending: true });

  try {
    const img = await fetch(poll.url);
    if (!img.ok) throw new Error(`download cartoon failed: ${img.status}`);
    const buffer = Buffer.from(await img.arrayBuffer());
    const ct = img.headers.get("content-type") || "image/png";
    const ext = ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : ct.includes("webp") ? "webp" : "png";
    const cartoonUrl = await saveCartoon(params.id, buffer, ext);
    return NextResponse.json({ cartoonUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "store cartoon error" },
      { status: 500 }
    );
  }
}
