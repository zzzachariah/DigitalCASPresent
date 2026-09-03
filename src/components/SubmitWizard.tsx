"use client";

import { useEffect, useRef, useState } from "react";
import type { Person } from "@/lib/types";
import type { EditorApi } from "@/lib/editor-api";
import { pad2 } from "@/lib/format";
import { Spinner } from "./Loading";
import DraftPreview, { type Draft } from "./DraftPreview";
import SectionList from "./SectionList";
import { PHOTO_ACCEPT, usePersonDraft } from "./usePersonDraft";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconEdit,
  IconPlus,
  IconSparkle,
  IconUpload,
  IconWarning,
} from "./icons";

// ─────────────────────────────────────────────────────────────────────
// Student submission as five pages. Each page slides in from the side it
// came from; the progress line eases forward; leaving the script page runs
// the AI split so the parts page opens with the work already done.
// ─────────────────────────────────────────────────────────────────────

const STEPS = [
  { n: "01", zh: "照片", en: "Photo" },
  { n: "02", zh: "信息", en: "Basics" },
  { n: "03", zh: "讲稿", en: "Script" },
  { n: "04", zh: "分段", en: "Parts" },
  { n: "05", zh: "确认", en: "Review" },
] as const;
const LAST = STEPS.length - 1;

const LANGUAGES: { value: Person["language"]; label: string }[] = [
  { value: "auto", label: "跟随提问语言 · Auto" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "bilingual", label: "中英双语 · Bilingual" },
];

export default function SubmitWizard({
  person,
  api,
  onSaved,
  onCancel,
  onDraftChange,
}: {
  person: Person | null;
  api: EditorApi;
  onSaved: (p: Person) => void;
  onCancel: () => void;
  onDraftChange?: (d: Draft) => void;
}) {
  const d = usePersonDraft({ person, api, admin: false });
  // Editing an existing submission opens on the review page; from there the
  // student jumps to whichever page needs a change.
  const [step, setStep] = useState(person ? LAST : 0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [reached, setReached] = useState(person ? LAST : 0);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onDraftChange?.(d.draft);
  }, [d.draft, onDraftChange]);

  /** Why page `i` can't be left yet, or null. */
  function blocker(i: number): string | null {
    if (i === 1 && !d.name.trim()) return "请填写姓名 · Name is required";
    if (i === 2 && !d.script.trim()) return "请先粘贴或上传讲稿 · Add your script first";
    if (i === 3 && d.sections.length === 0) return "至少需要一个部分 · Add at least one part";
    return null;
  }

  function show(to: number, direction: 1 | -1) {
    setDir(direction);
    setStep(to);
    setReached((r) => Math.max(r, to));
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function go(to: number) {
    if (to === step || d.sectioning || d.saving) return;
    d.setError("");
    if (to < step) return show(to, -1);
    // Moving forward: every page in between must be complete.
    for (let i = step; i < to; i++) {
      const why = blocker(i);
      if (why) {
        if (i !== step) show(i, 1);
        d.setError(why);
        return;
      }
      // Leaving the script page with no parts yet → open the parts page and
      // let the AI split run there (skeletons while it works).
      if (i === 2 && d.sections.length === 0) {
        show(3, 1);
        await d.autoSection();
        return;
      }
    }
    show(to, 1);
  }

  async function submit() {
    const saved = await d.save();
    if (saved) onSaved(saved);
  }

  const genders: { v: "" | "male" | "female"; t: string }[] = [
    { v: "", t: "默认 · Default" },
    { v: "male", t: "男声 · Male" },
    { v: "female", t: "女声 · Female" },
  ];

  const progress = (step / LAST) * 100;

  return (
    <div ref={topRef} className="scroll-mt-6">
      {/* ── Header + step bar ── */}
      <div className="mb-5 flex items-center justify-between">
        <button type="button" onClick={onCancel} className="btn-ghost -ml-2 px-2">
          <IconArrowLeft size={16} /> 返回
        </button>
        <div className="text-right">
          <h2 className="font-display text-[20px] font-semibold leading-tight tracking-[-0.01em]">{d.isEdit ? "修改我的提交" : "提交我的讲稿"}</h2>
          <p className="eyebrow">
            Step {step + 1} of {STEPS.length} · {STEPS[step].en}
          </p>
        </div>
      </div>

      <nav className="mb-6" aria-label="Steps">
        <ol className="grid grid-cols-5 gap-1">
          {STEPS.map((s, i) => {
            const done = i < step || (d.isEdit && i !== step);
            const clickable = d.isEdit || i <= reached;
            return (
              <li key={s.n}>
                <button
                  type="button"
                  onClick={() => clickable && go(i)}
                  disabled={!clickable}
                  aria-current={i === step ? "step" : undefined}
                  className={`group flex w-full flex-col items-start gap-1.5 rounded-md px-1 py-1.5 text-left transition-colors duration-300 ease-out disabled:cursor-default ${
                    i === step ? "text-ink" : clickable ? "text-ink-3 hover:text-ink" : "text-ink-4"
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className={i === step ? "text-accent" : ""}>{s.n}</span>
                    {done && i !== step && <IconCheck size={12} className="text-success" />}
                  </span>
                  <span className="text-[13px] font-medium leading-none">
                    {s.zh}
                    <span className="ml-1 hidden text-[11px] font-normal text-ink-4 sm:inline">{s.en}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="relative mt-2 h-0.5 overflow-hidden rounded-full bg-line">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </nav>

      {d.error && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-[13px] text-danger animate-rise">
          <IconWarning size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">{d.error}</p>
          <button type="button" onClick={() => d.setError("")} className="shrink-0 opacity-70 hover:opacity-100" aria-label="关闭">
            <IconClose size={16} />
          </button>
        </div>
      )}

      {/* ── Page ── */}
      <div key={step} className={dir === 1 ? "step-enter-fwd" : "step-enter-back"}>
        {step === 0 && (
          <section className="card p-5">
            <h3 className="text-[17px] font-semibold">一张清晰的正脸照片</h3>
            <p className="mt-1 text-[13px] text-ink-3">这张照片会变成你的数字人形象。JPG / PNG / WebP，≤8MB。</p>
            <input
              ref={fileRef}
              type="file"
              accept={PHOTO_ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) d.pickPhoto(f);
                e.target.value = "";
              }}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) d.pickPhoto(f);
              }}
              className={`relative mt-4 aspect-[4/3] cursor-pointer overflow-hidden rounded-xl border-2 transition-[border-color,background-color,transform] duration-300 ease-out sm:aspect-[16/10] ${
                d.photoPreview
                  ? "border-line bg-surface-2"
                  : dragging
                    ? "scale-[1.01] border-dashed border-accent bg-accent-soft"
                    : "border-dashed border-line-strong bg-surface-2 hover:border-accent"
              }`}
            >
              {d.photoPreview ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={d.photoPreview} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={d.photoPreview} alt="" className="absolute inset-0 h-full w-full object-contain animate-fade" />
                  <span className="absolute bottom-3 right-3 chip bg-surface/90 backdrop-blur">
                    <IconUpload size={14} /> 更换
                  </span>
                </>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-surface text-ink-3 shadow-1"><IconUpload size={20} /></span>
                  <p className="text-[14px] font-medium text-ink-2">点击上传，或把照片拖进来</p>
                  <p className="text-[12px] text-ink-4">Click to upload, or drop a photo here</p>
                </div>
              )}
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
              没有合适的照片也可以先跳过，之后用修改链接补上。{d.isEdit && "更换照片后，老师需要重新生成卡通形象。"}
            </p>
          </section>
        )}

        {step === 1 && (
          <section className="card space-y-4 p-5">
            <div>
              <h3 className="text-[17px] font-semibold">你是谁</h3>
              <p className="mt-1 text-[13px] text-ink-3">访客会在页面顶部看到这些。</p>
            </div>
            <div>
              <label className="label" htmlFor="sw-name">姓名 · Name</label>
              <input
                id="sw-name"
                className="input"
                value={d.name}
                onChange={(e) => d.setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && go(step + 1)}
                placeholder="例如：李雷 / Li Lei"
                maxLength={60}
                autoFocus
              />
            </div>
            <div>
              <label className="label" htmlFor="sw-sub">副标题 · Subtitle <span className="text-ink-4">可选，通常写你的知识问题</span></label>
              <input id="sw-sub" className="input" value={d.subtitle} onChange={(e) => d.setSubtitle(e.target.value)} placeholder="例如：Why do we seek knowledge?" maxLength={140} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <span className="label">数字人的声音 · Voice</span>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface-2 p-1">
                  {genders.map((g) => (
                    <button
                      key={g.v}
                      type="button"
                      onClick={() => d.setGender(g.v)}
                      className={`rounded-md px-2 py-2 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-200 ease-out ${
                        d.gender === g.v ? "bg-surface text-ink shadow-1" : "text-ink-3 hover:text-ink"
                      }`}
                    >
                      {g.t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label" htmlFor="sw-lang">回答语言 · Answer language</label>
                <div className="relative">
                  <select id="sw-lang" className="input appearance-none pr-9" value={d.language} onChange={(e) => d.setLanguage(e.target.value as Person["language"])}>
                    {LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                  <IconChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" />
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="card p-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-[17px] font-semibold">你的讲稿</h3>
                <p className="mt-1 text-[13px] text-ink-3">粘贴全文，或上传文件自动提取。下一步会由 AI 自动分段。</p>
              </div>
              <label className="btn-secondary cursor-pointer py-2 text-[13px]">
                <IconUpload size={15} /> {d.parsing ? "解析中…" : "上传 PDF / Word / txt"}
                <input
                  type="file"
                  accept=".txt,.pdf,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) d.pickScriptFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <textarea
              className="input mt-4 min-h-[280px] resize-y leading-relaxed"
              value={d.script}
              onChange={(e) => d.setScript(e.target.value)}
              placeholder="直接粘贴讲稿文字，或上传文件自动提取… / Paste your talk, or upload a file"
              autoFocus
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="eyebrow">{d.script.length} chars</span>
              {d.parsing && <span className="flex items-center gap-2 text-[12px] text-ink-3"><Spinner /> 正在提取文字…</span>}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2 px-1">
              <div>
                <h3 className="text-[17px] font-semibold">分成几个部分</h3>
                <p className="mt-1 text-[13px] text-ink-3">
                  {d.sectioning ? "AI 正在按引入、每个物品、结论切分…" : `共 ${d.sections.length} 个部分。访客会从这里选择想先听哪一段，标题和内容都可以改。`}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="btn-ghost px-2.5 py-1.5 text-[13px]" onClick={() => d.autoSection()} disabled={d.sectioning}>
                  <IconSparkle size={15} /> 重新分段
                </button>
                <button type="button" className="btn-ghost px-2.5 py-1.5 text-[13px]" onClick={d.addSection} disabled={d.sectioning}>
                  <IconPlus size={15} /> 添加
                </button>
              </div>
            </div>
            {d.sectioning ? (
              <div className="stagger space-y-3">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="card space-y-2.5 p-4" style={{ ["--i" as string]: i }}>
                    <div className="skeleton h-9 w-2/3" />
                    <div className="skeleton h-8 w-1/2" />
                    <div className="skeleton h-16" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {d.sections.length === 0 && (
                  <div className="card px-5 py-8 text-center">
                    <p className="text-[14px] text-ink-2">还没有分段</p>
                    <p className="mt-1 text-[12px] text-ink-3">点「重新分段」让 AI 来切，或手动添加。</p>
                  </div>
                )}
                <SectionList sections={d.sections} onUpdate={d.updateSection} onRemove={d.removeSection} onMove={d.moveSection} compact />
              </>
            )}
          </section>
        )}

        {step === 4 && (
          <section className="space-y-4">
            <div className="card divide-y divide-line">
              <div className="p-5">
                <h3 className="text-[17px] font-semibold">最后看一眼</h3>
                <p className="mt-1 text-[13px] text-ink-3">
                  {d.isEdit ? "重新提交后，页面会回到待审核，老师通过后再次上线。" : "提交后老师会审核；通过后你的二维码页面才会对访客开放。"}
                </p>
              </div>
              {(
                [
                  ["照片 · Photo", d.photoPreview ? "已上传" : "未上传（可稍后补）", 0, !!d.photoPreview],
                  ["姓名 · Name", d.name.trim() || "—", 1, !!d.name.trim()],
                  ["副标题 · Subtitle", d.subtitle.trim() || "未填写", 1, true],
                  ["讲稿 · Script", d.script.trim() ? `${d.script.trim().length} 字` : "—", 2, !!d.script.trim()],
                  ["部分 · Parts", d.sections.length ? d.sections.map((s, i) => `${pad2(i)} ${s.title || "未命名"}`).join(" · ") : "—", 3, d.sections.length > 0],
                ] as [string, string, number, boolean][]
              ).map(([label, value, target, ok], i) => (
                <div key={label} className="flex items-start gap-3 px-5 py-3.5 animate-rise" style={{ animationDelay: `${80 + i * 50}ms` }}>
                  <span className={`dot mt-2 ${ok ? "bg-success" : "bg-line-strong"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-ink-3">{label}</p>
                    <p className="truncate text-[14px] text-ink">{value}</p>
                  </div>
                  <button type="button" onClick={() => go(target)} className="btn-ghost -mr-2 px-2 py-1 text-[12px]">
                    <IconEdit size={13} /> 修改
                  </button>
                </div>
              ))}
            </div>
            <div className="lg:hidden animate-rise" style={{ animationDelay: "320ms" }}>
              <DraftPreview draft={d.draft} title="访客会看到 · Preview" />
            </div>
            <p className="px-1 text-[12px] leading-relaxed text-ink-3">
              提交成功后会得到一个专属修改链接，请务必保存。 / You’ll get a private link to edit later — keep it safe.
            </p>
          </section>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="sticky bottom-0 z-10 -mx-1 mt-5 border-t border-line bg-bg/85 px-1 py-3 backdrop-blur">
        <div className="flex gap-2">
          {step === 0 ? (
            <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => go(step - 1)} disabled={d.sectioning || d.saving}>
              <IconArrowLeft size={15} /> 上一步
            </button>
          )}
          {step < LAST ? (
            <button type="button" className="btn-primary flex-1" onClick={() => go(step + 1)} disabled={d.sectioning || d.parsing}>
              {d.sectioning ? <Spinner light /> : null}
              {d.sectioning ? "AI 分段中…" : step === 0 && !d.photoPreview ? "先跳过，下一步" : "下一步"}
              {!d.sectioning && <IconArrowRight size={15} />}
            </button>
          ) : (
            <button type="button" className="btn-primary flex-1" onClick={submit} disabled={d.saving}>
              {d.saving ? <Spinner light /> : <IconCheck size={15} />}
              {d.saving ? "提交中…" : d.isEdit ? "重新提交审核 · Resubmit" : "提交审核 · Submit"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
