# Privacy and AI operating state

## November 21, 2026 narration repair

The organizer subsequently requested narration repair and live verification for the same participant. Production `A2E_SPEECH_APPROVED_PERSON_IDS` separately identifies this approved record. This does not expand the photo list or authorize other participants. Only reviewed exhibition explanations reach A2E TTS; raw manuscripts and source sections are not TTS input. Ordinary provider voices are used, not voice cloning. Global external processing and D-ID remain closed.

Admin preparation processes each section/language variant sequentially, verifies persisted audio and provides an authenticated preview. The underlying storage uses immutable audio keys and reads the private copy back before recording completion. Historical audio remains inaccessible to ordinary visitors; live narration is generated only after the answer passes review.

## November 21, 2026 photo-processing scope

The organizer separately authorized one identified participant's photo for A2E cartoon and ambient-video generation. Production `A2E_PHOTO_APPROVED_PERSON_IDS` identifies that record; do not add other records without specific authorization. `EXTERNAL_AI_PROCESSING_APPROVED=false` continues to block external narration and D-ID. The existing text-AI consent does not grant photo-processing permission.

Admin diagnostics distinguish a deliberate privacy block from missing provider configuration. Photo routes read authorized private image bytes directly, never forward edit/preview credentials, and bind polling tokens to the participant and task purpose. Upload object names use content hashes to avoid collisions. The admin preparation flow can continue with explicit text-only processing when media is unavailable, without claiming missing assets are ready.

## November 19, 2026 verification

The original configuration used `claude-opus-4-8` through the old `.com` endpoint and returned a no-channel error during an earlier synthetic request. The organizer subsequently prioritized fast Anthropic-family replies. Production configuration now selects `AI_MODEL=AI_MODEL_LIVE=claude-sonnet-5` and `AI_BASE_URL=https://cf.api.fan/v1`, the production endpoint recommended in the logged-in Packy console. These are relay identifiers, not independent attestation of the upstream model.

On November 19, a fixed fictional compass question using the existing CAS key completed in **3,448 ms**, and the application's five-field safety reviewer accepted a fixed correct answer in **3,428 ms** (6,887 ms total). Both returned HTTP 200. The same Haiku probe returned HTTP 404. This is a small connectivity/format check, not a comprehensive quality evaluation or latency guarantee. No student manuscript, photo or record was used.

After being told about upstream processing and unconfirmed upstream retention, the organizer explicitly approved Packy and upstream model processing. `AI_PROCESSING_APPROVED=true` enables text AI; `EXTERNAL_AI_PROCESSING_APPROVED=false` keeps A2E/D-ID and external media processing closed. Student consent must also use the current version: old records receive a safe fallback until the author reviews the new notice and saves again. New uploads and splitting require the current consent header. Administrative raw-script splitting stays local because it cannot establish student consent.

[Packy's terms](https://www.packyapi.ai/terms) state that Packy does not train on customer content and does not retain input/output content. Its [DPA, H.2](https://www.packyapi.ai/dpa) places upstream content retention under the applicable upstream provider's terms; the subprocessor list is available on request rather than published. Do not represent this as independently verified non-retention by every upstream or promise remote deletion of all provider/back-up copies on the event deadline.

All answers receive complete-answer review before any text/suggestions/audio are released, selected-section-only context, no client-supplied history authority, and refusal on uncertainty. A model reviewer is defense in depth and cannot prove universal correctness or non-disclosure. Old cached audio is not reused as public chat narration.

The admin-only `POST /api/admin/ai-probe` runs at most two bounded requests using built-in fictional material and an exact model allowlist. It never accepts a manuscript, prompt or endpoint. A dedicated bearer requires `AI_PROBE_SECRET` and a valid `AI_PROBE_EXPIRES_AT` within one hour; it is unrelated to cleanup authorization. Diagnostics fail closed after the event. Do not enable real manuscript processing merely for connectivity diagnosis.

`EVENT_ENDS_AT=2026-12-13T00:00:00+08:00` was selected from the user's December 13 correction with midnight Beijing stated explicitly. Daily 16:00 UTC cleanup is authenticated with `CRON_SECRET`. The schedule is a future attempt, not evidence that destruction has already occurred. Check the final object inventory and resolve failures. See retention.md for maintenance operations and scope.

Student consent requires the current policy-version header before upload, parse, split, create, edit/read or photo mutation. Server records version and acceptance time. This asserts consent and does not establish identity; possession of the private edit token still controls editing. Never post those links in public reports.
