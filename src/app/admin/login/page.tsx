import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import LoginForm from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (isAdmin()) redirect("/admin");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <div className="mb-6">
        <p className="eyebrow">TOK Exhibition · Admin</p>
        <h1 className="mt-2 font-display text-[28px] font-semibold leading-tight tracking-[-0.015em]">老师后台</h1>
        <p className="mt-1 text-[14px] text-ink-3">审核同学的提交、生成数字人、导出二维码。</p>
      </div>
      <LoginForm />
    </main>
  );
}
