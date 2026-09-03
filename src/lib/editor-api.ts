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
  /** Upload the portrait → stored photo URL. */
  uploadPhoto(id: string, file: File): Promise<string>;
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
  async uploadPhoto(id, file) {
    return (await call(`/api/admin/people/${id}/photo`, { method: "POST", body: fileForm("photo", file) }, "照片上传失败")).photoUrl;
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
    async uploadPhoto(id, file) {
      return (
        await call(
          `/api/submit/${id}/photo`,
          { method: "POST", headers: auth(), body: fileForm("photo", file) },
          "照片上传失败"
        )
      ).photoUrl;
    },
  };
}
