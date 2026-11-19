import { NextRequest, NextResponse } from "next/server";
import { eventRetentionStatus, isEventDataPath } from "./lib/event-retention";

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const status = eventRetentionStatus();
  let response: NextResponse;
  if (isEventDataPath(path) && (status.state === "closed" || status.state === "invalid")) {
    const message = status.state === "closed"
      ? "活动已结束，资料访问与提交已关闭。 / The event has ended. Submissions and access are closed."
      : "活动资料暂不可用，请联系老师。 / Event data is unavailable. Please contact your teacher.";
    response = path.startsWith("/api/")
      ? NextResponse.json({ error: message }, { status: status.state === "closed" ? 410 : 503 })
      : new NextResponse(message, { status: status.state === "closed" ? 410 : 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } else {
    response = NextResponse.next();
  }
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

export const config = { matcher: ["/api/:path*", "/p/:path*", "/submit/:path*", "/admin/:path*"] };
