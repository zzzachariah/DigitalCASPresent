import { randomUUID } from "crypto";
import type { AnswerLang, Person } from "./types";

export interface AudioAsset { buffer: Buffer; contentType: string }
export class AudioReadError extends Error {
  constructor(public code: "missing" | "invalid" | "unavailable") { super(`Audio ${code}`); }
}
class AudioPreparationError extends Error {
  providerCode?: string;
  constructor(public phase: string, cause: unknown) {
    super(`${phase} failed`);
    const message = cause instanceof Error ? cause.message : "";
    this.providerCode = message.match(/"code"\s*:\s*"?(\d+)/)?.[1];
  }
}
export interface PreparationDependencies {
  getPerson: (id: string) => Promise<Person | null>;
  updatePerson: (id: string, patch: Partial<Person>) => Promise<Person | null>;
  tts: (text: string, gender: Person["gender"]) => Promise<string>;
  readAudio: (url: string) => Promise<AudioAsset>;
  saveAudio: (id: string, key: string, buffer: Buffer, ext: string) => Promise<string>;
}
export interface PreparationResult {
  sectionId: string;
  language: AnswerLang;
  status: "prepared" | "skipped" | "failed";
  reason: string;
  audioUrl?: string;
  bytes?: number;
  elapsedMs: number;
  providerCode?: string;
}

/** Check the actual payload, not just a 200 response or an audio MIME label. */
export function audioExtension(asset: AudioAsset): string {
  const b = asset.buffer;
  const contentType = asset.contentType.split(";")[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new AudioReadError("invalid");
  if (b.length < 12) throw new AudioReadError("invalid");
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (b.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (b.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
  throw new AudioReadError("invalid");
}

/** A unique key protects earlier files on BOTH Blob and filesystem drivers.
 *  Read the permanent copy back before it can become a visitor-facing URL. */
export async function createPermanentNarration(
  person: Person, sectionId: string, language: AnswerLang, text: string,
  dependencies: PreparationDependencies,
): Promise<{ url: string; bytes: number }> {
  let phase = "tts";
  try {
    const temporaryUrl = await dependencies.tts(text, person.gender);
    phase = "download";
    const asset = await dependencies.readAudio(temporaryUrl);
    const ext = audioExtension(asset);
    const key = `${sectionId.slice(0, 32)}-${language}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    phase = "audio_save";
    const url = await dependencies.saveAudio(person.id, key, asset.buffer, ext);
    phase = "audio_verification";
    const saved = await dependencies.readAudio(url);
    audioExtension(saved);
    if (!saved.buffer.equals(asset.buffer)) throw new Error("Permanent audio verification failed");
    return { url, bytes: saved.buffer.length };
  } catch (error) { throw new AudioPreparationError(phase, error); }
}

/** Prepare exactly one cached variant. No text generation and no deletion.
 *  All awaits finish before a fresh, narrowly merged record is written. */
export async function prepareExistingNarration(
  personId: string, sectionId: string, language: AnswerLang,
  dependencies: PreparationDependencies,
): Promise<PreparationResult> {
  const start = Date.now();
  const result = (status: PreparationResult["status"], reason: string, extra: Partial<PreparationResult> = {}): PreparationResult =>
    ({ sectionId, language, status, reason, elapsedMs: Date.now() - start, ...extra });
  let phase = "read";
  try {
    const original = await dependencies.getPerson(personId);
    if (!original) return result("failed", "person_missing");
    const section = original.sections.find((s) => s.id === sectionId);
    if (!section) return result("failed", "section_missing");
    const text = section.cachedAnswers?.[language];
    if (!text?.trim()) return result("failed", "cached_text_missing");
    const previousAudio = section.cachedAudio?.[language];
    if (previousAudio) {
      try {
        const existing = await dependencies.readAudio(previousAudio);
        audioExtension(existing);
        return result("skipped", "healthy_audio", { audioUrl: previousAudio, bytes: existing.buffer.length });
      } catch (error) {
        // Only definite absence/corruption justifies new paid synthesis.
        if (!(error instanceof AudioReadError) || error.code === "unavailable") {
          return result("failed", "existing_audio_unverified");
        }
      }
    }
    phase = "audio_preparation";
    const prepared = await createPermanentNarration(original, sectionId, language, text, dependencies);
    phase = "source_recheck";
    const fresh = await dependencies.getPerson(personId);
    if (!fresh) return result("failed", "person_missing");
    const current = fresh.sections.find((s) => s.id === sectionId);
    if (!current || current.title !== section.title || current.content !== section.content ||
        current.cachedAnswers?.[language] !== text || fresh.script !== original.script || fresh.gender !== original.gender) {
      return result("failed", "source_changed");
    }
    if (current.cachedAudio?.[language] !== previousAudio) return result("skipped", "audio_changed_during_preparation");
    const sections = fresh.sections.map((s) => s.id === sectionId
      ? { ...s, cachedAudio: { ...s.cachedAudio, [language]: prepared.url } } : s);
    phase = "persist";
    const updated = await dependencies.updatePerson(personId, { sections });
    if (!updated) return result("failed", "person_missing");
    phase = "persist_verification";
    const verified = await dependencies.getPerson(personId);
    const savedSection = verified?.sections.find((s) => s.id === sectionId);
    if (!verified || verified.script !== fresh.script || savedSection?.cachedAnswers?.[language] !== text ||
        savedSection.cachedAudio?.[language] !== prepared.url) return result("failed", "persist_unverified");
    return result("prepared", "saved_and_verified", { audioUrl: prepared.url, bytes: prepared.bytes });
  } catch (error) {
    // Provider diagnostics stay bounded and never expose URLs, keys or scripts.
    if (error instanceof AudioPreparationError) phase = error.phase;
    const providerCode = error instanceof AudioPreparationError ? error.providerCode : undefined;
    return result("failed", `${phase}_failed`, providerCode ? { providerCode } : {});
  }
}

/** Serializes this process's requests for a person; Blob has no record CAS.
 *  Operators must also avoid parallel edits/jobs from separate instances. */
const activePreparations = new Set<string>();
export function beginPreparation(id: string): (() => void) | null {
  if (activePreparations.has(id)) return null;
  activePreparations.add(id);
  return () => { activePreparations.delete(id); };
}
