# Backend assumptions and implementation boundaries

The current ApprovalTrack repository is an existing Node.js/Express JavaScript
application with a working React frontend, cookie-backed session authentication,
Mongoose models, MongoDB, and local Python model CLIs. To preserve the existing
frontend, authentication, and student/faculty features, the new case workflow
uses the existing JavaScript module conventions and is added alongside the
legacy `/applications` APIs. This is intentionally not a destructive rewrite to
the proposed TypeScript/FastAPI monorepo.

## Policy configuration

- The seeded required-document matrix is an informed assumption based on the
  public excerpts named in the implementation brief. The per-application `R`,
  `C`, and `-` assignments are not an official AICTE checklist. Verify and
  correct them against the final applicable handbook before operational use.
- Routes, stage checklists, alert windows, and score settings in policy
  `v2026.2` are demo configuration, not official AICTE rules or deadlines.
- A conditional slot without a configured answer stays `review_required`.
  This is a review task and must not be used as an automatic score deduction.
- The applicability form additionally accepts `premisesShared`,
  `premisesUsed`, and `affiliatingBodyRequired`; these cover slot conditions
  described in the supplied matrix but absent from its original five-question
  list.
- A conditional slot described only as "as applicable" has no safe
  machine-readable condition in the brief, so it remains `review_required`
  until an administrator configures a condition.
- The minimum lease term remains unset (`null`) pending handbook verification.
- Re-scrutiny is introduced into an individual case route only after a valid
  return. The default route is not extended with re-scrutiny pre-emptively.
- The legacy `BUREAU_OFFICER` role is the current application's
  competent-authority role. Final decisions on the new case API are restricted
  to that existing role; no role selection is accepted from a client.

## Runtime and integration

- The new API endpoints and deterministic engines are additive. Existing
  `/applications`, login/session behavior, admin screens, and student/faculty
  routes remain available.
- The backend currently targets the repository's existing Node.js 20+
  JavaScript runtime. Moving all source to TypeScript, introducing BullMQ,
  FastAPI, MinIO, Docker Compose, and replacing the existing session model are
  broader platform changes and have not been done as part of this additive
  workflow implementation.
- Multi-document workflow transactions require MongoDB replica-set or
  sharded-cluster support. The existing standalone MongoDB fallback remains
  for legacy features and cannot guarantee atomic multi-document writes.
- The new case-document owner indexes are ensured at database startup. Startup
  replaces the legacy global application/slot/version unique index with
  owner-specific partial indexes; the MongoDB database user needs permission
  to create and drop indexes during this migration.
- Outbox records are written with the new case transitions; delivery and
  transactional writes require a transaction-capable MongoDB deployment. The
  case event endpoint streams visible outbox events with polling and supports
  `Last-Event-ID` reconnection; it is not a message-broker publisher.
- Case checklist files reuse the existing private local storage, document
  versioning, OCR/M1/M2/M3 pipeline, extraction review, and authenticated
  download flow. Case uploads are institution-owned draft/returned updates;
  AI-extracted values still require explicit human confirmation. The legacy
  application rule evaluator is not applied to new case documents.
- New workflow obligations can be listed with role scoping, submitted with an
  institution evidence note, and verified by an authorised officer. The
  existing hourly scheduler evaluates pinned-policy reminder and escalation
  thresholds and queues deduplicated in-app alerts for the institution owner
  or regional senior authority. Acknowledging an alert is not treated as
  obligation completion.
- Existing Python CLIs remain the AI integration. AI output does not select
  routes, confirm fields, verify evidence, or write scores.
- Score and queue engines are pure functions and are not yet wired to every
  legacy dashboard endpoint.
