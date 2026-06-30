"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Person } from "@/lib/types";
import PersonEditor from "./PersonEditor";
import QrModal from "./QrModal";

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; person: Person };

export default function AdminApp() {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: "list" });
  const [qrFor, setQrFor] = useState<Person | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/admin/people");
    if (res.status === 401) {
      router.push("/admin/login");
      return;
    }
    const data = await res.json();
    setPeople(data.people ?? []);
    setLoading(false);
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
    await fetch(`/api/admin/people/${p.id}`, { method: "DELETE" });
    load();
  }

  if (view.kind !== "list") {
    return (
      <main className="mx-auto max-w-md px-5 py-6">
        <PersonEditor
          person={view.kind === "edit" ? view.person : null}
          onSaved={() => {
            setView({ kind: "list" });
            load();
          }}
          onCancel={() => setView({ kind: "list" })}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">数字人后台</h1>
          <p className="text-sm text-ink-mute">TOK Exhibition · {people.length} 位同学</p>
        </div>
        <button onClick={logout} className="text-sm text-ink-mute hover:text-ink">
          退出
        </button>
      </header>

      <button
        className="btn-primary mb-5 w-full"
        onClick={() => setView({ kind: "new" })}
      >
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
            点击上方按钮，上传第一位同学的照片和讲稿。
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {people.map((p) => (
            <li key={p.id} className="card flex items-center gap-3 p-3">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-black/5">
                {p.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.photoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-xl text-ink-mute">
                    🙂
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.name}</p>
                <p className="truncate text-xs text-ink-mute">
                  {p.sections.length} 部分 · /p/{p.slug}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setQrFor(p)}
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
                  className="rounded-xl px-2.5 py-2 text-sm hover:bg-red-50"
                  title="删除"
                >
                  🗑️
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {qrFor && <QrModal person={qrFor} onClose={() => setQrFor(null)} />}
    </main>
  );
}
