# ApprovalTrack Project Guide

**Project:** ApprovalTrack (AICTE approval workflow and stakeholder portal)  
**Repository layout:** React frontend, Node.js API, MongoDB persistence, and Python OCR/AI components  
**Last reviewed:** 2026-10-30

## 1. What this project does

ApprovalTrack is a web application for managing institution approval applications and the people, evidence, and review stages associated with them. It includes role-specific workspaces for institutions, review officers, committees, authorities, administrators, students, and faculty.

The application supports two related approval/workflow areas:

- **Application intake and case workflow:** institutions create applications, provide required evidence, and follow a policy-configured review route. Authorized reviewers work on assigned stages, request assistance, return an application with a reason, or approve it onward.
- **Institution and stakeholder services:** users can work with institution documents and obligations; student and faculty users can access college information, reports, announcements, and complaint workflows.

Document processing can use OCR and M1/M2/M3 extraction models. Their output is a review aid: people confirm extracted values, and the deterministic workflow—not an AI finding—controls case-stage transitions.

> **Operational note:** The repository describes itself as a workflow prototype/demo in places. Seeded policy routes, checklists, numeric thresholds, and deadlines may be synthetic. Verify applicable official requirements before relying on them operationally. Never treat development seed accounts or local secrets as production credentials.

## 2. Technology

| Area | Technologies |
|---|---|
| Frontend | React 18, Vite, React Router, Zustand, React Hook Form, Zod, TanStack Table, Recharts, Radix UI, lucide-react |
| API | Node.js 20+, Express 4, Mongoose 8, Zod |
| Database | MongoDB 7 |
| Queues and scheduled work | Inline queue mode for local use; optional BullMQ with Redis; `node-cron` scheduler |
| Document processing | Python 3, FastAPI (optional isolated service), OCR and M1/M2/M3 model scripts, Tesseract |
| Upload protection | Private file storage, optional ClamAV scanning |
| Tests | Node built-in test runner (frontend), Vitest and Supertest (backend), pytest tests under `mlmodels` |
| Deployment | Docker Compose, separate frontend/API/worker/AI-service containers, MongoDB, Redis, ClamAV |

Dependency versions and supported runtime constraints are defined in the package manifests, requirements files, and Dockerfiles. The backend package declares Node.js `>=20`.

## 3. Repository map

```text
ApprovalTracker/
├── Project.md                 # This guide
├── docker-compose.yml         # Local/containerized multi-service stack
├── .env.compose.example       # Compose variable names and placeholders
├── backend/
│   ├── src/
│   │   ├── app.js             # Express middleware, health endpoint, route mounting
│   │   ├── server.js          # Database connection, scheduler, HTTP lifecycle
│   │   ├── config/            # Environment validation, constants, logging
│   │   ├── middleware/        # Authentication, audit, errors, request controls
│   │   ├── models/            # Mongoose schemas and seed scripts
│   │   ├── engine/            # Checklist, policy, stage allocation, time/queue logic
│   │   └── modules/           # Feature routers and service code
│   ├── docs/                  # OpenAPI, API notes, rule basis, assumptions
│   ├── tests/                 # API and backend behavior tests
│   ├── .env.example           # Backend local configuration template
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── app/               # Routes, authentication bootstrap, role guards
│   │   ├── pages/             # Workspace and stakeholder pages
│   │   ├── components/        # Shared UI, workflow and document components
│   │   ├── layouts/           # Authenticated application shell
│   │   ├── services/          # API clients and request helpers
│   │   ├── store/             # Client-side session and workspace state
│   │   ├── data/              # Local configuration/fixture data
│   │   ├── styles/            # Feature-specific styles
│   │   └── styles.css         # Global and page styling
│   ├── e2e/                   # Playwright end-to-end tests
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── ai-service/
│   ├── app.py                 # Optional FastAPI boundary for model execution
│   ├── requirements.txt
│   └── Dockerfile
├── mlmodels/
│   ├── Model1/                # OCR utilities and M1 document classification
│   ├── Model2/                # M2 extraction
│   └── Model3/                # M3 lease/date extraction
└── test-documents/            # Local test documents (not production data)
```

The source tree above intentionally omits generated output and installed dependencies such as `node_modules`, `.venv`, build directories, and Python caches.

## 4. Main product areas

### Institution workspace

- Institution dashboard, application creation, and case register.
- Upload and review application documents against a case checklist.
- View extraction status and extracted values; confirm or correct values where authorized.
- Respond to returned applications and submit/resubmit them.
- Track institution documents, validity, undertakings, deficiency responses, notifications, and assistance requests.
- Institution-level annual report and college grievance workflows.

### Officer, committee, authority, and administrator workspaces

- Officer work queue, case review, document verification, and notifications.
- EVC visits, inspection scheduling, report upload, and assigned committee work.
- SAC/SHC hearings and appeals.
- Bureau/final approval queue, region and reporting views, and escalations.
- Administrator policy/rule, user, audit, governance, and incident-monitoring surfaces.

### Student and faculty workspaces

- College information, approved offerings, announcements, and complaint tracking.
- Student statutory committee/help information.
- Faculty department/cadre roster, yearly report submission/history, and complaint tracking.

Access to pages is controlled by frontend route guards and is also enforced by backend authentication and role/scope checks. The frontend role map is in `frontend/src/services/auth.js`; route permissions are in `frontend/src/app/App.jsx`.

## 5. Application and case lifecycle

1. **Create a draft.** An institution selects an application type and supplies the information needed for checklist and route evaluation.
2. **Prepare evidence.** The case checklist identifies document slots. Files are stored privately and may pass through antivirus scanning, OCR, document classification, and extraction.
3. **Review extracted values.** OCR/M1/M2/M3 results are attached to the document/case. Authorized users inspect and confirm or correct fields. Unconfirmed model output is not treated as an approved business value.
4. **Submit the case.** The backend validates the case and activates its allocated workflow stages.
5. **Review assigned stages.** The owner sees the current work, due date/SLA, documents, checks, and tasks. A stage can be approved onward or returned with a written reason, subject to permissions and configured requirements.
6. **Request assistance, if needed.** The current owner can assign an assistance request to an eligible user. The stage and owner clock are frozen while assistance is pending and resume after the decision.
7. **Complete the route.** EVC inspection/report, committee review, and final approval are performed only for stages allocated to the case. Final approval can create conditional obligations and notification work.
8. **Track follow-up.** Institutions submit obligation evidence; authorized officers verify it. Scheduled jobs produce reminders/escalations based on configured rules.

### Supported application types

The deterministic stage allocation rules currently define:

- New institution
- New course
- Increase in intake
- Extension of approval
- Conversion of diploma to degree
- Collaboration or twinning programme
- Restoration of intake

The stage sequence, responsible role, and SLA values are implemented in `backend/src/engine/stageAllocationRules.js`. Use that source and the policy configuration as the implementation reference; the defaults are not a substitute for current official requirements.

### Workflow invariants

- Application/case stage movement is governed by backend policy and allocated stages.
- AI/document findings may inform a human review but do not independently change the case route.
- Returned work requires a reason and is submitted again by the institution.
- Institution evidence submission and official verification are separate actions.
- Assistance decisions are assigned to a user and have a status/history.
- Case events and audit records support traceability; access is scoped to the signed-in user and role.

## 6. Architecture and data

### Request path

```text
Browser (React/Vite or Nginx)
  └── /api/v1 requests with secure session cookie
       └── Express API
            ├── MongoDB (Mongoose records and policy)
            ├── private upload storage
            ├── OCR/M1/M2/M3 scripts OR optional private FastAPI service
            ├── inline jobs OR BullMQ/Redis worker
            └── notification providers (configured separately)
```

The API is created in `backend/src/app.js`; `backend/src/server.js` connects to MongoDB, starts the scheduler, and handles shutdown. The optional FastAPI AI service runs as a separate process and is not required when the backend invokes the Python model scripts directly.

### Key MongoDB model groups

- **Identity and organization:** `User`, `Session`, `Institution`, `Student`, `Faculty`, password reset and email verification records.
- **Applications and workflow:** `Application`, `CaseRecord`, `CaseStageHistory`, `StageConfig`, `Policy`, `CaseDecision`, `CaseObligation`, `Undertaking`, `Visit`.
- **Documents and analysis:** `Document`, `AiExtraction`, `DocumentText`, `ProcessingRun`, `LeaseDetail`.
- **Operations and traceability:** `CaseTask`, `CaseFinding`, `PendingItem`, `OutboxEvent`, `Alert`, notification jobs/logs, `AuditLog`, `AuditHead`, `RuleConfig`.
- **Stakeholder features:** `Complaint`, `Announcement`, `YearlyReport`, `InstitutionAnnualReport`.
- **Administration/monitoring:** `ApplicationIncident` and related compliance records.

The definitive schema definitions are in `backend/src/models/`. This list groups the important concepts; it is not a promise that every UI surface uses every model.

### Important backend modules

`backend/src/modules/` contains feature-specific code for authentication/people, institutions, applications, cases, documents, workflow, dashboard, EVC, stakeholders, administration, notifications, and jobs. Shared stage/checklist/time logic lives in `backend/src/engine/`.

## 7. API and integrations

- API prefix: `/api/v1`
- Health endpoint: `GET /health`
- Case, document, workflow, stakeholder, admin, and EVC endpoints are mounted by `backend/src/app.js`.
- API contracts and examples: `backend/docs/openapi.yaml`, `backend/docs/openapi.json`, and the Postman collection when present.
- API response envelope: `{ "data": ..., "error": ..., "meta": { "requestId": "..." } }`.
- Browser requests use an HTTP-only session cookie. Mutating API requests must include `X-Requested-With: XMLHttpRequest`.
- The frontend API base defaults to `http://localhost:4000/api/v1`; deployments can set `VITE_API_BASE_URL`.
- Authenticated case users can receive scoped case events through the case event endpoint.

### AI service

`ai-service/app.py` exposes health checking and authenticated inference operations for OCR, M1, M2, and M3. It accepts only the supported operation/argument shapes, validates model file paths against its configured upload root, limits input/output and execution time, and disables shell execution. Keep this service on a private application network.

### Notifications and background work

The backend supports inline job execution for simple local setups and BullMQ/Redis for queued processing. The scheduler checks configured notification and stage-delay rules. Email/SMS capabilities depend on environment configuration; local defaults may log rather than send.

## 8. Local development

### Requirements

- Node.js 20 or newer
- MongoDB (a replica set is recommended when transaction atomicity is required)
- Python 3 and the model dependencies for OCR/model execution
- Tesseract and language data when running OCR locally
- Redis, ClamAV, and Docker Compose only when using the corresponding queue, malware-scan, or containerized configuration

### Start API and frontend

Use separate terminals. Do not copy production secrets into local development.

```powershell
# Terminal 1
cd backend
npm install
Copy-Item .env.example .env
# Edit .env with local MongoDB and frontend settings.
npm run seed
npm run dev
```

```powershell
# Terminal 2
cd frontend
npm install
npm run dev
```

The API normally listens on port `4000`; Vite normally serves the UI on port `5173`. The backend `.env.example` and `backend/src/config/env.js` define the required names and defaults. Set an appropriate `MONGODB_URI`, `FRONTEND_ORIGIN`, and sufficiently long local `COOKIE_SECRET`. Seeded user accounts are fictional and development-only. If workflow policies are missing on an already seeded database, the backend provides `npm run seed:workflow-policy`.

MongoDB standalone mode may not support multi-document transactions. The backend documentation describes ordered writes for that mode; use a replica set where transaction guarantees are required.

### Optional AI service

The backend can run model scripts locally using `PYTHON_BIN` and configured script paths, or call the isolated FastAPI service by setting `AI_SERVICE_URL` and `AI_SERVICE_TOKEN`. Both processes must see uploaded files at the same absolute path. Install the AI/model dependencies and Tesseract requirements described by `ai-service/README.md` and the model-specific requirements files.

### Docker Compose

`docker-compose.yml` defines MongoDB with replica-set initialization, Redis, ClamAV, AI service, API, worker, and frontend. Prepare a root `.env` from `.env.compose.example`, replace every placeholder with unique, strong secrets, and review notification-provider settings before starting the stack. The Compose frontend port defaults to `8080`. Do not commit `.env` or use example values in a shared or production environment.

## 9. Tests and quality checks

Run commands from the relevant project directory:

```powershell
# Frontend
cd frontend
npm test
npm run build
npm run test:e2e
```

```powershell
# Backend
cd backend
npm test
```

Python tests are located under `mlmodels/` and use pytest. Run them with the project Python environment and installed model dependencies, for example:

```powershell
python -m pytest mlmodels
```

End-to-end tests may require the frontend, API, database, seeded data, browser installation, and other services. A passing frontend build or unit suite alone does not prove that the whole application is correctly configured at runtime.

## 10. Configuration and operational safety

- Backend configuration is validated in `backend/src/config/env.js`; templates are in `backend/.env.example` and `.env.compose.example`.
- Do not commit `.env`, passwords, session secrets, AI service tokens, provider keys, or real uploaded documents.
- Production requires an explicitly configured session secret. Production configuration also requires ClamAV; remote AI service use requires its service token.
- Uploads must stay outside the public web root. Preserve the shared upload path when API and AI services run separately.
- Use TLS and secure deployment settings for production cookies/origins; restrict the AI service to internal traffic.
- Confirm role authorization, institution scoping, input validation, and audit behavior when adding or changing backend endpoints.
- Treat seeded routes, demo data, sample credentials, rules, deadlines, and thresholds as development configuration until verified.

## 11. Where to look when changing a feature

| Change | Start here |
|---|---|
| Add or change a page/route and role access | `frontend/src/app/App.jsx`, the relevant `frontend/src/pages/` component |
| Update global layout/navigation | `frontend/src/layouts/AppShell.jsx`, `frontend/src/styles.css` |
| Add a backend-backed frontend feature | Its page/component plus the appropriate `frontend/src/services/` API client |
| Add or change an API route | `backend/src/app.js`, then the corresponding `backend/src/modules/` router/service |
| Change case stage allocation or checklist behavior | `backend/src/engine/`, policy models, and application/case module |
| Change persistence | The relevant schema in `backend/src/models/` and its tests |
| Change document AI processing | `backend/src/modules/ai/`, `mlmodels/Model1/`, `Model2/`, `Model3/`, and possibly `ai-service/` |
| Change notification/job behavior | `backend/src/modules/notifications/`, `backend/src/modules/jobs/`, queue configuration |
| Change container deployment | `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`, `ai-service/Dockerfile` |
| Update API contract or assumptions | `backend/docs/` |

When modifying behavior, update the corresponding tests and documentation, preserve role scoping and user-visible error handling, and validate both the focused tests and relevant build.
