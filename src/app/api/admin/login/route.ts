import { NextRequest, NextResponse } from "next/server";
import { checkPassword, makeToken, adminCookieOptions, ADMIN_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { password } = (await req.json().catch(() => ({}))) as {
    password?: string;
  };
  if (!checkPassword(password || "")) {
    return NextResponse.json({ error: "密码错误 / Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, makeToken(), adminCookieOptions(60 * 60 * 12)); // 12h
  return res;
}
