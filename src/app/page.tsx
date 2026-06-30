import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-6 grid h-16 w-16 place-items-center rounded-3xl bg-brand-500 text-2xl text-white shadow-lift">
        ✦
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Digital CAS · TOK Exhibition
      </h1>
      <p className="mt-3 text-ink-soft">
        每位同学有一个专属二维码。扫码即可遇见 TA 的“数字人”，
        听 TA 讲解自己的 TOK 展览，并随时追问。
      </p>
      <p className="mt-1 text-sm text-ink-mute">
        Each student has their own QR code. Scan it to meet their digital
        guide and explore their TOK Exhibition.
      </p>

      <div className="mt-8 w-full space-y-3">
        <Link href="/admin" className="btn-primary w-full">
          进入后台 · Admin
        </Link>
        <p className="text-xs text-ink-mute">
          访客无需从这里进入 —— 直接扫描专属二维码即可。
        </p>
      </div>
    </main>
  );
}
