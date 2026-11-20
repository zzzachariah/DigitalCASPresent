"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Person } from "@/lib/types";
import { adminReadinessForPerson as readinessForPerson, narrationLanguages, narrationLanguageLabels, prepareNarrationVariants, type NarrationOptions, type NarrationRun } from "@/lib/admin-narration";
import { adminMediaStatus, MEDIA_LOADING, MEDIA_UNAVAILABLE, photoStatusForPerson, speechStatusForPerson, preparationSummary, type AdminMediaHealth } from "@/lib/admin-media";
import { preparationEntries, narrationEntryKey, interruptPreparation, type PreparationEntry } from "@/lib/admin-preparation";
import { readNarrationResponse } from "@/lib/admin-narration-stream";
import { readJson } from "@/lib/http";
import { generateAsset } from "@/lib/editor-api";
import { pad2, timeAgo } from "@/lib/format";
import { useMediaQuery } from "@/lib/use-media-query";
import PersonEditor from "./PersonEditor";
import DraftPreview, { type Draft } from "./DraftPreview";
import QrModal from "./QrModal";
import { Spinner } from "./Loading";
import {
  IconBolt,
  IconCheck,
  IconClose,
  IconCopy,
  IconEdit,
  IconExternal,
  IconFilm,
  IconImage,
  IconSparkle,
  IconInbox,
  IconLink,
  IconLogout,
  IconPlus,
  IconPrint,
  IconQr,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUsers,
  IconWarning,
} from "./icons";

const QrBatchPanel = dynamic(() => import("./QrBatchPanel"), { ssr: false });

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; person: Person };
type Qr = { title: string; subtitle?: string; link: string; downloadName: string } | null;
type Filter = "all" | "pending" | "needs_work" | "ready" | "published";

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "")
  );
}

export default function AdminApp() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [media, setMedia] = useState<AdminMediaHealth>(MEDIA_LOADING);
  const healthRequest = useRef(0);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [qr, setQr] = useState<Qr>(null);
  const [qrPackOpen, setQrPackOpen] = useState(false);
  const [copied, setCopied] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pregenId, setPregenId] = useState<string | null>(null);
  // Long jobs per person ("卡通…", "视频…", "讲解 2/3…") so several students
  // can be processed at once while the list stays usable.
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [preparations, setPreparations] = useState<Record<string, { entries: PreparationEntry[]; summary: string }>>({});
  const [toast, setToast] = useState("");
  function notify(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2200);
  }
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", subtitle: "", sections: [] });
  // Detail renders once: as a static column on wide screens, else as a sheet.
  const wide = useMediaQuery("(min-width: 1280px)");

  async function loadHealth() {
    const requestId = ++healthRequest.current;
    setMedia(MEDIA_LOADING);
    try {
      const res = await fetch("/api/admin/health", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error("Health unavailable");
      const data = await readJson(res);
      if (healthRequest.current === requestId) setMedia(adminMediaStatus(data));
    } catch {
      if (healthRequest.current === requestId) setMedia(MEDIA_UNAVAILABLE);
    }
  }

  async function load() {
    // Health failure must not hide existing student records or media previews.
    void loadHealth();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/people", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "加载失败");
      setPeople(data.people ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败，请刷新重试");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the detail sheet.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelectedId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  async function remove(p: Person) {
    if (!confirm(`删除「${p.name}」？此操作不可撤销。`)) return;
    setBusyId(p.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/people/${p.id}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok || !data.ok) throw new Error(data.error || "删除失败");
      setPeople((list) => list.filter((x) => x.id !== p.id));
      if (selectedId === p.id) setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(p: Person, status: "approved" | "pending") {
    if (status === "approved") {
      const readiness = readinessForPerson(p);
      if (!readiness.publishable) {
        setSelectedId(p.id);
        setError(`发布前必须补齐：${readiness.blockers.map((item) => item.label).join("、")}`);
        return;
      }
      if (readiness.warnings.length && !confirm(`还有 ${readiness.warnings.map((item) => item.label).join("、")} 未完成。\n\n仍然发布？访客页面可以使用，但会采用静态或现场生成的备用方案。`)) return;
    }
    setBusyId(p.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/people/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "操作失败");
      setPeople((list) => list.map((x) => (x.id === p.id ? data.person : x)));
      notify(status === "approved" ? `已发布：${p.name}` : `已下线：${p.name}`);
      // Reviewing the queue: jump to the next pending student.
      if (status === "approved" && filter === "pending") {
        const nextPending = people.find((x) => x.id !== p.id && x.status === "pending");
        setSelectedId(nextPending ? nextPending.id : null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  }

  function setJob(id: string, label: string | null) {
    setJobs((j) => {
      const next = { ...j };
      if (label) next[id] = label;
      else delete next[id];
      return next;
    });
  }

  /** Cartoon / loop video straight from the detail panel. */
  async function generate(p: Person, kind: "cartoon" | "loop-video") {
    const photo = photoStatusForPerson(media, p.id);
    if (!photo.ready) {
      setError(photo.message);
      return;
    }
    setJob(p.id, kind === "cartoon" ? "卡通生成中，约 30 秒…" : "动态视频生成中，约 1 分钟…");
    setError("");
    try {
      const url = await generateAsset(p.id, kind);
      setPeople((list) => list.map((x) => (x.id === p.id ? { ...x, [kind === "cartoon" ? "cartoonUrl" : "loopVideoUrl"]: url } : x)));
      notify(kind === "cartoon" ? `卡通已生成：${p.name}` : `动态视频已生成：${p.name}`);
    } catch (e) {
      setError(`${p.name}：${e instanceof Error ? e.message : "生成失败"}`);
    } finally {
      setJob(p.id, null);
    }
  }

  function failureDetails(run: NarrationRun): string {
    if (!run.failures.length) return "";
    return `已确认完成 ${run.completed}/${run.total} 项讲解；全部 ${run.failures.length} 项未完成原因已列在准备进度中。`;
  }

  function updatePreparation(id: string, key: string, patch: Partial<PreparationEntry>) {
    setPreparations((runs) => {
      const run = runs[id];
      return run ? { ...runs, [id]: { ...run, entries: run.entries.map((entry) => entry.key === key ? { ...entry, ...patch } : entry) } } : runs;
    });
  }

  function finishPreparation(id: string, summary: string, interrupted = false) {
    setPreparations((runs) => {
      const run = runs[id];
      return run ? { ...runs, [id]: { entries: interrupted ? interruptPreparation(run.entries) : run.entries, summary } } : runs;
    });
  }

  async function runNarration(p: Person, textOnly: boolean, audioOnly = false, options: { offset?: number; total?: number; regenerateRejectedText?: boolean; variant?: NarrationOptions["variant"] } = {}) {
    const speech = speechStatusForPerson(media, p.id);
    const offset = options.offset ?? 0;
    const total = options.total ?? (options.variant ? 1 : p.sections.length * narrationLanguages(p.language).length);
    return prepareNarrationVariants(p, { textOnly, audioOnly, regenerateRejectedText: options.regenerateRejectedText, variant: options.variant }, {
      request: async (body) => {
        const res = await fetch(`/api/admin/people/${p.id}/pregenerate`, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(body),
        });
        return readNarrationResponse(res, body, (detail) => updatePreparation(p.id, narrationEntryKey(body.sectionId, body.language), { detail }));
      },
      recover: async () => {
        const res = await fetch(`/api/admin/people/${p.id}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const data = await res.json();
        return data.person?.id === p.id && Array.isArray(data.person.sections) ? data.person : null;
      },
      onProgress: ({ current, variant, retry }) => {
        const activity = textOnly ? "正在生成或核验文字讲解" : "正在检查讲解、内容审核及配音";
        setJob(p.id, `第 ${offset + current}/${total} 步 · ${variant.title} · ${narrationLanguageLabels[variant.language]}${retry ? " · 补做" : ""}`);
        updatePreparation(p.id, narrationEntryKey(variant.sectionId, variant.language), { status: "running", detail: activity });
      },
      onUpdate: (updated) => setPeople((list) => list.map((x) => x.id === p.id ? { ...x, sections: updated.sections } : x)),
      onResult: (outcome) => {
        const saved = `文字${outcome.textReady ? "已保存" : "待准备"}；语音${outcome.audioReady ? "已保存" : "待准备"}`;
        const revision = outcome.revisionAttempted ? outcome.completed ? "已修订一次并通过独立审核。" : "已尝试一次修订，本项仍未完成。" : "";
        const detail = revision + (outcome.completed
          ? textOnly ? `${saved}。${speech.ready ? "本次仅准备文字。" : speech.message}` : `${saved}，已核验完成。`
          : `${outcome.reason}。${saved}。`);
        updatePreparation(p.id, narrationEntryKey(outcome.sectionId, outcome.language), { status: outcome.completed ? "complete" : "failed", detail });
      },
    });
  }

  /** Prepare permitted assets; unavailable media never blocks text preparation. */
  async function prepareAll(p: Person) {
    setError("");
    let current = p;
    const textOnly = !speechStatusForPerson(media, p.id).ready;
    const entries = preparationEntries(p, { includeMedia: true, photo: photoStatusForPerson(media, p.id), textOnly, regenerateRejectedText: true });
    setPreparations((runs) => ({ ...runs, [p.id]: { entries, summary: "" } }));
    const mediaEntries = entries.filter((entry) => entry.kind !== "narration");
    setJob(p.id, "正在依次准备…");
    try {
      for (let i = 0; i < mediaEntries.length; i++) {
        const entry = mediaEntries[i];
        if (entry.status === "blocked" || entry.kind === "narration") continue;
        if (entry.kind === "loop-video" && !current.cartoonUrl) {
          updatePreparation(p.id, entry.key, { status: "blocked", detail: "卡通形象尚未准备完成，视频待处理；继续准备讲解。" });
          continue;
        }
        setJob(p.id, `第 ${i + 1}/${entries.length} 步 · ${entry.label}生成中…`);
        updatePreparation(p.id, entry.key, { status: "running", detail: "正在生成并保存，请稍候" });
        try {
          const url = await generateAsset(p.id, entry.kind);
          current = { ...current, [entry.kind === "cartoon" ? "cartoonUrl" : "loopVideoUrl"]: url };
          setPeople((list) => list.map((x) => (x.id === p.id ? { ...x, [entry.kind === "cartoon" ? "cartoonUrl" : "loopVideoUrl"]: url } : x)));
          updatePreparation(p.id, entry.key, { status: "complete", detail: "已生成并保存" });
        } catch {
          updatePreparation(p.id, entry.key, { status: "failed", detail: "形象生成未完成，请核对服务状态后重试；继续准备讲解。" });
        }
      }
      const run = await runNarration(current, textOnly, false, { offset: mediaEntries.length, total: entries.length, regenerateRejectedText: true });
      const summary = preparationSummary(run.person, run.failures.length, textOnly);
      finishPreparation(p.id, summary);
      notify(summary);
      const details = failureDetails(run);
      if (details) setError(`${p.name}：${details}`);
    } catch {
      const message = "准备过程未完成，请查看逐项进度并刷新核对已保存结果。";
      finishPreparation(p.id, message, true);
      setError(`${p.name}：${message}`);
    } finally {
      setJob(p.id, null);
    }
  }

  /** Pre-generate every part's explanation (+ audio when A2E is configured)
   *  without opening the editor. */
  async function pregenerateAll(p: Person, mode: "auto" | "audio" | "text" = "auto") {
    const audioOnly = mode === "audio";
    const speech = speechStatusForPerson(media, p.id);
    if (audioOnly && !speech.ready) { setError(speech.message); return; }
    const textOnly = mode === "text" || !speech.ready;
    setPregenId(p.id);
    setError("");
    setPreparations((runs) => ({ ...runs, [p.id]: { entries: preparationEntries(p, { includeMedia: false, photo: photoStatusForPerson(media, p.id), textOnly, audioOnly }), summary: "" } }));
    try {
      const run = await runNarration(p, textOnly, audioOnly);
      const summary = preparationSummary(run.person, run.failures.length, textOnly);
      finishPreparation(p.id, summary);
      notify(summary);
      const details = failureDetails(run);
      if (details) setError(`${p.name}：${details}`);
    } catch {
      const message = "准备过程未完成，请查看逐项进度并刷新核对已保存结果。";
      finishPreparation(p.id, message, true);
      setError(message);
    } finally {
      setPregenId(null);
      setJob(p.id, null);
    }
  }

  /** An explicit retry targets the failed source section/language and retains
   * its original mode; it never rechecks the other completed variants. */
  async function retryNarration(p: Person, entry: PreparationEntry) {
    const mode = entry.narration;
    if (!mode?.variant || entry.status !== "failed" || jobs[p.id] || pregenId === p.id) return;
    const speech = speechStatusForPerson(media, p.id);
    if (!mode.textOnly && !speech.ready) { setError(speech.message); return; }
    setPregenId(p.id);
    setError("");
    updatePreparation(p.id, entry.key, { status: "running", detail: "正在重试此项，其他已完成结果保持不变" });
    try {
      const run = await runNarration(p, mode.textOnly, mode.audioOnly, { regenerateRejectedText: mode.regenerateRejectedText, variant: mode.variant });
      setPreparations((runs) => {
        const saved = runs[p.id];
        if (!saved) return runs;
        const remaining = saved.entries.filter((step) => step.status !== "complete").length;
        const summary = remaining === 0 && readinessForPerson(run.person).ready ? `素材已就绪：${p.name}`
          : `本项${run.completed ? "已完成" : "尚未完成"}；${remaining ? `仍有 ${remaining} 个准备步骤未完成` : "其他素材状态见上方现场准备"}。`;
        return { ...runs, [p.id]: { ...saved, summary } };
      });
      notify(run.completed ? "本项已完成，其他结果已保留" : "本项尚未完成，请查看原因");
    } catch {
      updatePreparation(p.id, entry.key, { status: "failed", detail: "本项未完成，请刷新核对保存结果后重试" });
      setError("本项未完成，其他已完成结果已保留。");
    } finally {
      setPregenId(null);
      setJob(p.id, null);
    }
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

  // Merge a just-saved person into the list instead of re-fetching: the Blob
  // listing can lag a few seconds behind a write.
  function onSaved(saved: Person) {
    const isNew = view.kind === "new";
    setPeople((list) =>
      list.some((x) => x.id === saved.id)
        ? list.map((x) => (x.id === saved.id ? { ...x, ...saved } : x))
        : [...list, saved]
    );
    setSelectedId(saved.id);
    setView({ kind: "list" });
    if (isNew) notify(`已创建：${saved.name}。完成现场准备并发布后再统一发放二维码。`);
  }

  const base = baseUrl();
  const submitLink = `${base}/submit`;
  const pendingCount = people.filter((p) => p.status === "pending").length;
  const readyCount = people.filter((p) => readinessForPerson(p).ready).length;
  const needsWorkCount = people.filter((p) => !readinessForPerson(p).ready).length;
  const publishedCount = people.filter((p) => p.status !== "pending").length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => {
        if (filter === "pending") return p.status === "pending";
        if (filter === "published") return p.status !== "pending";
        if (filter === "ready") return readinessForPerson(p).ready;
        if (filter === "needs_work") return !readinessForPerson(p).ready;
        return true;
      })
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q) || (p.cohort || "").toLowerCase().includes(q) || (p.subtitle || "").toLowerCase().includes(q))
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.createdAt - b.createdAt);
  }, [people, filter, query]);

  const selected = people.find((p) => p.id === selectedId) || null;
  const selectedReadiness = selected ? readinessForPerson(selected) : null;
  const selectedPhoto = photoStatusForPerson(media, selected?.id);
  const selectedSpeech = speechStatusForPerson(media, selected?.id);

  function editLink(p: Person): string | null {
    return p.editToken ? `${base}/submit/${p.id}?token=${encodeURIComponent(p.editToken)}` : null;
  }
  function openQrFor(p: Person) {
    setQr({ title: p.name, subtitle: "专属二维码 · Scan to meet", link: `${base}/p/${p.slug}`, downloadName: `qr-${p.slug}` });
  }
  function openSubmitQr() {
    setQr({ title: "学生提交入口", subtitle: "扫码提交讲稿 · Scan to submit", link: submitLink, downloadName: "qr-submit" });
  }

  // ── Editor view ──
  if (view.kind !== "list") {
    return (
      <main className="mx-auto max-w-6xl px-5 py-6 lg:px-10 lg:py-8">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
          <div className="min-w-0">
            <PersonEditor
              person={view.kind === "edit" ? view.person : null}
              onSaved={onSaved}
              onCancel={() => setView({ kind: "list" })}
              onDraftChange={setDraft}
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

  const statusBadge = (p: Person) =>
    p.status === "pending" ? (
      <span className="badge-pending"><span className="dot bg-warning" />待审核</span>
    ) : (
      <span className="badge-live"><span className="dot bg-success" />已发布</span>
    );

  const avatar = (p: Person, size = "h-10 w-10") => (
    <div className={`${size} shrink-0 overflow-hidden rounded-full border border-line bg-surface-2`}>
      {p.cartoonUrl || p.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.cartoonUrl || p.photoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center font-display text-sm font-semibold text-ink-4">{p.name.slice(0, 1)}</div>
      )}
    </div>
  );

  const detail = selected && (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">已选中 · Selected</p>
          <h2 className="mt-1 truncate font-display text-[22px] font-semibold leading-tight tracking-[-0.01em]">{selected.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            {statusBadge(selected)}
            {selected.source === "student" && <span className="badge-student">学生提交</span>}
            {selected.cohort && <span>{selected.cohort}</span>}
            <span>{selected.submittedAt ? `提交于 ${timeAgo(selected.submittedAt)}` : `更新于 ${timeAgo(selected.updatedAt)}`}</span>
          </p>
        </div>
        <button type="button" className="btn-icon xl:hidden" onClick={() => setSelectedId(null)} aria-label="关闭"><IconClose size={18} /></button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "照片", url: selected.photoUrl, icon: <IconImage size={18} /> },
          { label: "卡通", url: selected.cartoonUrl, icon: <IconImage size={18} /> },
          { label: "动态视频", url: selected.loopVideoUrl, icon: <IconFilm size={18} />, video: true },
        ].map((tile) => (
          <div key={tile.label} className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-surface-2">
            {tile.url ? (
              tile.video ? (
                <video src={tile.url} muted loop autoPlay playsInline className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={tile.url} alt="" className="h-full w-full object-cover" />
              )
            ) : (
              <div className="grid h-full w-full place-items-center border border-dashed border-line-strong text-ink-4">{tile.icon}</div>
            )}
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-2 pb-1.5 pt-4 text-[10px] font-medium text-white">
              {tile.label}{tile.url ? "" : " · 无"}
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        {selected.status === "pending" ? (
          <button type="button" className="btn-primary w-full" onClick={() => setStatus(selected, "approved")} disabled={busyId === selected.id}>
            <IconCheck size={16} /> 通过并发布
          </button>
        ) : selected.source === "student" ? (
          <button type="button" className="btn-secondary w-full" onClick={() => setStatus(selected, "pending")} disabled={busyId === selected.id}>
            下线（改回待审核）
          </button>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <a href={`${base}/p/${selected.slug}`} target="_blank" rel="noreferrer" className="btn-secondary"><IconExternal size={15} /> 预览页面</a>
          <button type="button" className="btn-secondary" onClick={() => openQrFor(selected)} disabled={selected.status === "pending"} title={selected.status === "pending" ? "发布后才可发放访客二维码" : "查看访客二维码"}><IconQr size={15} /> 二维码</button>
          <button type="button" className="btn-secondary" onClick={() => setView({ kind: "edit", person: selected })}><IconEdit size={15} /> 编辑</button>
          {editLink(selected) ? (
            <button type="button" className="btn-secondary" onClick={() => copy(editLink(selected)!, selected.id)}>
              {copied === selected.id ? <IconCheck size={15} /> : <IconLink size={15} />} {copied === selected.id ? "已复制" : "复制修改链接"}
            </button>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => copy(`${base}/p/${selected.slug}`, selected.id)}>
              {copied === selected.id ? <IconCheck size={15} /> : <IconCopy size={15} />} {copied === selected.id ? "已复制" : "复制链接"}
            </button>
          )}
        </div>
        {editLink(selected) && <p className="text-[11px] leading-relaxed text-ink-3">修改链接是私密的；同学需要补资料时，由老师重新发给本人。</p>}
      </div>

      {selectedReadiness && (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="eyebrow">现场准备 · Readiness</span>
              <p className="mt-1 text-[13px] font-medium text-ink-2">
                {selectedReadiness.ready ? "全部就绪" : `${selectedReadiness.done}/${selectedReadiness.total} 项完成`}
              </p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${selectedReadiness.ready ? "bg-success-soft text-success" : selectedReadiness.publishable ? "bg-warning-soft text-warning-ink" : "bg-danger-soft text-danger"}`}>
              {selectedReadiness.ready ? "可发放" : selectedReadiness.publishable ? "可备用发布" : "不可发布"}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={`h-full rounded-full transition-[width] ${selectedReadiness.ready ? "bg-success" : selectedReadiness.publishable ? "bg-warning" : "bg-danger"}`} style={{ width: `${selectedReadiness.percent}%` }} />
          </div>
          <ul className="mt-3 grid gap-1.5">
            {selectedReadiness.items.map((item) => (
              <li key={item.key} className="flex items-start gap-2 text-[12px]">
                <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${item.ready ? "bg-success-soft text-success" : item.required ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning-ink"}`}>
                  {item.ready ? <IconCheck size={11} /> : <IconWarning size={10} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink-2">{item.label}</span>
                  <span className="ml-1 text-ink-3">· {item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Assets: what the digital human needs before the event */}
      <div className="rounded-lg border border-line bg-surface-2/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="eyebrow">素材 · Assets</span>
          {jobs[selected.id] && (
            <span role="status" className="flex min-w-0 items-center gap-1.5 text-[12px] text-accent"><Spinner /> {jobs[selected.id]}</span>
          )}
        </div>
        <button
          type="button"
          className="btn-primary mt-2 w-full"
          onClick={() => prepareAll(selected)}
          disabled={!!jobs[selected.id] || pregenId === selected.id || selected.sections.length === 0}
          title={selectedPhoto.ready ? (selectedSpeech.ready ? "依次准备形象、视频和全部目标语言的讲解与语音，已有素材会复用" : "仅生成卡通、视频和文字讲解；配音尚未启用") : (selectedSpeech.ready ? "形象处理暂不可用；可准备讲解和配音" : "形象处理暂不可用；可先准备文字讲解")}
        >
          <IconSparkle size={15} /> {selectedPhoto.ready || selectedSpeech.ready ? "一键准备素材" : "一键准备文字"}
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">一键准备会保留通过审核的讲解；仅因依据或保密问题未通过时，尝试一次修订并重新独立审核。审核服务故障不会触发修订。“仅补语音”始终不改文字。</p>
        {!selectedPhoto.ready && <p role="status" className="mt-2 text-[12px] leading-relaxed text-ink-3">{selectedPhoto.message}</p>}
        {!selectedSpeech.ready && <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{selectedSpeech.message}</p>}
        <a href="/admin/service-check" className="mt-2 inline-block text-[12px] text-accent underline underline-offset-2">检查讲解服务</a>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button type="button" className="btn-secondary px-2 text-[12px]" onClick={() => generate(selected, "cartoon")} disabled={!selectedPhoto.ready || !!jobs[selected.id] || pregenId === selected.id || !selected.photoUrl} title={!selectedPhoto.ready ? selectedPhoto.message : undefined}>
            {selected.cartoonUrl ? "重做卡通" : "生成卡通"}
          </button>
          <button type="button" className="btn-secondary px-2 text-[12px]" onClick={() => generate(selected, "loop-video")} disabled={!selectedPhoto.ready || !!jobs[selected.id] || pregenId === selected.id || !selected.photoUrl} title={!selectedPhoto.ready ? selectedPhoto.message : undefined}>
            {selected.loopVideoUrl ? "重做视频" : "生成视频"}
          </button>
          <button
            type="button"
            className="btn-secondary px-2 text-[12px]"
            onClick={() => pregenerateAll(selected)}
            disabled={!!jobs[selected.id] || pregenId === selected.id || selected.sections.length === 0}
            title={selectedSpeech.ready ? "提前生成每个部分的讲解文字和语音" : "仅生成讲解文字，不发送到外部语音服务"}
          >
            {pregenId === selected.id ? <Spinner /> : <IconBolt size={14} />}
            {pregenId === selected.id ? "生成中…" : selectedSpeech.ready ? "讲解与语音" : "文字讲解"}
          </button>
        </div>
        {selectedSpeech.ready && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" className="btn-ghost text-[12px]" onClick={() => pregenerateAll(selected, "audio")} disabled={!!jobs[selected.id] || pregenId === selected.id || selected.sections.length === 0} title="仅为已有讲解补齐语音，不重新生成文字">
              仅补语音 · 不改文字
            </button>
            <button type="button" className="btn-ghost text-[12px]" onClick={() => pregenerateAll(selected, "text")} disabled={!!jobs[selected.id] || pregenId === selected.id || selected.sections.length === 0} title="仅准备讲解文字，不调用外部配音">
              仅准备文字
            </button>
          </div>
        )}
        {!selected.photoUrl && <p className="mt-2 text-[12px] text-ink-3">这位同学还没有照片，先补照片再生成卡通和视频。</p>}
        {preparations[selected.id] && (
          <section aria-label="逐项准备进度" className="mt-4 border-t border-line pt-3">
            <p className="text-[12px] font-medium text-ink-2">准备进度 · {preparations[selected.id].entries.filter((entry) => entry.status === "complete").length}/{preparations[selected.id].entries.length} 步完成</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-3">按顺序逐项处理，每一步保存并校验后标为完成。已完成的结果会保留。</p>
            <ol className="mt-3 space-y-3">
              {preparations[selected.id].entries.map((entry, index) => (
                <li key={entry.key} className="flex items-start gap-2 text-[12px]">
                  <span className="w-4 shrink-0 pt-0.5 font-mono text-[10px] text-ink-3">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-ink-2">{entry.label}</p>
                    <p className={`mt-0.5 leading-relaxed ${entry.status === "complete" ? "text-success" : entry.status === "failed" ? "text-danger" : entry.status === "running" ? "text-accent" : "text-ink-3"}`}>
                      {entry.status === "complete" ? "已完成" : entry.status === "failed" ? "未完成" : entry.status === "blocked" ? "待处理" : entry.status === "running" ? "处理中" : "等待"} · {entry.detail}
                    </p>
                    {entry.status === "failed" && entry.narration && (
                      <button type="button" className="btn-ghost mt-1 px-0 text-[11px]" disabled={!!jobs[selected.id] || pregenId === selected.id} onClick={() => retryNarration(selected, entry)} aria-label={`仅重试${entry.label}`}>
                        仅重试此项
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {preparations[selected.id].summary && <p role="status" className="mt-3 border-t border-line pt-2 text-[12px] leading-relaxed text-ink-2">{preparations[selected.id].summary}</p>}
          </section>
        )}
      </div>

      <button type="button" className="btn-danger w-full" onClick={() => remove(selected)} disabled={busyId === selected.id}>
        <IconTrash size={15} /> 删除
      </button>

      <div className="border-t border-line pt-4">
        <div className="flex items-center justify-between">
          <span className="eyebrow">讲稿 · {selected.sections.length} 个部分</span>
          <span className="eyebrow">/p/{selected.slug}</span>
        </div>
        <ol className="mt-2 space-y-1.5">
          {selected.sections.map((s, i) => (
            <li key={s.id} className="text-[13px]">
              <div className="flex items-center gap-2.5">
                <span className="w-5 font-mono text-[11px] text-ink-4">{pad2(i)}</span>
                <span className="truncate text-ink-2">{s.title}</span>
              </div>
              <ul className="ml-7 mt-1 space-y-1">
                {narrationLanguages(selected.language).map((lang) => {
                  const textReady = !!s.cachedAnswers?.[lang]?.trim();
                  const audioReady = !!s.cachedAudio?.[lang];
                  return <li key={lang} className="flex flex-wrap gap-x-2 text-[11px]">
                    <span className="text-ink-2">{narrationLanguageLabels[lang]}</span>
                    <span className={textReady ? "text-success" : "text-warning-ink"}>文字{textReady ? "已保存" : "待准备"}</span>
                    <span className={textReady && audioReady ? "text-success" : "text-warning-ink"}>语音{audioReady ? textReady ? "已保存" : "已保存，文字待准备" : "待准备"}</span>
                  </li>;
                })}
              </ul>
              {Object.values(s.cachedAudio ?? {}).some((url) => url?.startsWith("/api/photo/")) && (
                <details className="ml-7 mt-1 rounded-lg bg-surface-2 px-3 py-2">
                  <summary className="cursor-pointer text-[12px] text-accent">试听已保存配音</summary>
                  {(["zh", "en", "bilingual"] as const).map((lang) => {
                    const url = s.cachedAudio?.[lang];
                    if (!url?.startsWith("/api/photo/")) return null;
                    const label = lang === "zh" ? "中文" : lang === "en" ? "English" : "中英双语";
                    return <div key={`${lang}-${url}`} className="mt-3">
                      <p className="text-[12px] text-ink-3">{label}</p>
                      <audio controls preload="none" src={url} aria-label={`${s.title} ${label}配音`} className="mt-1 h-9 w-full" />
                    </div>;
                  })}
                </details>
              )}
            </li>
          ))}
        </ol>
        {selected.subtitle && <p className="mt-3 text-[12px] text-ink-3">“{selected.subtitle}”</p>}
      </div>
    </div>
  );

  const sidebarNav = (
    <>
      <button type="button" onClick={() => setFilter("all")} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${filter === "all" ? "bg-surface font-medium text-ink shadow-1" : "text-ink-2 hover:bg-surface"}`}>
        <IconUsers size={16} /> 全部同学 <span className="ml-auto font-mono text-[11px] text-ink-3">{people.length}</span>
      </button>
      <button type="button" onClick={() => setFilter("pending")} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${filter === "pending" ? "bg-surface font-medium text-ink shadow-1" : "text-ink-2 hover:bg-surface"}`}>
        <IconInbox size={16} /> 待审核
        {pendingCount > 0 && <span className="ml-auto rounded-full bg-warning px-1.5 font-mono text-[10px] font-medium text-bg">{pendingCount}</span>}
      </button>
      <button type="button" onClick={() => setFilter("needs_work")} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${filter === "needs_work" ? "bg-surface font-medium text-ink shadow-1" : "text-ink-2 hover:bg-surface"}`}>
        <IconWarning size={16} /> 待准备 <span className="ml-auto font-mono text-[11px] text-ink-3">{needsWorkCount}</span>
      </button>
      <button type="button" onClick={() => setFilter("ready")} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${filter === "ready" ? "bg-surface font-medium text-ink shadow-1" : "text-ink-2 hover:bg-surface"}`}>
        <IconCheck size={16} /> 已就绪 <span className="ml-auto font-mono text-[11px] text-ink-3">{readyCount}</span>
      </button>
      <button type="button" onClick={openSubmitQr} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-surface">
        <IconQr size={16} /> 学生提交入口
      </button>
      <button type="button" onClick={() => setQrPackOpen(true)} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-surface" disabled={publishedCount === 0}>
        <IconPrint size={16} /> 统一二维码包 <span className="ml-auto font-mono text-[11px] text-ink-3">{publishedCount}</span>
      </button>
    </>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[228px_minmax(0,1fr)] xl:grid-cols-[236px_minmax(0,1fr)_360px]">
      {/* ── Sidebar (desktop) ── */}
      <aside className="hidden lg:flex lg:min-h-dvh lg:flex-col lg:gap-6 lg:border-r lg:border-line lg:bg-surface-2/60 lg:px-4 lg:py-6">
        <div className="px-3">
          <p className="font-display text-[17px] font-semibold tracking-[-0.01em]">数字人后台</p>
          <p className="eyebrow mt-0.5">TOK Exhibition</p>
        </div>
        <nav className="space-y-1">{sidebarNav}</nav>
        <div className="mt-auto space-y-1 border-t border-line pt-4">
          <button type="button" onClick={load} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:bg-surface"><IconRefresh size={16} /> 刷新</button>
          <button type="button" onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:bg-surface"><IconLogout size={16} /> 退出</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="min-w-0 px-5 py-5 lg:px-8 lg:py-6">
        {/* phone header */}
        <header className="mb-4 flex items-center justify-between lg:hidden">
          <div>
            <p className="font-display text-[22px] font-semibold tracking-[-0.01em]">数字人后台</p>
            <p className="eyebrow">{people.length} 位同学{pendingCount > 0 && ` · ${pendingCount} 待审核`}</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={openSubmitQr} className="btn-icon" title="学生提交入口" aria-label="学生提交入口"><IconQr size={18} /></button>
            <button type="button" onClick={() => setQrPackOpen(true)} className="btn-icon" title="统一二维码打印包" aria-label="统一二维码打印包" disabled={publishedCount === 0}><IconPrint size={18} /></button>
            <button type="button" onClick={load} className="btn-icon" title="刷新" aria-label="刷新"><IconRefresh size={18} /></button>
            <button type="button" onClick={logout} className="btn-icon" title="退出" aria-label="退出"><IconLogout size={18} /></button>
          </div>
        </header>

        {error && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-[13px] text-danger animate-rise">
            <IconWarning size={16} className="mt-0.5 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{error}</p>
            <button type="button" onClick={() => setError("")} className="shrink-0 opacity-70 hover:opacity-100" aria-label="关闭"><IconClose size={16} /></button>
          </div>
        )}

        {/* toolbar */}
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1 lg:max-w-xs">
            <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
            <input className="input py-2 pl-9 text-[14px]" placeholder="搜索姓名、班级或链接…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none]">
            {(
              [
                ["all", `全部 ${people.length}`],
                ["pending", `待审核 ${pendingCount}`],
                ["needs_work", `待准备 ${needsWorkCount}`],
                ["ready", `已就绪 ${readyCount}`],
                ["published", `已发布 ${publishedCount}`],
              ] as [Filter, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`chip ${filter === k ? "!border-ink !bg-ink !text-bg" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="btn-secondary lg:ml-auto" onClick={() => setQrPackOpen(true)} disabled={publishedCount === 0}>
            <IconPrint size={16} /> 二维码打印包
          </button>
          <button type="button" className="btn-primary" onClick={() => setView({ kind: "new" })}>
            <IconPlus size={16} /> 新增同学
          </button>
        </div>

        {/* list / table */}
        {loading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-16" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="card px-6 py-14 text-center">
            <p className="text-[15px] font-medium">{people.length === 0 ? "还没有同学" : "没有匹配的同学"}</p>
            <p className="mt-1 text-[13px] text-ink-3">
              {people.length === 0 ? "点「新增同学」录入，或把提交入口发给同学让他们自己上传。" : "换个筛选条件或关键词试试。"}
            </p>
            {people.length === 0 && (
              <button type="button" className="btn-secondary mt-5" onClick={openSubmitQr}><IconQr size={15} /> 学生提交入口</button>
            )}
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="hidden grid-cols-[44px_minmax(0,1fr)_56px_96px_minmax(0,170px)_156px] items-center gap-3 border-b border-line px-4 py-2.5 lg:grid">
              <span />
              <span className="eyebrow">姓名</span>
              <span className="eyebrow">部分</span>
              <span className="eyebrow">状态</span>
              <span className="eyebrow">现场准备</span>
              <span />
            </div>
            <ul className="stagger divide-y divide-line">
              {filtered.map((p, i) => {
                const isSel = p.id === selectedId;
                const readiness = readinessForPerson(p);
                return (
                  <li
                    key={p.id}
                    style={{ ["--i" as string]: Math.min(i, 12) }}
                    onClick={() => setSelectedId(p.id)}
                    className={`grid cursor-pointer grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors duration-200 ease-out lg:grid-cols-[44px_minmax(0,1fr)_56px_96px_minmax(0,170px)_156px] ${
                      isSel ? "bg-accent-soft/60" : "hover:bg-surface-2"
                    }`}
                  >
                    {avatar(p)}
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-2 text-[14px] font-medium">
                        <span className="min-w-0 truncate">{p.name}</span>
                        {p.source === "student" && <span className="badge-student hidden shrink-0 lg:inline-flex">学生提交</span>}
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-3">
                        {p.cohort ? `${p.cohort} · ` : ""}/p/{p.slug}
                        <span className="lg:hidden"> · {p.sections.length} 部分</span>
                        <span> · {timeAgo(p.updatedAt)}</span>
                      </p>
                      <div className="mt-1 flex items-center gap-2 lg:hidden">{statusBadge(p)}{p.source === "student" && <span className="badge-student">学生提交</span>}</div>
                    </div>
                    <span className="hidden text-[13px] text-ink-2 lg:block">{p.sections.length}</span>
                    <span className="hidden lg:block">{statusBadge(p)}</span>
                    <div className="hidden min-w-0 lg:block" title={readiness.items.filter((item) => !item.ready).map((item) => item.label).join("、") || "全部就绪"}>
                      {jobs[p.id] ? (
                        <span className="truncate text-[12px] text-accent">{jobs[p.id]}</span>
                      ) : (
                        <>
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className={readiness.ready ? "text-success" : readiness.publishable ? "text-warning-ink" : "text-danger"}>{readiness.ready ? "已就绪" : readiness.publishable ? "可备用发布" : "待补必需资料"}</span>
                            <span className="font-mono text-ink-3">{readiness.done}/{readiness.total}</span>
                          </div>
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                            <div className={`h-full rounded-full ${readiness.ready ? "bg-success" : readiness.publishable ? "bg-warning" : "bg-danger"}`} style={{ width: `${readiness.percent}%` }} />
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                      {p.status === "pending" && (
                        <button type="button" onClick={() => setStatus(p, "approved")} disabled={busyId === p.id} className="btn-primary mr-1 px-2.5 py-1.5 text-[12px]">通过</button>
                      )}
                      <button type="button" onClick={() => openQrFor(p)} className="btn-icon hidden lg:inline-flex" title={p.status === "pending" ? "发布后才可发放二维码" : "二维码"} aria-label="二维码" disabled={p.status === "pending"}><IconQr size={16} /></button>
                      <button type="button" onClick={() => setView({ kind: "edit", person: p })} className="btn-icon" title="编辑" aria-label="编辑"><IconEdit size={16} /></button>
                      <button type="button" onClick={() => remove(p)} disabled={busyId === p.id} className="btn-icon hidden hover:!bg-danger-soft hover:!text-danger lg:inline-flex" title="删除" aria-label="删除"><IconTrash size={16} /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>

      {/* ── Detail: static column on xl, sheet below ── */}
      <aside className="hidden xl:block xl:min-h-dvh xl:border-l xl:border-line xl:bg-surface xl:px-6 xl:py-6">
        {selected && wide ? detail : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <IconUsers size={22} className="text-ink-4" />
            <p className="mt-3 text-[13px] text-ink-3">点一位同学查看详情与操作</p>
          </div>
        )}
      </aside>
      {selected && !wide && (
        <div className="fixed inset-0 z-40 xl:hidden" onClick={() => setSelectedId(null)}>
          <div className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-sm animate-fade" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-5 shadow-2 animate-rise lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[380px] lg:rounded-none lg:border-l lg:border-t-0 lg:p-6"
          >
            {detail}
          </div>
        </div>
      )}

      {qr && <QrModal {...qr} onClose={() => setQr(null)} />}
      {qrPackOpen && <QrBatchPanel people={people} base={base} onClose={() => setQrPackOpen(false)} />}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className="card flex items-center gap-2 px-4 py-2.5 text-[13px] shadow-2 animate-rise">
            <IconCheck size={15} className="text-success" /> {toast}
          </div>
        </div>
      )}
    </div>
  );
}
