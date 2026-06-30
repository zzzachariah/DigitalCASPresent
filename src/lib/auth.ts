import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

// ─────────────────────────────────────────────────────────────────────
// Minimal admin auth: a single shared password (ADMIN_PASSWORD) gates the
// backend upload UI. On login we set a signed httpOnly cookie. This is
// deliberately simple — fine for a small exhibition tool; swap for real
// auth if this ever holds sensitive data.
// ─────────────────────────────────────────────────────────────────────

const COOKIE = "dcp_admin";
const SECRET = process.env.ADMIN_PASSWORD || "change-me";

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

function makeToken(): string {
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

export function setAdminCookie() {
  cookies().set(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h
  });
}

export function clearAdminCookie() {
  cookies().delete(COOKIE);
}

export function isAdmin(): boolean {
  return verifyToken(cookies().get(COOKIE)?.value);
}
