# ApprovalTrack (SIH26262) — Student & Faculty Portal Specification and AI Build Prompt

## 1. Architectural Analysis of the Student and Faculty Portals

ApprovalTrack already tracks applications, stage movement, EVC readiness, undertakings, and document validity across institutional, officer, committee, senior authority, and admin roles. Adding a **Student Portal** and a **Faculty Portal** extends transparency to campus stakeholders while maintaining the core safeguard that **alerts, public disclosures, and stakeholder submissions only support the process and never automatically alter a statutory decision, start an official clock, or deduct from the Action Score without authorised officer verification**.

### 1.1 Public Institutional Profile & Offerings (Shared Across Student and Faculty)
When an institution's approval status and self-disclosure are published by the competent authority, both students and faculty need a read-only view of what the college is officially approved to offer and what campus facilities are declared. This prevents misinformation about unapproved courses, excess intake, or expired infrastructure certificates.

- **Institution Identity & Approval Summary**: Institution name, AICTE Permanent ID, university affiliation, institution type (Private Self-Financed, Aided, Autonomous), academic year approval status (`EoA Granted for 2026–27`, `Under Scrutiny`, `Placed under No-Admission Category`), and date of latest Extension of Approval (EoA) letter.
- **Approved Programmes & Intake Offerings**: Searchable table of approved courses by level (UG, PG, Diploma), programme name (e.g., B.Tech Computer Science and Engineering, M.Tech VLSI), shift, approved intake capacity for the current academic year, NBA accreditation status (Accredited / Not Accredited / Applied with validity dates), and tuition fee ceiling approved by the state fee committee.
- **Public Campus Facilities & Statutory Compliance Snapshot**: Declared built-up instructional area, laboratory count, library volumes and e-journals, computing terminals and internet bandwidth, hostel capacity, barrier-free accessibility status, and public validity status of essential safety certificates (Fire Safety Certificate, Building Structural Stability Certificate, Occupancy Certificate, Potable Water & Sanitary Certificate) shown as verified status badges without exposing sensitive internal deed numbers.
- **Statutory Committees & Ombudsperson Roster**: Publicly mandated contact details for the Anti-Ragging Committee, Internal Complaints Committee (ICC / POSH), Student Grievance Redressal Committee (SGRC), and SC/ST/OBC Cell.

### 1.2 Faculty Annual Academic & Compliance Report Submission (Faculty Only)
AICTE requires technical institutions to maintain accurate faculty-student ratios, cadre ratios, qualification records, and academic activity disclosures every academic year. The Faculty Portal allows individual faculty members to submit and sign off on their **Yearly Faculty Academic & Compliance Report**, which feeds into the institution's annual self-disclosure after institutional nodal officer verification.

- **Section A — Faculty Identity & Appointment Details**: Faculty AICTE ID, full name, department, designation (Assistant Professor, Associate Professor, Professor), nature of appointment (Regular / Ad-hoc / Adjunct), date of joining, highest qualification (Ph.D. / M.Tech / M.E.), PAN/Aadhaar verification status (masked), and current pay scale (6th / 7th CPC).
- **Section B — Teaching Load & Courses Handled**: Academic year selector (e.g., `2025–26` or `2026–27`), odd/even semester courses taught, lecture/tutorial/practical hours per week, project guidance count (UG/PG/Ph.D. scholars), and student feedback summary status.
- **Section C — Research, Publications & Patents**: Peer-reviewed journal papers (SCI/Scopus indexed with DOI), conference proceedings, books/book chapters, patents filed/granted, and sponsored research or consultancy grants received during the assessment year.
- **Section D — FDPs, MOOCs & Institutional Responsibilities**: AICTE ATAL / SWAYAM / NPTEL Faculty Development Programmes completed (minimum days/weeks), industrial training, and statutory committee roles held (e.g., NBA Coordinator, Examination Cell, Anti-Ragging Squad).
- **Section E — Supporting Evidence & Declaration**: Upload slots for FDP certificates, appointment/promotion orders, and publication proofs (PDF), plus a mandatory faculty declaration checkbox confirming that they are employed full-time at this single institution and not double-counted elsewhere. Workflow states: `Draft` -> `Submitted to HOD / Principal` -> `Returned for Correction` -> `Verified by Institution Nodal Officer`.

### 1.3 Stakeholder Grievance & Compliance Complaint Module (Both Student and Faculty)
Both students and faculty need a dedicated sidebar route and quick-action drawer to lodge complaints about institutional non-compliance or campus grievances, track their status, and escalate unresolved issues.

- **Shared Core Complaint Fields**:
  - `complaint_id` (auto-generated reference, e.g., `CMP-2026-00482`)
  - `complainant_role` (`student` or `faculty`)
  - `privacy_mode`: `Identified` (visible to SGRC/Institution nodal officer) vs. `Confidential / Whistleblower` (identity masked from the institution; visible only to the AICTE Regional Officer / Ombudsperson for serious statutory violations)
  - `category`: Filtered by role (see below)
  - `severity`: `Standard Grievance`, `Statutory Non-Compliance`, or `Urgent Safety / Harassment`
  - `department_or_programme`: Affected department, course, or campus block
  - `incident_date_or_period`: Date or academic semester when the issue occurred
  - `subject`: Concise summary title (max 120 chars)
  - `description`: Detailed narrative of the issue (min 50 chars)
  - `prior_internal_representation`: Toggle (`Yes / No`) indicating whether the issue was already raised with the college principal/SGRC, with optional internal ticket number and date
  - `evidence_attachments`: Up to 5 supporting files (PDF/PNG/JPG, such as fee receipts, photos of lab/safety deficiencies, or circulars; scanned through the quarantine filter)
  - `declaration_ack`: Mandatory confirmation that the complaint is factual and not malicious
- **Student-Specific Complaint Categories**:
  - Unapproved Course or Excess Intake Admission
  - Original Certificates / Marksheets Withheld by College
  - Excess Fee Demand or Non-Refund of Fees on Cancellation
  - Infrastructure, Laboratory, or Library Deficiency
  - Hostel, Mess, Sanitation, or Fire/Building Safety Hazard
  - Scholarship / Stipend Disbursement Delay
  - Ragging, Harassment, or SGRC Non-Responsiveness
- **Faculty-Specific Complaint Categories**:
  - Non-Payment, Delayed Disbursement, or Arbitrary Deduction of Salary
  - Non-Implementation of Prescribed Pay Scale (6th/7th CPC)
  - Original Qualification Certificates Withheld by Management
  - Ghost Faculty / Forced Proxy Attendance or Fake Biometric Entry
  - Coerced Sign-Off on False EVC / Self-Disclosure / Lab Equipment Records
  - Unlawful Termination or Denial of Maternity/Academic Leave
  - Workplace Harassment or ICC Non-Compliance
- **Safeguard & Routing Rule**: Submitting a complaint creates a tracked grievance ticket (`Submitted` -> `Under SGRC / Nodal Review` -> `Escalated to Regional Officer` -> `Resolved / Closed`). A complaint **never** automatically deducts points from the institution's Action Score or halts an application stage; only when an authorised AICTE officer verifies a statutory violation and confirms a compliance flag does it enter the official workflow.

### 1.4 Sidebar Navigation Architecture

| Portal | Sidebar Item | Route Path | Purpose |
|---|---|---|---|
| **Student Portal** | 1. College Overview & Approval | `/student/college-overview` | Public AICTE approval status, EoA history, and compliance badges |
| **Student Portal** | 2. Approved Courses & Offerings | `/student/offerings` | Approved programmes, intake, NBA status, and fee ceilings |
| **Student Portal** | 3. Campus Facilities & Safety | `/student/facilities` | Public labs, library, hostel, and safety certificate status |
| **Student Portal** | 4. Lodge a Complaint | `/student/complaints/new` | Student grievance & statutory non-compliance submission form |
| **Student Portal** | 5. My Complaints & Tracker | `/student/complaints` | Status timeline, SGRC responses, and escalation action |
| **Student Portal** | 6. Statutory Committees & Help | `/student/committees` | Anti-Ragging, SGRC, ICC, and Ombudsperson directory |
| **Faculty Portal** | 1. College Overview & Offerings | `/faculty/college-overview` | Public college profile, approved courses, intake, and facilities |
| **Faculty Portal** | 2. Department & Cadre Roster | `/faculty/department-roster` | Public department faculty strength, lab allocation, and AICTE ratio status |
| **Faculty Portal** | 3. Submit Yearly Report | `/faculty/yearly-report/new` | Multi-step annual academic, teaching, research & FDP submission |
| **Faculty Portal** | 4. My Yearly Reports History | `/faculty/yearly-reports` | Past annual reports, HOD/Principal verification status, and PDF export |
| **Faculty Portal** | 5. Lodge a Complaint | `/faculty/complaints/new` | Faculty grievance & whistleblower compliance form |
| **Faculty Portal** | 6. My Complaints & Tracker | `/faculty/complaints` | Status timeline of submitted faculty complaints and officer remarks |

---

## 2. Copy-Paste Prompt for Your Frontend AI Builder

Copy the entire prompt below and pass it directly to your AI coding assistant to generate the complete React frontend for the Student and Faculty portals.

```text
ROLE & CONTEXT
You are building the "Student Portal" and "Faculty Portal" frontend modules for ApprovalTrack (Smart India Hackathon 2026, problem statement SIH26262, AICTE approval-process and compliance tracker). These two portals extend the existing 21-page React.js application (which covers Institution, Officer, Committees, Senior Authority, and Admin roles). Deliver COMPLETE WORKING REACT FILES (no placeholders, no truncated snippets) using React 18+, React Router v6, Tailwind CSS, and Lucide React icons, backed by realistic deterministic mock data in a central state/context provider so every form, filter, drawer, and status transition works interactively out of the box.

DESIGN SYSTEM & INSTITUTIONAL STYLE
- Visual Theme: Clean white background (#FFFFFF) with crisp slate surfaces (#F8FAFC), deep navy institutional primary palette (#0F172A / #1E3A8A), slate borders (#E2E8F0), and high-contrast typography.
- Mandatory Global Safeguard Banner: Every single screen in both portals MUST display this persistent top banner:
  "DEMO DATA - NOT REAL AICTE DEADLINES. AI-suggested values are not verified. A person must confirm every value; the software never replaces the competent authority."
- Hard Governance Rule: Neither a student/faculty complaint nor a faculty yearly report may automatically deduct from an institution's Action Score, start a statutory clock, or alter application routing. Complaints show "Pending Verification — 0 Action Score impact until confirmed by an Authorised Officer." Yearly reports show "Pending Institutional Nodal Sign-Off" until verified.

NAVIGATION & LAYOUT ARCHITECTURE
Build a unified responsive shell (`StakeholderLayout.jsx`) with a top role-switcher bar (allowing demo switching between "Student View — Nirmal S R, B.Tech CSE 3rd Year" and "Faculty View — Dr. Kavitha Rajan, Associate Professor, CSE"), the mandatory safeguard banner, a collapsible left sidebar, and a persistent "Quick Complaint / Whistleblower" button in the header.

1. STUDENT PORTAL SIDEBAR & ROUTES (`/student/*`)
   - `/student/college-overview` ("College Overview & Approval"):
     Displays the public institutional profile of the student's college (fictional demo: "Sri Vidya Institute of Engineering and Technology, Coimbatore — AICTE Permanent ID: 1-492817462"). Shows current academic year approval badge ("EoA Granted for 2026-27"), university affiliation, accrediting bodies, downloadable public EoA letters (2022-23 to 2026-27), and a public compliance summary card (Fire Safety, Structural Stability, Occupancy Certificate, Potable Water, Anti-Ragging Undertaking — showing issue/expiry dates and "Verified Active" status badges).
   - `/student/offerings` ("Approved Courses & Offerings"):
     Interactive searchable and filterable table of all publicly approved programmes at the college. Columns: Programme Level (UG / PG / Diploma), Course Name, Shift (1st / 2nd), Approved Intake (2026-27), NBA Accreditation Status (Accredited with validity date vs. Not Accredited), State Fee Committee Approved Tuition Ceiling (in INR with Indian digit grouping), and Placement/Disclosure summary link. Include a search bar and level/accreditation filters.
   - `/student/facilities` ("Campus Facilities & Safety"):
     Public self-disclosure view of what the college offers to students: Instructional Built-Up Area (sq.m.), Department Laboratories (with equipment compliance status), Central Library (volumes, national/international journals, e-consortium access), Computing & Internet Bandwidth, Hostel & Mess capacity, Medical/First-Aid room, and Barrier-Free Environment (ramps, lifts, accessible washrooms).
   - `/student/complaints/new` ("Lodge a Complaint"):
     Complete, validated Student Grievance & Compliance Complaint form (see exact fields below).
   - `/student/complaints` ("My Complaints & Tracker"):
     List and detail drawer of the student's submitted complaints with status timeline (`Submitted` -> `Assigned to College SGRC` -> `Escalated to AICTE Regional Officer` -> `Resolved`), SLA day counter (held by institution SGRC vs. held by officer), officer/committee remarks, and a "Request Escalation to AICTE Ombudsperson" button when unresolved beyond 15 days.
   - `/student/committees` ("Statutory Committees & Help"):
     Public roster and contact cards for the Student Grievance Redressal Committee (SGRC), Anti-Ragging Committee & Squad, Internal Complaints Committee (ICC), SC/ST/OBC Cell, and University Ombudsperson.

2. FACULTY PORTAL SIDEBAR & ROUTES (`/faculty/*`)
   - `/faculty/college-overview` ("College Overview & Offerings"):
     Same public institutional profile, EoA approval status, approved courses & intake table, and public campus facilities view as the student portal, plus an additional "Institutional Compliance & EVC Readiness Snapshot" banner showing publicly disclosed faculty-student ratio (e.g., 1:18.5 against 1:20 norm) and cadre ratio.
   - `/faculty/department-roster` ("Department & Cadre Roster"):
     Publicly disclosed department-wise faculty strength (Professor / Associate Professor / Assistant Professor required vs. available), Ph.D. count, and laboratory mapping for the faculty member's department.
   - `/faculty/yearly-report/new` ("Submit Yearly Report"):
     Multi-step or tabbed Annual Faculty Academic & Compliance Report submission workflow (see exact fields below) with "Save as Draft", validation summary, and "Submit for HOD & Nodal Verification".
   - `/faculty/yearly-reports` ("My Yearly Reports History"):
     Table and preview modal of annual reports submitted by the faculty member across academic years (`2026-27`, `2025-26`, `2024-25`), showing verification status (`Draft`, `Submitted to HOD`, `Returned for Correction` with written reason, `Verified & Locked in Self-Disclosure`), submission timestamp, and a printable summary view.
   - `/faculty/complaints/new` ("Lodge a Complaint"):
     Complete, validated Faculty Grievance & Whistleblower Compliance form (see exact fields below).
   - `/faculty/complaints` ("My Complaints & Tracker"):
     List and detail timeline of submitted faculty complaints with confidentiality badge, review stage, and official response log.

EXACT FORM FIELDS TO IMPLEMENT

A) SHARED COMPLAINT SUBMISSION FORM (`/student/complaints/new` and `/faculty/complaints/new`)
Adapt categories dynamically based on whether the active user is `student` or `faculty`:
1. `privacy_mode` (Radio cards):
   - "Standard Identified Grievance" (shared with College SGRC / Grievance Cell first for resolution).
   - "Confidential / Whistleblower Mode" (identity masked from college management; routed directly to AICTE Regional Scrutiny / Vigilance Queue for serious statutory violations).
2. `category` (Select dropdown):
   - If Student:
     * "Unapproved Course or Excess Intake Admission"
     * "Original Certificates / Marksheets Withheld by College"
     * "Excess Fee Demand or Non-Refund of Fees on Cancellation"
     * "Laboratory, Equipment, or Library Deficiency"
     * "Hostel, Sanitation, Fire, or Building Safety Hazard"
     * "Scholarship / AICTE Stipend Disbursement Delay"
     * "Ragging, Harassment, or SGRC Non-Responsiveness"
   - If Faculty:
     * "Non-Payment, Delayed Disbursement, or Arbitrary Deduction of Salary"
     * "Non-Implementation of Prescribed Pay Scale (6th / 7th CPC)"
     * "Original Educational / Experience Certificates Withheld by Management"
     * "Ghost Faculty / Coerced Proxy Attendance or Fake Biometric Entry"
     * "Coerced Sign-Off on False EVC, Lab Equipment, or Self-Disclosure Records"
     * "Unlawful Termination or Denial of Statutory / Academic Leave"
     * "Workplace Harassment or ICC Non-Compliance"
3. `severity` (Select): "Routine Grievance", "Statutory Non-Compliance", "Urgent Safety / Certificate Withholding".
4. `department_or_programme` (Select): Pre-populated from the college's approved courses/departments plus "Campus-Wide / Administration".
5. `incident_date_or_period` (Date picker + academic semester selector).
6. `subject` (Text input, required, 10–120 chars).
7. `description` (Textarea, required, min 50 chars with live character counter).
8. `prior_internal_representation` (Boolean toggle): If true, reveal `internal_ticket_ref` (Text) and `internal_submission_date` (Date).
9. `evidence_attachments` (Simulated multi-file uploader): Accepts `.pdf`, `.png`, `.jpg` up to 5 files; display file name, size, document type tag (e.g., "Fee Receipt", "Salary Slip", "Lab Photo", "Appointment Order"), and a simulated security scan badge ("Passed Quarantine Check — Valid Extension & Header").
10. `declaration_confirmed` (Checkbox, required): "I affirm that the facts stated above are true to the best of my knowledge. I understand that submitting a complaint flags the item for human review by the competent authority and does not automatically alter statutory approval scores."

B) FACULTY YEARLY REPORT SUBMISSION FORM (`/faculty/yearly-report/new`)
Organize into 5 clear sections with progress indicators and field-level validation:
1. Section 1 — Academic Year & Faculty Profile:
   - `academic_year` (Select: `2026-27`, `2025-26`)
   - `faculty_aicte_id` (Read-only pre-filled, e.g., `FAC-TN-2019-88412`)
   - `full_name`, `department`, `designation` (`Assistant Professor`, `Associate Professor`, `Professor`), `appointment_type` (`Regular`, `Contractual`, `Adjunct`), `date_of_joining`
   - `highest_qualification` (`Ph.D.`, `M.Tech / M.E.`, `M.S.`), `phd_university_and_year`
   - `pay_scale_implemented` (`7th CPC`, `6th CPC`, `Consolidated`), `gross_monthly_salary_inr` (formatted with Indian commas), `salary_bank_mode` (`ECS / NEFT Direct Credit`)
2. Section 2 — Teaching Load & Student Mentoring:
   - Dynamic repeatable table for `courses_taught`: Semester (`Odd` / `Even`), Programme & Year, Course Code & Title, Weekly Lecture/Lab Hours (`L-T-P`), Student Pass Percentage, and Course File Uploaded (`Yes / No`).
   - `ug_projects_guided` (Number), `pg_theses_guided` (Number), `phd_scholars_supervising` (Number).
3. Section 3 — Research, Publications & Sponsored Projects:
   - Dynamic repeatable list for `publications`: Title, Journal/Conference Name, Indexing (`SCI / SCIE`, `Scopus`, `UGC Care`, `Other`), Month & Year, DOI / ISBN link.
   - `patents_published_or_granted` (Count + details text), `sponsored_research_grants_inr` (Amount + funding agency, e.g., AICTE RPS, DST, SERB, Industry Consultancy).
4. Section 4 — FDPs, MOOCs & Institutional Compliance Roles:
   - Dynamic list for `fdp_certifications`: Programme Title, Organiser (`AICTE ATAL`, `SWAYAM / NPTEL`, `IIT / NIT`, `Other`), Duration in Days, Completion Date, Certificate PDF upload.
   - `institutional_roles` (Multi-select checkboxes): NBA/NAAC Coordinator, EVC Nodal Member, Anti-Ragging Committee, Examination Cell, Placement Coordinator, Hostel Warden, SGRC Member.
5. Section 5 — Evidence Uploads & Statutory Exclusivity Declaration:
   - Upload slots for: (a) Latest Salary Bank Statement / Form-16 excerpt, (b) FDP / Publication Proof Bundle (PDF), (c) Semester Workload Allotment Order.
   - Mandatory Exclusivity Checkbox: "I solemnly declare that I am employed as a full-time regular faculty member solely at this institution for the stated academic year and my AICTE Faculty ID is not claimed by any other technical institution."

DELIVERABLES REQUIRED
Provide complete, runnable code files:
1. `src/data/mockStakeholderData.js` (rich fictional Tamil Nadu / Coimbatore college profile, 8 approved courses with intake/NBA/fees, 6 safety certificates, department faculty roster, 3 historical faculty yearly reports, and 4 sample student/faculty complaints across different stages).
2. `src/context/StakeholderContext.jsx` (state management for role switching, adding/updating complaints, escalating complaints, saving/submitting faculty yearly reports).
3. `src/components/layout/StakeholderLayout.jsx` (top safeguard banner, role switcher, sidebar for Student vs. Faculty, header notifications).
4. `src/pages/shared/CollegeOverviewPage.jsx`, `ApprovedOfferingsPage.jsx`, `CampusFacilitiesPage.jsx`.
5. `src/pages/shared/ComplaintFormPage.jsx` and `ComplaintsTrackerPage.jsx`.
6. `src/pages/student/StatutoryCommitteesPage.jsx`.
7. `src/pages/faculty/DepartmentRosterPage.jsx`, `FacultyYearlyReportFormPage.jsx`, and `FacultyYearlyReportsHistoryPage.jsx`.
8. `src/App.jsx` wiring all `/student/*` and `/faculty/*` routes cleanly.
```
