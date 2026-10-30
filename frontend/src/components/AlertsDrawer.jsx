import { useCallback, useEffect, useState } from "react";
import { Bell, Check, ExternalLink, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { caseWorkflowApi } from "../services/caseWorkflow";
import { useAppStore } from "../store/useAppStore";

export default function AlertsDrawer() {
  const role = useAppStore((state) => state.role);
  const [alerts, setAlerts] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const items = await caseWorkflowApi.listAlerts({ pageSize: 100, status: "OPEN" });
      setAlerts(items);
      setError("");
    } catch (loadError) {
      setError(loadError.message || "Alerts could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function acknowledge(alertId) {
    try {
      await caseWorkflowApi.updateAlertStatus(alertId, "ACKNOWLEDGED");
      setAlerts((current) => current.filter((item) => String(item._id) !== String(alertId)));
    } catch (updateError) {
      setError(updateError.message || "The alert could not be acknowledged.");
    }
  }

  const unreadCount = alerts.filter((item) => item.status === "OPEN").length;

  return <>
    <button
      className="notification-link alert-drawer-trigger"
      type="button"
      aria-label={`Open alerts${unreadCount ? `, ${unreadCount} unread` : ""}`}
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      <Bell size={18} />
      {unreadCount > 0 && <span className="notification-count" aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>}
    </button>
    {open && <div className="alerts-drawer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <aside className="alerts-drawer" role="dialog" aria-modal="true" aria-labelledby="alerts-drawer-title">
        <header className="alerts-drawer-header">
          <div><p className="eyebrow">ALERT CENTRE</p><h2 id="alerts-drawer-title">Alerts {unreadCount > 0 && <span>({unreadCount})</span>}</h2></div>
          <div className="alerts-drawer-actions">
            <button type="button" className="button button-secondary button-small" onClick={refresh} disabled={busy} aria-label="Refresh alerts"><RefreshCw size={15} /></button>
            <button type="button" className="button button-secondary button-small" onClick={() => setOpen(false)} aria-label="Close alerts"><X size={15} /></button>
          </div>
        </header>
        {error && <p className="alert alert-warning" role="alert">{error}</p>}
        {busy && !alerts.length && <p className="muted" role="status">Loading alerts…</p>}
        {!busy && !alerts.length && !error && <div className="state-card"><h3>You’re all caught up</h3><p>New stage alerts will appear here.</p></div>}
        <div className="alerts-drawer-list">
          {alerts.map((item) => {
            const caseId = item.case_id || item.caseId;
            const legacyApplicationId = item.application_id || item.applicationId;
            const adminIncidentPath = role === "Admin"
              ? `/admin/incidents?tab=pending&workflowType=${legacyApplicationId ? "LEGACY_APPLICATION" : "CASE_RECORD"}&applicationId=${encodeURIComponent(legacyApplicationId || caseId || "")}`
              : "";
            return <article className="alerts-drawer-item" key={item._id}>
              <div className="alerts-drawer-item-heading">
                <strong>{item.title}</strong>
                <span className={`alert-severity alert-severity-${String(item.severity || "INFO").toLowerCase()}`}>{item.severity || "INFO"}</span>
              </div>
              <p>{item.body}</p>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
              <div className="alerts-drawer-item-actions">
                {adminIncidentPath && (caseId || legacyApplicationId)
                  ? <Link to={adminIncidentPath} onClick={() => setOpen(false)}>Open incident monitoring <ExternalLink size={14} /></Link>
                  : caseId && <Link to={`/case/${caseId}`} onClick={() => setOpen(false)}>Open application <ExternalLink size={14} /></Link>}
                <button type="button" onClick={() => acknowledge(item._id)}><Check size={14} /> Acknowledge</button>
              </div>
            </article>;
          })}
        </div>
        <Link className="button button-secondary alerts-drawer-all" to="/notifications" onClick={() => setOpen(false)}>View all notifications</Link>
      </aside>
    </div>}
  </>;
}
