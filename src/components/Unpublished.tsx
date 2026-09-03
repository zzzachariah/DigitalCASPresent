import Link from "next/link";

/** Shown in place of a visitor page that hasn't been approved yet. */
export default function Unpublished({ name }: { name: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="eyebrow animate-rise">TOK Exhibition</p>
      <h1 className="mt-3 font-display text-[26px] font-semibold leading-tight tracking-[-0.01em] animate-rise" style={{ animationDelay: "60ms" }}>
        {name} 的数字人还在准备中
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2 animate-rise" style={{ animationDelay: "120ms" }}>
        老师审核通过后，这个页面就会开放。请稍后再扫一次。
      </p>
      <p className="mt-1 text-[13px] text-ink-3 animate-rise" style={{ animationDelay: "160ms" }}>
        This digital guide is awaiting review and will open once approved.
      </p>
      <Link href="/" className="btn-secondary mt-8 animate-rise" style={{ animationDelay: "220ms" }}>
        返回首页
      </Link>
    </main>
  );
}
