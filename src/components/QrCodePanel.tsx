"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { IconCheck, IconCopy, IconRefresh } from "./icons";

/** The public scan link only — never pass a student edit or preview token here. */
export default function QrCodePanel({ link, downloadName }: { link: string; downloadName: string }) {
  const [image, setImage] = useState<{ link: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dataUrl = image?.link === link ? image.url : "";

  useEffect(() => {
    let active = true;
    setImage(null);
    setError("");
    setNotice("");
    setCopied(false);
    QRCode.toDataURL(link, {
      width: 720,
      margin: 2,
      color: { dark: "#15181c", light: "#ffffff" },
    }).then((url) => {
      if (active) setImage({ link, url });
    }).catch(() => {
      if (active) setError("二维码生成失败，请重试。/ Could not generate the QR code. Please retry.");
    });
    return () => { active = false; };
  }, [link, attempt]);

  async function copy() {
    setNotice("");
    setCopied(false);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setNotice("自动复制未成功，请手动选择下面的链接复制。/ Copy failed. Select and copy the link below.");
    }
  }

  function download() {
    if (!dataUrl) return;
    try {
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${downloadName}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setNotice("如果下载未开始，可长按或右键保存二维码。/ If the download does not start, press and hold or right-click the QR code to save it.");
    } catch {
      setNotice("无法开始下载，请长按或右键保存二维码。/ Could not start the download. Save the QR image directly.");
    }
  }

  return (
    <div>
      <div className="mx-auto grid place-items-center rounded-xl bg-white p-4 ring-1 ring-line" aria-busy={!dataUrl && !error}>
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt="二维码 · QR code" className="aspect-square w-56 max-w-full" />
        ) : error ? (
          <div className="grid min-h-56 max-w-56 place-content-center gap-3 text-center">
            <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>
            <button type="button" className="btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
              <IconRefresh size={15} /> 重试 · Retry
            </button>
          </div>
        ) : (
          <div className="skeleton aspect-square w-56 max-w-full" role="status" aria-label="正在生成二维码 · Generating QR code" />
        )}
      </div>

      <p className="mt-3 select-all break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink-3">{link}</p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="btn-secondary flex-col gap-0.5 px-2" onClick={copy}>
          <span className="flex items-center gap-1.5">{copied ? <IconCheck size={15} /> : <IconCopy size={15} />}{copied ? "已复制" : "复制链接"}</span>
          <span className="text-[11px] font-normal">{copied ? "Copied" : "Copy link"}</span>
        </button>
        <button type="button" className="btn-secondary flex-col gap-0.5 px-2" onClick={download} disabled={!dataUrl}>
          <span>下载二维码</span>
          <span className="text-[11px] font-normal">Download QR</span>
        </button>
      </div>
      <p role="status" aria-live="polite" className="mt-2 text-[12px] leading-relaxed text-ink-3">{notice}</p>
    </div>
  );
}
