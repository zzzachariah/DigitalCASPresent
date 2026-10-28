"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { Person } from "@/lib/types";
import { IconClose, IconPrint, IconQr } from "./icons";

export default function QrBatchPanel({ people, base, onClose }: { people: Person[]; base: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const published = useMemo(
    () => people.filter((person) => person.status !== "pending").sort((a, b) => (a.cohort || "").localeCompare(b.cohort || "", "zh-CN") || a.name.localeCompare(b.name, "zh-CN")),
    [people]
  );
  const groups = useMemo(
    () => Array.from(new Set(published.map((person) => person.cohort?.trim()).filter((value): value is string => !!value))),
    [published]
  );
  const [group, setGroup] = useState("all");
  const selected = useMemo(() => group === "all" ? published : published.filter((person) => person.cohort === group), [group, published]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setError("");
    const missing = selected.filter((person) => !images[person.id]);
    if (!missing.length) return () => { active = false; };
    Promise.all(
      missing.map(async (person) => [
        person.id,
        await QRCode.toDataURL(`${base}/p/${person.slug}`, {
          width: 420,
          margin: 1,
          errorCorrectionLevel: "M",
          color: { dark: "#15181c", light: "#ffffff" },
        }),
      ] as const)
    ).then((entries) => {
      if (active) setImages((current) => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch(() => {
      if (active) setError("部分二维码生成失败，请关闭后重试。 / Some QR codes could not be generated.");
    });
    return () => { active = false; };
  }, [base, images, selected]);

  const ready = selected.length > 0 && selected.every((person) => images[person.id]);

  return (
    <div className="fixed inset-0 z-50 bg-bg" role="dialog" aria-modal aria-label="二维码打印包">
      <div ref={dialogRef} tabIndex={-1} className="mx-auto flex h-dvh max-w-7xl flex-col outline-none">
        <header className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">QR distribution pack</p>
            <h2 className="font-display text-[22px] font-semibold tracking-[-0.01em]">统一二维码打印包</h2>
            <p className="mt-1 text-[13px] text-ink-3">只包含已发布同学；A4 每页约 8 张，可在打印窗口选择“保存为 PDF”。</p>
          </div>
          {groups.length > 0 && (
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              班级 / 小组
              <select className="input w-auto min-w-40 py-2" value={group} onChange={(event) => setGroup(event.target.value)}>
                <option value="all">全部 · {published.length}</option>
                {groups.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="btn-primary" onClick={() => window.print()} disabled={!ready}>
            <IconPrint size={16} /> {ready ? `打印 / 保存 PDF · ${selected.length}` : "正在生成二维码…"}
          </button>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose size={19} /></button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <p role="alert" className="no-print mb-4 rounded-lg bg-danger-soft px-4 py-3 text-[13px] text-danger">{error}</p>}
          {selected.length === 0 ? (
            <div className="card grid min-h-64 place-items-center p-8 text-center">
              <div><IconQr size={24} className="mx-auto text-ink-4" /><p className="mt-3 text-[14px] text-ink-2">这个范围内还没有已发布同学</p></div>
            </div>
          ) : (
            <section className="qr-pack-print">
              <div className="qr-pack-heading hidden">
                <h1>Digital CAS · TOK Exhibition</h1>
                <p>{group === "all" ? "全部已发布同学" : group} · {selected.length} 人</p>
              </div>
              <div className="qr-pack-grid grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {selected.map((person) => (
                  <article key={person.id} className="qr-pack-card card flex items-center gap-4 p-4">
                    <div className="grid h-28 w-28 shrink-0 place-items-center rounded-lg bg-white p-1.5 ring-1 ring-line">
                      {images[person.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={images[person.id]} alt={`${person.name} 的二维码`} className="h-full w-full" />
                      ) : <div className="skeleton h-full w-full" />}
                    </div>
                    <div className="min-w-0">
                      <p className="font-display text-[19px] font-semibold leading-tight text-ink">{person.name}</p>
                      <p className="mt-1 text-[12px] text-ink-3">{person.cohort || "未填写班级 / 小组"}</p>
                      <p className="mt-4 break-all font-mono text-[9px] leading-relaxed text-ink-4">{base.replace(/^https?:\/\//, "")}/p/{person.slug}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
