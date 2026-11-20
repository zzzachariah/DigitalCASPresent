"use client";

import Link from "next/link";
import { useState } from "react";

const QWEN_MODELS = ["qwen3.7-plus", "qwen3.8-flash"];
const MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-2", ...QWEN_MODELS];
const STATUS: Record<string, string> = {
  ok: "收到有效响应", http_error: "服务返回错误", invalid_response: "服务响应异常",
  network_error: "服务连接失败", timeout: "服务响应超时", aborted: "检查已中止",
  event_closed: "活动已结束", skipped: "尚未检查", unknown_error: "服务响应尚未确认",
};
const KIND: Record<string, string> = {
  http: "上游请求失败", network: "连接失败", timeout: "响应超时", aborted: "请求中止",
  invalid_response: "响应格式异常", empty_response: "未返回有效内容", truncated_response: "输出被截断",
};
const FAILURE_CODES: Record<string, string> = {
  protocol_not_supported: "服务不支持当前请求方式", overloaded_error: "服务暂时繁忙",
  rate_limit_error: "服务请求限流", authentication_error: "服务凭据验证失败",
  invalid_request_error: "服务未接受请求参数", permission_error: "服务权限不足",
  not_found_error: "服务模型或资源不存在", api_error: "服务内部错误", insufficient_quota: "服务额度不足",
};
const MODES = { json_schema: "固定结构审核", tool: "兼容结构审核", text: "旧版文字格式检查" };
const FIXTURES = {
  basic: "基础生成与审核",
  "complex-valid": "复杂资料 · 应通过",
  "complex-unsupported": "缺少依据 · 应拒绝",
  "complex-extraction": "提取原文 · 应拒绝",
};
const PROFILES = { default: "供应商默认", medium: "中等强度", low: "较低强度" };
const FORMAT_ISSUES: Record<string, string> = { fenced_json: "返回了格式包装", invalid_json: "结果不是有效结构", wrong_fields: "审核项目不完整", wrong_values: "审核项目值无效" };
const CRITERIA: Record<string, string> = { safe: "校园适宜性", grounded: "依据充分性", private: "保密要求", relevant: "展览相关性", respectful: "礼貌与中立" };
type Step = { status?: string; pass?: boolean; elapsedMs?: number; httpStatus?: number; upstreamKind?: string; kind?: string; failure?: { kind?: string; httpStatus?: number; code?: string }; formatIssue?: string; reviewReason?: string; rejectedCriteria?: unknown };
type Result = { pass?: boolean; generation?: Step; review?: Step; fixture?: keyof typeof FIXTURES; reviewProfile?: keyof typeof PROFILES; configuredReviewProfile?: keyof typeof PROFILES; expectedApproved?: boolean; matchedExpectation?: boolean };

export default function AdminServiceCheck({ configuredModel, configuredReviewMode, configuredReviewProfile }: { configuredModel: string; configuredReviewMode: string; configuredReviewProfile: string }) {
  const initialModel = MODELS.includes(configuredModel) ? configuredModel : MODELS[0];
  const [model, setModel] = useState(initialModel);
  const [language, setLanguage] = useState("zh");
  const [reviewMode, setReviewMode] = useState(Object.prototype.hasOwnProperty.call(MODES, configuredReviewMode) ? configuredReviewMode : "json_schema");
  const [fixture, setFixture] = useState<keyof typeof FIXTURES>("basic");
  const [reviewProfile, setReviewProfile] = useState<keyof typeof PROFILES>(initialModel === "claude-sonnet-5" && Object.prototype.hasOwnProperty.call(PROFILES, configuredReviewProfile) ? configuredReviewProfile as keyof typeof PROFILES : "default");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  async function check() {
    if (!MODELS.includes(model) || !["zh", "en"].includes(language) || !Object.prototype.hasOwnProperty.call(MODES, reviewMode) || !Object.prototype.hasOwnProperty.call(FIXTURES, fixture) || !Object.prototype.hasOwnProperty.call(PROFILES, reviewProfile)) { setError("请选择列表中的检查选项。"); return; }
    setRunning(true); setResult(null); setError("");
    try {
      const response = await fetch("/api/admin/ai-probe", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, language, reviewMode, fixture, reviewProfile: model === "claude-sonnet-5" ? reviewProfile : "default" }),
      });
      if (!response.ok) {
        setError(response.status === 429 ? "检查次数较多，请稍后再试。" : response.status === 401 ? "请重新登录后台。" : `检查暂未完成（${response.status}）。`);
        return;
      }
      const data = await response.json();
      if (!data || data.syntheticOnly !== true || typeof data.pass !== "boolean") { setError("未收到可确认的检查结果。"); return; }
      if ((data.fixture !== undefined && data.fixture !== fixture) || (fixture !== "basic" && (data.fixture !== fixture || typeof data.matchedExpectation !== "boolean" || typeof data.expectedApproved !== "boolean"))) { setError("未收到与本次案例对应的检查结果。"); return; }
      setResult(data);
    } catch { setError("检查连接中断，尚未确认服务状态。"); }
    finally { setRunning(false); }
  }

  return <main className="mx-auto max-w-2xl p-6 sm:p-10">
    <Link href="/admin" className="text-sm text-accent">返回活动后台</Link>
    <h1 className="mt-6 text-2xl font-semibold">检查讲解服务</h1>
    <p className="mt-3 text-sm leading-relaxed text-ink-3">使用固定的虚构资料检查文字生成和内容审核，不读取学生稿件。检查不会更改活动使用的模型或审核设置。</p>
    <p className="mt-3 text-sm">活动当前模型：{configuredModel}</p>
    <p className="mt-1 text-sm">当前审核方式：{Object.prototype.hasOwnProperty.call(MODES, configuredReviewMode) ? MODES[configuredReviewMode as keyof typeof MODES] : "配置待核对"}</p>
    <p className="mt-1 text-sm">当前审核强度：{Object.prototype.hasOwnProperty.call(PROFILES, configuredReviewProfile) ? PROFILES[configuredReviewProfile as keyof typeof PROFILES] : "配置待核对"}</p>
    <label className="mt-6 block text-sm" htmlFor="check-model">本次检查模型</label>
    <select id="check-model" value={model} onChange={(event) => { setModel(event.target.value); if (event.target.value !== "claude-sonnet-5") setReviewProfile("default"); if (QWEN_MODELS.includes(event.target.value)) setReviewMode("json_schema"); setResult(null); setError(""); }} disabled={running} className="mt-2 w-full rounded-xl border border-white/10 bg-surface-2 p-3">
      {MODELS.map((value) => <option key={value} value={value}>{value}</option>)}
    </select>
    <div className="mt-4 grid grid-cols-2 gap-3">
      <label className="text-sm">检查语言<select aria-label="检查语言" value={language} onChange={(event) => { setLanguage(event.target.value); setResult(null); setError(""); }} disabled={running} className="mt-2 w-full rounded-xl border border-white/10 bg-surface-2 p-3"><option value="zh">中文</option><option value="en">English</option></select></label>
      <label className="text-sm">审核方式<select aria-label="审核方式" value={reviewMode} onChange={(event) => { setReviewMode(event.target.value); setResult(null); setError(""); }} disabled={running} className="mt-2 w-full rounded-xl border border-white/10 bg-surface-2 p-3">{Object.entries(MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-sm">测试案例<select aria-label="测试案例" value={fixture} onChange={(event) => { setFixture(event.target.value as keyof typeof FIXTURES); setResult(null); setError(""); }} disabled={running} className="mt-2 w-full rounded-xl border border-white/10 bg-surface-2 p-3">{Object.entries(FIXTURES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm">本次审核强度<select aria-label="本次审核强度" value={reviewProfile} onChange={(event) => { setReviewProfile(event.target.value as keyof typeof PROFILES); setResult(null); setError(""); }} disabled={running || model !== "claude-sonnet-5"} className="mt-2 w-full rounded-xl border border-white/10 bg-surface-2 p-3">{Object.entries(PROFILES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <p className="mt-2 text-xs leading-relaxed text-ink-3">复杂案例只审核固定候选回答；应拒绝的案例被正确拒绝才算检查成功。中等、较低强度仅供 Sonnet 5 本次对照检查，“供应商默认”不指定强度。</p>
    <button type="button" className="btn-primary mt-4" onClick={check} disabled={running}>{running ? fixture === "basic" ? "正在检查生成与审核…" : "正在检查固定案例审核…" : "开始检查"}</button>
    <div role="status" aria-live="polite" className="mt-6">
      {error && <p className="text-sm text-warning">{error}</p>}
      {result && <>
        <p className="font-medium">{(result.matchedExpectation ?? result.pass) ? fixture === "basic" ? "文字生成和审核检查均通过" : "审核结果符合测试预期" : "本次检查未符合全部预期"}</p>
        {typeof result.expectedApproved === "boolean" && <p className="mt-2 text-sm">预期结果：{result.expectedApproved ? "应通过审核" : "应拒绝"}。实际结果：{result.review?.status === "ok" && result.review.pass === true ? "已通过审核" : result.review?.status === "ok" && result.review.pass === false && result.review.reviewReason === "model_rejection" ? "已拒绝" : "未获得有效审核结论"}。</p>}
        <ul className="mt-4 space-y-3">
          {([['文字生成', result.generation], ['内容审核', result.review]] as const).map(([label, step]) => {
            const status = step?.status && Object.prototype.hasOwnProperty.call(STATUS, step.status) ? STATUS[step.status] : "未获得有效结果";
            const kindValue = step?.failure?.kind || step?.upstreamKind || step?.kind;
            const kind = kindValue && Object.prototype.hasOwnProperty.call(KIND, kindValue) ? KIND[kindValue] : "";
            const codeValue = step?.failure?.code;
            const code = codeValue && Object.prototype.hasOwnProperty.call(FAILURE_CODES, codeValue) ? FAILURE_CODES[codeValue] : "";
            const seconds = typeof step?.elapsedMs === "number" && Number.isFinite(step.elapsedMs) ? `${(step.elapsedMs / 1000).toFixed(1)} 秒` : "";
            const httpStatus = step?.failure?.httpStatus ?? step?.httpStatus;
            const http = Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? ` · HTTP ${httpStatus}` : "";
            const format = step?.formatIssue && Object.prototype.hasOwnProperty.call(FORMAT_ISSUES, step.formatIssue) ? FORMAT_ISSUES[step.formatIssue] : "";
            const skippedGeneration = label === "文字生成" && step?.status === "skipped" && fixture !== "basic";
            const rejected = label === "内容审核" && step?.status === "ok" && step.pass === false && step.reviewReason === "model_rejection";
            const criteria = rejected && Array.isArray(step?.rejectedCriteria) ? Object.keys(CRITERIA).filter((key) => (step.rejectedCriteria as unknown[]).includes(key)).map((key) => CRITERIA[key]) : [];
            return <li key={label} className="rounded-xl bg-surface-2 p-4 text-sm"><b>{label}：{skippedGeneration ? "本案例无需生成" : step?.pass === true ? "通过" : rejected ? "已拒绝" : "未获得通过结论"}</b><p className="mt-1 text-ink-3">{skippedGeneration ? "直接审核固定候选回答" : status}{kind ? ` · ${kind}` : ""}{code ? ` · ${code}` : ""}{format ? ` · ${format}` : ""}{http}{seconds ? ` · ${seconds}` : ""}</p>{criteria.length > 0 && <p className="mt-1 text-ink-3">未满足：{criteria.join("、")}</p>}</li>;
          })}
        </ul>
      </>}
    </div>
  </main>;
}
