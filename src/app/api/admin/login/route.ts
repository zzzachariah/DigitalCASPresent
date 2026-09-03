import { NextRequest, NextResponse } from "next/server";
import { adminConfigured, checkPassword, makeToken, adminCookieOptions, ADMIN_COOKIE, ADMIN_SESSION_SECONDS } from "@/lib/auth";
import { limitRequest } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const limited = limitRequest(req, "login");
  if (limited) return limited;

  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "后台密码尚未设置：请在环境变量里配置 ADMIN_PASSWORD / ADMIN_PASSWORD is not set" },
      { status: 503 }
    );
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!checkPassword(password || "")) {
    return NextResponse.json({ error: "密码错误 / Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, makeToken(), adminCookieOptions(ADMIN_SESSION_SECONDS));
  return res;
}
