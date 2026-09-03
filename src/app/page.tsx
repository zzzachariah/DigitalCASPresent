import Link from "next/link";
import { IconArrowRight } from "@/components/icons";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 py-8 lg:px-12">
      <header className="flex items-center justify-between">
        <span className="eyebrow">IBDP · TOK Exhibition</span>
        <Link href="/admin" className="text-[13px] text-ink-3 transition-colors hover:text-ink">
          老师后台 · Admin
        </Link>
      </header>

      <section className="flex flex-1 flex-col justify-center py-16 lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-center lg:gap-16">
        <div className="stagger">
          <h1 className="font-display text-[38px] font-semibold leading-[1.05] tracking-[-0.02em] lg:text-[56px] 2xl:text-[64px]" style={{ ["--i" as string]: 0 }}>
            每位同学，
            <br />
            一个会讲解的
            <br />
            数字人。
          </h1>
          <p className="mt-6 max-w-md text-[17px] leading-relaxed text-ink-2" style={{ ["--i" as string]: 1 }}>
            扫描同学的专属二维码，听 TA 讲解自己的 TOK 展览，随时追问。
          </p>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-ink-3" style={{ ["--i" as string]: 2 }}>
            Scan a student’s code to meet their digital guide and explore their TOK Exhibition.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row" style={{ ["--i" as string]: 3 }}>
            <Link href="/submit" className="btn-primary px-5 py-3">
              同学提交讲稿 · Submit my talk <IconArrowRight size={16} />
            </Link>
            <Link href="/admin" className="btn-secondary px-5 py-3">
              老师后台 · Admin
            </Link>
          </div>
        </div>

        <ol className="mt-16 grid gap-3 lg:mt-0" aria-label="How it works">
          {[
            ["01", "同学提交", "上传照片和讲稿，AI 自动分成几个部分。"],
            ["02", "老师审核", "在后台预览、生成卡通形象和动态视频，然后发布。"],
            ["03", "访客扫码", "在手机上选择想听的部分，听完可以追问。"],
          ].map(([n, h, d], i) => (
            <li key={n} className="card flex gap-4 p-4 animate-rise" style={{ animationDelay: `${200 + i * 70}ms` }}>
              <span className="font-mono text-[11px] text-accent">{n}</span>
              <div>
                <p className="text-[15px] font-medium">{h}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="text-[12px] text-ink-4">访客无需从这里进入，直接扫描专属二维码即可。</footer>
    </main>
  );
}
