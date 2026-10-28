import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, FilePlus2, ShieldCheck, Trash2, Upload } from "lucide-react";
import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

const initialForm = {
  privacyMode: "identified",
  category: "",
  severity: "Routine Grievance",
  department: "",
  incidentDate: "",
  semester: "",
  subject: "",
  description: "",
  priorRepresentation: false,
  internalTicketRef: "",
  internalSubmissionDate: "",
  declarationConfirmed: false,
};

function attachmentType(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes("fee") || name.includes("receipt")) return "Fee Receipt";
  if (name.includes("salary") || name.includes("bank")) return "Salary / Bank Proof";
  if (name.includes("lab") || name.includes("photo")) return "Facility Photo";
  if (name.includes("appointment") || name.includes("order")) return "Appointment Order";
  return "Supporting evidence";
}

export default function ComplaintFormPage() {
  const { role, categories, departments, addComplaint } = useStakeholder();
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const student = role === "student";
  const trackerPath = `/${role}/complaints`;

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addFiles(event) {
    const incoming = Array.from(event.target.files || []);
    event.target.value = "";
    const supported = incoming.filter((file) => /\.(pdf|png|jpe?g)$/i.test(file.name));
    if (supported.length !== incoming.length) {
      setError("Only PDF, PNG, and JPG evidence files are accepted in this demo.");
      return;
    }
    if (files.length + supported.length > 5) {
      setError("You can attach a maximum of five evidence files.");
      return;
    }
    setError("");
    setFiles((current) => [...current, ...supported]);
  }

  function submit(event) {
    event.preventDefault();
    if (!form.category || !form.department || !form.incidentDate || !form.semester
      || form.subject.trim().length < 10 || form.subject.trim().length > 120
      || form.description.trim().length < 50 || !form.declarationConfirmed) {
      setError("Complete all required fields. The subject must be 10-120 characters and the description at least 50 characters.");
      return;
    }
    if (form.priorRepresentation && (!form.internalTicketRef.trim() || !form.internalSubmissionDate)) {
      setError("Add the internal reference and date for the prior representation.");
      return;
    }
    const complaint = addComplaint({
      ...form,
      attachments: files,
      privacyLabel: form.privacyMode === "confidential" ? "Confidential / Whistleblower" : "Standard Identified Grievance",
    });
    navigate(trackerPath, { state: { createdId: complaint.id } });
  }

  return <div className="stakeholder-page">
    <PageHeader eyebrow={`${role.toUpperCase()} SUPPORT`} title="Lodge a Complaint"
      description={`Submit a ${student ? "student grievance" : "faculty grievance or confidential compliance concern"} for human review.`} />
    <SafeguardNote tone="amber">Complaint submission creates a demo tracking ticket only. It does not deduct Action Score points, start a statutory clock, halt an application, or determine a compliance violation.</SafeguardNote>
    <form className="stakeholder-form" onSubmit={submit}>
      <Panel title="Privacy and review route" description="Choose how your identity is handled in the demo workflow.">
        <div className="stakeholder-choice-grid">
          <label className={`stakeholder-choice-card ${form.privacyMode === "identified" ? "selected" : ""}`}>
            <input type="radio" name="privacyMode" value="identified" checked={form.privacyMode === "identified"} onChange={() => update("privacyMode", "identified")} />
            <span className="stakeholder-choice-icon"><CheckCircle2 size={19} /></span>
            <span><strong>Standard Identified Grievance</strong><small>Shared with the College SGRC / Grievance Cell first for resolution.</small></span>
          </label>
          <label className={`stakeholder-choice-card ${form.privacyMode === "confidential" ? "selected" : ""}`}>
            <input type="radio" name="privacyMode" value="confidential" checked={form.privacyMode === "confidential"} onChange={() => update("privacyMode", "confidential")} />
            <span className="stakeholder-choice-icon"><ShieldCheck size={19} /></span>
            <span><strong>Confidential / Whistleblower Mode</strong><small>Demo identity masking and regional scrutiny for serious statutory concerns.</small></span>
          </label>
        </div>
        {form.privacyMode === "confidential" && <div className="stakeholder-inline-warning"><ShieldCheck size={16} />Confidentiality routing is simulated in this frontend. Do not enter real personal or sensitive information.</div>}
      </Panel>
      <Panel title="Complaint details" description="Fields marked * are required. Use fictional information in this demo.">
        <div className="stakeholder-form-grid">
          <label className="stakeholder-field">Category *<select required value={form.category} onChange={(event) => update("category", event.target.value)}><option value="">Select a category</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="stakeholder-field">Severity *<select value={form.severity} onChange={(event) => update("severity", event.target.value)}><option>Routine Grievance</option><option>Statutory Non-Compliance</option><option>Urgent Safety / Certificate Withholding</option></select></label>
          <label className="stakeholder-field">Department / programme *<select required value={form.department} onChange={(event) => update("department", event.target.value)}><option value="">Select affected area</option>{departments.map((department) => <option key={department}>{department}</option>)}</select></label>
          <label className="stakeholder-field">Incident date *<input required type="date" value={form.incidentDate} onChange={(event) => update("incidentDate", event.target.value)} /></label>
          <label className="stakeholder-field">Academic semester *<select required value={form.semester} onChange={(event) => update("semester", event.target.value)}><option value="">Select semester</option><option>Odd semester 2026-27</option><option>Even semester 2025-26</option><option>Odd semester 2025-26</option><option>Earlier / not applicable</option></select></label>
          <label className="stakeholder-field stakeholder-field-full">Subject *<input required minLength={10} maxLength={120} value={form.subject} onChange={(event) => update("subject", event.target.value)} placeholder="Briefly summarize the concern" /><small>{form.subject.length}/120 characters</small></label>
          <label className="stakeholder-field stakeholder-field-full">Description *<textarea required minLength={50} rows={5} value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Describe what happened, when it occurred, and the resolution you are seeking. Do not include real sensitive personal details." /><small>{form.description.length} characters · minimum 50</small></label>
        </div>
        <label className="stakeholder-toggle-row"><input type="checkbox" checked={form.priorRepresentation} onChange={(event) => update("priorRepresentation", event.target.checked)} /><span><strong>Prior internal representation</strong><small>Have you already raised this with the principal or SGRC?</small></span></label>
        {form.priorRepresentation && <div className="stakeholder-form-grid stakeholder-conditional-fields">
          <label className="stakeholder-field">Internal ticket reference *<input required value={form.internalTicketRef} onChange={(event) => update("internalTicketRef", event.target.value)} placeholder="e.g. SGRC-2026-014" /></label>
          <label className="stakeholder-field">Internal submission date *<input required type="date" value={form.internalSubmissionDate} onChange={(event) => update("internalSubmissionDate", event.target.value)} /></label>
        </div>}
      </Panel>
      <Panel title="Supporting evidence" description="Up to five PDF, PNG, or JPG files. This is a local simulation; files are not uploaded or transmitted.">
        <label className="stakeholder-upload-zone"><Upload size={23} /><strong>Select supporting files</strong><span>PDF, PNG, JPG · up to five files</span><input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" multiple onChange={addFiles} /></label>
        {files.length > 0 && <div className="stakeholder-file-list">{files.map((file, index) => <div className="stakeholder-file-row" key={`${file.name}-${index}`}>
          <FilePlus2 size={17} /><div><strong>{file.name}</strong><small>{attachmentType(file.name)} · {(file.size / 1024).toFixed(0)} KB</small></div><span className="stakeholder-scan-pass"><ShieldCheck size={14} />Passed quarantine check — simulated</span>
          <button type="button" className="stakeholder-icon-action danger" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}><Trash2 size={16} /></button>
        </div>)}</div>}
      </Panel>
      <Panel title="Declaration" description="A human reviewer will assess the information before any official action.">
        <label className="stakeholder-declaration"><input type="checkbox" checked={form.declarationConfirmed} onChange={(event) => update("declarationConfirmed", event.target.checked)} />
          <span>I affirm that the facts stated above are true to the best of my knowledge. I understand that submitting a complaint flags the item for human review by the competent authority and does not automatically alter statutory approval scores. *</span>
        </label>
        {error && <div className="stakeholder-form-error" role="alert"><AlertTriangle size={17} />{error}</div>}
        <div className="stakeholder-form-actions"><button type="button" className="stakeholder-button secondary" onClick={() => navigate(trackerPath)}>Cancel</button><button type="submit" className="stakeholder-button primary"><FilePlus2 size={16} />Submit complaint for review</button></div>
      </Panel>
    </form>
  </div>;
}
