import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-3 font-display text-[26px] font-semibold leading-tight tracking-[-0.01em]">未找到这个数字人</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">二维码可能已失效，或该同学尚未创建。请确认链接是否正确。</p>
      <p className="mt-1 text-[13px] text-ink-3">This digital guide was not found. The QR code may be invalid.</p>
      <Link href="/" className="btn-secondary mt-8">
        返回首页
      </Link>
    </main>
  );
}
