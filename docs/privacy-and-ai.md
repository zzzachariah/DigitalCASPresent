# Privacy and AI operating state

## November 19, 2026 verification

The original configuration used `claude-opus-4-8` through the old `.com` endpoint and returned a no-channel error during an earlier synthetic request. The organizer subsequently prioritized fast Anthropic-family replies. Production configuration now selects `AI_MODEL=AI_MODEL_LIVE=claude-sonnet-5` and `AI_BASE_URL=https://cf.api.fan/v1`, the production endpoint recommended in the logged-in Packy console. These are relay identifiers, not independent attestation of the upstream model.

On November 19, a fixed fictional compass question using the existing CAS key completed in **3,448 ms**, and the application's five-field safety reviewer accepted a fixed correct answer in **3,428 ms** (6,887 ms total). Both returned HTTP 200. The same Haiku probe returned HTTP 404. This is a small connectivity/format check, not a comprehensive quality evaluation or latency guarantee. No student manuscript, photo or record was used.

After being told about upstream processing and unconfirmed upstream retention, the organizer explicitly approved Packy and upstream model processing. `AI_PROCESSING_APPROVED=true` enables text AI; `EXTERNAL_AI_PROCESSING_APPROVED=false` keeps A2E/D-ID and external media processing closed. Student consent must also use the current version: old records receive a safe fallback until the author reviews the new notice and saves again. New uploads and splitting require the current consent header. Administrative raw-script splitting stays local because it cannot establish student consent.

[Packy's terms](https://www.packyapi.ai/terms) state that Packy does not train on customer content and does not retain input/output content. Its [DPA, H.2](https://www.packyapi.ai/dpa) places upstream content retention under the applicable upstream provider's terms; the subprocessor list is available on request rather than published. Do not represent this as independently verified non-retention by every upstream or promise remote deletion of all provider/back-up copies on the event deadline.

All answers receive complete-answer review before any text/suggestions/audio are released, selected-section-only context, no client-supplied history authority, and refusal on uncertainty. A model reviewer is defense in depth and cannot prove universal correctness or non-disclosure. Old cached audio is not reused as public chat narration.

The admin-only `POST /api/admin/ai-probe` runs at most two bounded requests using built-in fictional material and an exact model allowlist. It never accepts a manuscript, prompt or endpoint. A dedicated bearer requires `AI_PROBE_SECRET` and a valid `AI_PROBE_EXPIRES_AT` within one hour; it is unrelated to cleanup authorization. Diagnostics fail closed after the event. Do not enable real manuscript processing merely for connectivity diagnosis.

`EVENT_ENDS_AT=2026-12-13T00:00:00+08:00` was selected from the user's December 13 correction with midnight Beijing stated explicitly. Daily 16:00 UTC cleanup is authenticated with `CRON_SECRET`. The schedule is a future attempt, not evidence that destruction has already occurred. Check the final object inventory and resolve failures. See retention.md for maintenance operations and scope.

Student consent requires the current policy-version header before upload, parse, split, create, edit/read or photo mutation. Server records version and acceptance time. This asserts consent and does not establish identity; possession of the private edit token still controls editing. Never post those links in public reports.
