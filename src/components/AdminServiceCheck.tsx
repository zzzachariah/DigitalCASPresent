"use client";

import Link from "next/link";
import { useState } from "react";

const MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-2"];
const STATUS: Record<string, string> = {
  ok: "收到有效响应", http_error: "服务返回错误", invalid_response: "服务响应异常",
  network_error: "服务连接失败", timeout: "服务响应超时", aborted: "检查已中止",
  event_closed: "活动已结束", skipped: "尚未检查",
};
const KIND: Record<string, string> = {
  http: "上游请求失败", network: "连接失败", timeout: "响应超时", aborted: "请求中止",
  invalid_response: "响应格式异常", empty_response: "未返回有效内容", truncated_response: "输出被截断",
};
type Step = { status?: string; pass?: boolean; elapsedMs?: number; httpStatus?: number; upstreamKind?: string; kind?: string };
type Result = { pass?: boolean; generation?: Step; review?: Step };

export default function AdminServiceCheck({ configuredModel }: { configuredModel: string }) {
  const [model, setModel] = useState(MODELS.includes(configuredModel) ? configuredModel : MODELS[0]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  async function check() {
    setRunning(true); setResult(null); setError("");
    try {
      const response = await fetch("/api/admin/ai-probe", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
      });
      if (!response.ok) {
        setError(response.status === 429 ? "检查次数较多，请稍后再试。" : response.status === 401 ? "请重新登录后台。" : `检查暂未完成（${response.status}）。`);
        return;
      }
      const data = await response.json();
      if (!data || data.syntheticOnly !== true || typeof data.pass !== "boolean") { setError("未收到可确认的检查结果。"); return; }
      setResult(data);
    } catch { setError("检查连接中断，尚未确认服务状态。"); }
    finally { setRunning(false); }
  }

  return <main className="mx-auto max-w-2xl p-6 sm:p-10">
    <Link href="/admin" className="text-sm text-accent">返回活动后台</Link>
    <h1 className="mt-6 text-2xl font-semibold">检查讲解服务</h1>
    <p className="mt-3 text-sm leading-relaxed text-ink-3">使用固定的虚构展品检查文字生成和内容审核，不读取学生稿件。检查不会更改活动使用的模型。</p>
    <p className="mt-3 text-sm">活动当前模型：{configuredModel}</p>
    <label className="mt-6 block text-sm" htmlFor="check-model">本次检查模型</label>
    <select id="check-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={running} className="mt-2 w-full rounded-xl border border-white/10 bg-surface-2 p-3">
      {MODELS.map((value) => <option key={value} value={value}>{value}</option>)}
    </select>
    <button type="button" className="btn-primary mt-4" onClick={check} disabled={running}>{running ? "正在检查生成与审核…" : "开始检查"}</button>
    <div role="status" aria-live="polite" className="mt-6">
      {error && <p className="text-sm text-warning">{error}</p>}
      {result && <>
        <p className="font-medium">{result.pass ? "文字生成和审核检查均通过" : "本次检查未全部通过"}</p>
        <ul className="mt-4 space-y-3">
          {([['文字生成', result.generation], ['内容审核', result.review]] as const).map(([label, step]) => {
            const status = step?.status && Object.prototype.hasOwnProperty.call(STATUS, step.status) ? STATUS[step.status] : "未获得有效结果";
            const kindValue = step?.upstreamKind || step?.kind;
            const kind = kindValue && Object.prototype.hasOwnProperty.call(KIND, kindValue) ? KIND[kindValue] : "";
            const seconds = typeof step?.elapsedMs === "number" && Number.isFinite(step.elapsedMs) ? `${(step.elapsedMs / 1000).toFixed(1)} 秒` : "";
            const http = Number.isInteger(step?.httpStatus) && step!.httpStatus! >= 100 && step!.httpStatus! <= 599 ? ` · HTTP ${step!.httpStatus}` : "";
            return <li key={label} className="rounded-xl bg-surface-2 p-4 text-sm"><b>{label}：{step?.pass === true ? "通过" : "未通过"}</b><p className="mt-1 text-ink-3">{status}{kind ? ` · ${kind}` : ""}{http}{seconds ? ` · ${seconds}` : ""}</p></li>;
          })}
        </ul>
      </>}
    </div>
  </main>;
}
