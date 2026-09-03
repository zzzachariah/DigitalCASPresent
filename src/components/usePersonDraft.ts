"use client";

import { useCallback, useMemo, useState } from "react";
import type { Person, Section } from "@/lib/types";
import { readJson } from "@/lib/http";
import type { EditorApi, SavePayload } from "@/lib/editor-api";
import type { Draft } from "./DraftPreview";

// ─────────────────────────────────────────────────────────────────────
// All editor state + actions for one person, shared by the single-page
// admin editor (PersonEditor) and the paged student wizard (SubmitWizard).
// ─────────────────────────────────────────────────────────────────────

// Must match the server's magic-byte whitelist (lib/image.ts). Listing the
// types explicitly (not image/*) also makes iOS convert HEIC → JPEG on pick.
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHOTO_MAX = 8 * 1024 * 1024;

export function emptySection(): Section {
  return { id: Math.random().toString(36).slice(2, 10), title: "", hint: "", content: "" };
}

/** Poll an async generation task (cartoon / loop video) until the server
 *  returns `doneKey`, reports an error, or we give up (~4 min). */
async function pollTask(
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

export function usePersonDraft({ person, api, admin }: { person: Person | null; api: EditorApi; admin: boolean }) {
  // Once a brand-new record has been created, further saves UPDATE it — so
  // a failed photo upload can be retried without creating a duplicate.
  const [created, setCreated] = useState<Person | null>(null);
  const existing = person ?? created;

  const [name, setName] = useState(person?.name ?? "");
  const [subtitle, setSubtitle] = useState(person?.subtitle ?? "");
  const [gender, setGender] = useState<"" | "male" | "female">(person?.gender ?? "");
  const [language, setLanguage] = useState<Person["language"]>(person?.language ?? "auto");
  const [script, setScript] = useState(person?.script ?? "");
  const [sections, setSections] = useState<Section[]>(person?.sections ?? []);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(person?.photoUrl);

  const [cartoonUrl, setCartoonUrl] = useState<string | undefined>(person?.cartoonUrl);
  const [cartooning, setCartooning] = useState(false);
  const [loopVideoUrl, setLoopVideoUrl] = useState<string | undefined>(person?.loopVideoUrl);
  const [loopGenerating, setLoopGenerating] = useState(false);
  const [pregenerating, setPregenerating] = useState<Set<string>>(new Set());
  const [bulkPregenerating, setBulkPregenerating] = useState(false);
  const [answersOpen, setAnswersOpen] = useState<Set<string>>(new Set());

  const [parsing, setParsing] = useState(false);
  const [sectioning, setSectioning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fail = useCallback((e: unknown, fallback: string) => {
    setError(e instanceof Error ? e.message : fallback);
  }, []);

  // ── sections ──
  const updateSection = useCallback((id: string, patch: Partial<Section>) => {
    // Editing the title/content invalidates any pre-generated answer.
    const invalidatesCache = "title" in patch || "content" in patch;
    setSections((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, ...patch, cachedAnswers: invalidatesCache ? undefined : s.cachedAnswers } : s
      )
    );
  }, []);
  const updateCachedAnswer = useCallback((id: string, key: "en" | "zh" | "bilingual", text: string) => {
    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, cachedAnswers: { ...(s.cachedAnswers || {}), [key]: text } } : s))
    );
  }, []);
  const toggleAnswersOpen = useCallback((id: string) => {
    setAnswersOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const removeSection = useCallback((id: string) => setSections((prev) => prev.filter((s) => s.id !== id)), []);
  const moveSection = useCallback((id: string, dir: -1 | 1) => {
    setSections((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);
  const addSection = useCallback(() => setSections((p) => [...p, emptySection()]), []);

  // ── script ──
  const pickScriptFile = useCallback(
    async (file: File) => {
      setError("");
      setParsing(true);
      try {
        setScript(await api.parse(file));
      } catch (e) {
        fail(e, "解析失败");
      } finally {
        setParsing(false);
      }
    },
    [api, fail]
  );

  /** Returns true when sections were produced. */
  const autoSection = useCallback(async (): Promise<boolean> => {
    if (!script.trim()) {
      setError("请先粘贴或上传讲稿 · Paste or upload your script first");
      return false;
    }
    setError("");
    setSectioning(true);
    try {
      setSections(await api.autosection(script));
      return true;
    } catch (e) {
      fail(e, "分段失败");
      return false;
    } finally {
      setSectioning(false);
    }
  }, [api, fail, script]);

  // ── photo ──
  const pickPhoto = useCallback((file: File): boolean => {
    if (!PHOTO_TYPES.includes(file.type)) {
      setError("只支持 JPG / PNG / WebP 图片 · Only JPG, PNG or WebP images");
      return false;
    }
    if (file.size > PHOTO_MAX) {
      setError("照片过大（≤8MB）· Photo too large (max 8MB)");
      return false;
    }
    setError("");
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    return true;
  }, []);

  // ── admin-only generation ──
  const generateCartoon = useCallback(async () => {
    if (!existing) return;
    setError("");
    setCartooning(true);
    try {
      const startRes = await fetch(`/api/admin/people/${existing.id}/cartoon`, { method: "POST" });
      const startData = await readJson(startRes);
      if (!startRes.ok) throw new Error(startData.error || "卡通发起失败");
      setCartoonUrl(
        await pollTask(`/api/admin/people/${existing.id}/cartoon?taskId=${encodeURIComponent(startData.taskId)}`, "cartoonUrl")
      );
    } catch (e) {
      fail(e, "卡通生成失败");
    } finally {
      setCartooning(false);
    }
  }, [existing, fail]);

  const generateLoopVideo = useCallback(async () => {
    if (!existing) return;
    setError("");
    setLoopGenerating(true);
    try {
      const startRes = await fetch(`/api/admin/people/${existing.id}/loop-video`, { method: "POST" });
      const startData = await readJson(startRes);
      if (!startRes.ok) throw new Error(startData.error || "循环视频发起失败");
      setLoopVideoUrl(
        await pollTask(`/api/admin/people/${existing.id}/loop-video?taskId=${encodeURIComponent(startData.taskId)}`, "loopVideoUrl")
      );
    } catch (e) {
      fail(e, "循环视频生成失败");
    } finally {
      setLoopGenerating(false);
    }
  }, [existing, fail]);

  const pregenerate = useCallback(
    async (sectionId?: string) => {
      if (!existing) return;
      setError("");
      if (sectionId) setPregenerating((prev) => new Set(prev).add(sectionId));
      else setBulkPregenerating(true);
      try {
        const res = await fetch(`/api/admin/people/${existing.id}/pregenerate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sectionId ? { sectionId } : {}),
        });
        const data = await readJson(res);
        if (!res.ok) throw new Error(data.error || "预生成失败");
        const updated = data.sections as Section[];
        setSections((prev) =>
          prev.map((s) => {
            const u = updated.find((x) => x.id === s.id);
            return u ? { ...s, cachedAnswers: u.cachedAnswers } : s;
          })
        );
      } catch (e) {
        fail(e, "预生成失败");
      } finally {
        if (sectionId) {
          setPregenerating((prev) => {
            const next = new Set(prev);
            next.delete(sectionId);
            return next;
          });
        } else {
          setBulkPregenerating(false);
        }
      }
    },
    [existing, fail]
  );

  // ── save ──
  /** Create or update, then upload the photo. Returns the saved person, or
   *  null after setting `error`. */
  const save = useCallback(async (): Promise<Person | null> => {
    setError("");
    if (!name.trim()) {
      setError("请填写姓名 · Name is required");
      return null;
    }
    if (!script.trim()) {
      setError("请提供讲稿 · Script is required");
      return null;
    }
    setSaving(true);
    try {
      const payload: SavePayload = { name, subtitle, gender, language, script, sections };
      if (admin) {
        if (cartoonUrl) payload.cartoonUrl = cartoonUrl;
        if (loopVideoUrl) payload.loopVideoUrl = loopVideoUrl;
      }
      let saved: Person = existing ? await api.update(existing.id, payload) : await api.create(payload);
      if (!existing) setCreated(saved);
      if (photoFile) {
        const photoUrl = await api.uploadPhoto(saved.id, photoFile);
        saved = { ...saved, photoUrl };
        setPhotoFile(null);
      }
      return saved;
    } catch (e) {
      fail(e, "保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }, [admin, api, cartoonUrl, existing, fail, gender, language, loopVideoUrl, name, photoFile, script, sections, subtitle]);

  const draft = useMemo<Draft>(() => ({ name, subtitle, photo: photoPreview, sections }), [name, subtitle, photoPreview, sections]);

  return {
    existing,
    isEdit: !!existing,
    name, setName,
    subtitle, setSubtitle,
    gender, setGender,
    language, setLanguage,
    script, setScript,
    sections, setSections,
    photoFile, photoPreview,
    cartoonUrl, cartooning,
    loopVideoUrl, loopGenerating,
    pregenerating, bulkPregenerating, answersOpen,
    parsing, sectioning, saving,
    error, setError,
    updateSection, updateCachedAnswer, toggleAnswersOpen, removeSection, moveSection, addSection,
    pickScriptFile, autoSection, pickPhoto,
    generateCartoon, generateLoopVideo, pregenerate,
    save,
    draft,
  };
}

export type PersonDraft = ReturnType<typeof usePersonDraft>;
