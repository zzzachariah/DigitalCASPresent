import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

// ─────────────────────────────────────────────────────────────────────
// Minimal admin auth: a single shared password (ADMIN_PASSWORD) gates the
// backend upload UI. On login we set a signed httpOnly cookie. Simple by
// design — fine for a small exhibition tool.
//
// Cookies are written on the NextResponse in the route handlers (the reliable
// way in App Router route handlers); here we only build/verify the token and
// read the cookie for server-side gating.
// ─────────────────────────────────────────────────────────────────────

export const ADMIN_COOKIE = "dcp_admin";
const SECRET = process.env.ADMIN_PASSWORD || "change-me";

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

export function makeToken(): string {
  const payload = "admin"; // single role
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token?: string): boolean {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const expected = sign(payload);
  try {
    return timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function checkPassword(input: string): boolean {
  const a = Buffer.from(input || "");
  const b = Buffer.from(process.env.ADMIN_PASSWORD || "");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Cookie options shared by login (set) and logout (clear). */
export function adminCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function isAdmin(): boolean {
  return verifyToken(cookies().get(ADMIN_COOKIE)?.value);
}
