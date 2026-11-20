# Privacy and AI operating state

## November 21, 2026 activity-wide approval and preparation progress

The organizer explicitly approved A2E processing for all participants in this activity, including future submissions. `A2E_PROCESSING_APPROVED=true` enables the existing person-bound photo/cartoon/video operations and reviewed, limited narration for those records. Individual approval lists remain a compatibility fallback, not an onboarding requirement. `EXTERNAL_AI_PROCESSING_APPROVED=false` continues to keep D-ID and arbitrary unscoped media processing closed. This approval does not fabricate student consent receipts or allow raw manuscripts to be sent as speech input; ordinary provider voices are used, not voice cloning. The public privacy notice now states the activity-wide scope.

Preparation handles one section/language at a time and emits only fixed generation/review/speech/persistence phase names before its final result. The admin shows a complete per-step history, per-language saved text/audio counts and exact missing variants. A service failure is not described as a content rejection, and a partial run is never called fully ready. Review output has a 512-token ceiling; truncated or malformed responses still fail closed. Safe HTTP/error categories can be diagnosed using fixed fictional material at `/admin/service-check` without reading student manuscripts or exposing provider messages.

Review requests use a fixed five-boolean response schema (`AI_REVIEW_FORMAT=json_schema`), rather than relying only on prose instructions to request JSON. The same five criteria still must all be true. A forced fixed-name tool is available only as an explicitly selected compatibility mode; no review rejection triggers a fallback or automatic retry. Diagnostics support fixed fictional Chinese and English examples, and distinguish framing, malformed JSON, incorrect fields and incorrect value types without exposing model output.

The earlier approvals below are historical and are superseded by this activity-wide scope.

## November 21, 2026 narration repair

The organizer subsequently requested narration repair and live verification for the same participant. Production `A2E_SPEECH_APPROVED_PERSON_IDS` separately identifies this approved record. This does not expand the photo list or authorize other participants. Only reviewed exhibition explanations reach A2E TTS; raw manuscripts and source sections are not TTS input. Ordinary provider voices are used, not voice cloning. Global external processing and D-ID remain closed.

Admin preparation processes each section/language variant sequentially, verifies persisted audio and provides an authenticated preview. The underlying storage uses immutable audio keys and reads the private copy back before recording completion. Historical audio remains inaccessible to ordinary visitors; live narration is generated only after the answer passes review.

## November 21, 2026 photo-processing scope

Initially, the organizer separately authorized one identified participant's photo for A2E cartoon and ambient-video generation. `A2E_PHOTO_APPROVED_PERSON_IDS` identified that record. The later activity-wide approval above now governs photo and reviewed speech processing; D-ID remains closed.

Admin diagnostics distinguish a deliberate privacy block from missing provider configuration. Photo routes read authorized private image bytes directly, never forward edit/preview credentials, and bind polling tokens to the participant and task purpose. Upload object names use content hashes to avoid collisions. The admin preparation flow can continue with explicit text-only processing when media is unavailable, without claiming missing assets are ready.

## November 19, 2026 verification

### November 21 preparation follow-up

The organizer's activity-wide A2E approval now covers all current and future submissions via `A2E_PROCESSING_APPROVED=true`; individual ID lists are only a fallback when this global flag is off. In production, `AI_REVIEW_FORMAT=tool` is explicitly selected after Chinese and English synthetic checks. The fixed five-boolean return is validated and no tool is executed. Native JSON-schema mode passed short probes but still returned malformed reviews for some real sections, so it is not used as an automatic fallback.

One-key preparation may make one concise revision when a valid review rejects only grounding or privacy. The replacement uses the same selected-section source, receives the full independent review, and is paired with audio only after approval and durable storage. Service errors, malformed reviews, other rejected criteria, and unsuccessful revisions remain incomplete. The audio-only action never rewrites text. Each failed narration variant can be retried separately without repeating completed variants.

The original configuration used `claude-opus-4-8` through the old `.com` endpoint and returned a no-channel error during an earlier synthetic request. The organizer subsequently prioritized fast Anthropic-family replies. Production configuration now selects `AI_MODEL=AI_MODEL_LIVE=claude-sonnet-5` and `AI_BASE_URL=https://cf.api.fan/v1`, the production endpoint recommended in the logged-in Packy console. These are relay identifiers, not independent attestation of the upstream model.

On November 19, a fixed fictional compass question using the existing CAS key completed in **3,448 ms**, and the application's five-field safety reviewer accepted a fixed correct answer in **3,428 ms** (6,887 ms total). Both returned HTTP 200. The same Haiku probe returned HTTP 404. This is a small connectivity/format check, not a comprehensive quality evaluation or latency guarantee. No student manuscript, photo or record was used.

After being told about upstream processing and unconfirmed upstream retention, the organizer explicitly approved Packy and upstream model processing. `AI_PROCESSING_APPROVED=true` enables text AI; `EXTERNAL_AI_PROCESSING_APPROVED=false` keeps A2E/D-ID and external media processing closed. Student consent must also use the current version: old records receive a safe fallback until the author reviews the new notice and saves again. New uploads and splitting require the current consent header. Administrative raw-script splitting stays local because it cannot establish student consent.

[Packy's terms](https://www.packyapi.ai/terms) state that Packy does not train on customer content and does not retain input/output content. Its [DPA, H.2](https://www.packyapi.ai/dpa) places upstream content retention under the applicable upstream provider's terms; the subprocessor list is available on request rather than published. Do not represent this as independently verified non-retention by every upstream or promise remote deletion of all provider/back-up copies on the event deadline.

All answers receive complete-answer review before any text/suggestions/audio are released, selected-section-only context, no client-supplied history authority, and refusal on uncertainty. A model reviewer is defense in depth and cannot prove universal correctness or non-disclosure. Old cached audio is not reused as public chat narration.

The admin-only `POST /api/admin/ai-probe` runs at most two bounded requests using built-in fictional material and an exact model allowlist. It never accepts a manuscript, prompt or endpoint. A dedicated bearer requires `AI_PROBE_SECRET` and a valid `AI_PROBE_EXPIRES_AT` within one hour; it is unrelated to cleanup authorization. Diagnostics fail closed after the event. Do not enable real manuscript processing merely for connectivity diagnosis.

`EVENT_ENDS_AT=2026-12-13T00:00:00+08:00` was selected from the user's December 13 correction with midnight Beijing stated explicitly. Daily 16:00 UTC cleanup is authenticated with `CRON_SECRET`. The schedule is a future attempt, not evidence that destruction has already occurred. Check the final object inventory and resolve failures. See retention.md for maintenance operations and scope.

Student consent requires the current policy-version header before upload, parse, split, create, edit/read or photo mutation. Server records version and acceptance time. This asserts consent and does not establish identity; possession of the private edit token still controls editing. Never post those links in public reports.
