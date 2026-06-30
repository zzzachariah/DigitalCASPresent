import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { storageDriverName } from "@/lib/store";
import { resolveBlobToken } from "@/lib/store-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only config diagnostics. Returns only booleans/names — never secrets.
// Open /api/admin/health (after logging in) to see what the live deployment
// actually has configured.
export async function GET() {
  if (!isAdmin()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Names only (no values) of env vars that look blob/token related — reveals
  // what Vercel actually injected when you connected the Blob store.
  const blobEnvKeys = Object.keys(process.env).filter((k) =>
    /blob|read_write_token/i.test(k)
  );

  return NextResponse.json({
    storage: storageDriverName(), // "vercel-blob" once Blob is wired
    onVercel: !!process.env.VERCEL,
    hasBlobTokenStandard: !!process.env.BLOB_READ_WRITE_TOKEN,
    tokenResolved: !!resolveBlobToken(),
    blobEnvKeys, // e.g. ["BLOB_READ_WRITE_TOKEN"] or a prefixed name
    aiKeySet: !!process.env.AI_API_KEY,
    aiModel: process.env.AI_MODEL || "(default: claude-opus-4-8)",
    avatarProvider: process.env.AVATAR_PROVIDER || "mock",
    didKeySet: !!process.env.DID_API_KEY,
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL || "(not set)",
  });
}
