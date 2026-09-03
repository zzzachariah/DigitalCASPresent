"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Person } from "@/lib/types";
import { readJson } from "@/lib/http";
import { studentApi, type StudentTokens } from "@/lib/editor-api";
import SubmitWizard, { readStoredDraft } from "./SubmitWizard";
import DraftPreview, { type Draft } from "./DraftPreview";
import { IconArrowRight, IconCheck, IconCopy, IconEdit, IconExternal } from "./icons";

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

const STEPS: [string, string, string][] = [
  ["01", "上传照片", "一张清晰的正脸照片，JPG 或 PNG。"],
  ["02", "放入讲稿", "粘贴文字，或上传 PDF / Word / txt 自动提取。"],
  ["03", "AI 分段", "自动分成引入、每个物品、结论几个部分，可以手动调整。"],
  ["04", "提交审核", "保存好你的专属修改链接；老师审核通过后页面上线。"],
];

export default function SubmitApp({ id, token }: { id?: string; token?: string }) {
  const tokenBox = useRef<StudentTokens>({ current: token ?? null, preview: null }).current;
  const api = useMemo(() => studentApi(tokenBox), [tokenBox]);

  const [stage, setStage] = useState<Stage>(id ? { kind: "loading" } : { kind: "intro" });
  const [mine, setMine] = useState<Remembered[]>([]);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [draft, setDraft] = useState<Draft>({ name: "", subtitle: "", sections: [] });

  useEffect(() => {
    if (!id) {
      setMine(remembered());
      const dr = readStoredDraft();
      setDraftName(dr ? dr.name.trim() || "未命名" : null);
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

  const topbar = (
    <header className="flex items-center justify-between">
      <span className="eyebrow">IBDP · TOK Exhibition</span>
      <a href="/submit" className="text-[13px] text-ink-3 transition-colors hover:text-ink">提交讲稿 · Submit</a>
    </header>
  );

  if (stage.kind === "loading") {
    return (
      <main className="mx-auto max-w-2xl px-5 py-8">
        {topbar}
        <div className="mt-8 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-28" />)}</div>
      </main>
    );
  }

  if (stage.kind === "invalid") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
        <p className="eyebrow">Invalid link</p>
        <h1 className="mt-3 font-display text-[26px] font-semibold leading-tight tracking-[-0.01em]">链接无效或已失效</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">请使用提交成功时保存的专属修改链接；找不到的话请联系老师。</p>
        <p className="mt-1 text-[13px] text-ink-3">Use the private link you saved when submitting, or ask your teacher.</p>
        <a href="/submit" className="btn-secondary mt-8">重新提交 · Submit again</a>
      </main>
    );
  }

  if (stage.kind === "edit") {
    const p = stage.person;
    return (
      <main className="mx-auto max-w-6xl px-5 py-6 lg:px-10 lg:py-8">
        {p && (
          <div
            className={`mb-5 flex items-start gap-2.5 rounded-lg px-4 py-3 text-[13px] animate-rise ${
              p.status === "approved" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"
            }`}
          >
            <span className="dot mt-1.5 bg-current" />
            <p>
              {p.status === "approved" ? (
                <>
                  <b>已发布 · Published.</b> 修改并重新提交后，页面会暂时下线，等老师再次审核。
                </>
              ) : (
                <>
                  <b>待审核 · Pending review.</b> 你仍可以修改；老师通过后页面才会开放。
                </>
              )}
            </p>
          </div>
        )}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
          <div className="min-w-0">
            <SubmitWizard
              person={p}
              api={api}
              onSaved={onSaved}
              onDraftChange={setDraft}
              onCancel={() => (p ? setStage({ kind: "done", person: p }) : setStage({ kind: "intro" }))}
            />
          </div>
          <aside className="hidden lg:block">
            <div className="sticky top-8">
              <DraftPreview draft={draft} />
            </div>
          </aside>
        </div>
      </main>
    );
  }

  if (stage.kind === "done") {
    const p = stage.person;
    const t = tokenBox.current || "";
    const editLink = `${base}/submit/${p.id}?token=${encodeURIComponent(t)}`;
    const previewLink = `${base}/p/${p.slug}?preview=${encodeURIComponent(tokenBox.preview || t)}`;
    return (
      <main className="mx-auto max-w-2xl px-5 py-8 lg:py-12">
        {topbar}
        <div className="stagger mt-10 space-y-4">
          <div style={{ ["--i" as string]: 0 }}>
            <div className="mb-5 h-16 w-16 animate-pop">
              <svg viewBox="0 0 64 64" className="h-16 w-16" aria-hidden>
                <circle cx="32" cy="32" r="30" className="fill-success-soft" />
                <path d="M20 33l8 8 16-17" fill="none" stroke="var(--success)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="check-draw" />
              </svg>
            </div>
            <p className="eyebrow">Submitted</p>
            <h1 className="mt-2 font-display text-[30px] font-semibold leading-tight tracking-[-0.015em]">已提交，等待老师审核</h1>
            <p className="mt-2 text-[15px] text-ink-2">
              {p.name} · {p.sections.length} 个部分{p.photoUrl ? "" : " · 还没有照片"}。老师通过后，你的二维码页面就会对访客开放。
            </p>
          </div>

          <div className="card p-5" style={{ ["--i" as string]: 1 }}>
            <p className="text-[15px] font-semibold">你的专属修改链接 · Private edit link</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
              这是以后修改内容的唯一入口，请截图或收藏保存，不要发给别人。
              <br />
              The only way to edit later — keep it, don’t share it.
            </p>
            <p className="mt-3 break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink-2">{editLink}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" className="btn-secondary" onClick={() => copy(editLink, "edit")}>
                {copied === "edit" ? <IconCheck size={15} /> : <IconCopy size={15} />} {copied === "edit" ? "已复制" : "复制链接"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setStage({ kind: "edit", person: p })}>
                <IconEdit size={15} /> 继续修改
              </button>
            </div>
          </div>

          <div className="card p-5" style={{ ["--i" as string]: 2 }}>
            <p className="text-[15px] font-semibold">预览我的数字人 · Preview</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-3">这个链接只能看、不能改，可以发给同学帮你看看；老师审核通过后，访客扫码才能看到。</p>
            <a href={previewLink} target="_blank" rel="noreferrer" className="btn-primary mt-3 w-full">
              打开预览 <IconExternal size={15} />
            </a>
          </div>
        </div>
      </main>
    );
  }

  // ── Intro ──
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-5 py-8 lg:px-10">
      {topbar}
      <section className="flex flex-1 flex-col justify-center py-12 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-center lg:gap-16">
        <div className="stagger">
          <p className="eyebrow" style={{ ["--i" as string]: 0 }}>Submit your talk</p>
          <h1 className="mt-3 font-display text-[36px] font-semibold leading-[1.05] tracking-[-0.02em] lg:text-[52px]" style={{ ["--i" as string]: 1 }}>
            提交我的
            <br />
            TOK 展览讲稿
          </h1>
          <p className="mt-5 max-w-md text-[16px] leading-relaxed text-ink-2" style={{ ["--i" as string]: 2 }}>
            提交后，系统会为你生成一个“数字人”：访客扫你的专属二维码，就能听你讲解自己的展览，还可以追问。
          </p>
          <p className="mt-2 max-w-md text-[13px] leading-relaxed text-ink-3" style={{ ["--i" as string]: 3 }}>
            Upload a photo and your script; visitors will scan your code, hear your talk part by part, and ask questions.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3" style={{ ["--i" as string]: 4 }}>
            <button type="button" className="btn-primary px-5 py-3" onClick={() => setStage({ kind: "edit", person: null })}>
              {draftName ? "继续上次的草稿 · Continue" : "开始填写 · Start"} <IconArrowRight size={16} />
            </button>
            <span className="text-[12px] text-ink-4">
              {draftName ? `这台设备上有未提交的草稿：${draftName}` : "大约 5 分钟 · about 5 minutes"}
            </span>
          </div>
          {mine.length > 0 && (
            <div className="mt-8 rounded-lg border border-line bg-surface-2/60 p-4" style={{ ["--i" as string]: 5 }}>
              <p className="eyebrow">这台设备上之前的提交</p>
              <ul className="mt-2 space-y-1.5">
                {mine.map((m) => (
                  <li key={m.id}>
                    <a href={`/submit/${m.id}?token=${encodeURIComponent(m.token)}`} className="inline-flex items-center gap-1.5 text-[14px] text-accent hover:underline">
                      {m.name} <IconArrowRight size={14} /> 继续修改
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <ol className="mt-12 space-y-2 lg:mt-0" aria-label="Steps">
          {STEPS.map(([n, h, d], i) => (
            <li key={n} className="card flex gap-4 p-4 animate-rise" style={{ animationDelay: `${240 + i * 60}ms` }}>
              <span className="font-mono text-[11px] text-accent">{n}</span>
              <div>
                <p className="text-[14px] font-medium">{h}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
