import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { Badge, Card, StatCard } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

const ESCALATION_TYPES = new Set([
  "STAGE_DELAY_ESCALATED",
  "CANCELLATION_PERMISSION_REQUEST",
  "LEASE_EXPIRED",
]);

export default function EscalationsPage() {
  const [escalations, setEscalations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const open = escalations.filter((item) => !item.acknowledged);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const alerts = await caseWorkflowApi.listAlerts();
      setEscalations(alerts.filter((item) => ESCALATION_TYPES.has(item.type)).map((item) => ({
        ...item,
        id: item._id,
        obligation: item.title,
        level: item.severity,
        acknowledged: item.status !== "OPEN",
      })));
    } catch (loadError) {
      setError(loadError.message || "Escalations could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function acknowledge(item) {
    setBusyId(item.id);
    setError("");
    try {
      const updated = await caseWorkflowApi.updateAlertStatus(item.id, "ACKNOWLEDGED");
      setEscalations((current) => current.map((alert) => alert.id === item.id
        ? { ...alert, ...updated, acknowledged: true }
        : alert));
    } catch (updateError) {
      setError(updateError.message || "The escalation could not be acknowledged.");
    } finally {
      setBusyId("");
    }
  }

  return <>
    <div className="page-heading"><div><p className="eyebrow">REGIONAL OVERSIGHT</p><h1>Escalations</h1><p>Review escalation alerts assigned to your account.</p></div><button className="button button-secondary" disabled={loading} onClick={load}><RefreshCw size={15} /> Refresh</button></div>
    <div className="stat-grid">
      <StatCard label="Escalation records" value={escalations.length} icon={AlertTriangle} />
      <StatCard label="Open escalations" value={open.length} icon={CheckCircle2} />
    </div>
    <Card title="Escalations assigned to you" description="Records are loaded from alerts addressed to your authenticated account. Acknowledging an alert does not decide or resolve the underlying case.">
      {error && <div className="note warning-note" role="alert">{error}</div>}
      {loading ? <div className="loading-state" aria-label="Loading escalations"><i /><i /><i /></div> : escalations.length
        ? <div className="notification-list">{escalations.map((item) => <article className="notification-item" key={item.id}>
          <Badge variant={item.level === "CRITICAL" ? "danger" : "warning"}>{item.level}</Badge>
          <div className="notification-copy">
            <strong>{item.obligation}</strong>
            <small>{item.body}</small>
            <small>{item.type.replaceAll("_", " ")} · {item.status}</small>
            {item.due_at && <small>Due: {new Date(item.due_at).toLocaleString()}</small>}
          </div>
          <button type="button" className="button button-secondary button-small" disabled={item.acknowledged || busyId === item.id} onClick={() => acknowledge(item)}>
            {item.acknowledged ? "Acknowledged" : busyId === item.id ? "Saving…" : "Acknowledge"}
          </button>
        </article>)}</div>
        : <p className="muted">There are no escalation records assigned to your account.</p>}
    </Card>
  </>;
}
