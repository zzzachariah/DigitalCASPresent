import { NextRequest, NextResponse } from "next/server";
import { checkPassword, setAdminCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { password } = (await req.json().catch(() => ({}))) as {
    password?: string;
  };
  if (!checkPassword(password || "")) {
    return NextResponse.json({ error: "密码错误 / Wrong password" }, { status: 401 });
  }
  setAdminCookie();
  return NextResponse.json({ ok: true });
}
