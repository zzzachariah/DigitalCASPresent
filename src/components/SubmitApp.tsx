"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Person } from "@/lib/types";
import { readJson } from "@/lib/http";
import { studentApi, type StudentTokens } from "@/lib/editor-api";
import PersonEditor from "./PersonEditor";

// ─────────────────────────────────────────────────────────────────────
// Student self-submission flow:
//   /submit               intro → form → "submitted" screen with private links
//   /submit/<id>?token=…  load own record → edit → resubmit
// The edit token is the only credential; it is also remembered in this
// browser so a student who comes back to /submit can find their submission.
// ─────────────────────────────────────────────────────────────────────

type Stage =
  | { kind: "intro" }
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "edit"; person: Person | null }
  | { kind: "done"; person: Person };

const STORAGE_KEY = "dcp_my_submissions";
interface Remembered {
  id: string;
  token: string;
  name: string;
  at: number;
}

function remembered(): Remembered[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function remember(entry: Remembered) {
  try {
    const list = remembered().filter((r) => r.id !== entry.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...list].slice(0, 5)));
  } catch {
    /* private mode etc. — the links are still shown on screen */
  }
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "")
  );
}

export default function SubmitApp({ id, token }: { id?: string; token?: string }) {
  // Shared box: studentApi.create() fills it; later calls read it.
  const tokenBox = useRef<StudentTokens>({ current: token ?? null, preview: null }).current;
  const api = useMemo(() => studentApi(tokenBox), [tokenBox]);

  const [stage, setStage] = useState<Stage>(id ? { kind: "loading" } : { kind: "intro" });
  const [mine, setMine] = useState<Remembered[]>([]);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!id) {
      setMine(remembered());
      return;
    }
    if (!token) {
      setStage({ kind: "invalid" });
      return;
    }
    fetch(`/api/submit/${id}`, { headers: { "x-edit-token": token }, cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (!res.ok) throw new Error(data.error);
        tokenBox.preview = data.previewToken ?? null;
        setStage({ kind: "edit", person: data.person });
      })
      .catch(() => setStage({ kind: "invalid" }));
  }, [id, token, tokenBox]);

  function onSaved(p: Person) {
    const t = tokenBox.current;
    if (t) remember({ id: p.id, token: t, name: p.name, at: Date.now() });
    setStage({ kind: "done", person: p });
    window.scrollTo({ top: 0 });
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      prompt("复制链接 / Copy this link:", text);
    }
  }

  const base = baseUrl();

  if (stage.kind === "loading") {
    return (
      <main className="mx-auto max-w-md px-5 py-6">
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-24 animate-pulse" />
          ))}
        </div>
      </main>
    );
  }

  if (stage.kind === "invalid") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 text-4xl">🔗</div>
        <h1 className="text-xl font-semibold">链接无效或已失效</h1>
        <p className="mt-2 text-sm text-ink-mute">
          请使用提交成功时保存的专属修改链接；找不到的话请联系老师。
        </p>
        <p className="mt-1 text-xs text-ink-mute">
          This edit link is invalid. Use the private link you saved when submitting, or ask your teacher.
        </p>
        <a href="/submit" className="btn-ghost mt-6">
          重新提交 / Submit again
        </a>
      </main>
    );
  }

  if (stage.kind === "edit") {
    const p = stage.person;
    return (
      <main className="mx-auto max-w-md px-5 py-6">
        {p && (
          <div
            className={`mb-4 rounded-2xl px-4 py-3 text-sm ring-1 ${
              p.status === "approved"
                ? "bg-green-50 text-green-800 ring-green-200"
                : "bg-amber-50 text-amber-800 ring-amber-200"
            }`}
          >
            {p.status === "approved" ? (
              <>
                <b>已发布 · Published.</b> 修改并重新提交后，页面会暂时下线，等老师再次审核。
              </>
            ) : (
              <>
                <b>待审核 · Pending review.</b> 你仍可以修改；老师通过后页面才会开放。
              </>
            )}
          </div>
        )}
        <PersonEditor
          person={p}
          mode="student"
          api={api}
          onSaved={onSaved}
          onCancel={() => (p ? setStage({ kind: "done", person: p }) : setStage({ kind: "intro" }))}
        />
      </main>
    );
  }

  if (stage.kind === "done") {
    const p = stage.person;
    const t = tokenBox.current || "";
    const editLink = `${base}/submit/${p.id}?token=${encodeURIComponent(t)}`;
    const previewLink = `${base}/p/${p.slug}?preview=${encodeURIComponent(tokenBox.preview || t)}`;
    return (
      <main className="mx-auto max-w-md px-5 py-8">
        <div className="card p-6 text-center">
          <div className="mb-3 text-4xl">🎉</div>
          <h1 className="text-xl font-semibold">已提交，等待老师审核</h1>
          <p className="mt-1 text-sm text-ink-mute">Submitted — your teacher will review it soon.</p>
          <p className="mt-4 text-sm text-ink-soft">
            {p.name} · {p.sections.length} 个部分{p.photoUrl ? "" : " · 还没有照片"}
          </p>
        </div>

        <div className="card mt-4 p-5">
          <p className="text-sm font-semibold">🔑 你的专属修改链接 · Your private edit link</p>
          <p className="mt-1 text-xs text-ink-mute">
            这是以后修改内容的唯一入口，请截图或收藏保存，不要发给别人。
            <br />
            Keep this link — it’s the only way to edit your submission later. Don’t share it.
          </p>
          <p className="mt-2 break-all rounded-xl bg-gray-50 px-3 py-2 text-xs text-ink-soft">{editLink}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button className="btn-ghost py-2 text-sm" onClick={() => copy(editLink, "edit")}>
              {copied === "edit" ? "已复制 ✓" : "复制链接 / Copy"}
            </button>
            <button className="btn-soft py-2 text-sm" onClick={() => setStage({ kind: "edit", person: p })}>
              继续修改 / Edit
            </button>
          </div>
        </div>

        <div className="card mt-4 p-5">
          <p className="text-sm font-semibold">👀 预览我的数字人 · Preview</p>
          <p className="mt-1 text-xs text-ink-mute">
            这个链接只能看、不能改，可以发给同学帮你看看；老师审核通过后，访客扫码才能看到。
          </p>
          <a href={previewLink} target="_blank" rel="noreferrer" className="btn-primary mt-3 w-full">
            打开预览 / Open preview →
          </a>
        </div>

        <a href="/submit" className="mt-6 block text-center text-sm text-ink-mute hover:text-ink">
          返回 / Back
        </a>
      </main>
    );
  }

  // intro
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-10">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-3xl bg-brand-500 text-xl text-white shadow-lift">
          ✦
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">提交我的 TOK 展览讲稿</h1>
        <p className="mt-1 text-sm text-ink-mute">Submit your TOK Exhibition talk</p>
      </div>

      <div className="card space-y-3 p-5 text-sm text-ink-soft">
        <p>提交后，系统会为你生成一个“数字人”：访客扫你的专属二维码，就能听你讲解自己的展览，还可以追问。</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>上传一张清晰的正脸照片（JPG / PNG）。</li>
          <li>粘贴或上传你的讲稿（PDF / Word / txt 都可以）。</li>
          <li>点“AI 智能分段”，检查每个部分的标题和内容。</li>
          <li>提交后保存好你的专属修改链接；老师审核通过后页面上线。</li>
        </ol>
        <p className="text-xs text-ink-mute">
          Upload a clear front-facing photo, paste or upload your script, let the AI split it into parts,
          then submit. Your page goes live once a teacher approves it.
        </p>
      </div>

      <button className="btn-primary mt-5 w-full" onClick={() => setStage({ kind: "edit", person: null })}>
        开始填写 / Start →
      </button>

      {mine.length > 0 && (
        <div className="card mt-5 p-4">
          <p className="text-sm font-semibold">这台设备上之前的提交 · Your earlier submissions</p>
          <ul className="mt-2 space-y-1.5">
            {mine.map((m) => (
              <li key={m.id}>
                <a
                  href={`/submit/${m.id}?token=${encodeURIComponent(m.token)}`}
                  className="text-sm text-brand-600 hover:underline"
                >
                  {m.name} → 继续修改 / Edit
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
