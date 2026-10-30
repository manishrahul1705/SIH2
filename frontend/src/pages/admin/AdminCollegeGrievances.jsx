import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Download, FileText, Search, ShieldCheck } from "lucide-react";
import { Badge, Card } from "../../components/ui/primitives";
import { PageHeader, Panel } from "../../components/stakeholder/PortalPrimitives";
import { stakeholderApi } from "../../services/stakeholder";

const pendingStatuses = new Set(["PENDING_ADMIN_VALIDATION", "SUBMITTED"]);

function dateLabel(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function complaintStatus(status) {
  return status === "PENDING_ADMIN_VALIDATION" || status === "SUBMITTED"
    ? "Pending validation"
    : status.replaceAll("_", " ");
}

function complainantDetails(complaint) {
  const user = complaint.complainant_id;
  return user && typeof user === "object"
    ? `${user.name || "Name unavailable"} · ${user.email || "Email unavailable"}${user.phone ? ` · ${user.phone}` : ""}`
    : `${complaint.complainant_role || "Complainant"} · Identity record ${user || "unavailable"}`;
}

export default function AdminCollegeGrievances() {
  const [colleges, setColleges] = useState([]);
  const [selectedInstitution, setSelectedInstitution] = useState(null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("pending");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledging, setAcknowledging] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [evidenceReviewed, setEvidenceReviewed] = useState(false);
  const [resolving, setResolving] = useState(null);
  const [resolution, setResolution] = useState("");

  const loadSummary = useCallback(async () => {
    setError("");
    try {
      setColleges(await stakeholderApi.getAdminComplaintSummary());
    } catch (loadError) {
      setError(loadError.message || "College grievance summary could not be loaded.");
    }
  }, []);

  const loadDetail = useCallback(async (institution) => {
    setSelectedInstitution(institution);
    setDetail(null);
    setError("");
    try {
      const result = await stakeholderApi.getAdminCollegeComplaints(institution._id);
      setDetail(result);
    } catch (loadError) {
      setError(loadError.message || "College complaints could not be loaded.");
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const filteredColleges = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return colleges;
    return colleges.filter(({ institution }) => (
      institution.name?.toLowerCase().includes(query)
      || institution.aicte_id?.toLowerCase().includes(query)
      || institution.region?.toLowerCase().includes(query)
    ));
  }, [colleges, search]);

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
      setError(downloadError.message || "Evidence could not be downloaded.");
    }
  }

  async function acknowledge(event) {
    event.preventDefault();
    if (!acknowledging) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await stakeholderApi.acknowledgeComplaint(acknowledging._id, remarks, evidenceReviewed);
      setMessage(`Complaint ${acknowledging.complaint_id || acknowledging._id} acknowledged and sent to the college.`);
      setAcknowledging(null);
      setRemarks("");
      setEvidenceReviewed(false);
      await Promise.all([loadSummary(), selectedInstitution && loadDetail(selectedInstitution)]);
    } catch (actionError) {
      setError(actionError.message || "The complaint could not be forwarded.");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(event) {
    event.preventDefault();
    if (!resolving) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await stakeholderApi.resolveComplaint(resolving._id, resolution);
      setMessage(`Complaint ${resolving.complaint_id || resolving._id} marked resolved.`);
      setResolving(null);
      setResolution("");
      await Promise.all([loadSummary(), selectedInstitution && loadDetail(selectedInstitution)]);
    } catch (actionError) {
      setError(actionError.message || "The complaint could not be resolved.");
    } finally {
      setBusy(false);
    }
  }

  const complaints = detail?.[tab] || [];

  return <div className="page-container page-shell-wide">
    <PageHeader
      eyebrow="AICTE GRIEVANCE CELL"
      title="College Grievances"
      description="Review complaints confidentially, forward validated grievances to colleges, and track their responses."
      action={selectedInstitution ? <button className="button button-secondary" onClick={() => { setSelectedInstitution(null); setDetail(null); setError(""); }}>All colleges</button> : null}
    />
    {error && <p className="state-card state-error" role="alert">{error}</p>}
    {message && <p className="note success-note" role="status">{message}</p>}

    {!selectedInstitution ? <>
      <div className="grievance-overview-shell">
        <div className="grievance-summary-bar">
          <label className="grievance-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search college name, AICTE ID, or region" /></label>
          <button className="button button-secondary" onClick={loadSummary}>Refresh</button>
        </div>

        <div className="grievance-summary-grid">
          <div className="grievance-summary-card grievance-summary-card--blue">
            <div className="grievance-summary-icon"><Building2 size={24} /></div>
            <div className="grievance-summary-copy">
              <div className="grievance-summary-label">Institutions</div>
              <div className="grievance-summary-number">{colleges.length}</div>
            </div>
            <div className="grievance-summary-foot">Total institutions with grievances</div>
          </div>

          <div className="grievance-summary-card grievance-summary-card--amber">
            <div className="grievance-summary-icon"><Search size={22} /></div>
            <div className="grievance-summary-copy">
              <div className="grievance-summary-label">Pending validation</div>
              <div className="grievance-summary-number">{colleges.reduce((count, item) => count + (item.pendingCount || 0), 0)}</div>
            </div>
            <div className="grievance-summary-foot">Complaints awaiting validation</div>
          </div>

          <div className="grievance-summary-card grievance-summary-card--green">
            <div className="grievance-summary-icon"><FileText size={22} /></div>
            <div className="grievance-summary-copy">
              <div className="grievance-summary-label">Forwarded</div>
              <div className="grievance-summary-number">{colleges.reduce((count, item) => count + (item.completedCount || 0), 0)}</div>
            </div>
            <div className="grievance-summary-foot">Complaints forwarded to colleges</div>
          </div>
        </div>

        <div className="grievance-list-panel">
          <div className="grievance-panel-header">
            <div>
              <h2>Institutions with grievances</h2>
              <p>View colleges with grievances and their current status.</p>
            </div>
            <label className="compact-select">
              <span>Sort by</span>
              <select defaultValue="latest">
                <option value="latest">Latest update</option>
                <option value="pending">Pending validation</option>
                <option value="forwarded">Forwarded</option>
              </select>
            </label>
          </div>

          {filteredColleges.length
            ? <div className="grievance-institution-list">{filteredColleges.map((item) => (
              <button className="grievance-institution-row" key={item.institution._id} onClick={() => loadDetail(item.institution)}>
                <div className="grievance-institution-main">
                  <span className="grievance-institution-icon"><Building2 size={20} /></span>
                  <div className="grievance-institution-copy">
                    <strong>{item.institution.name}</strong>
                    <small>{item.institution.aicte_id || "AICTE ID unavailable"} · {item.institution.region || item.institution.state || "Region unavailable"}</small>
                  </div>
                </div>

                <div className="grievance-status-stack">
                  <div className="grievance-status-pill grievance-status-pill--pending">
                    <span className="pill-dot" />
                    Pending Validation
                    <strong>{item.pendingCount || 0}</strong>
                  </div>
                  <div className="grievance-status-pill grievance-status-pill--success">
                    <span className="pill-dot" />
                    Completed / Forwarded
                    <strong>{item.completedCount || 0}</strong>
                  </div>
                </div>

                <div className="grievance-meta-summary">
                  <div className="grievance-row-count"><FileText size={16} /> {item.totalCount || 0} total complaint{(item.totalCount || 0) === 1 ? "" : "s"}</div>
                  <div className="grievance-row-date">Latest update {dateLabel(item.lastActivity)}</div>
                </div>
              </button>
            ))}</div>
            : <Card title="No colleges with complaints"><p className="muted">{search ? "No colleges match your search." : "Complaints will appear here after students or faculty submit them."}</p></Card>}
        </div>
      </div>
    </> : <>
      <div className="grievance-detail-shell">
        <div className="grievance-detail-header">
          <div className="grievance-institution-brand">
            <span className="grievance-institution-brand-icon"><Building2 size={24} /></span>
            <div>
              <h2>{detail?.institution?.name || selectedInstitution.name}</h2>
              <p>{detail?.institution?.aicte_id || selectedInstitution.aicte_id || "AICTE ID unavailable"} · {detail?.institution?.region || selectedInstitution.region || "Region unavailable"}</p>
            </div>
          </div>
        </div>

        <div className="grievance-tabs" role="tablist" aria-label="Complaint status">
          <button type="button" role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>Pending Validation <span>{detail?.pending?.length || 0}</span></button>
          <button type="button" role="tab" aria-selected={tab === "completed"} className={tab === "completed" ? "active" : ""} onClick={() => setTab("completed")}>Completed / Forwarded <span>{detail?.completed?.length || 0}</span></button>
        </div>

        {!detail ? <p>Loading college complaints…</p> : !complaints.length ? <div className="grievance-empty-panel">
          <div className="grievance-empty-illustration"><Search size={58} /></div>
          <h3>{tab === "pending" ? "No complaints are waiting for Admin validation." : "No completed or forwarded complaints."}</h3>
          <p>{tab === "pending" ? "Once complaints from this institution are submitted, they will appear here for your review." : "Complaints that have been validated or forwarded will appear here for the institution summary."}</p>
          <button className="button button-primary" onClick={() => { loadDetail(selectedInstitution); loadSummary(); }}>Refresh college records</button>
        </div> : <div className="grievance-complaint-list">
          {complaints.map((complaint) => {
            const isPending = pendingStatuses.has(complaint.status);
            const complainant = complaint.complainant_role === "FACULTY" ? "Faculty" : "Student";
            return <article className="grievance-complaint-card" key={complaint._id}>
              <div className="grievance-complaint-top">
                <div><p className="stakeholder-eyebrow">{complaint.complaint_id || complaint._id} · {complaint.category.replaceAll("_", " ")}</p><h3>{complaint.subject}</h3></div>
                <Badge variant={isPending ? "warning" : complaint.status === "RESOLVED" ? "success" : "info"}>{complaintStatus(complaint.status)}</Badge>
              </div>
              <p>{complaint.description}</p>
              <div className="grievance-meta"><span>Submitted {dateLabel(complaint.createdAt)}</span><span>Complainant type: {complainant} · Identity visible to authorized Admin only</span><span>{complainantDetails(complaint)}</span></div>
              {!!complaint.evidence?.length && <div className="grievance-evidence"><strong>Evidence files</strong>{complaint.evidence.map((file) => <button key={file._id} type="button" onClick={() => download(complaint, file)}><Download size={14} />{file.file_name}</button>)}</div>}
              {complaint.admin_action?.acknowledged_at && <div className="grievance-directive"><strong>Admin remarks</strong><p>{complaint.admin_action.admin_remarks || "No additional directive."}</p><small>Acknowledged {dateLabel(complaint.admin_action.acknowledged_at)} · Evidence reviewed {dateLabel(complaint.admin_action.evidence_reviewed_at)} · Response due {dateLabel(complaint.admin_action.response_deadline)}</small></div>}
              {complaint.college_response?.action_taken_report && <div className="grievance-directive"><strong>College Action Taken Report</strong><p>{complaint.college_response.action_taken_report}</p><small>Submitted {dateLabel(complaint.college_response.responded_at)}</small>
                {complaint.college_response.proof_document && <button className="text-link" type="button" onClick={() => download(complaint, complaint.college_response.proof_document)}><Download size={14} /> Download ATR proof</button>}
              </div>}
              <div className="grievance-card-actions">
                {isPending && <button className="button button-primary" type="button" onClick={() => { setAcknowledging(complaint); setRemarks(""); setEvidenceReviewed(false); }}>Acknowledge &amp; Send to College</button>}
                {!isPending && complaint.status !== "RESOLVED" && <button className="button button-secondary" type="button" onClick={() => { setResolving(complaint); setResolution(""); }}>Mark resolved</button>}
              </div>
            </article>;
          })}
        </div>}
      </div>
    </>}

    {(acknowledging || resolving) && <div className="grievance-modal-backdrop" role="presentation">
      <section className="grievance-modal" role="dialog" aria-modal="true" aria-labelledby="grievance-modal-title">
        <button className="grievance-modal-close" type="button" onClick={() => { setAcknowledging(null); setResolving(null); setRemarks(""); setResolution(""); setEvidenceReviewed(false); }} aria-label="Close dialog">×</button>
        {acknowledging ? <>
          <ShieldCheck size={24} />
          <h2 id="grievance-modal-title">Acknowledge &amp; send to college</h2>
          <p>Review the complaint and download each attachment before forwarding. Do not send information that could identify the complainant. A response deadline of seven days will be set.</p>
          <form onSubmit={acknowledge}>
            <label className="stakeholder-field">Admin remarks or directives (optional)<textarea rows={4} maxLength={3000} value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="For example: Please submit an explanation and release original certificates within 7 working days." /></label>
            <label className="grievance-review-confirmation">
              <input type="checkbox" required checked={evidenceReviewed} onChange={(event) => setEvidenceReviewed(event.target.checked)} />
              <span>I reviewed the complaint and any attachments and confirmed they do not reveal the complainant's identity.</span>
            </label>
            <button className="button button-primary" disabled={busy || !evidenceReviewed}>{busy ? "Forwarding…" : "Confirm and forward"}</button>
          </form>
        </> : <>
          <FileText size={24} />
          <h2 id="grievance-modal-title">Resolve complaint</h2>
          <p>Record the final AICTE resolution note for the complainant.</p>
          <form onSubmit={resolve}>
            <label className="stakeholder-field">Resolution note<textarea required minLength={10} maxLength={2000} rows={4} value={resolution} onChange={(event) => setResolution(event.target.value)} /></label>
            <button className="button button-primary" disabled={busy || resolution.trim().length < 10}>{busy ? "Saving…" : "Mark resolved"}</button>
          </form>
        </>}
      </section>
    </div>}
  </div>;
}
