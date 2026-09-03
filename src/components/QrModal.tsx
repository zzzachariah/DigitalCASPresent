"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { IconCopy, IconCheck, IconExternal } from "./icons";

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
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(link, {
      width: 720,
      margin: 2,
      color: { dark: "#15181c", light: "#ffffff" },
    }).then(setDataUrl);
  }, [link]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--overlay)] p-0 backdrop-blur-sm animate-fade sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={title}
    >
      <div
        className="card w-full max-w-sm animate-rise rounded-b-none p-6 shadow-2 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5">
          <p className="eyebrow">{subtitle || "QR"}</p>
          <h3 className="mt-1 font-display text-xl font-semibold tracking-[-0.01em]">{title}</h3>
        </div>

        <div className="mx-auto grid place-items-center rounded-xl bg-white p-4 ring-1 ring-line">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt="QR" className="h-56 w-56" />
          ) : (
            <div className="skeleton h-56 w-56" />
          )}
        </div>

        <p className="mt-3 break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink-3">{link}</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="btn-secondary" onClick={copy}>
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            {copied ? "已复制" : "复制链接"}
          </button>
          <a className="btn-secondary" href={dataUrl} download={`${downloadName}.png`}>
            下载二维码
          </a>
        </div>
        <a href={link} target="_blank" rel="noreferrer" className="btn-primary mt-2 w-full">
          打开页面 <IconExternal size={15} />
        </a>
        <button onClick={onClose} className="btn-ghost mt-1 w-full">
          关闭
        </button>
      </div>
    </div>
  );
}
