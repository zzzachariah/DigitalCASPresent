"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Person, Section } from "@/lib/types";
import { readJson } from "@/lib/http";
import { generateAsset, type EditorApi, type SavePayload } from "@/lib/editor-api";
import { downscaleImage } from "@/lib/image-client";
import { LIMITS, defaultSectionTitle } from "@/lib/validate";
import type { Draft } from "./DraftPreview";

// ─────────────────────────────────────────────────────────────────────
// All editor state + actions for one person, shared by the single-page
// admin editor (PersonEditor) and the paged student wizard (SubmitWizard).
// ─────────────────────────────────────────────────────────────────────

// Must match the server's magic-byte whitelist (lib/image.ts). Listing the
// types explicitly (not image/*) also makes iOS convert HEIC → JPEG on pick.
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHOTO_MAX = 20 * 1024 * 1024; // originals are downscaled before upload

export function emptySection(): Section {
  return { id: Math.random().toString(36).slice(2, 10), title: "", hint: "", content: "" };
}

/** Offline fallback for the AI split: one part per blank-line paragraph,
 *  extras folded into the last part so the count stays within limits. */
export function paragraphSections(script: string): Section[] {
  const paras = script.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  if (paras.length > LIMITS.sections) {
    paras.splice(LIMITS.sections - 1, paras.length, paras.slice(LIMITS.sections - 1).join("\n\n"));
  }
  return paras.map((content, i) => ({ ...emptySection(), title: defaultSectionTitle(i, content), content }));
}

export function usePersonDraft({
  person,
  api,
  admin,
  onCreated,
}: {
  person: Person | null;
  api: EditorApi;
  admin: boolean;
  /** Fires as soon as a brand-new record exists on the server (before the
   *  photo upload), so the caller can remember its id / edit token. */
  onCreated?: (p: Person) => void;
}) {
  // Once a brand-new record has been created, further saves UPDATE it — so
  // a failed photo upload can be retried without creating a duplicate.
  const [created, setCreated] = useState<Person | null>(null);
  const existing = person ?? created;
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const addedIdRef = useRef<string | null>(null);

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
        s.id === id
          ? invalidatesCache
            ? { ...s, ...patch, cachedAnswers: undefined, cachedAudio: undefined, cachedSuggestions: undefined }
            : { ...s, ...patch }
          : s
      )
    );
  }, []);
  const updateCachedAnswer = useCallback((id: string, key: "en" | "zh" | "bilingual", text: string) => {
    // Edited text → the pre-generated audio for that language is stale.
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const cachedAudio = { ...(s.cachedAudio || {}) };
        delete cachedAudio[key];
        return { ...s, cachedAnswers: { ...(s.cachedAnswers || {}), [key]: text }, cachedAudio };
      })
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
  /** Append an empty part; returns its id so the UI can focus it. */
  const addSection = useCallback((): string => {
    const s = emptySection();
    addedIdRef.current = s.id;
    setSections((p) => [...p, s]);
    return s.id;
  }, []);
  /** A restored draft that had already been created on the server continues
   *  as an update of that record. */
  const adoptCreated = useCallback((p: Person) => setCreated(p), []);

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
      const why = e instanceof Error && e.message ? e.message : "分段失败";
      // First split failed (AI down, rate-limited…): never leave the student
      // stuck — split by paragraphs locally and say so. A re-split over parts
      // they already edited must not silently replace them, so no fallback there.
      const parts = sections.length === 0 ? paragraphSections(script) : [];
      if (parts.length) {
        setSections(parts);
        setError(`AI 分段暂时不可用（${why}）。已先按段落切好，可以手动调整，或稍后再点「重新分段」。`);
        return true;
      }
      setError(why);
      return false;
    } finally {
      setSectioning(false);
    }
  }, [api, script, sections.length]);

  // ── photo ──
  const pickPhoto = useCallback(async (file: File): Promise<boolean> => {
    if (!PHOTO_TYPES.includes(file.type)) {
      setError("只支持 JPG / PNG / WebP 图片 · Only JPG, PNG or WebP images");
      return false;
    }
    if (file.size > PHOTO_MAX) {
      setError("照片过大（≤20MB）· Photo too large");
      return false;
    }
    setError("");
    // Show the original immediately; upload the downscaled copy.
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoFile(await downscaleImage(file));
    return true;
  }, []);

  // ── admin-only generation ──
  const generateCartoon = useCallback(async () => {
    if (!existing) return;
    setError("");
    setCartooning(true);
    try {
      setCartoonUrl(await generateAsset(existing.id, "cartoon"));
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
      setLoopVideoUrl(await generateAsset(existing.id, "loop-video"));
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
        // Only adopt caches for parts whose text matches what the server
        // generated from — an unsaved local edit keeps its "not generated" state.
        setSections((prev) =>
          prev.map((s) => {
            const u = updated.find((x) => x.id === s.id);
            return u && u.title === s.title && u.content === s.content
              ? { ...s, cachedAnswers: u.cachedAnswers, cachedAudio: u.cachedAudio, cachedSuggestions: u.cachedSuggestions }
              : s;
          })
        );
        if (data.failed) setError(`有 ${data.failed} 个部分没有生成成功，可以再点一次重试。`);
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
      if (!existing) {
        setCreated(saved);
        onCreated?.(saved);
      }
      if (photoFile) {
        try {
          setUploadProgress(0);
          const photoUrl = await api.uploadPhoto(saved.id, photoFile, setUploadProgress);
          saved = { ...saved, photoUrl };
          setPhotoFile(null);
        } catch (e) {
          // The record is saved; only the photo is missing. Say so, and let
          // the next save retry just the upload (it updates, never duplicates).
          const why = e instanceof Error ? e.message : "照片上传失败";
          setError(`资料已保存，但照片没有传上：${why}。请再点一次提交，只会重试上传，不会重复创建。`);
          return null;
        } finally {
          setUploadProgress(null);
        }
      }
      return saved;
    } catch (e) {
      fail(e, "保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }, [admin, api, cartoonUrl, existing, fail, gender, language, loopVideoUrl, name, onCreated, photoFile, script, sections, subtitle]);

  const draft = useMemo<Draft>(() => ({ name, subtitle, photo: photoPreview, sections }), [name, subtitle, photoPreview, sections]);

  /** True when the form differs from the record it started from. */
  const dirty = useMemo(() => {
    if (photoFile) return true;
    const base = person;
    if (!base) return !!(name.trim() || subtitle.trim() || script.trim() || sections.length);
    const same =
      name === base.name &&
      (subtitle || "") === (base.subtitle || "") &&
      (gender || "") === (base.gender || "") &&
      language === base.language &&
      script === base.script &&
      JSON.stringify(sections.map((s) => [s.id, s.title, s.hint || "", s.content])) ===
        JSON.stringify(base.sections.map((s) => [s.id, s.title, s.hint || "", s.content]));
    return !same;
  }, [gender, language, name, person, photoFile, script, sections, subtitle]);

  return {
    existing,
    isEdit: !!existing,
    dirty,
    uploadProgress,
    lastAddedId: addedIdRef,
    adoptCreated,
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
