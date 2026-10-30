# Runtime Validation Report

**Generated**: 2026-10-29 (Admin approval and OCR rerun)  
**Target**: `D:\ApprovalTracker`

## Current Admin/OCR validation (2026-10-29)

| Check | Result | Exit code | Evidence |
|---|---|---:|---|
| Backend tests | PASS | 0 | `backend\npm test`: 135 tests passed across 19 files, including deterministic stage rules, Admin assignment, frozen-stage authorization, M2 processing for `other` document slots, overdue-assist recipient/deduplication, contact-email delivery, and isolation from legacy pipeline transitions. |
| Frontend tests | PASS | 0 | `frontend\npm test`: 39 tests passed. |
| Frontend production build | PASS | 0 | `frontend\npm run build` succeeded; existing dependency annotation and large-chunk warnings remain. |
| Python model and AI service tests | PASS | 0 | `python -m pytest mlmodels ai-service\tests`: 185 passed, 1 skipped because the optional font needed by an M3 fixture is unavailable. |
| Browser E2E | PASS | 0 | The full Playwright suite passed 5/5 against an isolated localhost MongoDB database. The stage journey verifies the seven exact type labels, submission, Admin final-stage assignment, the Administrator final approval queue, rejection of Bureau Officer final approval (HTTP 403), two-column review layout, alerts drawer, editable extracted-field confirmation with persisted expiry updates, freeze and backend `STAGE_FROZEN`, assist reviewer identity and decision, all five stage approvals, `FINAL_APPROVED`, the final approval notification, and validity obligation registration. Student, Faculty, Institution, and invalid-login journeys also passed. |

**OCR evaluation**: All 89 synthetic PDFs were processed with the production M1 `predict_file`, M2 `run`, and M3 `build_result` entrypoints. Against the fixture's explicit labels, M1 top-1 classification was correct for 82/89; all 7 incorrect suggestions were red/non-prefill and none were accepted as a prefill. The upload pipeline invokes M2 when M1 classifies a document as `other`, and deterministic labelled-field parsing still extracts recognized fields if the M2 model is unavailable. M2 was available for all 89; exact labeled matches were issue dates 41/41, Search-period `valid_from` values 5/5, expiry/Search-period `valid_to` values 17/17 (12 expiry labels plus 5 Search-period ends), certificate/reference numbers 67/67, and issuer names 67/67. The extracted-field form now labels these values as Issue Date, Valid From, Valid To, Certificate Number, and Issuer. All 89 fixtures had embedded text and none used Tesseract; scanned-PDF OCR quality remains unverified. M3 matched explicitly labeled lease starts and ends for 6/6 each.

**UI adjustment**: The ambiguity-review checkbox is scoped to 16×16 px, aligned with the left edge of its explanatory text, and no longer inherits the full-width field-input styles. Valid From uses the date input control.

**Environment**: Node.js v24.14.0 and Playwright/Chromium available; MongoDB reachable on localhost and used with a unique, disposable `approvaltrack_e2e_<hex>` database. Docker is unavailable (CLI not installed), but the browser tier ran independently of Docker. Playwright started the API and Vite frontend and dropped only its isolated database during teardown.

**Current automated total**: 364 passed, 1 skipped, 0 failed (135 backend + 39 frontend + 5 browser E2E + 185 Python).

**Current overall result**: NEEDS_SIGNOFF — automated tests, production build, and the full configured Playwright suite pass. Stage allocation, assistance freeze/unfreeze, Admin-only final approval, each stage approval, final status, extracted-field confirmation display, overdue alert targeting/deduplication, OCR confidence gating, and final notification/validity registration are covered. Live email-provider delivery, Redis/BullMQ execution, Docker deployment, and remaining deployment infrastructure paths are unverified; scanned-PDF accuracy is also unverified, so this report does not claim full deployment sign-off.

## Prior validation update (before stage-workflow changes)

| Check | Result | Evidence |
|---|---|---|
| Backend tests | PASS | `Set-Location backend; npm test`: 116 passed across 15 test files, including standalone audit-write serialization and BullMQ scheduler/worker dispatch tests. |
| Frontend tests | PASS | `npm test`: 36 passed. |
| Frontend production build | PASS | `npm run build` succeeded; existing dependency annotation and large-chunk warnings remain. |
| Python model and FastAPI service tests | PASS | `python -m pytest mlmodels ai-service\tests`: 165 passed, 1 skipped. |
| Browser E2E | PASS (isolated disposable MongoDB) | Four Playwright tests passed with multiple workers: student announcement/complaint create-and-read, invalid student login, faculty annual-report draft round trip, and institution annual-report draft round trip. Teardown dropped only the guarded `approvaltrack_e2e_<hex>` database. |
| All-role authentication and API access matrix | PASS (isolated disposable MongoDB) | Seeded all 12 roles, authenticated each role, verified `/auth/me`, and checked role-specific access to announcements, complaints, institutions, and the institution-only score endpoint. All 48 access decisions matched the expected 200/403 policy. |
| Live readiness | PASS | `/health` at `http://localhost:4000/health` returned `ok` for MongoDB, upload storage, and Python; Vite responded at `127.0.0.1:5174`. |
| Browser check | PARTIAL | The authenticated isolated Admin governance page rendered; the checkbox and content field shared the same left edge (x=347). No new notice or complaint was submitted during this check. |
| University/DTE queue and grievance lifecycle | PASS (isolated API) | Verified own-appeal scope, complaint progression, student appeal, Ombudsperson decisions, and 7 matching outbox events and audit entries. |
| Reminder scanner | PASS (isolated DB) | Three synthetic overdue grievance, appeal, and institutional report records produced 30 deduplicated notification jobs; a repeat run created no duplicates and escalation recipients were scoped by region. |
| Institutional annual-report API | PASS (isolated API) | Verified June 30 IST deadline, institution scoping, rejection of overwrites after submission, and outbox events for save and submit. |
| Compliance Action Score route | PASS (live API) | Fixed the route registration bug (handler had been nested after the overview response); institution login received current/projected score response, student login received HTTP 403, and the response correctly marked incomplete evidence as incomplete. |
| Regional reminder escalation | PASS (unit) | Corrected undertaking/yearly-report escalation to use the 3-day Bureau Officer and 7-day Senior Authority ladder, with active-recipient filtering by the associated institution's region; missing region is logged and does not cause a global notification. |
| Application create outbox/audit | PASS (isolated API) | Authenticated institution created a draft in a disposable standalone database; corresponding `application.created` event and `APPLICATION_CREATED` audit entry were present. Multi-record ACID behavior was not claimed on standalone MongoDB. |
| Policy draft/sign-off outbox and audit | PASS (isolated API) | Created and signed off successive policy versions through the authenticated API against a disposable standalone MongoDB database; verified draft/sign-off events, retirement of the prior version, and matching hash-chain audit actions. |
| Identity/institution outbox and audit | PASS (isolated API) | In a disposable standalone database, verified transactional audit/outbox records for password change/reset, institution registration, email verification, and institution activation. |
| Notification delivery and alert outbox/audit | PASS (isolated API + unit tests) | Verified deduplicated queue creation, in-app alert creation, sent/terminal-failed outcomes, delivery logs, provider bounce handling, administrator failure alerts, and matching outbox/audit records. Focused notification regression tests cover queued, in-app, sent, terminal failure, and bounce paths. |
| Audit hash-chain after notification changes | PASS (isolated API) | The authenticated admin `GET /api/v1/admin/audit/verify-chain` returned `valid: true` and `headMatches: true` after login and notification queue mutations in a disposable standalone database. |
| ClamAV protocol and upload enforcement | PASS (unit + isolated authenticated API) | Fake clamd protocol tests cover clean, infected, unavailable, and unconfigured outcomes. An authenticated case upload was marked `CLEAN`; a simulated infected PDF returned HTTP 422 and created no document record. Production configuration rejects startup unless `CLAMAV_HOST` is set. |
| Isolated FastAPI AI service | PASS (unit + real M1 inference) | Added a token-protected FastAPI service with fixed OCR/M1/M2/M3 operation allowlists, upload-root path checks, bounded execution, health checks, and an optional backend HTTP bridge. Its 6 tests are included in the Python total; real M1 inference through the FastAPI endpoint returned valid model JSON. |
| AI outage manual-mode signal | PASS (unit) | Remote service unavailable/timeout failures are persisted as `AI_UNAVAILABLE_MANUAL_MODE`, while unrelated pipeline error codes remain intact. Manual entry remains available for failed extraction; stopping the live FastAPI service during an end-to-end drill remains unverified. |
| Redis/BullMQ queue path | PASS (unit; Redis unavailable for live probe) | Added timezone-aware repeat jobs, a separate worker process, bounded concurrency, retries/backoff, and queued case evaluations. The version-checked case pipeline re-reads current state when retrying conflicts. Redis dispatch, lock recovery, and concurrent case execution have not been tested against a live Redis instance. |
| Docker Compose deployment definition | PASS (static YAML validation only) | Added Compose services for MongoDB replica-set bootstrap with a scoped application user, Redis, ClamAV, FastAPI, API, worker, and Nginx frontend. The Compose YAML parsed and service wiring was checked; Docker CLI is unavailable, so image builds, service health, startup, network routes, and shared-volume permissions are unverified. MinIO is not included because document storage still uses the shared filesystem volume. |
| Domain mutation outbox/audit coverage | PASS (suite + live probes) | In addition to case/application/workflow paths, policy draft/sign-off/retirement, auth password/registration/verification changes, admin account/config changes, Student/Faculty profile changes, institution profile changes, document analysis requests/failures, document uploads/confirmation/reprocessing, AI extraction outcomes, and notification state changes use corresponding audit/outbox records. |
| Latest code hygiene | PASS | `git diff --check` completed without whitespace errors after the latest code changes. |

**Prior automated total**: 321 passed, 1 skipped, 0 failed (116 backend + 36 frontend + 165 Python model/FastAPI + 4 browser E2E tests). The 48 role/access assertions are an additional isolated API integration probe, not part of that test count. This is historical pre-stage-workflow evidence, not the current test total or a feature-completeness/AI-accuracy percentage.

**Prior overall result**: NEEDS_SIGNOFF — backend, frontend, Python/FastAPI tests, the production build, parallel browser E2E for student/faculty/institution, all-role authentication/API access, and a real M1 inference probe passed. The parallel run also verifies the standalone MongoDB audit-write serialization regression fix. BullMQ and Docker Compose deployment paths are implemented, but only worker unit behavior and static Compose YAML were validated. This is not full feature sign-off: G1–G12 are not all verified end to end; live Redis/Compose runtime, MinIO/object-storage integration, TLS deployment, and the live AI-disabled fallback drill remain unverified. No AI accuracy percentage is inferred.

The earlier run evidence below is retained for context; its test counts and dates are superseded by this update.

## Historical broad validation summary (superseded by current results above)

| Step | Status | Exit Code | Details |
|---|---|---:|---|
| Startup/readiness | PASS | 0 | Backend, frontend, and MongoDB were listening; `/health` returned `ok` for MongoDB, upload storage, and Python. These services were already running; a cold start was not tested. |
| Backend tests | PASS | 0 | Historical suite: 116 tests passed across 15 test files. |
| Frontend tests | PASS | 0 | Historical suite: 36 tests passed. |
| Frontend production build | PASS | 0 | Build succeeded. Existing Zod annotation and large-chunk warnings remain. |
| Python model and FastAPI tests | PASS | 0 | 165 passed, 1 skipped. |
| Browser E2E | PASS (limited role scope) | 0 | Four Playwright tests passed for student, faculty, and institution workflows against a disposable MongoDB database. The current stage journey is documented above. Other role-specific browser journeys remain untested. |
| Real API/database integration | PARTIAL | 0 | All 12 seeded roles were authenticated and checked against four role-scoped APIs on a disposable MongoDB database. There is no isolated, repeatable API integration suite covering all pipeline scenarios. |

**Historical automated test total**: 321 passed, 1 skipped, 0 failed. This is not a feature-completeness or AI-accuracy percentage.

**Historical overall**: NEEDS_SIGNOFF — automated suites and the role/API access probe passed, but the full G1-G12 acceptance set and all role workspaces were not verified end to end.

## Earlier commands (retained context)

- `Set-Location backend; npm test` — 80 passed, exit code 0.
- `Set-Location frontend; npm test` — 35 passed, exit code 0.
- `Set-Location frontend; npm run build` — succeeded, exit code 0.
- `python -m pytest mlmodels/Model1 mlmodels/Model2 mlmodels/Model3` — 159 passed, 1 skipped, exit code 0.
- `Get-Command docker` / `docker info` capability check — Docker CLI was not installed.
- `node --version` — `v24.14.0`.
- `GET http://localhost:4000/health` — status `ok`.

## Environment and test stack

```text
environment:
  docker: UNAVAILABLE — Docker CLI is not installed.
  node: AVAILABLE — v24.14.0.
  playwright: AVAILABLE — Playwright and Chromium ran through `npm run test:e2e`; five browser tests passed using a guarded, disposable local MongoDB database.
  infra-tier: FALLBACK(local MongoDB) — the local MongoDB service was healthy and used by the running app; Docker-backed reproducibility was unavailable.
  browser-tier: PRIMARY(Playwright) — five configured browser tests passed, including the deterministic stage/assist journey. Other officer/committee/admin workflows are not covered.
startup: PASS — exit_code: 0; Playwright started the API and Vite frontend, configured readiness URLs responded, and the API connected to isolated localhost MongoDB. Full deployment startup is unverified.
integration: PASS (test scope) — exit_code: 0; 166 passed (127 backend + 39 frontend), 0 failed; browser E2E also exercised persisted API/DB state. Docker-backed infrastructure and live Redis are unverified.
e2e: PASS — exit_code: 0; 5 passed, 0 failed. Covered intake labels, stage review, assist freeze/unfreeze, final approval, expiry obligation, alerts drawer, student/faculty/institution portal flows, and invalid login. Remaining role-specific journeys are uncovered.
overall: NEEDS_SIGNOFF — all current automated checks pass, but live email-provider delivery, Redis/BullMQ, and Docker deployment remain unverified.
```

## Live browser evidence from earlier validation

- Created a new-course draft and resumed it after uploading a synthetic fire-safety image.
- Confirmed that the resumed draft restored the uploaded document, its analysis-ready state, and saved suggestions.
- Exercised manual field completion and human confirmation before submitting a synthetic application; submission returned HTTP 200 in the earlier full-flow run.
- Rechecked the document case page and resumed application after the duplicate-key fix; no browser console errors were observed on those refreshed pages.
- “Start another application” correctly cleared the prior application type. New-course selection showed 5 slots; new-institution selection showed 10. The earlier timeout was caused by the test expecting the wrong slot count.
- Login routing was verified for institution, scrutiny, and EVC users. Subsequent SAC/SHC, bureau, senior, admin, student, and faculty login checks received HTTP 429 after rapid repeated attempts; those roles remain unverified, not failed.
- One invalid-login attempt was rejected and an anonymous protected-route visit redirected to login.
- The model output for the synthetic image was not an accuracy benchmark: the operator had to supply/correct values and confirm them.

## Acceptance scenarios (source: supplied intake-pipeline spec)

Status reflects the exact evidence obtained, not an assumption that an untested scenario works.

| Scenario | Status | Evidence / remaining gap |
|---|---|---|
| G1: Five required documents, submission, scrutiny route/holder, clean preliminary state | PARTIAL | Live submission and scrutiny-plan unit coverage exist, but the five-document journey and clean preliminary result were not exercised together. |
| G2: Empty lease slot, warning/incomplete state, no automatic return | PARTIAL | Rules tests cover missing-slot findings and no automatic return; the complete submission journey was not run. |
| G3: Expired certificate, recommendation, authorised return, renewal, re-scrutiny | PARTIAL | Unit tests cover the expired-document recommendation and no automatic movement; the full human return/renewal flow was not run. |
| G4: Unresolved ambiguous date blocks confirmation without obligation/alert | PARTIAL | Date ambiguity and explicit-resolution rules are unit-tested; the complete persistence/no-alert journey was not run. |
| G5: Blurred scan or disabled AI degrades to manual entry | PARTIAL | Confidence/manual-entry behavior is unit-tested; the AI-disabled live flow was not run. |
| G6: Unsafe/renamed/instruction-bearing/oversized file quarantines with audit | PARTIAL | Quarantined-slot behavior is tested; malicious/oversized upload, quarantine storage, and audit were not exercised together live. |
| G7: Lease mismatch stays under review until an official confirms | PARTIAL | Lease mismatch and score rules have unit coverage; the official-confirmation live journey was not run. |
| G8: Changing unconfirmed AI suggestions cannot change the plan/hash | PASS (unit) | Determinism test varies unconfirmed suggestions and verifies a stable plan hash. |
| G9: Repeated evaluation/event replay creates no duplicates | PARTIAL | Repeated pure evaluation and single-EVC-task behavior are unit-tested; replaying the complete event flow and alert creation was not verified. |
| G10: Concurrent evaluation jobs serialize and re-queue after conflict | PARTIAL | BullMQ dispatch and retry/backoff for case evaluations are implemented and worker behavior is unit-tested. A live concurrent Redis/Mongo replica-set conflict-and-retry test has not been run. |
| G11: Scrutiny completion on an EVC route creates one EVC task | PASS (unit) | Engine tests verify task creation, frozen route behavior, and no duplicate task after reevaluation. |
| G12: Cross-institution upload and reasonless return are denied and audited | PARTIAL | Scope/route rules have unit coverage; live 403/422 responses and their audit records were not verified together. |

## Issues and limitations

- The verified audit chain and `GET /api/v1/audit/verify-chain` endpoint exist. Complaints, appeals, announcements, and institutional annual-report mutations now write an outbox event and audit record together with the record update when MongoDB transactions are available. Other legacy workflow mutations do not all follow this pattern; standalone MongoDB also triggers the documented non-atomic fallback.
- The optional FastAPI AI service, ClamAV scanning, BullMQ scheduling/worker code, and Docker Compose/Nginx deployment definitions are present. BullMQ remains optional (`QUEUE_MODE=inline` is the development default), and the Compose runtime has not been exercised. MinIO/object storage is not integrated; the Compose stack uses a shared private filesystem volume.
- The announcement feed is administrator-published, with an optional source link; it does not automatically sync from an AICTE feed. Individual faculty yearly reports are an ApprovalTrack extension, distinct from the APH institutional Internal Committee annual report.
- The University/DTE queue and full student complaint/Ombudsperson path were verified through authenticated API requests in isolated disposable databases; an appeal assigned to another officer was excluded. The initial failed probe used stale shared test data and is superseded by these checks.
- Reminder scanner integration was verified using a disposable database: grievance response, Ombudsperson appeal, and institution annual-report reminders generated 30 jobs; a repeat run retained the same count. Bureau Officer and Senior Authority escalation recipients were region filtered.
- The institutional annual-report API was verified with two institution accounts: the submitted report remained private to its institution, used June 30 at 23:59 IST as its deadline, produced save/submit outbox events, and rejected an attempted overwrite.
- Fixed a duplicate React key in the document-analysis-check list. Frontend tests and the production build passed after the fix; refreshed browser pages showed no console errors.
- A disposable-database integration probe now verifies successful login and role-specific access for all 12 seeded roles; it does not replace full browser workflow tests for each role.
- Docker and Redis are unavailable in this environment. A local MongoDB service was used for earlier API probes, but container deployment and BullMQ runtime behavior have not been tested.
- G10 has queue-level unit coverage but remains partial until concurrent case conflicts/retries are verified against live MongoDB replica-set and Redis services.
- Added a repository-owned Playwright E2E suite for student, faculty, and institution flows. The suite passes concurrently; officer, committee, authority, and admin browser journeys remain uncovered.
- Standalone MongoDB previously showed a concurrent audit-head race during parallel browser testing. Added a re-entrant in-process write queue for standalone mode and a regression test; the backend suite and concurrent E2E suite now pass. Replica-set deployments continue to use MongoDB transactions.
- The frontend build succeeds but reports dependency annotation warnings and a 644 kB JavaScript chunk (plus the PDF.js worker). The package audit also reports 2 moderate advisories; no broad dependency upgrade was attempted.
- One Python test was skipped by the existing suite. No AI accuracy score can be inferred from the single synthetic document flow.

## Test data cleanup (previous validation runs)

Removed the three exact synthetic cases created during earlier validation, their 3 uploaded files, extraction/processing records, and case workflow records. In this validation, also removed only the named isolated test announcement and complaint. Preserved audit/outbox history and the shared document-text cache. The exact announcement and complaint were confirmed absent after cleanup; `/health` remained `ok`. Stopped only the isolated validation service PIDs on ports 4100 and 5174; the normal services on ports 4000 and 5173 remain available.
