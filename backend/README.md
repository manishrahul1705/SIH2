# ApprovalTrack backend

ApprovalTrack's backend is a Node.js 20+ / Express API with MongoDB/Mongoose,
cookie sessions, role and institution scoping, local document storage, and
offline Python CLI integration for the existing M1/M2/M3 models. It is a demo
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

The seed creates one account for each of the nine roles. The default fictional
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

The trained M1, M2, and M3 models are local Python command-line programs, not
separate HTTP servers. The backend invokes these scripts itself during a
document upload. To try their inference independently, open a terminal for
each command:

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
- OpenAPI 3.1: [docs/openapi.json](./docs/openapi.json)
- Additive case workflow outline: [docs/openapi.yaml](./docs/openapi.yaml)
- Postman collection: [docs/ApprovalTrack.postman_collection.json](./docs/ApprovalTrack.postman_collection.json)
- Rule basis and default settings: [docs/RULES.md](./docs/RULES.md)

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

## Integrations

- Document uploads accept PDF, JPEG, or PNG (20 MB max), are stored outside
  the public web root, and are streamed only through authorized download routes.
- The pipeline invokes the configured OCR, M1, and M2 Python CLIs, plus M3
  when M1 suggests a lease or the uploader selected the Lease Deed slot.
  Suggestions remain unconfirmed until a person confirms them.
- `NOTIFY_MODE=log` is the development default. Set it to `send` and configure
  Resend/TextBee credentials to deliver real messages. Provider credentials are
  never required for local demo mode.
- `POST /api/v1/admin/jobs/:name/run` triggers a registered scheduled job.

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
