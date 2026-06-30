import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { extractText } from "@/lib/parse";

export const runtime = "nodejs";

// Upload a .txt / .pdf / .docx and get back the extracted plain text,
// so the admin can review/edit it before saving.
export async function POST(req: NextRequest) {
  if (!isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "未找到文件 / No file" }, { status: 400 });
  }
  if (file.size > 15 * 1024 * 1024) {
    return NextResponse.json({ error: "文件过大（<15MB）/ File too large" }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const text = await extractText(buffer, file.name, file.type);
    if (!text.trim()) {
      return NextResponse.json(
        { error: "未能从文件中提取到文字 / Could not extract text" },
        { status: 422 }
      );
    }
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "解析失败 / Parse failed" },
      { status: 422 }
    );
  }
}
