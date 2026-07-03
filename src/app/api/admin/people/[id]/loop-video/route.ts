import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, saveLoopVideo, storageWritable } from "@/lib/store";
import { a2eConfigured, a2eLoopVideoStart, a2eLoopVideoPoll } from "@/lib/a2e";

export const runtime = "nodejs";
export const maxDuration = 60;

function baseUrlFrom(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${req.headers.get("host")}`;
}

// POST = start generating the ambient "talking" loop video → { taskId }.
// Uses the cartoon if one exists, else the raw photo.
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
  const source = person?.cartoonUrl || person?.photoUrl;
  if (!source) return NextResponse.json({ error: "请先上传照片（建议先生成卡通形象）" }, { status: 400 });

  const srcUrl = source.startsWith("http") ? source : `${baseUrlFrom(req)}${source}`;

  const res = await a2eLoopVideoStart(srcUrl);
  if ("error" in res) {
    return NextResponse.json({ error: "循环视频发起失败: " + res.error }, { status: 502 });
  }
  return NextResponse.json({ taskId: res.taskId });
}

// GET ?taskId=… = poll. When ready, download + store permanently → { loopVideoUrl }.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "no taskId" }, { status: 400 });

  const poll = await a2eLoopVideoPoll(taskId);
  if ("error" in poll) return NextResponse.json({ error: "循环视频生成失败: " + poll.error }, { status: 502 });
  if ("pending" in poll) return NextResponse.json({ pending: true, status: poll.status });

  try {
    const vid = await fetch(poll.url);
    if (!vid.ok) throw new Error(`download loop video failed: ${vid.status}`);
    const buffer = Buffer.from(await vid.arrayBuffer());
    const ct = vid.headers.get("content-type") || "video/mp4";
    const ext = ct.includes("webm") ? "webm" : ct.includes("quicktime") ? "mov" : "mp4";
    const loopVideoUrl = await saveLoopVideo(params.id, buffer, ext);
    return NextResponse.json({ loopVideoUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "store loop video error" },
      { status: 500 }
    );
  }
}
