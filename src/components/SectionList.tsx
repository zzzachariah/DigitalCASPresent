"use client";

import { useEffect, useRef } from "react";
import type { Section } from "@/lib/types";
import { pad2 } from "@/lib/format";
import { Spinner } from "./Loading";
import { IconBolt, IconClose, IconDown, IconUp } from "./icons";

/** Admin-only extras rendered inside each section card. */
export interface SectionAdminTools {
  pregenerate: (sectionId: string) => void;
  pregenerating: Set<string>;
  bulkPregenerating: boolean;
  answersOpen: Set<string>;
  toggleAnswersOpen: (id: string) => void;
  updateCachedAnswer: (id: string, key: "en" | "zh" | "bilingual", text: string) => void;
}

/** Editable list of a person's parts, shared by the admin editor and the
 *  student wizard. */
export default function SectionList({
  sections,
  onUpdate,
  onRemove,
  onMove,
  admin,
  compact = false,
  focusId = null,
}: {
  sections: Section[];
  onUpdate: (id: string, patch: Partial<Section>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  admin?: SectionAdminTools;
  compact?: boolean;
  /** Id of a part just added: scrolled into view and its title focused. */
  focusId?: string | null;
}) {
  const titleRefs = useRef(new Map<string, HTMLInputElement>());
  useEffect(() => {
    if (!focusId) return;
    const el = titleRefs.current.get(focusId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }, [focusId, sections.length]);

  return (
    <div className="stagger space-y-3">
      {sections.map((s, i) => (
        <div key={s.id} className="card space-y-2.5 p-4" style={{ ["--i" as string]: Math.min(i, 6) }}>
          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 font-mono text-[11px] text-ink-4">{pad2(i)}</span>
            <input
              ref={(el) => {
                if (el) titleRefs.current.set(s.id, el);
                else titleRefs.current.delete(s.id);
              }}
              className="input flex-1 py-2"
              value={s.title}
              onChange={(e) => onUpdate(s.id, { title: e.target.value })}
              placeholder="标题，如：Object 1 · The Passport"
              maxLength={80}
            />
            <button type="button" onClick={() => onMove(s.id, -1)} className="btn-icon" title="上移" aria-label="上移" disabled={i === 0}><IconUp size={16} /></button>
            <button type="button" onClick={() => onMove(s.id, 1)} className="btn-icon" title="下移" aria-label="下移" disabled={i === sections.length - 1}><IconDown size={16} /></button>
            <button type="button" onClick={() => onRemove(s.id)} className="btn-icon hover:!bg-danger-soft hover:!text-danger" title="删除" aria-label="删除"><IconClose size={16} /></button>
          </div>
          <input
            className="input py-2 text-[13px]"
            value={s.hint ?? ""}
            onChange={(e) => onUpdate(s.id, { hint: e.target.value })}
            placeholder="一句话提示（可选）· one-line teaser"
            maxLength={160}
          />
          <textarea
            className={`input resize-y text-[13px] leading-relaxed ${compact ? "min-h-[72px]" : "min-h-[96px]"}`}
            value={s.content}
            onChange={(e) => onUpdate(s.id, { content: e.target.value })}
            placeholder="这一部分对应的讲稿内容… / the script for this part"
          />
          {admin && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <button
                type="button"
                className="chip"
                onClick={() => admin.pregenerate(s.id)}
                disabled={admin.pregenerating.has(s.id) || admin.bulkPregenerating}
              >
                {admin.pregenerating.has(s.id) ? <Spinner /> : <IconBolt size={14} />}
                {s.cachedAnswers && Object.keys(s.cachedAnswers).length > 0 ? "重新预生成" : "预生成讲解"}
              </button>
              {s.cachedAnswers && Object.keys(s.cachedAnswers).length > 0 && (
                <>
                  <span className="badge-live">
                    已生成 · {Object.keys(s.cachedAnswers).join(" / ")}
                    {s.cachedAudio && Object.keys(s.cachedAudio).length > 0 && " · 含语音"}
                  </span>
                  <button type="button" className="chip" onClick={() => admin.toggleAnswersOpen(s.id)}>
                    {admin.answersOpen.has(s.id) ? "收起讲解" : "查看 / 编辑讲解"}
                  </button>
                </>
              )}
            </div>
          )}
          {admin && admin.answersOpen.has(s.id) && s.cachedAnswers && (
            <div className="space-y-3 rounded-lg bg-surface-2 p-3 animate-fade">
              {(Object.entries(s.cachedAnswers) as ["en" | "zh" | "bilingual", string][]).map(([key, text]) => (
                <div key={key}>
                  <p className="eyebrow mb-1.5">{key === "zh" ? "中文讲解" : key === "en" ? "English" : "双语 · Bilingual"}</p>
                  <textarea
                    className="input min-h-[110px] resize-y text-[13px] leading-relaxed"
                    value={text}
                    onChange={(e) => admin.updateCachedAnswer(s.id, key, e.target.value)}
                  />
                </div>
              ))}
              <p className="text-[12px] text-ink-3">改完后点底部「保存修改」生效；清空某段文字 = 该语言恢复为现场实时生成。</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
