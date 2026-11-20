import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, saveLoopVideo, storageWritable } from "@/lib/store";
import { a2ePhotoReadiness, a2eUploadImageBytes, issueA2ePhotoTask, verifyA2ePhotoTask, a2eLoopVideoStart, a2eLoopVideoPoll } from "@/lib/a2e";

import { readAvatarSource } from "@/lib/avatar-source";

export const runtime = "nodejs";
export const maxDuration = 60;


// POST = start generating the ambient "talking" loop video → { taskId }.
// Uses the cartoon if one exists, else the raw photo.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const readiness = a2ePhotoReadiness(params.id);
  if (!readiness.ready) return NextResponse.json(
    { error: readiness.message, code: `a2e_${readiness.status}`, a2e: readiness },
    { status: readiness.status === "privacy_disabled" ? 403 : 503 }
  );
  const writable = storageWritable();
  if (!writable.ok) return NextResponse.json({ error: writable.reason }, { status: 503 });

  const person = await getPerson(params.id);
  const source = person?.cartoonUrl || person?.photoUrl;
  if (!person || !source) return NextResponse.json({ error: "请先上传照片（建议先生成卡通形象）" }, { status: 400 });

  let res: Awaited<ReturnType<typeof a2eLoopVideoStart>>;
  try {
    const image = await readAvatarSource(person, "cartoon-or-photo");
    const hosted = await a2eUploadImageBytes(image.buffer, image.contentType, person.id);
    res = await a2eLoopVideoStart(hosted, person.id);
  } catch {
    return NextResponse.json({ error: "照片处理暂时失败，请稍后重试 / Photo processing is temporarily unavailable" }, { status: 502 });
  }
  if ("error" in res) {
    return NextResponse.json({ error: "循环视频发起失败: " + res.error }, { status: 502 });
  }
  return NextResponse.json({ taskId: issueA2ePhotoTask(person.id, "loop", res.taskId) });
}

// GET ?taskId=… = poll. When ready, download + store permanently → { loopVideoUrl }.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const readiness = a2ePhotoReadiness(params.id);
  if (!readiness.ready) return NextResponse.json(
    { error: readiness.message, code: `a2e_${readiness.status}`, a2e: readiness },
    { status: readiness.status === "privacy_disabled" ? 403 : 503 }
  );
  const taskId = verifyA2ePhotoTask(req.nextUrl.searchParams.get("taskId"), params.id, "loop");
  if (!taskId) return NextResponse.json({ error: "bad taskId" }, { status: 400 });

  const poll = await a2eLoopVideoPoll(taskId, params.id);
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
