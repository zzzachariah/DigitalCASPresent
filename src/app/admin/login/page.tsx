import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import LoginForm from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (isAdmin()) redirect("/admin");
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-3xl bg-brand-500 text-xl text-white shadow-lift">
          ✦
        </div>
        <h1 className="text-xl font-semibold tracking-tight">后台登录 · Admin</h1>
        <p className="mt-1 text-sm text-ink-mute">
          上传同学的照片与讲稿、生成二维码。
        </p>
      </div>
      <LoginForm />
    </main>
  );
}
