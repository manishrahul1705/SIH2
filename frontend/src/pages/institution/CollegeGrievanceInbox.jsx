import { useCallback, useEffect, useState } from "react";
import { Download, FileText, ShieldCheck } from "lucide-react";
import { PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { stakeholderApi } from "../../services/stakeholder";

function dateLabel(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

export default function CollegeGrievanceInbox() {
  const [complaints, setComplaints] = useState([]);
  const [reports, setReports] = useState({});
  const [files, setFiles] = useState({});
  const [expandedId, setExpandedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const records = await stakeholderApi.getInstitutionComplaints();
      if (!Array.isArray(records)) throw new Error("The college grievance response was invalid.");
      setComplaints(records);
    } catch (loadError) {
      setError(loadError.message || "College grievances could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function download(complaint, evidence) {
    setError("");
    try {
      const blob = await stakeholderApi.downloadComplaintEvidence(complaint._id, evidence._id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = evidence.file_name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError.message || "The evidence file could not be downloaded.");
    }
  }

  async function submitReply(event, complaint) {
    event.preventDefault();
    const report = (reports[complaint._id] || "").trim();
    if (report.length < 10) {
      setError("Enter an Action Taken Report of at least 10 characters.");
      return;
    }
    setBusyId(complaint._id);
    setError("");
    setMessage("");
    try {
      await stakeholderApi.replyToComplaint(complaint._id, report, files[complaint._id] || null);
      setMessage(`Action Taken Report submitted for ${complaint.complaint_id}. The complainant and AICTE have been notified.`);
      setReports((current) => ({ ...current, [complaint._id]: "" }));
      setFiles((current) => ({ ...current, [complaint._id]: null }));
      setExpandedId("");
      await load();
    } catch (submitError) {
      setError(submitError.message || "The Action Taken Report could not be submitted.");
    } finally {
      setBusyId("");
    }
  }

  return <div className="page-container">
    <PageHeader
      eyebrow="INSTITUTION GRIEVANCE INBOX"
      title="College Grievances"
      description="View only grievances acknowledged and forwarded by AICTE. The complainant's identity is never shown to the college."
    />
    <div className="grievance-privacy-note"><ShieldCheck size={18} /><span>Complainants are anonymous to your institution. Use the reference number for all replies; do not attempt to identify the complainant.</span></div>
    {error && <p className="state-card state-error" role="alert">{error}</p>}
    {message && <p className="note success-note" role="status">{message}</p>}
    <Panel title="Forwarded grievances" description="Submit your official response and supporting proof before each response deadline." action={<button className="button button-secondary" onClick={load}>Refresh</button>}>
      {loading ? <p>Loading grievances…</p> : complaints.length
        ? <div className="grievance-complaint-list">{complaints.map((complaint) => {
          const resolved = complaint.status === "RESOLVED";
          const replied = complaint.status === "COLLEGE_REPLIED";
          const proof = complaint.college_response?.proof_document;
          return <article className="grievance-complaint-card" key={complaint._id}>
            <div className="grievance-complaint-top">
              <div><p className="stakeholder-eyebrow">{complaint.complaint_id} · {complaint.category.replaceAll("_", " ")}</p><h3>{complaint.subject}</h3></div>
              <StatusPill tone={resolved ? "green" : replied ? "blue" : "amber"}>{complaint.status.replaceAll("_", " ")}</StatusPill>
            </div>
            <p>{complaint.description}</p>
            <div className="grievance-meta">
              <span>Complainant: {complaint.anonymous_alias}</span>
              <span>Forwarded {dateLabel(complaint.admin_action?.acknowledged_at)}</span>
              <span>Response deadline {dateLabel(complaint.admin_action?.response_deadline || complaint.response_due_at)}</span>
            </div>
            <div className="grievance-directive"><strong>AICTE Admin directives</strong><p>{complaint.admin_action?.admin_remarks || "No additional directive was recorded."}</p></div>
            {!!complaint.evidence?.length && <div className="grievance-evidence"><strong>Attached evidence</strong>{complaint.evidence.map((file) => <button key={file._id} type="button" onClick={() => download(complaint, file)}><Download size={14} />{file.file_name}</button>)}</div>}
            {complaint.college_response?.action_taken_report && <div className="grievance-directive"><strong>Previously submitted Action Taken Report</strong><p>{complaint.college_response.action_taken_report}</p><small>Submitted {dateLabel(complaint.college_response.responded_at)}</small>
              {proof && <button className="text-link" type="button" onClick={() => download(complaint, proof)}><Download size={14} /> Download submitted proof</button>}
            </div>}
            {!resolved && <div className="grievance-card-actions">
              <button className="button button-primary" type="button" onClick={() => setExpandedId(expandedId === complaint._id ? "" : complaint._id)}>
                {replied ? "Update Action Taken Report" : "Submit Resolution / Action Taken Report"}
              </button>
            </div>}
            {expandedId === complaint._id && !resolved && <form className="grievance-reply-form" onSubmit={(event) => submitReply(event, complaint)}>
              <label className="stakeholder-field">Official Action Taken Report<textarea required minLength={10} maxLength={5000} rows={5} value={reports[complaint._id] || ""} onChange={(event) => setReports((current) => ({ ...current, [complaint._id]: event.target.value }))} placeholder="Describe the steps taken to address this complaint." /></label>
              <label className="stakeholder-field">Supporting proof (optional; PDF, JPG, or PNG, up to 10 MB)
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  if (file && file.size > 10 * 1024 * 1024) {
                    setError("Proof file must be 10 MB or smaller.");
                    event.target.value = "";
                    return;
                  }
                  setError("");
                  setFiles((current) => ({ ...current, [complaint._id]: file }));
                }} />
                <small>{files[complaint._id]?.name || "Attach rectification proof or an official receipt."}</small>
              </label>
              <button className="button button-primary" disabled={busyId === complaint._id || (reports[complaint._id] || "").trim().length < 10}>
                {busyId === complaint._id ? "Submitting…" : "Submit Action Taken Report"}
              </button>
            </form>}
          </article>;
        })}</div>
        : error ? null : <div className="state-card"><FileText size={22} /><h3>No forwarded grievances</h3><p>Complaints appear here only after AICTE Admin acknowledges and forwards them.</p></div>}
    </Panel>
  </div>;
}
