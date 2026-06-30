// ─────────────────────────────────────────────────────────────────────
// Extract plain text from an uploaded script file (.txt / .pdf / .docx).
// Used by the admin upload endpoint. Runs server-side only.
// ─────────────────────────────────────────────────────────────────────

export async function extractText(
  buffer: Buffer,
  filename: string,
  mime: string
): Promise<string> {
  const name = filename.toLowerCase();

  if (name.endsWith(".txt") || mime.startsWith("text/")) {
    return buffer.toString("utf8").trim();
  }

  if (name.endsWith(".docx") || mime.includes("officedocument.wordprocessing")) {
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    const result = await (mammoth as any).extractRawText({ buffer });
    return String(result.value || "").trim();
  }

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    // pdf-parse default export is a function (buffer) => Promise<{ text }>
    const mod = await import("pdf-parse");
    const pdfParse = (mod as any).default ?? mod;
    const data = await pdfParse(buffer);
    return String(data.text || "").trim();
  }

  if (name.endsWith(".doc")) {
    throw new Error(
      "Legacy .doc files aren't supported — please save as .docx, .pdf, or paste the text."
    );
  }

  // Fallback: try utf8.
  return buffer.toString("utf8").trim();
}
