import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 text-4xl">🔍</div>
      <h1 className="text-xl font-semibold">未找到这个数字人</h1>
      <p className="mt-2 text-sm text-ink-mute">
        二维码可能已失效，或该同学尚未创建。请确认链接是否正确。
      </p>
      <p className="mt-1 text-xs text-ink-mute">
        This digital guide was not found. The QR code may be invalid.
      </p>
      <Link href="/" className="btn-ghost mt-6">
        返回首页
      </Link>
    </main>
  );
}
