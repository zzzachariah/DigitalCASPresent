"use client";

import { useEffect, useRef, useState } from "react";
import type { Person, Section } from "@/lib/types";
import { readJson } from "@/lib/http";
import { adminApi, type EditorApi, type SavePayload } from "@/lib/editor-api";
import { pad2 } from "@/lib/format";
import { LoadingOverlay, Spinner } from "./Loading";
import type { Draft } from "./DraftPreview";
import {
  IconArrowLeft,
  IconBolt,
  IconChevronDown,
  IconClose,
  IconDown,
  IconFilm,
  IconImage,
  IconPlus,
  IconSparkle,
  IconUp,
  IconUpload,
  IconWarning,
} from "./icons";

const LANGUAGES: { value: Person["language"]; label: string }[] = [
  { value: "auto", label: "跟随提问语言 · Auto" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "bilingual", label: "中英双语 · Bilingual" },
];

// Must match the server's magic-byte whitelist (lib/image.ts). Listing the
// types explicitly (not image/*) also makes iOS convert HEIC → JPEG on pick.
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHOTO_MAX = 8 * 1024 * 1024;

export type EditorMode = "admin" | "student";

function emptySection(): Section {
  return { id: Math.random().toString(36).slice(2, 10), title: "", hint: "", content: "" };
}

/** Poll an async generation task (cartoon / loop video) until the server
 *  returns `doneKey`, reports an error, or we give up (~4 min). */
async function pollTask(
  url: string,
  doneKey: "cartoonUrl" | "loopVideoUrl",
  everyMs = 3000,
  maxTries = 80
): Promise<string> {
  let lastStatus = "";
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, everyMs));
    const res = await fetch(url);
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "生成失败");
    if (typeof data[doneKey] === "string" && data[doneKey]) return data[doneKey];
    if (data.status) lastStatus = String(data.status);
  }
  throw new Error(`生成超时，请重试${lastStatus ? `（最后状态: ${lastStatus}）` : ""}`);
}

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

export default function PersonEditor({
  person,
  onSaved,
  onCancel,
  onDraftChange,
  mode = "admin",
  api = adminApi,
}: {
  person: Person | null;
  onSaved: (p: Person) => void;
  onCancel: () => void;
  /** Live draft for a side-by-side preview. */
  onDraftChange?: (d: Draft) => void;
  /** "student": the self-submission form — no admin-only generation tools. */
  mode?: EditorMode;
  api?: EditorApi;
}) {
  const admin = mode === "admin";
  // Once a brand-new record has been created, further saves in this editor
  // UPDATE it — so a failed photo upload can be retried without creating a
  // duplicate person.
  const [created, setCreated] = useState<Person | null>(null);
  const existing = person ?? created;
  const isEdit = !!existing;

  const [name, setName] = useState(person?.name ?? "");
  const [subtitle, setSubtitle] = useState(person?.subtitle ?? "");
  const [gender, setGender] = useState<"" | "male" | "female">(person?.gender ?? "");
  const [language, setLanguage] = useState<Person["language"]>(person?.language ?? "auto");
  const [script, setScript] = useState(person?.script ?? "");
  const [sections, setSections] = useState<Section[]>(person?.sections ?? []);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(person?.photoUrl);

  const [cartoonUrl, setCartoonUrl] = useState<string | undefined>(person?.cartoonUrl);
  const [cartooning, setCartooning] = useState(false);
  const [loopVideoUrl, setLoopVideoUrl] = useState<string | undefined>(person?.loopVideoUrl);
  const [loopGenerating, setLoopGenerating] = useState(false);

  const [pregenerating, setPregenerating] = useState<Set<string>>(new Set());
  const [bulkPregenerating, setBulkPregenerating] = useState(false);
  const [answersOpen, setAnswersOpen] = useState<Set<string>>(new Set());

  const [parsing, setParsing] = useState(false);
  const [sectioning, setSectioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [error]);

  useEffect(() => {
    onDraftChange?.({ name, subtitle, photo: photoPreview, sections });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, subtitle, photoPreview, sections]);

  function fail(e: unknown, fallback: string) {
    setError(e instanceof Error ? e.message : fallback);
  }

  function updateSection(id: string, patch: Partial<Section>) {
    // Editing the title/content invalidates any pre-generated answer.
    const invalidatesCache = "title" in patch || "content" in patch;
    setSections((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, ...patch, cachedAnswers: invalidatesCache ? undefined : s.cachedAnswers } : s
      )
    );
  }
  function updateCachedAnswer(id: string, key: "en" | "zh" | "bilingual", text: string) {
    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, cachedAnswers: { ...(s.cachedAnswers || {}), [key]: text } } : s))
    );
  }
  function toggleAnswersOpen(id: string) {
    setAnswersOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function removeSection(id: string) {
    setSections((prev) => prev.filter((s) => s.id !== id));
  }
  function moveSection(id: string, dir: -1 | 1) {
    setSections((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function onPickScriptFile(file: File) {
    setError("");
    setParsing(true);
    try {
      setScript(await api.parse(file));
    } catch (e) {
      fail(e, "解析失败");
    } finally {
      setParsing(false);
    }
  }

  async function autoSection() {
    if (!script.trim()) {
      setError("请先粘贴或上传讲稿 / Paste or upload your script first");
      return;
    }
    setError("");
    setSectioning(true);
    try {
      setSections(await api.autosection(script));
    } catch (e) {
      fail(e, "分段失败");
    } finally {
      setSectioning(false);
    }
  }

  function onPickPhoto(file: File) {
    if (!PHOTO_TYPES.includes(file.type)) {
      setError("只支持 JPG / PNG / WebP 图片 / Only JPG, PNG or WebP images");
      return;
    }
    if (file.size > PHOTO_MAX) {
      setError("照片过大（≤8MB）/ Photo too large (max 8MB)");
      return;
    }
    setError("");
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function generateCartoon() {
    if (!existing) return;
    setError("");
    setCartooning(true);
    try {
      const startRes = await fetch(`/api/admin/people/${existing.id}/cartoon`, { method: "POST" });
      const startData = await readJson(startRes);
      if (!startRes.ok) throw new Error(startData.error || "卡通发起失败");
      const url = await pollTask(
        `/api/admin/people/${existing.id}/cartoon?taskId=${encodeURIComponent(startData.taskId)}`,
        "cartoonUrl"
      );
      setCartoonUrl(url);
    } catch (e) {
      fail(e, "卡通生成失败");
    } finally {
      setCartooning(false);
    }
  }

  async function generateLoopVideo() {
    if (!existing) return;
    setError("");
    setLoopGenerating(true);
    try {
      const startRes = await fetch(`/api/admin/people/${existing.id}/loop-video`, { method: "POST" });
      const startData = await readJson(startRes);
      if (!startRes.ok) throw new Error(startData.error || "循环视频发起失败");
      const url = await pollTask(
        `/api/admin/people/${existing.id}/loop-video?taskId=${encodeURIComponent(startData.taskId)}`,
        "loopVideoUrl"
      );
      setLoopVideoUrl(url);
    } catch (e) {
      fail(e, "循环视频生成失败");
    } finally {
      setLoopGenerating(false);
    }
  }

  function mergeCachedAnswers(updatedSections: Section[]) {
    setSections((prev) =>
      prev.map((s) => {
        const updated = updatedSections.find((u) => u.id === s.id);
        return updated ? { ...s, cachedAnswers: updated.cachedAnswers } : s;
      })
    );
  }

  async function pregenerate(sectionId?: string) {
    if (!existing) return;
    setError("");
    if (sectionId) setPregenerating((prev) => new Set(prev).add(sectionId));
    else setBulkPregenerating(true);
    try {
      const res = await fetch(`/api/admin/people/${existing.id}/pregenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sectionId ? { sectionId } : {}),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "预生成失败");
      mergeCachedAnswers(data.sections as Section[]);
    } catch (e) {
      fail(e, "预生成失败");
    } finally {
      if (sectionId) {
        setPregenerating((prev) => {
          const next = new Set(prev);
          next.delete(sectionId);
          return next;
        });
      } else {
        setBulkPregenerating(false);
      }
    }
  }

  async function save() {
    setError("");
    if (!name.trim()) return setError("请填写姓名 / Name is required");
    if (!script.trim()) return setError("请提供讲稿 / Script is required");
    setSaving(true);
    try {
      const payload: SavePayload = { name, subtitle, gender, language, script, sections };
      if (admin) {
        if (cartoonUrl) payload.cartoonUrl = cartoonUrl;
        if (loopVideoUrl) payload.loopVideoUrl = loopVideoUrl;
      }
      let saved: Person = existing ? await api.update(existing.id, payload) : await api.create(payload);
      if (!existing) setCreated(saved);
      if (photoFile) {
        const photoUrl = await api.uploadPhoto(saved.id, photoFile);
        saved = { ...saved, photoUrl };
        setPhotoFile(null);
      }
      onSaved(saved);
    } catch (e) {
      fail(e, "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const heading = admin ? (isEdit ? "编辑同学" : "新增同学") : isEdit ? "修改我的提交" : "提交我的讲稿";
  const headingEn = admin ? (isEdit ? "Edit student" : "New student") : isEdit ? "Edit submission" : "Submit my talk";
  const saveLabel = admin
    ? isEdit
      ? "保存修改"
      : "创建并生成二维码"
    : isEdit
      ? "重新提交审核 · Resubmit"
      : "提交审核 · Submit";

  const genders: { v: "" | "male" | "female"; t: string }[] = [
    { v: "", t: "默认 · Default" },
    { v: "male", t: "男声 · Male" },
    { v: "female", t: "女声 · Female" },
  ];

  return (
    <div className="relative space-y-4">
      {(sectioning || saving || parsing || cartooning || loopGenerating || bulkPregenerating) && (
        <LoadingOverlay
          label={
            sectioning
              ? "AI 正在智能分段…"
              : cartooning
                ? "正在生成卡通形象…"
                : loopGenerating
                  ? "正在生成动态视频…"
                  : bulkPregenerating
                    ? "正在为所有部分预生成讲解…"
                    : saving
                      ? admin
                        ? "正在保存…"
                        : "正在提交…"
                      : "正在解析文件…"
          }
          sub={
            sectioning
              ? "把讲稿分成几个部分，请稍候 · Splitting your script"
              : cartooning
                ? "用照片生成卡通，约 20–40 秒"
                : loopGenerating
                  ? "生成说话动作循环视频，约 30–90 秒"
                  : bulkPregenerating
                    ? "让访客选这些部分时能立刻播放，不用等 AI"
                    : saving
                      ? "上传照片并保存 · Uploading photo"
                      : "从 PDF / Word 提取文字 · Extracting text"
          }
        />
      )}

      <div className="flex items-center justify-between">
        <button type="button" onClick={onCancel} className="btn-ghost -ml-2 px-2">
          <IconArrowLeft size={16} /> 返回
        </button>
        <div className="text-right">
          <h2 className="font-display text-[20px] font-semibold leading-tight tracking-[-0.01em]">{heading}</h2>
          <p className="eyebrow">{headingEn}</p>
        </div>
      </div>

      {error && (
        <div ref={errorRef} className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-[13px] text-danger animate-rise">
          <IconWarning size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <button type="button" onClick={() => setError("")} className="shrink-0 opacity-70 hover:opacity-100" aria-label="关闭">
            <IconClose size={16} />
          </button>
        </div>
      )}

      {/* 01 · Photo (+ admin-only generated assets) */}
      <SectionCard n="01" title="大头照" sub="Photo">
        <div className="flex items-center gap-4">
          <div className="relative h-[88px] w-[88px] shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2">
            {photoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoPreview} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-ink-4">
                <IconImage size={22} />
              </div>
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
                if (f) onPickPhoto(f);
                e.target.value = "";
              }}
            />
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>
              <IconUpload size={16} /> {photoPreview ? "更换照片" : "上传照片"}
            </button>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">正脸、清晰、JPG / PNG / WebP、≤8MB · Clear, front-facing photo</p>
            {!admin && isEdit && <p className="text-[12px] text-ink-3">更换照片后，老师需要重新生成卡通形象。</p>}
          </div>
        </div>

        {admin && (
          <div className="mt-5 divide-y divide-line border-t border-line">
            <div className="flex items-center gap-4 py-4">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
                {cartoonUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cartoonUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-ink-4"><IconSparkle size={18} /></div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">卡通形象 · Cartoon</p>
                <p className="text-[12px] leading-relaxed text-ink-3">用本人照片生成轻卡通（还认得出是谁），用于访客端显示和数字人说话。</p>
              </div>
              {isEdit ? (
                <button type="button" className="btn-secondary shrink-0" onClick={generateCartoon} disabled={cartooning}>
                  {cartoonUrl ? "重新生成" : "生成"}
                </button>
              ) : (
                <span className="shrink-0 text-[12px] text-ink-4">先保存</span>
              )}
            </div>
            <div className="flex items-center gap-4 py-4">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
                {loopVideoUrl ? (
                  <video src={loopVideoUrl} muted loop autoPlay playsInline className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-ink-4"><IconFilm size={18} /></div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">动态视频 · Talking loop <span className="badge-muted ml-1">推荐</span></p>
                <p className="text-[12px] leading-relaxed text-ink-3">几秒的说话状态循环视频，只生成一次；访客提问时语音配它播放，秒回。建议先生成卡通。</p>
              </div>
              {isEdit ? (
                <button type="button" className="btn-secondary shrink-0" onClick={generateLoopVideo} disabled={loopGenerating}>
                  {loopVideoUrl ? "重新生成" : "生成"}
                </button>
              ) : (
                <span className="shrink-0 text-[12px] text-ink-4">先保存</span>
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* 02 · Basics */}
      <SectionCard n="02" title="基本信息" sub="Basics">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pe-name">姓名 · Name</label>
            <input id="pe-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：李雷 / Li Lei" maxLength={60} />
          </div>
          <div>
            <label className="label" htmlFor="pe-sub">副标题 · Subtitle <span className="text-ink-4">可选</span></label>
            <input id="pe-sub" className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="例如：Why do we seek knowledge?" maxLength={140} />
          </div>
          <div>
            <span className="label">声音 · Voice</span>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface-2 p-1">
              {genders.map((g) => (
                <button
                  key={g.v}
                  type="button"
                  onClick={() => setGender(g.v)}
                  className={`rounded-md px-2 py-2 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-200 ease-out ${
                    gender === g.v ? "bg-surface text-ink shadow-1" : "text-ink-3 hover:text-ink"
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
              <select id="pe-lang" className="input appearance-none pr-9" value={language} onChange={(e) => setLanguage(e.target.value as Person["language"])}>
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
            <IconUpload size={15} /> {parsing ? "解析中…" : "上传 PDF / Word / txt"}
            <input
              type="file"
              accept=".txt,.pdf,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickScriptFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <textarea
          className="input min-h-[180px] resize-y leading-relaxed"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder="直接粘贴讲稿文字，或上传文件自动提取… / Paste your talk, or upload a file"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] leading-relaxed text-ink-3">AI 会把讲稿分成几个“部分”，访客可以选择想先听哪一部分。分段后可手动微调。</p>
          <button type="button" className="btn-primary shrink-0" onClick={autoSection} disabled={sectioning}>
            {sectioning ? <Spinner light /> : <IconSparkle size={16} />}
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
            <span className="text-[12px] text-ink-3">Parts · {sections.length}</span>
          </div>
          <div className="flex items-center gap-1">
            {admin && isEdit && sections.length > 0 && (
              <button type="button" className="btn-ghost px-2.5 py-1.5 text-[13px]" onClick={() => pregenerate()} disabled={bulkPregenerating}>
                <IconBolt size={15} /> 预生成全部
              </button>
            )}
            <button type="button" className="btn-ghost px-2.5 py-1.5 text-[13px]" onClick={() => setSections((p) => [...p, emptySection()])}>
              <IconPlus size={15} /> 添加
            </button>
          </div>
        </div>
        {admin && isEdit && sections.length > 0 && (
          <p className="px-1 text-[12px] leading-relaxed text-ink-3">预生成：提前让 AI 写好每部分的讲解，访客选中时立刻播放。追问仍然是现场实时回答。</p>
        )}
        {sections.length === 0 && (
          <div className="card px-5 py-8 text-center">
            <p className="text-[14px] text-ink-2">还没有分段</p>
            <p className="mt-1 text-[12px] text-ink-3">先点「AI 智能分段」，或手动添加。 / Use “AI 智能分段” above, or add parts by hand.</p>
          </div>
        )}
        <div className="stagger space-y-3">
          {sections.map((s, i) => (
            <div key={s.id} className="card space-y-2.5 p-4" style={{ ["--i" as string]: i }}>
              <div className="flex items-center gap-2">
                <span className="w-6 shrink-0 font-mono text-[11px] text-ink-4">{pad2(i)}</span>
                <input
                  className="input flex-1 py-2"
                  value={s.title}
                  onChange={(e) => updateSection(s.id, { title: e.target.value })}
                  placeholder="标题，如：Object 1 · The Passport"
                  maxLength={80}
                />
                <button type="button" onClick={() => moveSection(s.id, -1)} className="btn-icon" title="上移" aria-label="上移"><IconUp size={16} /></button>
                <button type="button" onClick={() => moveSection(s.id, 1)} className="btn-icon" title="下移" aria-label="下移"><IconDown size={16} /></button>
                <button type="button" onClick={() => removeSection(s.id)} className="btn-icon hover:!bg-danger-soft hover:!text-danger" title="删除" aria-label="删除"><IconClose size={16} /></button>
              </div>
              <input
                className="input py-2 text-[13px]"
                value={s.hint ?? ""}
                onChange={(e) => updateSection(s.id, { hint: e.target.value })}
                placeholder="一句话提示（可选）· one-line teaser"
                maxLength={160}
              />
              <textarea
                className="input min-h-[96px] resize-y text-[13px] leading-relaxed"
                value={s.content}
                onChange={(e) => updateSection(s.id, { content: e.target.value })}
                placeholder="这一部分对应的讲稿内容… / the script for this part"
              />
              {admin && isEdit && (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => pregenerate(s.id)}
                    disabled={pregenerating.has(s.id) || bulkPregenerating}
                  >
                    {pregenerating.has(s.id) ? <Spinner /> : <IconBolt size={14} />}
                    {s.cachedAnswers && Object.keys(s.cachedAnswers).length > 0 ? "重新预生成" : "预生成讲解"}
                  </button>
                  {s.cachedAnswers && Object.keys(s.cachedAnswers).length > 0 && (
                    <>
                      <span className="badge-live">已生成 · {Object.keys(s.cachedAnswers).join(" / ")}</span>
                      <button type="button" className="chip" onClick={() => toggleAnswersOpen(s.id)}>
                        {answersOpen.has(s.id) ? "收起讲解" : "查看 / 编辑讲解"}
                      </button>
                    </>
                  )}
                </div>
              )}
              {admin && isEdit && answersOpen.has(s.id) && s.cachedAnswers && (
                <div className="space-y-3 rounded-lg bg-surface-2 p-3 animate-fade">
                  {(Object.entries(s.cachedAnswers) as ["en" | "zh" | "bilingual", string][]).map(([key, text]) => (
                    <div key={key}>
                      <p className="eyebrow mb-1.5">{key === "zh" ? "中文讲解" : key === "en" ? "English" : "双语 · Bilingual"}</p>
                      <textarea
                        className="input min-h-[110px] resize-y text-[13px] leading-relaxed"
                        value={text}
                        onChange={(e) => updateCachedAnswer(s.id, key, e.target.value)}
                      />
                    </div>
                  ))}
                  <p className="text-[12px] text-ink-3">改完后点底部「保存修改」生效；清空某段文字 = 该语言恢复为现场实时生成。</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {!admin && (
        <p className="px-1 text-[12px] leading-relaxed text-ink-3">
          提交后老师会审核；通过后你的二维码页面才会对访客开放。提交成功后会得到一个专属修改链接，请务必保存。
          <br />
          Your talk goes live after a teacher approves it. You’ll get a private link to edit it later — keep it safe.
        </p>
      )}

      {/* Sticky action bar */}
      <div className="sticky bottom-0 z-10 -mx-1 mt-2 border-t border-line bg-bg/85 px-1 py-3 backdrop-blur">
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onCancel}>取消</button>
          <button type="button" className="btn-primary flex-[2]" onClick={save} disabled={saving}>
            {saving ? <Spinner light /> : null}
            {saving ? (admin ? "保存中…" : "提交中…") : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
