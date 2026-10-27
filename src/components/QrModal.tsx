"use client";

import { useEffect, useRef } from "react";
import { IconExternal } from "./icons";
import QrCodePanel from "./QrCodePanel";

export default function QrModal({
  title,
  subtitle,
  link,
  downloadName,
  onClose,
}: {
  title: string;
  subtitle?: string;
  link: string;
  downloadName: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog; give it back when closing.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--overlay)] p-0 backdrop-blur-sm animate-fade sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={title}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="card max-h-[90dvh] w-full max-w-sm animate-rise overflow-y-auto rounded-b-none p-6 shadow-2 outline-none sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5">
          <p className="eyebrow">{subtitle || "QR"}</p>
          <h3 className="mt-1 font-display text-xl font-semibold tracking-[-0.01em]">{title}</h3>
        </div>

        <QrCodePanel link={link} downloadName={downloadName} />
        <a href={link} target="_blank" rel="noreferrer" className="btn-primary mt-2 w-full">
          打开页面 · Open <IconExternal size={15} />
        </a>
        <button type="button" onClick={onClose} className="btn-ghost mt-1 w-full">
          关闭 · Close
        </button>
      </div>
    </div>
  );
}
