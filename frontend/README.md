# ApprovalTrack frontend

ApprovalTrack is a workflow prototype for the All India Council for Technical Education (AICTE). Login is verified through the ApprovalTrack backend; role assignments come from the authenticated backend account. Institution intake cases, their OCR/M1–M3 document reviews, and student/faculty complaints and reports use backend APIs. The seven-type approval pipeline is deterministic; AI findings do not choose or advance stages.

## Run locally

```powershell
cd frontend
npm install
npm run dev
```

Start the backend separately from `backend` using `npm run dev`. The frontend
uses `http://localhost:4000/api/v1` for login/session requests by default.
Run production checks with `npm run build` and `npm test`.

The Admin **Alert rules** and **Users and roles** pages load and update data
through the backend API. User creation and status changes, as well as rule
configuration changes, require an authenticated Admin account. Some analytics
and design-system pages remain prototype data.

## Demo login accounts

- Institution: `institution@approvaltrack.demo`
- Scrutiny Officer: `scrutiny@approvaltrack.demo`
- EVC: `evc@approvaltrack.demo`
- SAC/SHC: `sac@approvaltrack.demo`
- Bureau Officer: `bureau@approvaltrack.demo`
- Senior Authority: `senior@approvaltrack.demo`
- Admin: `admin@approvaltrack.demo`
- Student: `student@approvaltrack.demo`
- Faculty: `faculty@approvaltrack.demo`

All seeded demo accounts use `ApprovalTrack-Demo-2026!`. Enter only email and
password: the backend-saved role chooses the workspace. Role switching is not
available in the authenticated UI. These fictional credentials are for local
development only.

## Demo walkthrough

1. Sign in with an **Institution** demo account, open **New application**, choose one of the seven application types, upload supporting evidence, and submit.
2. Open **My cases**. The stage review shows the deterministic sequence and SLA, extracted-field confirmation state, and a protected document preview. Source bounding boxes are green at 90%+, amber at 70–89%, and red below 70%.
3. As the current stage owner, use **Request Another User / Stage Help**. The stage freezes and approval/return controls are hidden until the assignee records a decision. The owner SLA resumes after that decision.
4. Review the assist task from **Assist requests** as its assignee, then return to the stage owner and approve each allocated stage. The final stage is assigned to an Administrator and appears in **Administrator final approval queue**. Final approval queues the institution email and in-app notification and creates any conditional undertaking records.
5. To check a deficiency path, use **Reject / Raise Deficiency** with a written reason, respond as the institution, and resubmit the case.
6. Student and faculty demo accounts still support their complaint/report workflows; OCR/M1/M2/M3 document analysis remains available for institution applications.

## Project structure

- `src/app/`: React Router routes and role guards.
- `src/layouts/`: authenticated application shell and demo login shell.
- `src/pages/`: separate page entry points for login, notifications, audit, institution, officer, committee, authority, admin, and design-system pages.
- `src/components/ui/`: accessible shared primitives, data table, status badges, ownership clocks, stepper, score components, dialogs, and AI field row.
- `src/components/StageWorkflowPanel.jsx`: deterministic stage stepper, assist freeze/decision state, and stage actions.
- `src/components/DocumentEvidencePreview.jsx`: authenticated PDF/image source preview with confidence-colored extraction overlays.
- `src/pages/AssistRequestsPage.jsx`: per-user queue of pending stage-assist requests.
- `src/data/`: fictional JSON fixtures and policy settings.
- `src/services/admin.js`: authenticated Admin API requests for users, institutions, and alert rules.
- `src/services/api.js`: promise-based mock service with a 300–600 ms delay.
- `src/store/`: shared role, AI availability, notifications, score simulation, and audit state.
- `src/utils/`: pure route/score rules and date-only deadline semantics, with Node tests.

Route, score, and deadline calculations are utility functions rather than values inferred from presentation components. Lease flags are informational until an authorised confirmation. An institution submission and officer verification are separate states.
