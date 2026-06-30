"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Person } from "@/lib/types";

export default function QrModal({
  person,
  onClose,
}: {
  person: Person;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const base =
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const link = `${base}/p/${person.slug}`;

  useEffect(() => {
    QRCode.toDataURL(link, {
      width: 720,
      margin: 2,
      color: { dark: "#1c1c1e", light: "#ffffff" },
    }).then(setDataUrl);
  }, [link]);

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm animate-fade-up rounded-t-3xl bg-white p-6 shadow-lift sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 text-center">
          <h3 className="text-lg font-semibold">{person.name}</h3>
          <p className="text-sm text-ink-mute">专属二维码 · Scan to meet</p>
        </div>

        <div className="mx-auto grid place-items-center rounded-3xl bg-white p-4 ring-1 ring-black/5">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt="QR" className="h-56 w-56" />
          ) : (
            <div className="h-56 w-56 animate-pulse rounded-2xl bg-gray-100" />
          )}
        </div>

        <p className="mt-3 break-all text-center text-xs text-ink-mute">{link}</p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn-ghost" onClick={copy}>
            {copied ? "已复制 ✓" : "复制链接"}
          </button>
          <a className="btn-soft" href={dataUrl} download={`qr-${person.slug}.png`}>
            下载二维码
          </a>
        </div>
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="btn-primary mt-3 w-full"
        >
          预览访客页面 →
        </a>
        <button onClick={onClose} className="mt-3 w-full py-2 text-sm text-ink-mute">
          关闭
        </button>
      </div>
    </div>
  );
}
