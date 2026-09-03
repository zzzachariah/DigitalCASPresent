"use client";

import { useState } from "react";
import { readJson } from "@/lib/http";
import { Spinner } from "./Loading";

export default function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
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
      const data = await readJson(res);
      setError(data.error || "登录失败 / Login failed");
    } catch {
      setError("网络错误，请重试 · Network error, please retry");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="card animate-rise p-6 shadow-2">
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
        autoComplete="current-password"
        autoFocus
      />
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      <button type="submit" className="btn-primary mt-4 w-full" disabled={loading}>
        {loading ? <Spinner light /> : null}
        {loading ? "登录中…" : "登录 / Log in"}
      </button>
      <p className="mt-4 text-center text-[12px] text-ink-3">密码在服务器环境变量 ADMIN_PASSWORD 中设置。</p>
    </form>
  );
}
