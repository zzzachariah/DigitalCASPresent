"use client";

import { useRef, useState } from "react";
import type { Person, Section } from "@/lib/types";
import { readJson } from "@/lib/http";
import { LoadingOverlay, Spinner } from "./Loading";

const LANGUAGES: { value: Person["language"]; label: string }[] = [
  { value: "auto", label: "跟随提问语言 (Auto)" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "bilingual", label: "中英双语 (Bilingual)" },
];

function emptySection(): Section {
  return { id: Math.random().toString(36).slice(2, 10), title: "", hint: "", content: "" };
}

export default function PersonEditor({
  person,
  onSaved,
  onCancel,
}: {
  person: Person | null;
  onSaved: (p: Person) => void;
  onCancel: () => void;
}) {
  const isEdit = !!person;
  const [name, setName] = useState(person?.name ?? "");
  const [subtitle, setSubtitle] = useState(person?.subtitle ?? "");
  const [gender, setGender] = useState<"" | "male" | "female">(person?.gender ?? "");
  const [language, setLanguage] = useState<Person["language"]>(person?.language ?? "auto");
  const [script, setScript] = useState(person?.script ?? "");
  const [sections, setSections] = useState<Section[]>(person?.sections ?? []);
  const [photoUrl, setPhotoUrl] = useState<string | undefined>(person?.photoUrl);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(person?.photoUrl);

  const [cartoonUrl, setCartoonUrl] = useState<string | undefined>(person?.cartoonUrl);
  const [cartooning, setCartooning] = useState(false);

  const [parsing, setParsing] = useState(false);
  const [sectioning, setSectioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  function updateSection(id: string, patch: Partial<Section>) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
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
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/parse", { method: "POST", body: fd });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "解析失败");
      setScript(data.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setParsing(false);
    }
  }

  async function autoSection() {
    if (!script.trim()) {
      setError("请先粘贴或上传讲稿");
      return;
    }
    setError("");
    setSectioning(true);
    try {
      const res = await fetch("/api/admin/autosection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "分段失败");
      setSections(data.sections);
    } catch (e) {
      setError(e instanceof Error ? e.message : "分段失败");
    } finally {
      setSectioning(false);
    }
  }

  function onPickPhoto(file: File) {
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function generateCartoon() {
    if (!person) return;
    setError("");
    setCartooning(true);
    try {
      // Start the (async) render, then poll until the cartoon is ready.
      const startRes = await fetch(`/api/admin/people/${person.id}/cartoon`, { method: "POST" });
      const startData = await readJson(startRes);
      if (!startRes.ok) throw new Error(startData.error || "卡通发起失败");
      const taskId = startData.taskId as string;

      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 3000)); // ~4 min max
        const pRes = await fetch(
          `/api/admin/people/${person.id}/cartoon?taskId=${encodeURIComponent(taskId)}`
        );
        const pData = await readJson(pRes);
        if (!pRes.ok) throw new Error(pData.error || "卡通生成失败");
        if (pData.cartoonUrl) {
          setCartoonUrl(pData.cartoonUrl);
          return;
        }
        // else { pending: true } → keep polling
      }
      throw new Error("卡通生成超时,请重试");
    } catch (e) {
      setError(e instanceof Error ? e.message : "卡通生成失败");
    } finally {
      setCartooning(false);
    }
  }

  async function save() {
    setError("");
    if (!name.trim()) return setError("请填写姓名");
    if (!script.trim()) return setError("请提供讲稿");
    setSaving(true);
    try {
      const payload = { name, subtitle, gender, language, script, sections };
      const res = await fetch(
        isEdit ? `/api/admin/people/${person!.id}` : "/api/admin/people",
        {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "保存失败");
      let saved: Person = data.person;

      if (photoFile) {
        const fd = new FormData();
        fd.append("photo", photoFile);
        const pres = await fetch(`/api/admin/people/${saved.id}/photo`, {
          method: "POST",
          body: fd,
        });
        const pdata = await readJson(pres);
        if (pres.ok) saved = { ...saved, photoUrl: pdata.photoUrl };
        else throw new Error(pdata.error || "照片上传失败");
      }
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5 pb-28">
      {(sectioning || saving || parsing || cartooning) && (
        <LoadingOverlay
          label={
            sectioning
              ? "AI 正在智能分段…"
              : cartooning
                ? "正在生成卡通形象…"
                : saving
                  ? "正在保存…"
                  : "正在解析文件…"
          }
          sub={
            sectioning
              ? "把讲稿分成几个部分，请稍候"
              : cartooning
                ? "用照片生成卡通,约 20–40 秒"
                : saving
                  ? "上传照片并生成二维码"
                  : "从 PDF / Word 提取文字"
          }
        />
      )}

      <div className="flex items-center justify-between">
        <button onClick={onCancel} className="text-sm text-ink-mute hover:text-ink">
          ← 返回
        </button>
        <h2 className="text-base font-semibold">
          {isEdit ? "编辑同学" : "新增同学"}
        </h2>
        <span className="w-10" />
      </div>

      {/* Photo */}
      <section className="card p-5">
        <p className="label">大头照 · Photo</p>
        <div className="flex items-center gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-black/5">
            {photoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoPreview} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-2xl text-ink-mute">
                🙂
              </div>
            )}
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => e.target.files?.[0] && onPickPhoto(e.target.files[0])}
            />
            <button className="btn-soft" onClick={() => fileRef.current?.click()}>
              {photoPreview ? "更换照片" : "上传照片"}
            </button>
            <p className="mt-1 text-xs text-ink-mute">建议正脸、清晰、≤8MB</p>
          </div>
        </div>

        {/* Cartoon avatar (A2E) — needs the person saved with a photo first. */}
        <div className="mt-4 flex items-center gap-4 border-t border-black/5 pt-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-black/5">
            {cartoonUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cartoonUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-xl text-ink-mute">🎨</div>
            )}
          </div>
          <div>
            <p className="label">卡通形象 · Cartoon</p>
            {isEdit ? (
              <button className="btn-soft" onClick={generateCartoon} disabled={cartooning}>
                {cartooning ? "生成中…" : cartoonUrl ? "重新生成卡通" : "✨ 生成卡通形象"}
              </button>
            ) : (
              <p className="text-xs text-ink-mute">先保存这位同学,再回来生成卡通形象。</p>
            )}
            <p className="mt-1 text-xs text-ink-mute">
              用本人照片生成轻卡通(还认得出是谁),用于访客端显示和数字人说话。
            </p>
          </div>
        </div>
      </section>

      {/* Basics */}
      <section className="card space-y-4 p-5">
        <div>
          <label className="label">姓名 · Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：李雷 / Li Lei" />
        </div>
        <div>
          <label className="label">副标题 · Subtitle（可选）</label>
          <input
            className="input"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="例如：TOK Exhibition · Knowledge & Technology"
          />
        </div>
        <div>
          <label className="label">声音性别 · Voice（数字人音色）</label>
          <div className="flex gap-2">
            {[
              { v: "", t: "默认" },
              { v: "male", t: "男声" },
              { v: "female", t: "女声" },
            ].map((g) => (
              <button
                key={g.v}
                type="button"
                onClick={() => setGender(g.v as "" | "male" | "female")}
                className={`flex-1 rounded-2xl px-3 py-2.5 text-sm font-medium ring-1 transition ${
                  gender === g.v
                    ? "bg-brand-500 text-white ring-brand-500"
                    : "bg-white text-ink-soft ring-black/10 hover:bg-gray-50"
                }`}
              >
                {g.t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">回答语言 · Answer language</label>
          <select
            className="input appearance-none"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Person["language"])}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Script */}
      <section className="card space-y-3 p-5">
        <div className="flex items-center justify-between">
          <p className="label mb-0">讲稿 · Script</p>
          <label className="cursor-pointer text-sm text-brand-600 hover:underline">
            {parsing ? "解析中…" : "上传 pdf/word/txt"}
            <input
              type="file"
              accept=".txt,.pdf,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              hidden
              onChange={(e) => e.target.files?.[0] && onPickScriptFile(e.target.files[0])}
            />
          </label>
        </div>
        <textarea
          className="input min-h-[160px] resize-y leading-relaxed"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder="直接粘贴讲稿文字，或上传 PDF / Word / txt 自动提取…"
        />
        <button className="btn-primary w-full" onClick={autoSection} disabled={sectioning}>
          {sectioning ? (
            <>
              <Spinner light /> AI 分段中…
            </>
          ) : (
            "✨ AI 智能分段"
          )}
        </button>
        <p className="text-xs text-ink-mute">
          AI 会把讲稿分成几个“部分”，访客可以选择想先听哪一部分。分段后可手动微调。
        </p>
      </section>

      {/* Sections */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <p className="text-sm font-semibold text-ink-soft">
            部分 · Sections（{sections.length}）
          </p>
          <button
            className="text-sm text-brand-600 hover:underline"
            onClick={() => setSections((p) => [...p, emptySection()])}
          >
            + 添加
          </button>
        </div>
        {sections.length === 0 && (
          <div className="card p-5 text-center text-sm text-ink-mute">
            还没有分段。先点上面的「AI 智能分段」，或手动添加。
          </div>
        )}
        {sections.map((s, i) => (
          <div key={s.id} className="card space-y-2 p-4">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-50 text-xs font-medium text-brand-700">
                {i + 1}
              </span>
              <input
                className="input flex-1 py-2"
                value={s.title}
                onChange={(e) => updateSection(s.id, { title: e.target.value })}
                placeholder="标题，如：Object 1 · The Passport"
              />
              <button onClick={() => moveSection(s.id, -1)} className="px-1 text-ink-mute hover:text-ink" title="上移">↑</button>
              <button onClick={() => moveSection(s.id, 1)} className="px-1 text-ink-mute hover:text-ink" title="下移">↓</button>
              <button onClick={() => removeSection(s.id)} className="px-1 text-red-400 hover:text-red-600" title="删除">✕</button>
            </div>
            <input
              className="input py-2 text-sm"
              value={s.hint ?? ""}
              onChange={(e) => updateSection(s.id, { hint: e.target.value })}
              placeholder="一句话提示（可选）"
            />
            <textarea
              className="input min-h-[90px] resize-y text-sm leading-relaxed"
              value={s.content}
              onChange={(e) => updateSection(s.id, { content: e.target.value })}
              placeholder="这一部分对应的讲稿内容…"
            />
          </div>
        ))}
      </section>

      {error && <p className="px-1 text-sm text-red-500">{error}</p>}

      {/* Sticky save bar */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-black/5 bg-white/90 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-md gap-3">
          <button className="btn-ghost flex-1" onClick={onCancel}>
            取消
          </button>
          <button className="btn-primary flex-[2]" onClick={save} disabled={saving}>
            {saving ? (
              <>
                <Spinner light /> 保存中…
              </>
            ) : isEdit ? (
              "保存修改"
            ) : (
              "创建并生成二维码"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
