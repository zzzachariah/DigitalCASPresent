"use client";

import type { Section } from "@/lib/types";
import { pad2 } from "@/lib/format";
import { IconUser } from "./icons";

/** What the editor exposes for the live preview. */
export interface Draft {
  name: string;
  subtitle: string;
  photo?: string;
  sections: Section[];
}

/** A phone-sized rendering of the visitor page, fed by the editor's draft
 *  state — so students and admins see the result while they type. */
export default function DraftPreview({ draft, title = "实时预览 · Live preview" }: { draft: Draft; title?: string }) {
  const hasName = !!draft.name.trim();
  const name = hasName ? draft.name.trim() : "同学姓名";
  return (
    <div>
      <p className="eyebrow mb-3">{title}</p>
      <div className="card overflow-hidden shadow-2">
        <div className="px-4 pb-3 pt-4">
          <p className="truncate font-display text-[20px] font-semibold leading-tight tracking-[-0.01em]">{name}</p>
          {draft.subtitle.trim() ? (
            <p className="truncate text-[12px] text-ink-2">{draft.subtitle}</p>
          ) : (
            <p className="truncate text-[12px] text-ink-4">副标题 · 知识问题</p>
          )}
          <p className="eyebrow mt-1">TOK Exhibition · {draft.sections.length} parts</p>
        </div>
        <div className="relative mx-4 aspect-[4/3] overflow-hidden rounded-lg border border-line bg-surface-2">
          {draft.photo ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={draft.photo} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={draft.photo} alt="" className="absolute inset-0 h-full w-full object-contain" />
            </>
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <span className="grid h-16 w-16 place-items-center rounded-full bg-surface-3 font-display text-2xl font-semibold text-ink-4">
                {hasName ? name.slice(0, 1) : <IconUser size={26} />}
              </span>
            </div>
          )}
        </div>
        <div className="mx-4 mb-4 mt-3 overflow-hidden rounded-lg border border-line">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="eyebrow">目录</span>
            <span className="eyebrow">{draft.sections.length} parts</span>
          </div>
          {draft.sections.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-ink-4">分段后会显示在这里</p>
          ) : (
            draft.sections.slice(0, 6).map((s, i) => (
              <div key={s.id} className="flex items-center gap-2.5 border-b border-line/70 px-3 py-2 last:border-b-0">
                <span className="w-5 font-mono text-[10px] text-ink-4">{pad2(i)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-ink-2">{s.title.trim() || "未命名部分"}</span>
                  {s.hint?.trim() && <span className="block truncate text-[11px] text-ink-3">{s.hint}</span>}
                </span>
              </div>
            ))
          )}
          {draft.sections.length > 6 && (
            <p className="px-3 py-1.5 text-center text-[11px] text-ink-4">… 还有 {draft.sections.length - 6} 个</p>
          )}
        </div>
      </div>
    </div>
  );
}
