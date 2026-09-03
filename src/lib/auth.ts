import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

// ─────────────────────────────────────────────────────────────────────
// Minimal admin auth: a single shared password (ADMIN_PASSWORD) gates the
// backend UI. On login we set a signed, time-limited httpOnly cookie.
//
// Cookies are written on the NextResponse in the route handlers; here we
// only build/verify the token and read the cookie for server-side gating.
// ─────────────────────────────────────────────────────────────────────

export const ADMIN_COOKIE = "dcp_admin";
/** How long an admin login stays valid (also the cookie max-age). */
export const ADMIN_SESSION_SECONDS = 60 * 60 * 12; // 12h

function adminPassword(): string {
  return (process.env.ADMIN_PASSWORD || "").trim();
}

/** False when no password is configured — then nobody can log in (rather
 *  than everybody: an unset password used to let an EMPTY password through). */
export function adminConfigured(): boolean {
  return adminPassword().length > 0;
}

/** HMAC key for session tokens. A dedicated ADMIN_SESSION_SECRET is preferred;
 *  otherwise derive from the password so changing it logs everyone out. */
function secret(): string {
  return process.env.ADMIN_SESSION_SECRET?.trim() || adminPassword();
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

/** Constant-time string comparison that never matches an empty value. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  const ba = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** Token = admin.<issuedAtMs>.<hmac>. */
export function makeToken(now = Date.now()): string {
  const payload = `admin.${now}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined, now = Date.now()): boolean {
  if (!token || !adminConfigured()) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "admin") return false;
  const issued = Number(parts[1]);
  if (!Number.isFinite(issued)) return false;
  if (now - issued > ADMIN_SESSION_SECONDS * 1000) return false; // expired
  if (issued > now + 60_000) return false; // from the future → forged
  return safeEqual(parts[2], sign(`${parts[0]}.${parts[1]}`));
}

export function checkPassword(input: string): boolean {
  if (!adminConfigured()) return false;
  // Compare fixed-length digests so a length mismatch doesn't short-circuit.
  const a = createHmac("sha256", "pw").update(input || "").digest("hex");
  const b = createHmac("sha256", "pw").update(adminPassword()).digest("hex");
  return safeEqual(a, b);
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
