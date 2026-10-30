import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { stakeholderApi } from "../../services/stakeholder";

const currentYear = new Date().getFullYear();
const emptyReport = (year = currentYear) => ({
  calendar_year: year,
  complaints_received: 0,
  ic_training_or_orientation: 0,
  complaints_disposed: 0,
  pending_over_90_days: 0,
  awareness_programs: 0,
  action_taken: "",
});

export default function InstitutionAnnualReportPage() {
  const [reports, setReports] = useState([]);
  const [form, setForm] = useState(emptyReport());
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setReports((await stakeholderApi.getInstitutionAnnualReports()) || []);
  }

  useEffect(() => { load().catch((loadError) => setError(loadError.message)); }, []);

  function edit(report) {
    setForm({
      calendar_year: report.calendar_year,
      complaints_received: report.complaints_received,
      ic_training_or_orientation: report.ic_training_or_orientation,
      complaints_disposed: report.complaints_disposed,
      pending_over_90_days: report.pending_over_90_days,
      awareness_programs: report.awareness_programs,
      action_taken: report.action_taken,
    });
    setFiles([]);
  }

  async function save(submit) {
    setBusy(true);
    setError("");
    try {
      const saved = await stakeholderApi.saveInstitutionAnnualReport({
        ...form,
        calendar_year: Number(form.calendar_year),
        complaints_received: Number(form.complaints_received),
        ic_training_or_orientation: Number(form.ic_training_or_orientation),
        complaints_disposed: Number(form.complaints_disposed),
        pending_over_90_days: Number(form.pending_over_90_days),
        awareness_programs: Number(form.awareness_programs),
      });
      for (const file of files) await stakeholderApi.uploadInstitutionAnnualReportEvidence(saved._id, file);
      if (submit) await stakeholderApi.submitInstitutionAnnualReport(saved._id);
      setFiles([]);
      await load();
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }

  async function download(report, evidence) {
    setError("");
    try {
      const blob = await stakeholderApi.downloadInstitutionAnnualReportEvidence(report._id, evidence._id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = evidence.file_name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) { setError(downloadError.message); }
  }

  function change(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="institution-annual-page">
      <div className="institution-annual-header">
        <div>
          <p className="institution-annual-eyebrow">INSTITUTIONAL COMPLIANCE</p>
          <h1>Internal Committee annual report</h1>
          <p>Record the institution’s annual report on sexual-harassment prevention and Internal Committee activity.</p>
        </div>
      </div>

      <div className="institution-annual-alert">
        <Info size={18} />
        <span>APH 2024–27 §6.48 describes an institution-level Internal Committee annual report due by 30 June. This is separate from individual faculty yearly reports. Check amendments and the applicable cycle before filing.</span>
      </div>

      <section className="institution-annual-panel">
        <div className="institution-annual-panel-header">
          <div className="institution-annual-panel-icon">📝</div>
          <div>
            <h2>Annual report fields</h2>
            <p>The deadline is calculated as 30 June of the selected calendar year.</p>
          </div>
        </div>

        <div className="institution-annual-grid">
          <label className="institution-annual-field">
            <span>Calendar year</span>
            <input type="number" min="2000" max="9999" value={form.calendar_year} onChange={(event) => change("calendar_year", event.target.value)} />
          </label>

          <label className="institution-annual-field">
            <span>Complaints received</span>
            <input type="number" min="0" step="1" value={form.complaints_received} onChange={(event) => change("complaints_received", event.target.value)} />
          </label>

          <label className="institution-annual-field">
            <span>IC training/orientation sessions</span>
            <input type="number" min="0" step="1" value={form.ic_training_or_orientation} onChange={(event) => change("ic_training_or_orientation", event.target.value)} />
          </label>

          <label className="institution-annual-field">
            <span>Complaints disposed</span>
            <input type="number" min="0" step="1" value={form.complaints_disposed} onChange={(event) => change("complaints_disposed", event.target.value)} />
          </label>

          <label className="institution-annual-field">
            <span>Cases pending over 90 days</span>
            <input type="number" min="0" step="1" value={form.pending_over_90_days} onChange={(event) => change("pending_over_90_days", event.target.value)} />
          </label>

          <label className="institution-annual-field">
            <span>Awareness workshops/programmes</span>
            <input type="number" min="0" step="1" value={form.awareness_programs} onChange={(event) => change("awareness_programs", event.target.value)} />
          </label>

          <label className="institution-annual-field institution-annual-field-full">
            <span>Action taken</span>
            <textarea rows={5} value={form.action_taken} onChange={(event) => change("action_taken", event.target.value)} />
          </label>
        </div>

        {error && <p className="institution-annual-error" role="alert">{error}</p>}

        <div className="institution-annual-actions">
          <button className="institution-annual-button secondary" type="button" disabled={busy || !form.action_taken.trim()} onClick={() => save(false)}>{busy ? "Saving…" : "Save draft"}</button>
          <button className="institution-annual-button primary" type="button" disabled={busy || !form.action_taken.trim()} onClick={() => save(true)}>{busy ? "Saving…" : "Submit annual report"}</button>
        </div>
      </section>

      {reports.length > 0 && <section className="institution-annual-subpanel">
        <div className="institution-annual-subpanel-header">
          <h3>Submitted and draft reports</h3>
        </div>
        <div className="institution-annual-report-list">
          {reports.map((report) => (
            <div key={report._id || report.calendar_year} className="institution-annual-report-card">
              <div className="report-card-top">
                <strong>Calendar year {report.calendar_year}</strong>
                <span className={`report-state ${report.status === "SUBMITTED" ? "submitted" : "draft"}`}>{report.status}</span>
              </div>
              <p>{report.complaints_received} complaints received · {report.complaints_disposed} complaints disposed · {report.pending_over_90_days} pending over 90 days</p>
              {report.evidence?.length ? <div className="report-evidence-list">{report.evidence.map((file) => <button key={file._id} type="button" className="report-evidence-button" onClick={() => download(report, file)}>{file.file_name}</button>)}</div> : null}
              {report.status === "DRAFT" && <button className="institution-annual-button secondary small" type="button" onClick={() => edit(report)}>Edit draft</button>}
            </div>
          ))}
        </div>
      </section>}
    </div>
  );
}
