import Link from "next/link";

/** Shown in place of a visitor page that hasn't been approved yet. */
export default function Unpublished({ name }: { name: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 text-4xl">⏳</div>
      <h1 className="text-xl font-semibold">{name} 的数字人还在准备中</h1>
      <p className="mt-2 text-sm text-ink-mute">老师审核通过后，这个页面就会开放。请稍后再扫一次。</p>
      <p className="mt-1 text-xs text-ink-mute">
        This digital guide is awaiting review and will open once approved.
      </p>
      <Link href="/" className="btn-ghost mt-6">
        返回首页
      </Link>
    </main>
  );
}
