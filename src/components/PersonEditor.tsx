"use client";

import { useEffect, useRef } from "react";
import type { Person } from "@/lib/types";
import { adminApi, type EditorApi } from "@/lib/editor-api";
import { LoadingOverlay, Spinner } from "./Loading";
import type { Draft } from "./DraftPreview";
import SectionList from "./SectionList";
import { PHOTO_ACCEPT, usePersonDraft } from "./usePersonDraft";
import {
  IconArrowLeft,
  IconBolt,
  IconChevronDown,
  IconClose,
  IconFilm,
  IconImage,
  IconPlus,
  IconSparkle,
  IconUpload,
  IconWarning,
} from "./icons";

const LANGUAGES: { value: Person["language"]; label: string }[] = [
  { value: "auto", label: "跟随提问语言 · Auto" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "bilingual", label: "中英双语 · Bilingual" },
];

function SectionCard({ n, title, sub, children }: { n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-[11px] text-accent">{n}</span>
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {sub && <span className="text-[12px] text-ink-3">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/** Single-page admin editor: everything visible at once, plus the
 *  admin-only generation tools (cartoon, loop video, pre-generated answers). */
export default function PersonEditor({
  person,
  onSaved,
  onCancel,
  onDraftChange,
  api = adminApi,
}: {
  person: Person | null;
  onSaved: (p: Person) => void;
  onCancel: () => void;
  /** Live draft for a side-by-side preview. */
  onDraftChange?: (d: Draft) => void;
  api?: EditorApi;
}) {
  const d = usePersonDraft({ person, api, admin: true });
  const fileRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (d.error) errorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [d.error]);

  useEffect(() => {
    onDraftChange?.(d.draft);
  }, [d.draft, onDraftChange]);

  async function save() {
    const saved = await d.save();
    if (saved) onSaved(saved);
  }

  const genders: { v: "" | "male" | "female"; t: string }[] = [
    { v: "", t: "默认 · Default" },
    { v: "male", t: "男声 · Male" },
    { v: "female", t: "女声 · Female" },
  ];

  const busy = d.sectioning || d.saving || d.parsing || d.cartooning || d.loopGenerating || d.bulkPregenerating;

  return (
    <div className="relative space-y-4">
      {busy && (
        <LoadingOverlay
          label={
            d.sectioning
              ? "AI 正在智能分段…"
              : d.cartooning
                ? "正在生成卡通形象…"
                : d.loopGenerating
                  ? "正在生成动态视频…"
                  : d.bulkPregenerating
                    ? "正在为所有部分预生成讲解…"
                    : d.saving
                      ? "正在保存…"
                      : "正在解析文件…"
          }
          sub={
            d.sectioning
              ? "把讲稿分成几个部分，请稍候"
              : d.cartooning
                ? "用照片生成卡通，约 20–40 秒"
                : d.loopGenerating
                  ? "生成说话动作循环视频，约 30–90 秒"
                  : d.bulkPregenerating
                    ? "让访客选这些部分时能立刻播放，不用等 AI"
                    : d.saving
                      ? "上传照片并保存"
                      : "从 PDF / Word 提取文字"
          }
        />
      )}

      <div className="flex items-center justify-between">
        <button type="button" onClick={onCancel} className="btn-ghost -ml-2 px-2">
          <IconArrowLeft size={16} /> 返回
        </button>
        <div className="text-right">
          <h2 className="font-display text-[20px] font-semibold leading-tight tracking-[-0.01em]">{d.isEdit ? "编辑同学" : "新增同学"}</h2>
          <p className="eyebrow">{d.isEdit ? "Edit student" : "New student"}</p>
        </div>
      </div>

      {d.error && (
        <div ref={errorRef} className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-[13px] text-danger animate-rise">
          <IconWarning size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">{d.error}</p>
          <button type="button" onClick={() => d.setError("")} className="shrink-0 opacity-70 hover:opacity-100" aria-label="关闭">
            <IconClose size={16} />
          </button>
        </div>
      )}

      {/* 01 · Photo + generated assets */}
      <SectionCard n="01" title="大头照" sub="Photo">
        <div className="flex items-center gap-4">
          <div className="relative h-[88px] w-[88px] shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2">
            {d.photoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.photoPreview} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-ink-4"><IconImage size={22} /></div>
            )}
          </div>
          <div className="min-w-0">
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
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>
              <IconUpload size={16} /> {d.photoPreview ? "更换照片" : "上传照片"}
            </button>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">正脸、清晰、JPG / PNG / WebP、≤8MB</p>
          </div>
        </div>

        <div className="mt-5 divide-y divide-line border-t border-line">
          <div className="flex items-center gap-4 py-4">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
              {d.cartoonUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.cartoonUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-ink-4"><IconSparkle size={18} /></div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">卡通形象 · Cartoon</p>
              <p className="text-[12px] leading-relaxed text-ink-3">用本人照片生成轻卡通（还认得出是谁），用于访客端显示和数字人说话。</p>
            </div>
            {d.isEdit ? (
              <button type="button" className="btn-secondary shrink-0" onClick={d.generateCartoon} disabled={d.cartooning}>
                {d.cartoonUrl ? "重新生成" : "生成"}
              </button>
            ) : (
              <span className="shrink-0 text-[12px] text-ink-4">先保存</span>
            )}
          </div>
          <div className="flex items-center gap-4 py-4">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
              {d.loopVideoUrl ? (
                <video src={d.loopVideoUrl} muted loop autoPlay playsInline className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-ink-4"><IconFilm size={18} /></div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">动态视频 · Talking loop <span className="badge-muted ml-1">推荐</span></p>
              <p className="text-[12px] leading-relaxed text-ink-3">几秒的说话状态循环视频，只生成一次；访客提问时语音配它播放，秒回。建议先生成卡通。</p>
            </div>
            {d.isEdit ? (
              <button type="button" className="btn-secondary shrink-0" onClick={d.generateLoopVideo} disabled={d.loopGenerating}>
                {d.loopVideoUrl ? "重新生成" : "生成"}
              </button>
            ) : (
              <span className="shrink-0 text-[12px] text-ink-4">先保存</span>
            )}
          </div>
        </div>
      </SectionCard>

      {/* 02 · Basics */}
      <SectionCard n="02" title="基本信息" sub="Basics">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pe-name">姓名 · Name</label>
            <input id="pe-name" className="input" value={d.name} onChange={(e) => d.setName(e.target.value)} placeholder="例如：李雷 / Li Lei" maxLength={60} />
          </div>
          <div>
            <label className="label" htmlFor="pe-sub">副标题 · Subtitle <span className="text-ink-4">可选</span></label>
            <input id="pe-sub" className="input" value={d.subtitle} onChange={(e) => d.setSubtitle(e.target.value)} placeholder="例如：Why do we seek knowledge?" maxLength={140} />
          </div>
          <div>
            <span className="label">声音 · Voice</span>
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
            <label className="label" htmlFor="pe-lang">回答语言 · Answer language</label>
            <div className="relative">
              <select id="pe-lang" className="input appearance-none pr-9" value={d.language} onChange={(e) => d.setLanguage(e.target.value as Person["language"])}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
              <IconChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* 03 · Script */}
      <SectionCard n="03" title="讲稿" sub="Script">
        <div className="mb-2 flex items-center justify-end">
          <label className="btn-ghost cursor-pointer px-2 py-1 text-[13px]">
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
          className="input min-h-[180px] resize-y leading-relaxed"
          value={d.script}
          onChange={(e) => d.setScript(e.target.value)}
          placeholder="直接粘贴讲稿文字，或上传文件自动提取…"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] leading-relaxed text-ink-3">AI 会把讲稿分成几个“部分”，访客可以选择想先听哪一部分。分段后可手动微调。</p>
          <button type="button" className="btn-primary shrink-0" onClick={d.autoSection} disabled={d.sectioning}>
            {d.sectioning ? <Spinner light /> : <IconSparkle size={16} />}
            AI 智能分段
          </button>
        </div>
      </SectionCard>

      {/* 04 · Parts */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[11px] text-accent">04</span>
            <h3 className="text-[15px] font-semibold">部分</h3>
            <span className="text-[12px] text-ink-3">Parts · {d.sections.length}</span>
          </div>
          <div className="flex items-center gap-1">
            {d.isEdit && d.sections.length > 0 && (
              <button type="button" className="btn-ghost px-2.5 py-1.5 text-[13px]" onClick={() => d.pregenerate()} disabled={d.bulkPregenerating}>
                <IconBolt size={15} /> 预生成全部
              </button>
            )}
            <button type="button" className="btn-ghost px-2.5 py-1.5 text-[13px]" onClick={d.addSection}>
              <IconPlus size={15} /> 添加
            </button>
          </div>
        </div>
        {d.isEdit && d.sections.length > 0 && (
          <p className="px-1 text-[12px] leading-relaxed text-ink-3">预生成：提前让 AI 写好每部分的讲解，访客选中时立刻播放。追问仍然是现场实时回答。</p>
        )}
        {d.sections.length === 0 && (
          <div className="card px-5 py-8 text-center">
            <p className="text-[14px] text-ink-2">还没有分段</p>
            <p className="mt-1 text-[12px] text-ink-3">先点「AI 智能分段」，或手动添加。</p>
          </div>
        )}
        <SectionList
          sections={d.sections}
          onUpdate={d.updateSection}
          onRemove={d.removeSection}
          onMove={d.moveSection}
          admin={
            d.isEdit
              ? {
                  pregenerate: (id) => d.pregenerate(id),
                  pregenerating: d.pregenerating,
                  bulkPregenerating: d.bulkPregenerating,
                  answersOpen: d.answersOpen,
                  toggleAnswersOpen: d.toggleAnswersOpen,
                  updateCachedAnswer: d.updateCachedAnswer,
                }
              : undefined
          }
        />
      </section>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 z-10 -mx-1 mt-2 border-t border-line bg-bg/85 px-1 py-3 backdrop-blur">
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onCancel}>取消</button>
          <button type="button" className="btn-primary flex-[2]" onClick={save} disabled={d.saving}>
            {d.saving ? <Spinner light /> : null}
            {d.saving ? "保存中…" : d.isEdit ? "保存修改" : "创建并生成二维码"}
          </button>
        </div>
      </div>
    </div>
  );
}
