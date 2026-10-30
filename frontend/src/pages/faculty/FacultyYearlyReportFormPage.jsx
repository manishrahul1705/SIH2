import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";
import { stakeholderApi } from "../../services/stakeholder";

const blankReport = {
  academic_year: "",
  due_date: "",
  courses_taught: "",
  projects_guided: "",
  publications: "",
  fdp_certifications: "",
  institutional_roles: "",
};

function lines(value) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((item) => {
    try { return JSON.parse(item); } catch { return item; }
  });
}

function reportFields(report) {
  const data = report?.report_data || {};
  const text = (value) => Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n")
    : typeof value === "string" ? value : "";
  return {
    academic_year: report?.academic_year || "",
    due_date: report?.due_date ? new Date(report.due_date).toISOString().slice(0, 10) : "",
    courses_taught: text(data.courses_taught),
    projects_guided: text(data.projects_guided),
    publications: text(data.publications),
    fdp_certifications: text(data.fdp_certifications),
    institutional_roles: text(data.institutional_roles),
  };
}

export default function FacultyYearlyReportFormPage() {
  const { faculty, reports, loading, error: loadError, reload } = useStakeholder();
  const navigate = useNavigate();
  const [form, setForm] = useState(blankReport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [evidenceFiles, setEvidenceFiles] = useState([]);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function chooseYear(year) {
    const saved = reports.find((report) => report.academic_year === year);
    setForm(saved ? reportFields(saved) : { ...blankReport, academic_year: year });
  }

  async function save(submit) {
    if (!/^\d{4}-\d{2}$/.test(form.academic_year)) {
      setError("Enter the academic year in YYYY-YY format, such as 2025-26.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const existing = reports.find((report) => report.academic_year === form.academic_year);
      const saved = await stakeholderApi.saveYearlyReport({
        academic_year: form.academic_year,
        due_date: form.due_date,
        report_data: {
          ...(existing?.report_data || {}),
          courses_taught: lines(form.courses_taught),
          projects_guided: lines(form.projects_guided),
          publications: lines(form.publications),
          fdp_certifications: lines(form.fdp_certifications),
          institutional_roles: lines(form.institutional_roles),
        },
      });
      for (const file of evidenceFiles) await stakeholderApi.uploadYearlyReportEvidence(saved._id, file);
      if (submit) await stakeholderApi.submitYearlyReport(saved._id);
      await reload();
      navigate("/faculty/yearly-reports", { state: { createdId: saved._id } });
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  const existing = reports.find((report) => report.academic_year === form.academic_year);
  return <div className="stakeholder-page">
    <PageHeader eyebrow="ANNUAL FACULTY REPORT" title="Submit Yearly Report"
      description="This is an ApprovalTrack faculty-portal extension. APH 2024–27's annual report requirement is institution-level Internal Committee reporting, not an individual faculty annual report." />
    {loading && <Panel title="Loading profile">Loading your faculty profile and saved reports...</Panel>}
    {loadError && <p role="alert">{loadError}</p>}
    {!loading && !faculty && <Panel title="Faculty profile unavailable"><p>This account does not have a linked faculty profile. A report cannot be saved.</p></Panel>}
    {faculty && <Panel title="Verified faculty profile" description="Read-only information from your backend profile.">
      <p>{faculty.name || "Name not recorded"} · {faculty.department || "Department not recorded"} · {faculty.designation || "Designation not recorded"}</p>
    </Panel>}
    <Panel title="Report details" description="Use one item per line. Leave fields blank if no records are being reported.">
      <div className="stakeholder-form-grid">
        <label className="stakeholder-field">Academic year *
          <input required value={form.academic_year} placeholder="2025-26" pattern="\d{4}-\d{2}" onChange={(event) => chooseYear(event.target.value)} />
        </label>
        <label className="stakeholder-field">Due date *
          <input required type="date" value={form.due_date} onChange={(event) => update("due_date", event.target.value)} />
        </label>
        {[
          ["courses_taught", "Courses taught"],
          ["projects_guided", "Projects guided"],
          ["publications", "Publications"],
          ["fdp_certifications", "FDP certifications"],
          ["institutional_roles", "Institutional roles"],
        ].map(([key, label]) => <label className="stakeholder-field stakeholder-field-full" key={key}>{label}
          <textarea rows={3} value={form[key]} onChange={(event) => update(key, event.target.value)} />
        </label>)}
      </div>
      <label className="stakeholder-field stakeholder-field-full">Supporting evidence (optional)
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple onChange={(event) => setEvidenceFiles(Array.from(event.target.files || []).slice(0, 10))} />
        <small>{evidenceFiles.map((file) => file.name).join(", ") || "PDF, JPEG or PNG; maximum ten files, 15 MB each. Attachments are stored with this report."}</small>
      </label>
    </Panel>
    {existing && <p>Editing the saved {existing.status.toLowerCase()} report for this academic year.</p>}
    {error && <div className="stakeholder-form-error" role="alert">{error}</div>}
    <div className="stakeholder-report-actions">
      <button type="button" className="stakeholder-button secondary" disabled={busy || loading || !faculty || !form.academic_year || !form.due_date} onClick={() => save(false)}>Save draft to backend</button>
      <button type="button" className="stakeholder-button primary" disabled={busy || loading || !faculty || !form.academic_year || !form.due_date} onClick={() => save(true)}>Submit report</button>
    </div>
    <SafeguardNote tone="blue">Evidence attachments are stored with the report. Draft or returned reports can be edited; submitted reports are not reopened by this form.</SafeguardNote>
  </div>;
}
