import type { Person, Section } from "./types";
import { readJson } from "./http";

// ─────────────────────────────────────────────────────────────────────
// Client-side API used by the person editor. The same form is used by the
// admin backend and by students submitting their own talk; only the
// endpoints (and the credential) differ, so the editor takes one of these.
// ─────────────────────────────────────────────────────────────────────

export interface SavePayload {
  name: string;
  subtitle: string;
  gender: "" | "male" | "female";
  language: Person["language"];
  script: string;
  sections: Section[];
  /** Admin only — re-asserted on save so a stale save can't clobber them. */
  cartoonUrl?: string;
  loopVideoUrl?: string;
}

export interface EditorApi {
  /** Upload a .txt/.pdf/.docx → extracted text. */
  parse(file: File): Promise<string>;
  /** Ask the AI to split a script into sections. */
  autosection(script: string): Promise<Section[]>;
  create(payload: SavePayload): Promise<Person>;
  update(id: string, payload: SavePayload): Promise<Person>;
  /** Upload the portrait → stored photo URL. `onProgress` gets 0–1. */
  uploadPhoto(id: string, file: File, onProgress?: (p: number) => void): Promise<string>;
}

/** Multipart upload with progress (fetch can't report upload progress). */
function uploadWithProgress(
  url: string,
  field: string,
  file: File,
  headers: Record<string, string>,
  onProgress: ((p: number) => void) | undefined,
  fallback: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error("网络错误，请重试 · Network error"));
    xhr.ontimeout = () => reject(new Error("上传超时，请重试 · Upload timed out"));
    xhr.timeout = 120_000;
    xhr.onload = () => {
      let data: any = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        data = { error: `${fallback} (${xhr.status})` };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `${fallback} (${xhr.status})`));
    };
    xhr.send(fileForm(field, file));
  });
}

/** Poll an async generation task (cartoon / loop video) until the server
 *  returns `doneKey`, reports an error, or we give up (~4 min). */
export async function pollTask(
  url: string,
  doneKey: "cartoonUrl" | "loopVideoUrl",
  everyMs = 3000,
  maxTries = 80
): Promise<string> {
  let lastStatus = "";
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, everyMs));
    const res = await fetch(url);
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "生成失败");
    if (typeof data[doneKey] === "string" && data[doneKey]) return data[doneKey];
    if (data.status) lastStatus = String(data.status);
  }
  throw new Error(`生成超时，请重试${lastStatus ? `（最后状态: ${lastStatus}）` : ""}`);
}

/** Start + poll a cartoon or loop-video render for a person. */
export async function generateAsset(personId: string, kind: "cartoon" | "loop-video"): Promise<string> {
  const startRes = await fetch(`/api/admin/people/${personId}/${kind}`, { method: "POST" });
  const startData = await readJson(startRes);
  if (!startRes.ok) throw new Error(startData.error || (kind === "cartoon" ? "卡通发起失败" : "循环视频发起失败"));
  return pollTask(
    `/api/admin/people/${personId}/${kind}?taskId=${encodeURIComponent(startData.taskId)}`,
    kind === "cartoon" ? "cartoonUrl" : "loopVideoUrl"
  );
}

async function call(url: string, init: RequestInit, fallback: string): Promise<any> {
  const res = await fetch(url, init);
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || `${fallback} (${res.status})`);
  return data;
}

function jsonInit(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function fileForm(field: string, file: File): FormData {
  const fd = new FormData();
  fd.append(field, file);
  return fd;
}

/** Backend (cookie-authenticated) endpoints. */
export const adminApi: EditorApi = {
  async parse(file) {
    return (await call("/api/admin/parse", { method: "POST", body: fileForm("file", file) }, "解析失败")).text;
  },
  async autosection(script) {
    return (await call("/api/admin/autosection", jsonInit("POST", { script }), "分段失败")).sections;
  },
  async create(payload) {
    return (await call("/api/admin/people", jsonInit("POST", payload), "保存失败")).person;
  },
  async update(id, payload) {
    return (await call(`/api/admin/people/${id}`, jsonInit("PUT", payload), "保存失败")).person;
  },
  async uploadPhoto(id, file, onProgress) {
    return (await uploadWithProgress(`/api/admin/people/${id}/photo`, "photo", file, {}, onProgress, "照片上传失败")).photoUrl;
  },
};

/** The student's credentials, shared between the API and the page: create()
 *  fills them in from the server's response; later calls send `current`. */
export interface StudentTokens {
  /** Edit token (secret). */
  current: string | null;
  /** View-only token for the preview link. */
  preview: string | null;
}

/** Student self-submission endpoints. */
export function studentApi(token: StudentTokens): EditorApi {
  const auth = (): Record<string, string> => (token.current ? { "x-edit-token": token.current } : {});
  return {
    async parse(file) {
      return (await call("/api/submit/parse", { method: "POST", body: fileForm("file", file) }, "解析失败")).text;
    },
    async autosection(script) {
      return (await call("/api/submit/autosection", jsonInit("POST", { script }), "分段失败")).sections;
    },
    async create(payload) {
      const data = await call("/api/submit", jsonInit("POST", payload), "提交失败");
      token.current = data.editToken;
      token.preview = data.previewToken ?? null;
      return data.person;
    },
    async update(id, payload) {
      return (await call(`/api/submit/${id}`, jsonInit("PUT", payload, auth()), "保存失败")).person;
    },
    async uploadPhoto(id, file, onProgress) {
      return (await uploadWithProgress(`/api/submit/${id}/photo`, "photo", file, auth(), onProgress, "照片上传失败")).photoUrl;
    },
  };
}
