"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Person } from "@/lib/types";
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
  IconQr,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUsers,
  IconWarning,
} from "./icons";

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; person: Person };
type Qr = { title: string; subtitle?: string; link: string; downloadName: string } | null;
type Filter = "all" | "pending" | "published";

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "")
  );
}

function assetSummary(p: Person): string[] {
  const out: string[] = [];
  out.push(p.photoUrl ? "照片" : "无照片");
  if (p.cartoonUrl) out.push("卡通");
  if (p.loopVideoUrl) out.push("视频");
  const pre = p.sections.filter((s) => s.cachedAnswers && Object.keys(s.cachedAnswers).length > 0).length;
  const audio = p.sections.filter((s) => s.cachedAudio && Object.keys(s.cachedAudio).length > 0).length;
  if (pre > 0) out.push(`预生成 ${pre}/${p.sections.length}${audio > 0 ? ` · 语音 ${audio}` : ""}`);
  return out;
}

export default function AdminApp() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [qr, setQr] = useState<Qr>(null);
  const [copied, setCopied] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pregenId, setPregenId] = useState<string | null>(null);
  // Long jobs per person ("卡通…", "视频…", "讲解 2/3…") so several students
  // can be processed at once while the list stays usable.
  const [jobs, setJobs] = useState<Record<string, string>>({});
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

  async function load() {
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

  /** Everything a student needs before the event, in order: cartoon → loop
   *  video → pre-generated explanations with audio. Skips what exists. */
  async function prepareAll(p: Person) {
    setError("");
    const steps: string[] = [];
    if (!p.cartoonUrl) steps.push("cartoon");
    if (!p.loopVideoUrl) steps.push("loop-video");
    steps.push("pregenerate");
    let current = p;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const prefix = `${i + 1}/${steps.length} · `;
        if (step === "cartoon" || step === "loop-video") {
          setJob(p.id, prefix + (step === "cartoon" ? "卡通生成中…" : "动态视频生成中…"));
          const url = await generateAsset(p.id, step);
          current = { ...current, [step === "cartoon" ? "cartoonUrl" : "loopVideoUrl"]: url };
          setPeople((list) => list.map((x) => (x.id === p.id ? current : x)));
        } else {
          setJob(p.id, prefix + "讲解与语音预生成中…");
          const res = await fetch(`/api/admin/people/${p.id}/pregenerate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await readJson(res);
          if (!res.ok) throw new Error(data.error || "预生成失败");
          current = { ...current, sections: data.sections };
          setPeople((list) => list.map((x) => (x.id === p.id ? current : x)));
          if (data.failed) notify(`${p.name}：有 ${data.failed} 个部分没生成成功，可再点一次`);
        }
      }
      notify(`素材已就绪：${p.name}`);
    } catch (e) {
      setError(`${p.name}：${e instanceof Error ? e.message : "准备素材失败"}`);
    } finally {
      setJob(p.id, null);
    }
  }

  /** Pre-generate every part's explanation (+ audio when A2E is configured)
   *  without opening the editor. */
  async function pregenerateAll(p: Person) {
    setPregenId(p.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/people/${p.id}/pregenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "预生成失败");
      setPeople((list) => list.map((x) => (x.id === p.id ? { ...x, sections: data.sections } : x)));
      notify(data.failed ? `${p.name}：有 ${data.failed} 个部分没生成成功` : `讲解与语音已就绪：${p.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "预生成失败");
    } finally {
      setPregenId(null);
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
    setPeople((list) =>
      list.some((x) => x.id === saved.id)
        ? list.map((x) => (x.id === saved.id ? { ...x, ...saved } : x))
        : [...list, saved]
    );
    setSelectedId(saved.id);
    setView({ kind: "list" });
  }

  const base = baseUrl();
  const submitLink = `${base}/submit`;
  const pendingCount = people.filter((p) => p.status === "pending").length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => (filter === "pending" ? p.status === "pending" : filter === "published" ? p.status !== "pending" : true))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q) || (p.subtitle || "").toLowerCase().includes(q))
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.createdAt - b.createdAt);
  }, [people, filter, query]);

  const selected = people.find((p) => p.id === selectedId) || null;

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
          <button type="button" className="btn-secondary" onClick={() => openQrFor(selected)}><IconQr size={15} /> 二维码</button>
          <button type="button" className="btn-secondary" onClick={() => setView({ kind: "edit", person: selected })}><IconEdit size={15} /> 编辑</button>
          {editLink(selected) ? (
            <button type="button" className="btn-secondary" onClick={() => copy(editLink(selected)!, selected.id)}>
              {copied === selected.id ? <IconCheck size={15} /> : <IconLink size={15} />} {copied === selected.id ? "已复制" : "学生链接"}
            </button>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => copy(`${base}/p/${selected.slug}`, selected.id)}>
              {copied === selected.id ? <IconCheck size={15} /> : <IconCopy size={15} />} {copied === selected.id ? "已复制" : "复制链接"}
            </button>
          )}
        </div>
      </div>

      {/* Assets: what the digital human needs before the event */}
      <div className="rounded-lg border border-line bg-surface-2/60 p-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">素材 · Assets</span>
          {jobs[selected.id] && (
            <span className="flex items-center gap-1.5 text-[12px] text-accent"><Spinner /> {jobs[selected.id]}</span>
          )}
        </div>
        <button
          type="button"
          className="btn-primary mt-2 w-full"
          onClick={() => prepareAll(selected)}
          disabled={!!jobs[selected.id] || pregenId === selected.id || !selected.photoUrl || selected.sections.length === 0}
          title={!selected.photoUrl ? "需要先有照片" : "卡通 → 动态视频 → 讲解与语音，已有的会跳过"}
        >
          <IconSparkle size={15} /> 一键准备素材
        </button>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button type="button" className="btn-secondary px-2 text-[12px]" onClick={() => generate(selected, "cartoon")} disabled={!!jobs[selected.id] || !selected.photoUrl}>
            {selected.cartoonUrl ? "重做卡通" : "生成卡通"}
          </button>
          <button type="button" className="btn-secondary px-2 text-[12px]" onClick={() => generate(selected, "loop-video")} disabled={!!jobs[selected.id] || !selected.photoUrl}>
            {selected.loopVideoUrl ? "重做视频" : "生成视频"}
          </button>
          <button
            type="button"
            className="btn-secondary px-2 text-[12px]"
            onClick={() => pregenerateAll(selected)}
            disabled={!!jobs[selected.id] || pregenId === selected.id || selected.sections.length === 0}
            title="提前生成每个部分的讲解文字和语音，访客选中时零等待"
          >
            {pregenId === selected.id ? <Spinner /> : <IconBolt size={14} />}
            {pregenId === selected.id ? "生成中…" : "讲解与语音"}
          </button>
        </div>
        {!selected.photoUrl && <p className="mt-2 text-[12px] text-ink-3">这位同学还没有照片，先补照片再生成卡通和视频。</p>}
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
            <li key={s.id} className="flex items-center gap-2.5 text-[13px]">
              <span className="w-5 font-mono text-[11px] text-ink-4">{pad2(i)}</span>
              <span className="truncate text-ink-2">{s.title}</span>
              {s.cachedAnswers && Object.keys(s.cachedAnswers).length > 0 && (
                <span className="dot bg-success" title={s.cachedAudio && Object.keys(s.cachedAudio).length ? "已预生成 · 含语音" : "已预生成（无语音）"} />
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
      <button type="button" onClick={openSubmitQr} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-surface">
        <IconQr size={16} /> 学生提交入口
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
            <input className="input py-2 pl-9 text-[14px]" placeholder="搜索姓名或链接…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none]">
            {(
              [
                ["all", `全部 ${people.length}`],
                ["pending", `待审核 ${pendingCount}`],
                ["published", `已发布 ${people.length - pendingCount}`],
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
          <button type="button" className="btn-primary lg:ml-auto" onClick={() => setView({ kind: "new" })}>
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
              <span className="eyebrow">素材</span>
              <span />
            </div>
            <ul className="stagger divide-y divide-line">
              {filtered.map((p, i) => {
                const isSel = p.id === selectedId;
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
                        /p/{p.slug}
                        <span className="lg:hidden"> · {p.sections.length} 部分</span>
                        <span> · {timeAgo(p.updatedAt)}</span>
                      </p>
                      <div className="mt-1 flex items-center gap-2 lg:hidden">{statusBadge(p)}{p.source === "student" && <span className="badge-student">学生提交</span>}</div>
                    </div>
                    <span className="hidden text-[13px] text-ink-2 lg:block">{p.sections.length}</span>
                    <span className="hidden lg:block">{statusBadge(p)}</span>
                    <span className={`hidden truncate text-[12px] lg:block ${jobs[p.id] ? "text-accent" : "text-ink-3"}`}>{jobs[p.id] || assetSummary(p).join(" · ")}</span>
                    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                      {p.status === "pending" && (
                        <button type="button" onClick={() => setStatus(p, "approved")} disabled={busyId === p.id} className="btn-primary mr-1 px-2.5 py-1.5 text-[12px]">通过</button>
                      )}
                      <button type="button" onClick={() => openQrFor(p)} className="btn-icon hidden lg:inline-flex" title="二维码" aria-label="二维码"><IconQr size={16} /></button>
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
