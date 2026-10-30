# ApprovalTrack backend

ApprovalTrack's backend is a Node.js 20+ / Express API with MongoDB/Mongoose,
cookie sessions, role and institution scoping, local document storage, and
local-process or optional FastAPI HTTP integration for the existing M1/M2/M3 models. It is a demo
workflow; configured deadlines and rule assumptions are marked synthetic in
the API and in [RULES.md](./docs/RULES.md).

## Local setup

1. Install Node.js 20+, Python 3.10+, and MongoDB 7+. A normal standalone
   MongoDB connection is supported. Because standalone MongoDB does not support
   transactions, multi-document workflows use ordered non-atomic writes in
   standalone mode; use a replica set if atomic transactions are required. On
   startup, the backend ensures case/application document-owner indexes, which
   requires the MongoDB user to have index-management permission.

2. From this folder, install dependencies and create `.env`:

   ```powershell
   npm install
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

3. Check `MONGODB_URI`, `FRONTEND_ORIGIN`, and `PYTHON_BIN` in `.env`. The
   example URI points to local standalone MongoDB on port 27017. The model
   paths assume this folder is `ApprovalTracker/backend` and that the models
   are in the sibling `ApprovalTracker/mlmodels` folder. Python packages
   required by the OCR/model scripts must be installed in that interpreter.
   The backend adds model and OCR directories to `PYTHONPATH` when spawning
   those scripts.

4. Seed the fictional demo data and run the API:

   ```powershell
   npm run seed
   npm run dev
   ```

The seed creates one account for each of the thirteen roles. The default fictional
password is `ApprovalTrack-Demo-2026!`; set `DEMO_PASSWORD` before seeding to
choose another. These are development-only credentials. Never use them or the
example cookie secret in production.

If demo accounts already exist but workflow policy records are missing, run
`npm run seed:workflow-policy` instead. It inserts only the missing workflow
policy versions and does not change accounts. The seeded checklist, routes,
deadlines, and scores are configuration assumptions for development, not
official AICTE rules.

## Run the frontend

Open a separate PowerShell terminal:

```powershell
cd ..\frontend
npm install
npm run dev
```

Open the Vite URL printed in that terminal (normally `http://localhost:5173`).
Sign-in and role detection use the backend session API. Most workspace content
is still fictional mock data and is not loaded from backend APIs.

## Run the models separately

The M1, M2, and M3 models are Python command-line programs. By default, the
backend invokes these scripts directly during document analysis. To use the
optional isolated FastAPI service instead, follow [the AI service setup](../ai-service/README.md)
and configure `AI_SERVICE_URL` and `AI_SERVICE_TOKEN`. The backend and AI
service must share the same absolute upload path. To try the model scripts
independently, open a terminal for each command:

```powershell
# M1: from mlmodels\Model1\m1_training
python .\predict_m1.py --file ..\samples\fire_safety_certificate.pdf

# M2: from mlmodels\Model2
$env:PYTHONPATH = "..\Model1\ocr;.\ocr;."
python .\ocr\m2_extract.py .\samples\sample_fire.pdf --doc-type fire

# M3: from mlmodels\Model3
python .\ocr\m3_extract.py .\samples\01_start_end_dates.pdf --doc-type lease
```

These commands use the existing trained model artifacts; training is not
required to start the application.

## API and docs

- Base URL: `http://localhost:4000/api/v1`
- Health: `GET http://localhost:4000/health`
- Optional AI service: [../ai-service/README.md](../ai-service/README.md)
- OpenAPI 3.1: [docs/openapi.json](./docs/openapi.json)
- Additive case workflow outline: [docs/openapi.yaml](./docs/openapi.yaml)
- Postman collection: [docs/ApprovalTrack.postman_collection.json](./docs/ApprovalTrack.postman_collection.json)
- Rule basis and default settings: [docs/RULES.md](./docs/RULES.md)
- Admin incident monitoring API: [docs/admin-incidents.md](./docs/admin-incidents.md)

The API uses `{ "data": ..., "error": ..., "meta": { "requestId": "..." } }`
responses and an HTTP-only session cookie. Mutating API requests must include
`X-Requested-With: XMLHttpRequest`. `INSTITUTION` accounts are restricted to
their own institution; students and faculty are limited to their own simple
profiles and faculty yearly-report reminders.

The additive case workflow exposes application type and checklist preview
routes, policy administration, scoped case drafts and transitions, final
decisions, and workflow obligation endpoints. Institutions can submit evidence
notes for obligations; authorised officers can verify them. Case checklist
documents use `POST /api/v1/cases/:id/documents` and reuse the private document
storage and AI extraction pipeline; a person must confirm suggestions. The
existing scheduler checks policy-configured reminder and escalation thresholds
hourly and queues deduplicated in-app alerts. Authenticated case users can
subscribe to `/api/v1/cases/events` for scoped workflow events.
See [docs/ASSUMPTIONS.md](./docs/ASSUMPTIONS.md) for compatibility choices and
remaining boundaries.

Submitted intake cases also use the deterministic `SIH26262-1.0` stage workflow.
The seven application types and their ordered stage/SLA rules live in
`src/engine/stageAllocationRules.js`; workflow actions operate on `CaseRecord`
so existing OCR and M1/M2/M3 document extraction remain attached to the case.
The primary endpoints are:

- `POST /api/v1/cases` and `POST /api/v1/cases/:id/submit` to create and activate
  the allocated pipeline.
- `POST /api/v1/documents/:id/confirm` to confirm or edit extracted fields; a
  frozen stage owner receives `403 STAGE_FROZEN`.
- `GET /api/v1/cases/assist-requests/my` and
  `GET /api/v1/cases/:id/stages/:stageIndex/assignees?role=EVC` for assist work.
- `POST /api/v1/cases/:id/stages/:stageIndex/request-assist` to pause the owner
  SLA and freeze the stage; `POST
  /api/v1/cases/:id/assist-requests/:assistId/decide` records the helper's
  approval/rejection and resumes the owner clock.
- `POST /api/v1/cases/:id/stages/:stageIndex/approve` and
  `POST /api/v1/cases/:id/stages/:stageIndex/reject` for explicit stage
  decisions. Final approval creates conditional obligations and queues
  in-app/email notices; email uses `Institution.contact_email`.
- `GET /api/v1/alerts/my-alerts` for the signed-in user's alerts. The stage SLA
  scanner runs every five minutes and writes one deduplicated HIGH alert per
  overdue stage or assist request.
- `GET /api/v1/evc/cases?tab=waiting_inspection|waiting_approval` and
  `GET /api/v1/evc/cases/:id` for assigned EVC committee work and document
  inspection details.
- `POST /api/v1/evc/cases/:id/schedule-inspection`,
  `POST /api/v1/cases/:id/evc-report`,
  `POST /api/v1/evc/cases/:id/approve`, and
  `POST /api/v1/evc/cases/:id/reject` for schedule, inspection-report,
  committee-signoff, and rejection transitions. Scheduling accepts dates from
  tomorrow onward; rejection requires at least 30 characters and a confirmed
  notification chain. EVC notifications use the existing durable
  `NotificationJob` email worker and the existing SHA-256 chained audit log.

The corresponding `/api/v1/applications/:id/...` stage-action aliases also
target the active `CaseRecord` collection. Existing role names are reused:
regional review maps to `SCRUTINY_OFFICER`, legal verification maps to
`BUREAU_OFFICER`, and the final approval stage is assigned to `BUREAU_OFFICER`.
EVC work is assigned to the active EVC member and chair accounts in the case
region; both roles may access the assigned committee stage.
Legacy case-pipeline evaluations are non-mutating for deterministic workflow
cases, so OCR and analysis findings cannot silently advance or replace the
allocated stages.

## Integrations

- Document uploads accept PDF, JPEG, or PNG (20 MB max), are stored outside
  the public web root, and are streamed only through authorized download routes.
  When `CLAMAV_HOST` is configured, each upload is streamed to ClamAV before
  storage; infected files are rejected and scanner outages fail closed. Local
  development without a configured scanner marks uploads `UNSCANNED`. Production
  startup requires `CLAMAV_HOST`, and successful uploads expose their
  `antivirus_status`.
-   The pipeline caches normalized OCR text and page layout by file hash and OCR
  version. M1 receives the cached text; M2 and lease-specific M3 receive the same
  page data, including source coordinates, rather than independently repeating
  OCR. Each attempt is recorded as a processing run, and the case processing
  endpoint exposes its status and model versions. Suggestions remain unconfirmed
  until a person confirms them. A daily case-pipeline scanner reevaluates
  date-sensitive findings without making human decisions.
- `NOTIFY_MODE=log` is the development default. Set it to `send` and configure
  Resend/TextBee credentials to deliver real messages. Provider credentials are
  never required for local demo mode.
- `POST /api/v1/admin/jobs/:name/run` triggers a registered scheduled job.
- `QUEUE_MODE=inline` (default) runs the in-process scheduler. Set
  `QUEUE_MODE=bullmq` and configure `REDIS_URL` to register repeatable
  timezone-aware jobs in Redis; run
  `node src/modules/jobs/workerProcess.js` as a separate process to consume
  them. Case reevaluations use retryable BullMQ jobs in this mode. The Compose
  profile enables this mode and starts the dedicated worker service.

## Docker Compose deployment

The repository-root `docker-compose.yml` provides a single-host deployment
profile with MongoDB replica-set initialization, Redis-backed BullMQ scheduled
and case-evaluation jobs, the Node API, a separate worker, the isolated FastAPI
model service, ClamAV, and Nginx-served React assets. Uploaded documents use a
private shared Docker volume mounted at `/app/uploads` by the API and AI
service.

From the repository root in PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.compose.example .env }
# Replace every placeholder with unique, strong secrets before starting.
docker compose up --build -d
docker compose ps
docker compose logs -f api worker ai-service
```

The MongoDB username and password in `.env` must use URL-safe characters
(letters, digits, hyphens, and underscores) because they are embedded in the
MongoDB URI. Also set a unique MongoDB replica-set key (6–1024 characters).
For example, generate a 256-character hex value with
`python -c "import secrets; print(secrets.token_hex(128))"`. Set distinct root
and application credentials: the init service
creates a database-scoped `readWrite` user, while the API and worker do not use
the MongoDB root account. The checked-in example contains placeholders and is
not suitable for deployment. Do not seed fictional demo users into a production database.
For a demonstration deployment only, set a unique `DEMO_PASSWORD` and seed
deliberately:

```powershell
docker compose run --rm -e DEMO_PASSWORD=$env:DEMO_PASSWORD api node src/models/seed.js
```

The Compose profile exposes only the Nginx frontend port. Put it behind a
TLS-terminating reverse proxy before any non-local use; HTTPS certificates,
backups, production secret management, and operational monitoring must be
provided by the deployment environment. This profile uses a private Docker
volume for uploads shared at the same path by the API and AI service. Their
container users share the same numeric UID so files created with private
permissions remain readable by the inference service. It does not configure MinIO/object storage. Docker Compose
image builds and runtime behavior must be validated on a host with Docker
Engine because Docker is unavailable in the current development environment.

## Browser end-to-end tests

The Playwright suite exercises student complaint creation/read-back, faculty
yearly-report draft/read-back, institution annual-report draft/read-back, and
the invalid-login path against a running API and Vite frontend. It requires a
local MongoDB and deletes its disposable database after execution. It refuses
MongoDB URIs unless the host is loopback and the database name matches
`approvaltrack_e2e_<12-32 hex characters>`; never point it at shared or
production data.

Install the browser once and run from the repository root in PowerShell:

```powershell
Set-Location .\frontend
npx playwright install chromium
$dbSuffix = [guid]::NewGuid().ToString("N")
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/approvaltrack_e2e_$dbSuffix"
$env:E2E_DEMO_PASSWORD = "E2E-only-$dbSuffix-Password!"
npm run test:e2e
```

The test runner starts the API and frontend on ports 4317 and 5174. It seeds
only the isolated database and drops that database during teardown. It does
not require Docker or Redis; the inline scheduler is used for these tests.

## Validation

```powershell
npm test
npm audit
npm run seed
```

Tests cover API envelopes and authorization fallbacks, model indexes, rules,
and scheduler registration/dispatch/shutdown. `npm run seed` works with either
a standalone server or replica set. Standalone mode cannot make multi-document
workflow writes atomic. Real outbound email/SMS
delivery requires provider credentials and an online TextBee gateway. TextBee's
official docs could not be reached in the implementation environment, so its
configured REST endpoint and payload have not been independently verified.

## Safety notice

**DEMO DATA - NOT REAL AICTE DEADLINES.** AI-suggested values are not verified.
A person must confirm every value; the software never replaces the competent
authority. No model output starts a clock, changes routing, or writes to a
score or policy table. Synthetic workflow intervals are configurable demo
assumptions, not official AICTE deadlines.

## Stakeholder grievance and reporting workflows

Student complaints use the institution's Student Grievance Redressal Committee
(SGRC) path; a student may appeal a recorded decision to a region-assigned
Ombudsperson within the 15-day appeal window. Faculty/staff complaints use a
separate institution GRC path and may be appealed to a region-assigned
University/State DTE officer. The currently configured 15-day institution
response target and automated escalation reminders are product defaults, not
claims about a statutory deadline. As product defaults, reminders are sent at
90/60/30/15/7/1 days, on the due date, and when overdue; escalation goes to a
regional Bureau Officer after three overdue days and a Senior Authority after
seven. The 30-day Ombudsperson decision target is the APH §6.50 target; no
faculty/staff appeal decision period is assumed.

The institution annual-report workflow records the APH §6.48 Internal
Committee annual report due by 30 June. Individual faculty yearly reports are
an ApprovalTrack extension and should not be represented as an AICTE-mandated
faculty report. Report reminder and escalation schedules use the product
defaults above. Overdue undertaking and yearly-report escalations target only
active Bureau Officer users in the associated institution's region after three
overdue days; Senior Authority users in that same region are included after
seven days. If the institution has no region, escalation is logged and skipped
instead of being broadcast globally. Announcements are published by an authorized administrator;
this release does not automatically synchronize an official AICTE notice feed.

Institution accounts can read their live Compliance Action Score from
`GET /api/v1/dashboard/action-score`. The endpoint scopes cases, obligations,
and confirmed document dates to the signed-in institution, excludes
officer-owned waits, and returns both the current score and a 30-day projection.
If there is insufficient complete case evidence, the result is explicitly
marked incomplete rather than presented as a score of 100. Other roles are
denied access to this institution-facing score endpoint.

Primary domain-state mutations across policies, cases, applications,
institutions, admin-managed accounts/configuration, Student/Faculty profiles,
documents, complaints, appeals, announcements, pending items, undertakings,
alerts, reports, EVC visits, decisions, and cancellation reviews write an
outbox event and hash-chain audit entry with the associated state change.
Document analysis requests and AI-processing failures, notification delivery
outcomes, newly queued jobs, generated in-app alerts, and verified provider
bounce status changes are also recorded.
Replica-set MongoDB makes these multi-record writes transactional. Standalone
MongoDB uses the existing non-atomic compatibility fallback and logs the
limitation. Login/logout/session-issuance records and operational job triggers
are handled separately; password changes/resets and institution
registration/activation are recorded as domain/security events. This does not
claim that every persistence operation in the application has an outbox event.

Policy references reviewed:

- [AICTE Approval Process Handbook 2024–2027](https://aicte.gov.in/sites/default/files/approval/APH%20Final.pdf)
- [AICTE Public Notice for Approval Process 2026–27](https://aicte.gov.in/sites/default/files/Public%20notice%20for%20approval%20process%202026-27.pdf)
- [AICTE Rules and Regulations](https://aicte.gov.in/bureaus/administration/rulesregulations)
