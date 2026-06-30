"use client";

import { useState } from "react";

export default function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      // Hard navigation so the browser sends the freshly-set cookie to the
      // server-rendered /admin page (avoids the App Router cache/cookie race).
      window.location.href = "/admin";
      return;
    }
    setLoading(false);
    const data = await res.json().catch(() => ({}));
    setError(data.error || "登录失败");
  }

  return (
    <form onSubmit={submit} className="card p-6">
      <label className="label" htmlFor="pw">
        管理密码 · Password
      </label>
      <input
        id="pw"
        type="password"
        className="input"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
        autoFocus
      />
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      <button type="submit" className="btn-primary mt-4 w-full" disabled={loading}>
        {loading ? "登录中…" : "登录 / Log in"}
      </button>
      <p className="mt-3 text-center text-xs text-ink-mute">
        密码在服务器环境变量 ADMIN_PASSWORD 中设置。
      </p>
    </form>
  );
}
