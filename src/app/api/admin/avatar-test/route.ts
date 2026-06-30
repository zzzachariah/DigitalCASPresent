import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getPerson, listPeople } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Admin-only: attempt a real D-ID render and return the raw result/error so we
// can see exactly why the talking video isn't generating.
// Usage: /api/admin/avatar-test            (uses the first person)
//        /api/admin/avatar-test?personId=… (a specific person)
export async function GET(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const personId = req.nextUrl.searchParams.get("personId");
  const person = personId ? await getPerson(personId) : (await listPeople())[0];
  if (!person) {
    return NextResponse.json({ error: "没有任何人物,请先在后台创建一个人" }, { status: 404 });
  }

  const provider = (process.env.AVATAR_PROVIDER || "mock").toLowerCase();
  const didKey = process.env.DID_API_KEY?.trim() || "";

  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host");
  const base = (process.env.NEXT_PUBLIC_BASE_URL || `${proto}://${host}`).replace(/\/$/, "");
  const photoPublicUrl = person.photoUrl
    ? person.photoUrl.startsWith("http")
      ? person.photoUrl
      : `${base}${person.photoUrl}`
    : undefined;

  const checks = {
    person: person.name,
    avatarProvider: provider,
    didKeySet: !!didKey,
    photoUrl: person.photoUrl || null,
    photoIsPublicHttps: !!photoPublicUrl && photoPublicUrl.startsWith("https://"),
    photoPublicUrl: photoPublicUrl || null,
  };

  if (provider !== "did") {
    return NextResponse.json({ ...checks, verdict: "AVATAR_PROVIDER 不是 did(当前=" + provider + ")" });
  }
  if (!didKey) {
    return NextResponse.json({ ...checks, verdict: "DID_API_KEY 未设置" });
  }
  if (!photoPublicUrl || !photoPublicUrl.startsWith("https://")) {
    return NextResponse.json({ ...checks, verdict: "这个人没有公开的 https 照片(需要先连好 Blob 并上传真实照片)" });
  }

  const auth = didKey.includes(":")
    ? `Basic ${Buffer.from(didKey).toString("base64")}`
    : `Basic ${didKey}`;

  try {
    const res = await fetch("https://api.d-id.com/talks", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        source_url: photoPublicUrl,
        script: {
          type: "text",
          input: "你好,这是一段测试。Hello, this is a test.",
          provider: { type: "microsoft", voice_id: "zh-CN-XiaoxiaoNeural" },
        },
        config: { stitch: true },
      }),
    });
    const status = res.status;
    const bodyText = await res.text();
    let parsed: unknown = bodyText;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      /* keep text */
    }
    return NextResponse.json({
      ...checks,
      didCreateStatus: status,
      didCreateOk: res.ok,
      didResponse: parsed,
      verdict: res.ok
        ? "D-ID 接受了请求 ✅(说明 key/照片都没问题;视频会异步渲染)"
        : "D-ID 拒绝了请求 ❌(看 didResponse 里的原因)",
    });
  } catch (e) {
    return NextResponse.json({
      ...checks,
      didError: e instanceof Error ? e.message : String(e),
      verdict: "调用 D-ID 时网络/异常出错",
    });
  }
}
