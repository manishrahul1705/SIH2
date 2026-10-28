# ApprovalTrack frontend

ApprovalTrack is a workflow prototype for the All India Council for Technical Education (AICTE). Login is verified through the ApprovalTrack backend; role assignments come from the authenticated backend account. Most workspace records and interactions remain fictional mock data.

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
configuration changes, require an authenticated Admin account. Other workflow
pages continue to use local prototype data.

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

1. Sign in with an **Institution** demo account and open **New application**. Select a fictional application type and inspect the live route preview from policy v2026.2. Complete the wizard and submit the demo case.
2. Open **My cases**, select a case and inspect the route stepper and institution/officer ownership clocks.
3. Sign out and sign in with a **Scrutiny Officer** account, open a case from **My queue**, and attempt a return without text in the required reason field. The confirm action stays disabled. Add a reason and return the case; the action is recorded in the audit trail.
4. Sign in again as the institution and submit a deficiency response. The case response is not marked verified automatically.
5. Sign in again as an officer and complete a scrutiny stage. The policy-defined next stage is displayed; EVC work is represented as one task per case/policy route.
6. Open **Documents and validity**, then **Upload renewal**. Use the blurred-certificate sample to see a low-confidence field left blank. AI values show model/version and confidence. Select an uploaded sample and confirm proposed fields to start the clock; until confirmation, no clock starts.
7. Acknowledge a notification. The toast says the obligation is still open.
8. From the institution dashboard, use **Simulate: upload fire renewal**. The score calculator moves the Action Score from 63 to 70. The verifier completing review leaves that score unchanged.
9. Confirm the lease flag from the document review. The confirmation explains the 10-point deduction and updates the score.
10. Sign in as **Admin**, open **AI service**, and stop AI. Sign in again as an institution user; manual entry remains available.

## Project structure

- `src/app/`: React Router routes and role guards.
- `src/layouts/`: authenticated application shell and demo login shell.
- `src/pages/`: separate page entry points for login, notifications, audit, institution, officer, committee, authority, admin, and design-system pages.
- `src/components/ui/`: accessible shared primitives, data table, status badges, ownership clocks, stepper, score components, dialogs, and AI field row.
- `src/data/`: fictional JSON fixtures and policy settings.
- `src/services/admin.js`: authenticated Admin API requests for users, institutions, and alert rules.
- `src/services/api.js`: promise-based mock service with a 300–600 ms delay.
- `src/store/`: shared role, AI availability, notifications, score simulation, and audit state.
- `src/utils/`: pure route/score rules and date-only deadline semantics, with Node tests.

Route, score, and deadline calculations are utility functions rather than values inferred from presentation components. Lease flags are informational until an authorised confirmation. An institution submission and officer verification are separate states.
