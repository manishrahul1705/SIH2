import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, Download, Eye, FileText, RefreshCw, X } from "lucide-react";
import { PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";
import { stakeholderApi } from "../../services/stakeholder";

const statusTone = (status) => status === "RESOLVED" ? "green" : ["REJECTED", "PENDING_ADMIN_VALIDATION", "SUBMITTED"].includes(status) ? "amber" : "blue";
const statusLabel = (status) => ({
  PENDING_ADMIN_VALIDATION: "Under AICTE Admin Validation",
  ACKNOWLEDGED_SENT_TO_COLLEGE: "Acknowledged by AICTE & Dispatched to College",
  COLLEGE_REPLIED: "College Action Taken Report received",
  RESOLVED: "Resolved by College",
}[status] || status.replaceAll("_", " "));

export default function ComplaintsTrackerPage() {
  const { complaints, loading, error, reload } = useStakeholder();
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequest = useRef(0);
  const reloadRef = useRef(reload);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      reloadRef.current().catch(() => {});
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function viewEvidence(complaint, evidence) {
    setActionError("");
    const requestId = ++previewRequest.current;
    setPreview({ fileName: evidence.file_name, mimeType: evidence.mime_type, url: "", loading: true });
    setPreviewLoading(true);
    try {
      const blob = await stakeholderApi.downloadComplaintEvidence(complaint._id, evidence._id);
      const url = URL.createObjectURL(blob);
      if (requestId !== previewRequest.current) {
        URL.revokeObjectURL(url);
        return;
      }
      setPreview({ fileName: evidence.file_name, mimeType: blob.type || evidence.mime_type, url, loading: false });
    } catch (previewError) {
      if (requestId === previewRequest.current) {
        setActionError(previewError.message || "The evidence document could not be opened.");
        setPreview(null);
      }
    } finally {
      if (requestId === previewRequest.current) setPreviewLoading(false);
    }
  }
  function closePreview() {
    previewRequest.current += 1;
    setPreviewLoading(false);
    setPreview(null);
  }
  async function refreshComplaints() {
    setActionError("");
    try {
      await reload();
    } catch (refreshError) {
      setActionError(refreshError.message || "Complaint status could not be refreshed.");
    }
  }
  async function appeal(complaint) {
    const reason = window.prompt(complaint.complainant_role === "STUDENT"
      ? "Explain why you are appealing the SGRC decision:"
      : "Explain why you are appealing the faculty/staff GRC decision:");
    if (!reason) return;
    setActionError("");
    try {
      await stakeholderApi.submitStudentAppeal(complaint._id, { reason });
      await reload();
    } catch (appealError) { setActionError(appealError.message); }
  }

  const progressSteps = [
    "Submitted",
    "Under AICTE Admin Validation",
    "Acknowledged & Sent to College for Redressal",
    "Resolved by College",
  ];
  function progressIndex(status) {
    if (status === "RESOLVED") return 4;
    if (["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED", "ACKNOWLEDGED", "IN_REVIEW"].includes(status)) return 3;
    return 1;
  }

  return <div className="stakeholder-page">
    <PageHeader eyebrow="COMPLAINT TRACKER" title="My Complaints & Tracker" description="Your authenticated complaint records, evidence, and official status history." action={<Link className="stakeholder-button primary" to="new">New complaint</Link>} />
    <Panel className="complaints-tracker-panel" title="Complaint records" action={<button className="stakeholder-button secondary small complaints-refresh" type="button" onClick={refreshComplaints} disabled={loading}><RefreshCw size={15} className={loading ? "is-spinning" : ""} />Refresh status</button>}>
      {loading ? <p>Loading complaints…</p> : error ? <p role="alert">{error}</p> : complaints.length
        ? <div className="stakeholder-report-list">{complaints.map((complaint) => <article className="stakeholder-report-card" key={complaint._id}>
          <div className="stakeholder-report-icon">!</div><div className="stakeholder-report-copy">
            <div><strong>{complaint.subject}</strong><StatusPill tone={statusTone(complaint.status)}>{statusLabel(complaint.status)}</StatusPill></div>
            <p>{complaint.category.replaceAll("_", " ")} · {complaint.description}</p>
            <small>Reference {complaint.complaint_id || complaint._id} · Submitted {new Date(complaint.createdAt).toLocaleString()}</small>
            <ol className="complaint-progress">
              {progressSteps.map((step, index) => {
                const current = progressIndex(complaint.status);
                const complete = index < current;
                const active = current < progressSteps.length && index === current;
                return <li key={step} className={`${complete ? "complete" : ""} ${active ? "current" : ""}`}><span>{complete ? "✓" : index + 1}</span><small>{step}</small></li>;
              })}
            </ol>
            {complaint.admin_action?.acknowledged_at && <p><strong>AICTE Admin remarks:</strong> {complaint.admin_action.admin_remarks || "Your complaint was acknowledged and forwarded."} · Response due {complaint.admin_action.response_deadline ? new Date(complaint.admin_action.response_deadline).toLocaleDateString() : "not set"}</p>}
            {complaint.college_response?.action_taken_report && <div className="complaint-college-response"><strong>College Action Taken Report</strong><p>{complaint.college_response.action_taken_report}</p>
              {complaint.college_response.proof_document && <button className="stakeholder-button secondary small complaint-evidence-view" type="button" onClick={() => viewEvidence(complaint, complaint.college_response.proof_document)} disabled={previewLoading}><Eye size={14} />View college proof <span>{complaint.college_response.proof_document.file_name}</span></button>}
            </div>}
            {complaint.resolution_note && <p><strong>Official update:</strong> {complaint.resolution_note}</p>}
            <small>Committee: {complaint.committee_type?.replaceAll("_", " ")} · Response target: {new Date(complaint.response_due_at).toLocaleDateString()}</small>
            {complaint.appeal_status && complaint.appeal_status !== "NONE" && <p>Appeal: {complaint.appeal_status.replaceAll("_", " ")} · Route: {complaint.appeal_route?.replaceAll("_", " ")}{complaint.appeal_due_at ? ` · Decision target ${new Date(complaint.appeal_due_at).toLocaleDateString()}` : ""}{complaint.appeal_resolution_note ? ` · ${complaint.appeal_resolution_note}` : ""}</p>}
            {["RESOLVED", "REJECTED"].includes(complaint.status) && complaint.appeal_status === "NONE" && (
              complaint.complainant_role !== "STUDENT" || complaint.resolved_at && Date.now() <= new Date(complaint.resolved_at).getTime() + 15 * 86400000
            ) && <button className="stakeholder-button secondary small" onClick={() => appeal(complaint)}>{complaint.complainant_role === "STUDENT" ? "Appeal to Ombudsperson" : "Appeal to University/DTE"}</button>}
            {!!complaint.evidence?.length && <div className="stakeholder-evidence-list"><strong>Evidence documents</strong>{complaint.evidence.map((item) => <button className="stakeholder-button secondary small complaint-evidence-view" type="button" key={item._id} onClick={() => viewEvidence(complaint, item)} disabled={previewLoading}><Eye size={14} />View document <span>{item.file_name}</span></button>)}</div>}
            <ol className="stakeholder-complaint-history">{(complaint.history || []).map((event, index) => <li key={`${event.created_at}-${index}`}>{event.status.replaceAll("_", " ")} · {event.note} · {new Date(event.created_at).toLocaleString()}</li>)}</ol>
          </div>
        </article>)}</div>
        : <div className="stakeholder-empty"><strong>No complaints submitted</strong><p>Complaints you submit will appear here with their reference and status history.</p><Link className="stakeholder-button primary" to="new">Lodge a complaint</Link></div>}
      {actionError && <p role="alert">{actionError}</p>}
    </Panel>
    <Dialog.Root open={Boolean(preview)} onOpenChange={(open) => { if (!open) closePreview(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="complaint-document-overlay" />
        {preview && <Dialog.Content className="complaint-document-dialog" aria-describedby="complaint-document-description">
          <header className="complaint-document-heading">
            <span className="complaint-document-icon"><FileText size={20} /></span>
            <div><p>COMPLAINT EVIDENCE</p><Dialog.Title>{preview.fileName}</Dialog.Title></div>
            <Dialog.Close className="complaint-document-close" aria-label="Close document preview" onClick={closePreview}><X size={20} /></Dialog.Close>
          </header>
          <p id="complaint-document-description" className="complaint-document-caption">Private evidence attached to your complaint.</p>
          <div className="complaint-document-viewer">
            {preview.loading && <div className="complaint-document-loading"><span className="stakeholder-spinner" />Loading document securely…</div>}
            {!preview.loading && preview.url && preview.mimeType === "application/pdf" && <iframe title={`Preview of ${preview.fileName}`} src={preview.url} />}
            {!preview.loading && preview.url && ["image/jpeg", "image/png"].includes(preview.mimeType) && <img src={preview.url} alt={`Preview of ${preview.fileName}`} />}
            {!preview.loading && preview.url && !["application/pdf", "image/jpeg", "image/png"].includes(preview.mimeType) && <div className="complaint-document-fallback"><AlertCircle size={24} /><p>This file type cannot be previewed in the browser.</p></div>}
          </div>
          <footer className="complaint-document-actions">
            {preview.url && <a className="stakeholder-button secondary" href={preview.url} download={preview.fileName}><Download size={15} />Download document</a>}
            <Dialog.Close className="stakeholder-button primary" type="button" onClick={closePreview}>Close preview</Dialog.Close>
          </footer>
        </Dialog.Content>}
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
