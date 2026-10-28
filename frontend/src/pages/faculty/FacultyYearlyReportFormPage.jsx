import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, FilePlus2, Plus, Save, Send, Trash2 } from "lucide-react";
import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

const SECTIONS = [
  "Academic year & profile",
  "Teaching & mentoring",
  "Research & projects",
  "FDPs & responsibilities",
  "Evidence & declaration",
];
const DEFAULT_COURSE = { semester: "Odd", programmeYear: "", courseCodeTitle: "", weeklyHours: "", passPercentage: "", courseFileUploaded: "No" };
const DEFAULT_PUBLICATION = { title: "", journal: "", indexing: "Scopus", monthYear: "", doi: "" };
const DEFAULT_FDP = { title: "", organiser: "AICTE ATAL", durationDays: "", completionDate: "", certificate: "" };
const ROLES = ["NBA/NAAC Coordinator", "EVC Nodal Member", "Anti-Ragging Committee", "Examination Cell", "Placement Coordinator", "Hostel Warden", "SGRC Member"];

function makeInitial(faculty) {
  return {
    academic_year: "2026-27",
    faculty_aicte_id: faculty.aicteId,
    full_name: faculty.fullName,
    department: faculty.department,
    designation: faculty.designation,
    appointment_type: faculty.appointmentType,
    date_of_joining: faculty.dateOfJoining,
    highest_qualification: faculty.highestQualification,
    phd_university_and_year: faculty.phdUniversityAndYear,
    pay_scale_implemented: faculty.payScale,
    gross_monthly_salary_inr: faculty.monthlySalary,
    salary_bank_mode: "ECS / NEFT Direct Credit",
    courses_taught: [{ ...DEFAULT_COURSE, courseCodeTitle: "CS301 - Data Structures", programmeYear: "B.Tech CSE · Year 2", weeklyHours: "3-1-2", passPercentage: "91" }],
    ug_projects_guided: "4",
    pg_theses_guided: "2",
    phd_scholars_supervising: "1",
    publications: [{ ...DEFAULT_PUBLICATION, title: "Efficient Edge Analytics for Smart Campuses", journal: "Journal of Applied Computing", indexing: "Scopus", monthYear: "2026-04", doi: "10.0000/demo.2026.041" }],
    patents_published_or_granted: "1",
    patents_details: "Fictional demo patent disclosure: campus energy analytics dashboard.",
    sponsored_research_grants_inr: "250000",
    funding_agency: "AICTE RPS - fictional demo grant",
    fdp_certifications: [{ ...DEFAULT_FDP, title: "Outcome-Based Education Practices", organiser: "AICTE ATAL", durationDays: "5", completionDate: "2026-07-18", certificate: "" }],
    institutional_roles: ["NBA/NAAC Coordinator", "Examination Cell"],
    evidence_salary: "",
    evidence_fdp_publications: "",
    evidence_workload_order: "",
    exclusivityConfirmed: false,
  };
}

function Field({ label, children, hint, className = "" }) {
  return <label className={`stakeholder-field ${className}`}>{label}{children}{hint && <small>{hint}</small>}</label>;
}

function RepeatList({ title, description, items, template, onChange, renderItem }) {
  function edit(index, key, value) {
    onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item));
  }
  return <Panel title={title} description={description} action={<button type="button" className="stakeholder-button secondary small" onClick={() => onChange([...items, { ...template }])}><Plus size={15} />Add item</button>}>
    {items.map((item, index) => <div className="stakeholder-repeat-card" key={`${title}-${index}`}>
      <div className="stakeholder-repeat-heading"><strong>{title.replace(/s$/, "")} {index + 1}</strong>{items.length > 1 && <button className="stakeholder-icon-action danger" type="button" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}><Trash2 size={15} /></button>}</div>
      {renderItem(item, (key, value) => edit(index, key, value))}
    </div>)}
  </Panel>;
}

export default function FacultyYearlyReportFormPage() {
  const { faculty, saveReport } = useStakeholder();
  const navigate = useNavigate();
  const [form, setForm] = useState(() => makeInitial(faculty));
  const [section, setSection] = useState(0);
  const [reportId, setReportId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function save(submit) {
    if (submit && (!form.exclusivityConfirmed || !form.full_name.trim() || !form.department
      || !form.designation || !form.date_of_joining || !form.highest_qualification
      || !form.courses_taught.length || !form.evidence_salary
      || !form.evidence_fdp_publications || !form.evidence_workload_order)) {
      setError("Complete the required profile details, attach all three evidence files, and confirm the statutory exclusivity declaration before submitting.");
      setSection(4);
      return;
    }
    if (submit && form.courses_taught.some((course) => !course.courseCodeTitle.trim() || !course.programmeYear.trim())) {
      setError("Complete the programme/year and course code/title for every teaching row.");
      setSection(1);
      return;
    }
    const saved = saveReport({ ...form, id: reportId }, submit);
    setReportId(saved.id);
    setError("");
    if (submit) {
      setMessage("Report submitted to HOD. It is now Pending Institutional Nodal Sign-Off.");
      navigate("/faculty/yearly-reports", { state: { createdId: saved.id } });
    } else {
      setMessage(`Draft ${saved.id} saved on this device. No official review has started.`);
      window.setTimeout(() => setMessage(""), 5000);
    }
  }

  function uploadEvidence(key, event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      setError("Evidence uploads accept PDF files in this frontend simulation.");
      event.target.value = "";
      return;
    }
    update(key, file.name);
    setError("");
  }

  function sectionContent() {
    if (section === 0) return <>
      <Panel title="Academic year & faculty profile" description="Identity fields are fictional and pre-filled for the demo.">
        <div className="stakeholder-form-grid">
          <Field label="Academic year *"><select value={form.academic_year} onChange={(event) => update("academic_year", event.target.value)}><option>2026-27</option><option>2025-26</option></select></Field>
          <Field label="Faculty AICTE ID"><input readOnly value={form.faculty_aicte_id} /></Field>
          <Field label="Full name *"><input required value={form.full_name} onChange={(event) => update("full_name", event.target.value)} /></Field>
          <Field label="Department *"><select value={form.department} onChange={(event) => update("department", event.target.value)}><option>Computer Science and Engineering</option><option>Electronics and Communication Engineering</option><option>Mechanical Engineering</option><option>Electrical and Electronics Engineering</option></select></Field>
          <Field label="Designation *"><select value={form.designation} onChange={(event) => update("designation", event.target.value)}><option>Assistant Professor</option><option>Associate Professor</option><option>Professor</option></select></Field>
          <Field label="Appointment type *"><select value={form.appointment_type} onChange={(event) => update("appointment_type", event.target.value)}><option>Regular</option><option>Contractual</option><option>Adjunct</option></select></Field>
          <Field label="Date of joining *"><input required type="date" value={form.date_of_joining} onChange={(event) => update("date_of_joining", event.target.value)} /></Field>
          <Field label="Highest qualification *"><select value={form.highest_qualification} onChange={(event) => update("highest_qualification", event.target.value)}><option>Ph.D.</option><option>M.Tech / M.E.</option><option>M.S.</option></select></Field>
          <Field label="Ph.D. university and year"><input value={form.phd_university_and_year} onChange={(event) => update("phd_university_and_year", event.target.value)} /></Field>
          <Field label="Pay scale implemented"><select value={form.pay_scale_implemented} onChange={(event) => update("pay_scale_implemented", event.target.value)}><option>7th CPC</option><option>6th CPC</option><option>Consolidated</option></select></Field>
          <Field label="Gross monthly salary (INR)"><input inputMode="numeric" value={form.gross_monthly_salary_inr} onChange={(event) => update("gross_monthly_salary_inr", event.target.value.replace(/[^\d]/g, ""))} onBlur={() => update("gross_monthly_salary_inr", Number(form.gross_monthly_salary_inr || 0).toLocaleString("en-IN"))} /></Field>
          <Field label="Salary bank mode"><select value={form.salary_bank_mode} onChange={(event) => update("salary_bank_mode", event.target.value)}><option>ECS / NEFT Direct Credit</option><option>Other bank transfer</option></select></Field>
        </div>
      </Panel>
      <SafeguardNote tone="amber">Personal identifiers and salary values here are fictional examples. Do not enter real PAN, Aadhaar, or banking information.</SafeguardNote>
    </>;
    if (section === 1) return <>
      <RepeatList title="Courses taught" description="Add odd/even semester teaching assignments." items={form.courses_taught} template={DEFAULT_COURSE} onChange={(items) => update("courses_taught", items)} renderItem={(item, edit) => <div className="stakeholder-form-grid">
        <Field label="Semester"><select value={item.semester} onChange={(event) => edit("semester", event.target.value)}><option>Odd</option><option>Even</option></select></Field>
        <Field label="Programme & year *"><input required value={item.programmeYear} onChange={(event) => edit("programmeYear", event.target.value)} placeholder="B.Tech CSE · Year 2" /></Field>
        <Field label="Course code & title *"><input required value={item.courseCodeTitle} onChange={(event) => edit("courseCodeTitle", event.target.value)} placeholder="CS301 - Data Structures" /></Field>
        <Field label="Weekly hours (L-T-P)"><input value={item.weeklyHours} onChange={(event) => edit("weeklyHours", event.target.value)} placeholder="3-1-2" /></Field>
        <Field label="Student pass percentage"><input type="number" min="0" max="100" value={item.passPercentage} onChange={(event) => edit("passPercentage", event.target.value)} /></Field>
        <Field label="Course file uploaded"><select value={item.courseFileUploaded} onChange={(event) => edit("courseFileUploaded", event.target.value)}><option>Yes</option><option>No</option></select></Field>
      </div>} />
      <Panel title="Student mentoring" description="Number of active project and thesis supervisions during this academic year.">
        <div className="stakeholder-form-grid">{[["ug_projects_guided", "UG projects guided"], ["pg_theses_guided", "PG theses guided"], ["phd_scholars_supervising", "Ph.D. scholars supervising"]].map(([key, label]) => <Field label={label} key={key}><input type="number" min="0" value={form[key]} onChange={(event) => update(key, event.target.value)} /></Field>)}</div>
      </Panel>
    </>;
    if (section === 2) return <>
      <RepeatList title="Publications" description="Journal articles, conference papers, books, or chapters." items={form.publications} template={DEFAULT_PUBLICATION} onChange={(items) => update("publications", items)} renderItem={(item, edit) => <div className="stakeholder-form-grid">
        <Field label="Title"><input value={item.title} onChange={(event) => edit("title", event.target.value)} /></Field>
        <Field label="Journal / conference"><input value={item.journal} onChange={(event) => edit("journal", event.target.value)} /></Field>
        <Field label="Indexing"><select value={item.indexing} onChange={(event) => edit("indexing", event.target.value)}><option>SCI / SCIE</option><option>Scopus</option><option>UGC Care</option><option>Other</option></select></Field>
        <Field label="Month & year"><input type="month" value={item.monthYear} onChange={(event) => edit("monthYear", event.target.value)} /></Field>
        <Field label="DOI / ISBN link" className="stakeholder-field-full"><input value={item.doi} onChange={(event) => edit("doi", event.target.value)} placeholder="https://doi.org/..." /></Field>
      </div>} />
      <Panel title="Patents & sponsored projects">
        <div className="stakeholder-form-grid">
          <Field label="Patents filed / published / granted"><input type="number" min="0" value={form.patents_published_or_granted} onChange={(event) => update("patents_published_or_granted", event.target.value)} /></Field>
          <Field label="Patent details"><input value={form.patents_details} onChange={(event) => update("patents_details", event.target.value)} /></Field>
          <Field label="Sponsored research grants (INR)"><input inputMode="numeric" value={form.sponsored_research_grants_inr} onChange={(event) => update("sponsored_research_grants_inr", event.target.value.replace(/[^\d]/g, ""))} /></Field>
          <Field label="Funding agency"><input value={form.funding_agency} onChange={(event) => update("funding_agency", event.target.value)} /></Field>
        </div>
      </Panel>
    </>;
    if (section === 3) return <>
      <RepeatList title="FDP certifications" description="Include faculty development programmes and MOOCs completed in the assessment year." items={form.fdp_certifications} template={DEFAULT_FDP} onChange={(items) => update("fdp_certifications", items)} renderItem={(item, edit) => <div className="stakeholder-form-grid">
        <Field label="Programme title"><input value={item.title} onChange={(event) => edit("title", event.target.value)} /></Field>
        <Field label="Organiser"><select value={item.organiser} onChange={(event) => edit("organiser", event.target.value)}><option>AICTE ATAL</option><option>SWAYAM / NPTEL</option><option>IIT / NIT</option><option>Other</option></select></Field>
        <Field label="Duration in days"><input type="number" min="1" value={item.durationDays} onChange={(event) => edit("durationDays", event.target.value)} /></Field>
        <Field label="Completion date"><input type="date" value={item.completionDate} onChange={(event) => edit("completionDate", event.target.value)} /></Field>
        <Field label="Certificate PDF" className="stakeholder-field-full"><input type="file" accept=".pdf,application/pdf" onChange={(event) => edit("certificate", event.target.files?.[0]?.name || "")} /><small>{item.certificate || "No file selected · local demo only"}</small></Field>
      </div>} />
      <Panel title="Institutional responsibilities" description="Select all responsibilities held during the assessment year.">
        <div className="stakeholder-check-grid">{ROLES.map((name) => <label key={name}><input type="checkbox" checked={form.institutional_roles.includes(name)} onChange={(event) => update("institutional_roles", event.target.checked ? [...form.institutional_roles, name] : form.institutional_roles.filter((role) => role !== name))} />{name}</label>)}</div>
      </Panel>
    </>;
    return <>
      <Panel title="Evidence uploads" description="Simulated PDF upload slots. Evidence stays in the browser demo and is not transmitted.">
        <div className="stakeholder-evidence-grid">{[["evidence_salary", "Latest salary bank statement / Form-16 excerpt"], ["evidence_fdp_publications", "FDP / publication proof bundle"], ["evidence_workload_order", "Semester workload allotment order"]].map(([key, label]) => <label className="stakeholder-evidence-slot" key={key}><span><FilePlus2 size={18} />{label} *</span><input type="file" accept=".pdf,application/pdf" onChange={(event) => uploadEvidence(key, event)} /><small>{form[key] || "Choose a PDF file"}</small></label>)}</div>
      </Panel>
      <Panel title="Statutory exclusivity declaration" description="Required before submitting this report for HOD and nodal review.">
        <label className="stakeholder-declaration"><input type="checkbox" checked={form.exclusivityConfirmed} onChange={(event) => update("exclusivityConfirmed", event.target.checked)} />
          <span>I solemnly declare that I am employed as a full-time regular faculty member solely at this institution for the stated academic year and my AICTE Faculty ID is not claimed by any other technical institution. *</span>
        </label>
      </Panel>
      <SafeguardNote tone="amber">Pending Institutional Nodal Sign-Off. Submission is not verification and does not start a statutory clock, alter application routing, or write to an Action Score or policy table.</SafeguardNote>
    </>;
  }

  return <div className="stakeholder-page">
    <PageHeader eyebrow="ANNUAL FACULTY DISCLOSURE" title="Submit Yearly Report"
      description="Complete the five sections of your annual academic and compliance report. Save a draft at any time." />
    <div className="stakeholder-progress"><div className="stakeholder-progress-copy"><strong>Section {section + 1} of {SECTIONS.length}</strong><span>{Math.round(((section + 1) / SECTIONS.length) * 100)}% complete</span></div><div className="stakeholder-progress-track"><span style={{ width: `${((section + 1) / SECTIONS.length) * 100}%` }} /></div>
      <div className="stakeholder-progress-steps">{SECTIONS.map((title, index) => <button type="button" key={title} onClick={() => setSection(index)} className={index === section ? "active" : index < section ? "complete" : ""}><span>{index < section ? <Check size={14} /> : index + 1}</span>{title}</button>)}</div>
    </div>
    <div className="stakeholder-report-form">{sectionContent()}</div>
    {error && <div className="stakeholder-form-error" role="alert">{error}</div>}
    {message && <div className="stakeholder-form-success" role="status">{message}</div>}
    <div className="stakeholder-report-actions"><button type="button" className="stakeholder-button secondary" onClick={() => save(false)}><Save size={16} />Save as Draft</button>
      <div><button type="button" className="stakeholder-button secondary" disabled={section === 0} onClick={() => setSection((current) => current - 1)}><ChevronLeft size={16} />Previous</button>
        {section < SECTIONS.length - 1 ? <button type="button" className="stakeholder-button primary" onClick={() => { setError(""); setSection((current) => current + 1); }} >Next section<ChevronRight size={16} /></button>
          : <button type="button" className="stakeholder-button primary" onClick={() => save(true)}><Send size={16} />Submit for HOD & Nodal Verification</button>}</div>
    </div>
    <p className="stakeholder-small-disclaimer">Save and submission actions update local demo data only. Verification remains a separate human step.</p>
  </div>;
}
