import { useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2 } from "lucide-react";
import { Badge, Card, StatCard } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

function dueLabel(value) {
  if (!value) return "No due date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No due date" : date.toLocaleString();
}

export default function NotificationsLive({ data, setMessage }) {
  const [items, setItems] = useState(data.notifications);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setItems(data.notifications);
    setSelected([]);
  }, [data.notifications]);

  async function acknowledge(ids) {
    setBusy(true);
    setError("");
    try {
      await Promise.all(ids.map((id) => caseWorkflowApi.updateAlertStatus(id, "ACKNOWLEDGED")));
      setItems((current) => current.map((item) => ids.includes(item.id) ? { ...item, acknowledged: true } : item));
      setSelected([]);
      setMessage(ids.length === 1 ? "Alert acknowledged." : `${ids.length} alerts acknowledged.`);
    } catch (requestError) {
      setError(requestError.message || "Alerts could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  const openItems = items.filter((item) => !item.acknowledged);
  const overdueItems = openItems.filter((item) => item.dueDate && new Date(item.dueDate).getTime() < Date.now());
  const escalatedItems = openItems.filter((item) => ["HIGH", "CRITICAL"].includes(item.level));

  return <>
    <div className="notification-summary">
      <StatCard label="Open alerts" value={openItems.length} icon={Bell} />
      <StatCard label="Overdue alerts" value={overdueItems.length} icon={AlertTriangle} />
      <StatCard label="High severity" value={escalatedItems.length} icon={CheckCircle2} />
    </div>
    <Card title="Alerts" description="Acknowledging an alert does not fulfil or close its underlying obligation.">
      {error && <div className="note warning-note" role="alert">{error}</div>}
      <div className="filter-bar">
        <button className="button button-secondary button-small" disabled={busy || selected.length === 0} onClick={() => acknowledge(selected)}>Acknowledge selected ({selected.length})</button>
      </div>
      {items.length === 0
        ? <p className="muted">No alerts are available for this account.</p>
        : <div className="notification-list">{items.map((item) => <article className="notification-item" key={item.id}>
          <input type="checkbox" aria-label={`Select ${item.obligation}`} disabled={item.acknowledged || busy} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
          <Badge variant={["HIGH", "CRITICAL"].includes(item.level) ? "danger" : item.level === "INFO" ? "info" : "warning"}>{item.level}</Badge>
          <div className="notification-copy">
            <strong>{item.obligation}</strong>
            <small>{item.body}</small>
            <small>Due: {dueLabel(item.dueDate)}</small>
          </div>
          <button className="button button-secondary button-small" disabled={item.acknowledged || busy} onClick={() => acknowledge([item.id])}>{item.acknowledged ? "Acknowledged" : "Acknowledge"}</button>
        </article>)}</div>}
    </Card>
  </>;
}
