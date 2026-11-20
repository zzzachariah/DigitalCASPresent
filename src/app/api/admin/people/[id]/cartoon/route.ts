import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, saveCartoon, storageWritable } from "@/lib/store";
import { a2ePhotoReadiness, a2eUploadImageBytes, issueA2ePhotoTask, verifyA2ePhotoTask, a2eCartoonStart, a2eCartoonPoll } from "@/lib/a2e";

import { readAvatarSource } from "@/lib/avatar-source";

export const runtime = "nodejs";
export const maxDuration = 60;


// POST = start a cartoon-ify task → { taskId }. (Fast; render happens async.)
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
  if (!person?.photoUrl) return NextResponse.json({ error: "请先上传照片" }, { status: 400 });

  let res: Awaited<ReturnType<typeof a2eCartoonStart>>;
  try {
    const image = await readAvatarSource(person, "photo");
    const hosted = await a2eUploadImageBytes(image.buffer, image.contentType, person.id);
    res = await a2eCartoonStart(hosted, person.id);
  } catch {
    return NextResponse.json({ error: "照片处理暂时失败，请稍后重试 / Photo processing is temporarily unavailable" }, { status: 502 });
  }
  if ("error" in res) {
    return NextResponse.json({ error: "卡通发起失败: " + res.error }, { status: 502 });
  }
  return NextResponse.json({ taskId: issueA2ePhotoTask(person.id, "cartoon", res.taskId) });
}

// GET ?taskId=… = poll. When ready, download the (3-day) A2E image and store
// it permanently → { cartoonUrl }. Otherwise { pending: true } or { error }.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const readiness = a2ePhotoReadiness(params.id);
  if (!readiness.ready) return NextResponse.json(
    { error: readiness.message, code: `a2e_${readiness.status}`, a2e: readiness },
    { status: readiness.status === "privacy_disabled" ? 403 : 503 }
  );
  const taskId = verifyA2ePhotoTask(req.nextUrl.searchParams.get("taskId"), params.id, "cartoon");
  if (!taskId) return NextResponse.json({ error: "bad taskId" }, { status: 400 });

  const poll = await a2eCartoonPoll(taskId, params.id);
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
