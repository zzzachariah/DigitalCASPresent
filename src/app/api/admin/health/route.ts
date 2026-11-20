import { aiProcessingAllowed, externalProcessingAllowed } from "@/lib/processing-policy";
import { NextResponse } from "next/server";
import { a2eReadiness, a2ePhotoReadiness, a2ePhotoApprovedPersonIds, a2eSpeechReadiness, a2eSpeechApprovedPersonIds } from "@/lib/a2e";
import { adminConfigured, isAdmin } from "@/lib/auth";
import { storageDriverName, storageWritable } from "@/lib/store";
import { resolveBlobToken, mediaBlobConfigured, recordsBlobConfigured, hasBlobOidcToken } from "@/lib/store-shared";

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
    adminPasswordSet: adminConfigured(),
    hasBlobTokenStandard: !!process.env.BLOB_READ_WRITE_TOKEN,
    tokenResolved: !!resolveBlobToken(),
    mediaStorageConfigured: mediaBlobConfigured(),
    privateRecordsConfigured: recordsBlobConfigured(),
    storageWritesReady: storageWritable().ok,
    legacyRecordsReadOnly: true,
    // OIDC path: works without a manually-copied token if both are present.
    hasOidcToken: hasBlobOidcToken(),
    hasBlobStoreId: !!process.env.BLOB_STORE_ID,
    blobEnvKeys, // e.g. ["BLOB_READ_WRITE_TOKEN"] or a prefixed name
    externalProcessingApproved: externalProcessingAllowed(),
    aiProcessingApproved: aiProcessingAllowed(),
    mediaProcessingApproved: externalProcessingAllowed(),
    aiLiveModel: process.env.AI_MODEL_LIVE || process.env.AI_MODEL || "claude-sonnet-5",
    eventEndsAt: process.env.EVENT_ENDS_AT || null,
    aiKeySet: !!process.env.AI_API_KEY,
    aiModel: process.env.AI_MODEL || "(default: claude-sonnet-5)",
    avatarProvider: process.env.AVATAR_PROVIDER || "mock",
    a2eKeySet: !!process.env.A2E_API_KEY?.trim(),
    a2e: a2eReadiness(),
    a2ePhoto: {
      global: a2ePhotoReadiness(),
      approvedPersonIds: a2ePhotoApprovedPersonIds(),
      people: Object.fromEntries(a2ePhotoApprovedPersonIds().map((id) => [id, a2ePhotoReadiness(id)])),
    },
    a2eSpeech: {
      global: a2eSpeechReadiness(),
      approvedPersonIds: a2eSpeechApprovedPersonIds(),
      people: Object.fromEntries(a2eSpeechApprovedPersonIds().map((id) => [id, a2eSpeechReadiness(id)])),
    },
    didKeySet: !!process.env.DID_API_KEY,
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL || "(not set)",
  });
}
