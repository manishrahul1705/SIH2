import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { Badge, Card, StatCard } from "../../components/ui/primitives";
import { evcApi } from "../../services/evc";

const typeLabels = {
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration or twinning programme",
  restoration_of_intake: "Restoration of intake",
};

function displayDate(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not set" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function DashboardError({ error, onRetry }) {
  return <div className="evc-state evc-error" role="alert">
    <AlertTriangle size={20} />
    <span>{error}</span>
    <button className="button button-secondary button-small" type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button>
  </div>;
}

function ApprovalTabs({ active, pendingCount, completedCount, onChange }) {
  return <div className="evc-tabs" role="tablist" aria-label="EVC approvals">
    <button className={`evc-tab ${active === "pending" ? "active" : ""}`} type="button" role="tab" aria-selected={active === "pending"} onClick={() => onChange("pending")}>
      Pending Approval <span className="evc-tab-count">{pendingCount}</span>
    </button>
    <button className={`evc-tab ${active === "completed" ? "active" : ""}`} type="button" role="tab" aria-selected={active === "completed"} onClick={() => onChange("completed")}>
      Completed Approval <span className="evc-tab-count">{completedCount}</span>
    </button>
  </div>;
}

function ApplicationsTable({ cases, completed = false }) {
  if (!cases.length) {
    return <div className="evc-empty">
      {completed ? <CheckCircle2 size={26} /> : <Clock3 size={26} />}
      <strong>{completed ? "No completed EVC approvals." : "No pending EVC applications."}</strong>
      <span>{completed ? "Applications approved by your EVC panel will appear here." : "New applications assigned to your EVC stage will appear here."}</span>
    </div>;
  }
  return <div className="evc-table-wrap">
    <table className="evc-table">
      <thead><tr>
        <th>Application ID</th><th>Institution</th><th>Application type</th><th>Region</th>
        <th>{completed ? "Approved date" : "Assigned date"}</th><th>Stage SLA due</th><th>Status</th>
      </tr></thead>
      <tbody>{cases.map((item) => <tr key={item._id}>
        <td>{completed
          ? <strong>{item.caseNo}</strong>
          : <Link className="evc-case-link" to={`/cases/${item._id}?tab=${item.inspectionStatus === "REPORT_UPLOADED" ? "waiting_approval" : "waiting_inspection"}`}>{item.caseNo}</Link>}
        </td>
        <td>{item.institution}</td>
        <td>{typeLabels[item.applicationType] || item.applicationType}</td>
        <td>{item.region || "—"}</td>
        <td>{displayDate(completed ? item.approvedAt || item.assignedAt : item.assignedAt)}</td>
        <td>{displayDate(item.stageDueAt)}</td>
        <td><Badge variant={completed ? "success" : item.inspectionStatus === "REPORT_UPLOADED" ? "info" : item.inspectionStatus === "SCHEDULED" ? "info" : "warning"}>
          {completed ? "Approved" : item.inspectionStatus === "REPORT_UPLOADED" ? "Application approval" : item.inspectionStatus === "SCHEDULED" ? `Inspection scheduled · ${displayDate(item.scheduled_inspection_date)}` : "Inspection approval"}
        </Badge></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function EvcDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("pending");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await evcApi.getDashboard());
    } catch (loadError) {
      setError(loadError.message || "Could not load the EVC dashboard.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const pending = useMemo(() => [
    ...(data?.inspection || []),
    ...(data?.approval || []),
  ], [data]);
  const inspectionCount = data?.inspection?.length || 0;
  const applicationCount = data?.approval?.length || 0;
  const completedCount = data?.completed?.length || 0;
  const activeCases = activeTab === "pending" ? pending : data?.completed || [];

  return <main className="evc-workspace">
    <header className="evc-workspace-heading">
      <div><p className="eyebrow">EXPERT VISIT COMMITTEE</p><h1>EVC Dashboard</h1><p>Monitor pending and completed EVC approvals across your assigned cases.</p></div>
      <button className="button button-secondary button-small" type="button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>
    </header>
    {error && <DashboardError error={error} onRetry={() => void load()} />}
    <ApprovalTabs active={activeTab} pendingCount={pending.length} completedCount={completedCount} onChange={setActiveTab} />
    {activeTab === "pending" && <div className="stat-grid">
      <StatCard label="Inspection Approval" value={inspectionCount} note="Awaiting inspection or inspection report" icon={Clock3} variant="warning" />
      <StatCard label="Application Approval" value={applicationCount} note="Inspection report ready for committee sign-off" icon={CheckCircle2} variant="info" />
    </div>}
    <Card
      title={activeTab === "pending" ? `All Pending Applications (${pending.length})` : `Completed Approvals (${completedCount})`}
      description={activeTab === "pending" ? "Select an application to schedule or review its EVC stage." : "Applications approved by your assigned EVC committee."}
    >
      {!data && !error
        ? <div className="loading-state" aria-label="Loading EVC dashboard"><i /><i /><i /></div>
        : <ApplicationsTable cases={activeCases} completed={activeTab === "completed"} />}
    </Card>
  </main>;
}
