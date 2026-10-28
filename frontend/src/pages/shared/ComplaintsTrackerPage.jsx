import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, CalendarDays, CheckCircle2, Clock3, Eye, FilePlus2, ShieldCheck, X } from "lucide-react";
import { PageHeader, Panel, SafeguardNote, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

const STAGES = ["Submitted", "Assigned to College SGRC", "Escalated to AICTE Regional Officer", "Resolved / Closed"];
const STATUS_TONE = (status) => status.includes("Escalated") || status.includes("Regional") ? "blue" : status.includes("Resolved") ? "green" : status.includes("Review") ? "amber" : "slate";

function daysSince(value) {
  const start = new Date(`${value}T00:00:00`);
  const today = new Date();
  return Math.max(0, Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - start) / 86400000));
}

export default function ComplaintsTrackerPage() {
  const { role, complaints, escalateComplaint } = useStakeholder();
  const location = useLocation();
  const [selectedId, setSelectedId] = useState(location.state?.createdId || "");
  const [filter, setFilter] = useState("All statuses");
  const mine = useMemo(() => complaints.filter((item) => item.role === role
    && (filter === "All statuses" || item.status === filter)), [complaints, role, filter]);
  const selected = complaints.find((item) => item.id === selectedId);

  function canEscalate(item) {
    return item.stage < 2 && daysSince(item.createdAt) >= 15 && !item.status.includes("Resolved");
  }

  return <div className="stakeholder-page">
    <PageHeader eyebrow={`${role.toUpperCase()} CASE TRACKER`} title="My Complaints & Tracker"
      description="Review the status of your submitted demo complaints, human-review notes, and available escalation actions."
      action={<Link className="stakeholder-button primary" to={`/${role}/complaints/new`}><FilePlus2 size={16} />Lodge a complaint</Link>} />
    <SafeguardNote>Complaint status is for tracking only. A complaint is not a verified statutory violation and has 0 Action Score impact until an authorised officer confirms a compliance flag.</SafeguardNote>
    <Panel title="Your submissions" description={`${mine.length} complaint${mine.length === 1 ? "" : "s"} in this demo portal.`}
      action={<label className="stakeholder-filter-label">Status<select value={filter} onChange={(event) => setFilter(event.target.value)}><option>All statuses</option>{[...new Set(complaints.filter((item) => item.role === role).map((item) => item.status))].map((status) => <option key={status}>{status}</option>)}</select></label>}>
      {mine.length ? <div className="stakeholder-complaint-list">{mine.map((item) => <article className={`stakeholder-complaint-card ${selectedId === item.id ? "selected" : ""}`} key={item.id}>
        <div className="stakeholder-complaint-card-top"><span className="stakeholder-complaint-id">{item.id}</span><StatusPill tone={STATUS_TONE(item.status)}>{item.status}</StatusPill></div>
        <h3>{item.subject}</h3>
        <div className="stakeholder-complaint-meta"><span>{item.category}</span><span>{item.department}</span><span><CalendarDays size={14} />{item.createdAt}</span></div>
        <div className="stakeholder-complaint-card-bottom"><span className={`stakeholder-privacy-tag ${item.privacyMode === "confidential" ? "confidential" : ""}`}><ShieldCheck size={14} />{item.privacyMode === "confidential" ? "Confidential" : "Identified"}</span><span><Clock3 size={14} />{daysSince(item.createdAt)} days open</span>
          <button type="button" className="stakeholder-text-button" onClick={() => setSelectedId(selectedId === item.id ? "" : item.id)}><Eye size={15} />{selectedId === item.id ? "Hide details" : "View details"}</button>
        </div>
        {selectedId === item.id && <ComplaintDetails item={item} canEscalate={canEscalate(item)} onEscalate={() => escalateComplaint(item.id)} onClose={() => setSelectedId("")} />}
      </article>)}</div> : <div className="stakeholder-empty"><strong>No complaints match this view</strong><p>Submit a demo complaint to create a tracking ticket.</p><Link className="stakeholder-button primary" to={`/${role}/complaints/new`}><FilePlus2 size={15} />Create complaint</Link></div>}
    </Panel>
  </div>;
}

function ComplaintDetails({ item, canEscalate, onEscalate, onClose }) {
  const completedStage = Math.min(item.stage, STAGES.length - 1);
  return <div className="stakeholder-complaint-details">
    <div className="stakeholder-detail-header"><div><p className="stakeholder-eyebrow">TRACKING DETAILS</p><h4>{item.id} · {item.severity}</h4></div><button className="stakeholder-icon-action" onClick={onClose} aria-label="Close complaint details"><X size={17} /></button></div>
    <div className="stakeholder-timeline">{STAGES.map((stage, index) => <div className={`stakeholder-timeline-step ${index <= completedStage ? "complete" : ""}`} key={stage}>
      <span>{index < completedStage ? <CheckCircle2 size={15} /> : index + 1}</span><div><strong>{stage}</strong><small>{index === completedStage ? item.updatedAt : index < completedStage ? "Recorded in demo tracker" : "Not yet reached"}</small></div>
    </div>)}</div>
    <div className="stakeholder-officer-remark"><strong>Latest human-review note</strong><p>{item.officerRemark || "No reviewer remark has been recorded."}</p></div>
    {item.privacyMode === "confidential" && <div className="stakeholder-inline-warning"><ShieldCheck size={16} />Complainant identity is masked from the institution in this demo view.</div>}
    {canEscalate && <button className="stakeholder-button secondary" onClick={onEscalate}><ArrowUpRight size={16} />Request escalation to AICTE Ombudsperson</button>}
    {item.stage < 2 && !canEscalate && <p className="stakeholder-escalation-hint">Ombudsperson escalation request becomes available after 15 days unresolved.</p>}
    <div className="stakeholder-no-impact"><ShieldCheck size={16} />Pending Verification — 0 Action Score impact until confirmed by an Authorised Officer.</div>
  </div>;
}
