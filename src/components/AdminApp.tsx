"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Person } from "@/lib/types";
import { readJson } from "@/lib/http";
import PersonEditor from "./PersonEditor";
import QrModal from "./QrModal";

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; person: Person };
type Qr = { title: string; subtitle?: string; link: string; downloadName: string } | null;

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
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [qr, setQr] = useState<Qr>(null);
  const [copied, setCopied] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusyId(null);
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
  // listing can lag a few seconds behind a write, which would make the new
  // person "disappear" right after creating them.
  function onSaved(saved: Person) {
    setPeople((list) =>
      list.some((x) => x.id === saved.id)
        ? list.map((x) => (x.id === saved.id ? { ...x, ...saved } : x))
        : [...list, saved]
    );
    setView({ kind: "list" });
  }

  if (view.kind !== "list") {
    return (
      <main className="mx-auto max-w-md px-5 py-6">
        <PersonEditor
          person={view.kind === "edit" ? view.person : null}
          onSaved={onSaved}
          onCancel={() => setView({ kind: "list" })}
        />
      </main>
    );
  }

  const base = baseUrl();
  const submitLink = `${base}/submit`;
  const pending = people.filter((p) => p.status === "pending");
  const approved = people.filter((p) => p.status !== "pending");

  function editLink(p: Person): string | null {
    return p.editToken ? `${base}/submit/${p.id}?token=${encodeURIComponent(p.editToken)}` : null;
  }

  function row(p: Person) {
    const isPending = p.status === "pending";
    const busy = busyId === p.id;
    const student = p.source === "student";
    const link = editLink(p);
    return (
      <li key={p.id} className="card p-3">
        <div className="flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-black/5">
            {p.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.cartoonUrl || p.photoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-xl text-ink-mute">🙂</div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate font-medium">
              <span className="truncate">{p.name}</span>
              {isPending && (
                <span className="chip shrink-0 bg-amber-100 px-2 py-0 text-[11px] text-amber-800">待审核</span>
              )}
              {student && !isPending && (
                <span className="chip shrink-0 bg-brand-50 px-2 py-0 text-[11px] text-brand-700">学生提交</span>
              )}
            </p>
            <p className="truncate text-xs text-ink-mute">
              {p.sections.length} 部分 · /p/{p.slug}
              {!p.photoUrl && " · 无照片"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() =>
                setQr({
                  title: p.name,
                  subtitle: "专属二维码 · Scan to meet",
                  link: `${base}/p/${p.slug}`,
                  downloadName: `qr-${p.slug}`,
                })
              }
              className="rounded-xl px-2.5 py-2 text-sm hover:bg-gray-50"
              title="二维码"
            >
              📱
            </button>
            <button
              onClick={() => setView({ kind: "edit", person: p })}
              className="rounded-xl px-2.5 py-2 text-sm hover:bg-gray-50"
              title="编辑"
            >
              ✏️
            </button>
            <button
              onClick={() => remove(p)}
              disabled={busy}
              className="rounded-xl px-2.5 py-2 text-sm hover:bg-red-50 disabled:opacity-50"
              title="删除"
            >
              🗑️
            </button>
          </div>
        </div>
        {(isPending || student) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-black/5 pt-2">
            {isPending ? (
              <button
                onClick={() => setStatus(p, "approved")}
                disabled={busy}
                className="btn-primary px-3 py-1.5 text-sm"
              >
                {busy ? "处理中…" : "✅ 通过并发布"}
              </button>
            ) : (
              <button
                onClick={() => setStatus(p, "pending")}
                disabled={busy}
                className="btn-ghost px-3 py-1.5 text-sm"
              >
                {busy ? "处理中…" : "下线（改回待审核）"}
              </button>
            )}
            {isPending && (
              <a
                href={`${base}/p/${p.slug}`}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost px-3 py-1.5 text-sm"
              >
                预览
              </a>
            )}
            {link && (
              <button onClick={() => copy(link, p.id)} className="text-xs text-brand-600 hover:underline">
                {copied === p.id ? "已复制 ✓" : "复制学生修改链接"}
              </button>
            )}
            {p.submittedAt && (
              <span className="text-xs text-ink-mute">
                提交于 {new Date(p.submittedAt).toLocaleString("zh-CN", { hour12: false })}
              </span>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">数字人后台</h1>
          <p className="text-sm text-ink-mute">
            TOK Exhibition · {people.length} 位同学
            {pending.length > 0 && ` · ${pending.length} 待审核`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={load} className="text-sm text-ink-mute hover:text-ink" title="刷新">
            刷新
          </button>
          <button onClick={logout} className="text-sm text-ink-mute hover:text-ink">
            退出
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          <span className="mt-0.5 shrink-0">⚠️</span>
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <button onClick={() => setError("")} className="shrink-0 text-red-400 hover:text-red-600" aria-label="关闭">
            ✕
          </button>
        </div>
      )}

      {/* Student self-submission entry point */}
      <section className="card mb-5 p-4">
        <p className="text-sm font-semibold">学生提交入口 · Student submission</p>
        <p className="mt-0.5 text-xs text-ink-mute">
          把这个链接发给同学，他们自己上传照片和讲稿；提交后在下方审核通过即上线。
        </p>
        <p className="mt-2 break-all rounded-xl bg-gray-50 px-3 py-2 text-xs text-ink-soft">{submitLink}</p>
        <div className="mt-2 flex gap-2">
          <button className="btn-ghost flex-1 py-2 text-sm" onClick={() => copy(submitLink, "submit")}>
            {copied === "submit" ? "已复制 ✓" : "复制链接"}
          </button>
          <button
            className="btn-soft flex-1 py-2 text-sm"
            onClick={() =>
              setQr({
                title: "学生提交入口",
                subtitle: "扫码提交讲稿 · Scan to submit",
                link: submitLink,
                downloadName: "qr-submit",
              })
            }
          >
            二维码
          </button>
        </div>
      </section>

      <button className="btn-primary mb-5 w-full" onClick={() => setView({ kind: "new" })}>
        ＋ 新增同学（照片 + 讲稿）
      </button>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-20 animate-pulse" />
          ))}
        </div>
      ) : people.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mb-2 text-3xl">📇</div>
          <p className="font-medium">还没有同学</p>
          <p className="mt-1 text-sm text-ink-mute">
            点击上方按钮，上传第一位同学的照片和讲稿；或把提交链接发给同学。
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {pending.length > 0 && (
            <section>
              <p className="mb-2 px-1 text-sm font-semibold text-amber-800">待审核（{pending.length}）</p>
              <ul className="space-y-3">{pending.map(row)}</ul>
            </section>
          )}
          <section>
            {pending.length > 0 && (
              <p className="mb-2 px-1 text-sm font-semibold text-ink-soft">已发布（{approved.length}）</p>
            )}
            <ul className="space-y-3">{approved.map(row)}</ul>
          </section>
        </div>
      )}

      {qr && <QrModal {...qr} onClose={() => setQr(null)} />}
    </main>
  );
}
