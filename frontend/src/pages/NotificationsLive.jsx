import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Bell, Building2, CalendarClock, CheckCircle2, ChevronRight, Clock3, Eye, Search, ShieldCheck, X } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

function formatDate(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, options);
}

function readableType(value) {
  return value ? value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) : "General alert";
}

function displayMessage(item) {
  const body = String(item.body || "").trim();
  if (item.channel === "APPLICATION_FINAL_APPROVED" || body.includes("Stage-by-stage approval summary:")) {
    return "Your application has received final approval. View your application for the approval status and next steps.";
  }
  const compact = body.replace(/\s+/g, " ");
  return compact || item.obligation || "You have a new notification.";
}

function alertContext(item, cases) {
  const reference = item.case_id || item.caseId || item.application_id || item.applicationId;
  const relatedCase = cases.find((record) => String(record.caseId) === String(reference) || String(record.id) === String(reference));
  if (relatedCase) return { primary: relatedCase.institution, secondary: relatedCase.id };
  if (reference) return { primary: "Application", secondary: String(reference) };
  return { primary: "General notification", secondary: "" };
}

function statusFor(item) {
  if (item.acknowledged) return "Acknowledged";
  if (item.dueDate && new Date(item.dueDate).getTime() < Date.now()) return "Overdue";
  return "Open";
}

export default function NotificationsLive({ data, setMessage }) {
  const [items, setItems] = useState(data.notifications);
  const [selected, setSelected] = useState([]);
  const [viewingId, setViewingId] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const records = data.cases || [];
  const viewing = items.find((item) => String(item.id) === viewingId);
  const alertTypes = [...new Set(items.map((item) => item.channel).filter(Boolean))].sort();
  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter((item) => {
      const context = alertContext(item, records);
      const matchesSearch = !search || [item.obligation, item.body, item.channel, context.primary, context.secondary]
        .some((value) => String(value || "").toLowerCase().includes(search));
      const matchesType = typeFilter === "ALL" || item.channel === typeFilter;
      const matchesSeverity = severityFilter === "ALL"
        || severityFilter === "HIGH_SEVERITY" && ["HIGH", "CRITICAL"].includes(item.level)
        || item.level === severityFilter;
      const status = statusFor(item);
      const matchesStatus = statusFilter === "ALL"
        || statusFilter === "OPEN" && !item.acknowledged
        || statusFilter === "OVERDUE" && status === "Overdue"
        || statusFilter === "ACKNOWLEDGED" && item.acknowledged;
      const created = item.createdAt ? new Date(item.createdAt).getTime() : null;
      const matchesFrom = !fromDate || created !== null && created >= new Date(`${fromDate}T00:00:00`).getTime();
      const matchesTo = !toDate || created !== null && created <= new Date(`${toDate}T23:59:59.999`).getTime();
      return matchesSearch && matchesType && matchesSeverity && matchesStatus && matchesFrom && matchesTo;
    });
  }, [items, records, query, typeFilter, severityFilter, statusFilter, fromDate, toDate]);

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
  const severityVariant = useMemo(() => ({
    HIGH: "danger",
    CRITICAL: "danger",
    MEDIUM: "warning",
    LOW: "success",
    INFO: "info",
  }), []);
  function showSummaryFilter(status, severity = "ALL") {
    setQuery("");
    setTypeFilter("ALL");
    setSeverityFilter(severity);
    setStatusFilter(status);
    setFromDate("");
    setToDate("");
  }

  return <>
    <div className="notification-summary">
      <button className="notification-summary-card blue" type="button" onClick={() => showSummaryFilter("OPEN")} aria-label={`Show ${openItems.length} open alerts`} aria-pressed={statusFilter === "OPEN" && severityFilter === "ALL"}>
        <span className="notification-summary-icon"><Bell size={23} /></span>
        <span className="notification-summary-copy"><strong>Open alerts</strong><b>{openItems.length}</b><small>Alerts requiring attention</small></span>
        <span className="notification-summary-arrow"><ChevronRight size={18} /></span>
      </button>
      <button className="notification-summary-card red" type="button" onClick={() => showSummaryFilter("OVERDUE")} aria-label={`Show ${overdueItems.length} overdue alerts`} aria-pressed={statusFilter === "OVERDUE"}>
        <span className="notification-summary-icon"><AlertTriangle size={23} /></span>
        <span className="notification-summary-copy"><strong>Overdue alerts</strong><b>{overdueItems.length}</b><small>Past their due date</small></span>
        <span className="notification-summary-arrow"><ChevronRight size={18} /></span>
      </button>
      <button className="notification-summary-card green" type="button" onClick={() => showSummaryFilter("OPEN", "HIGH_SEVERITY")} aria-label={`Show ${escalatedItems.length} high severity alerts`} aria-pressed={statusFilter === "OPEN" && severityFilter === "HIGH_SEVERITY"}>
        <span className="notification-summary-icon"><ShieldCheck size={23} /></span>
        <span className="notification-summary-copy"><strong>High severity</strong><b>{escalatedItems.length}</b><small>Critical alerts needing action</small></span>
        <span className="notification-summary-arrow"><ChevronRight size={18} /></span>
      </button>
      <button className="notification-summary-card purple" type="button" onClick={() => showSummaryFilter("ACKNOWLEDGED")} aria-label={`Show ${items.length - openItems.length} acknowledged alerts`} aria-pressed={statusFilter === "ACKNOWLEDGED"}>
        <span className="notification-summary-icon"><Clock3 size={23} /></span>
        <span className="notification-summary-copy"><strong>Acknowledged alerts</strong><b>{items.length - openItems.length}</b><small>Alerts acknowledged</small></span>
        <span className="notification-summary-arrow"><ChevronRight size={18} /></span>
      </button>
    </div>
    <Card title="Alerts" description="Review alerts and acknowledge them when seen. Acknowledgement does not close an underlying obligation." className="notification-register-card">
      {error && <div className="note warning-note" role="alert">{error}</div>}
      <div className="notification-filter-bar">
        <label className="notification-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search alerts by application, institution or message…" aria-label="Search alerts" /></label>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by alert type"><option value="ALL">All types</option>{alertTypes.map((type) => <option value={type} key={type}>{readableType(type)}</option>)}</select>
        <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)} aria-label="Filter by severity"><option value="ALL">All severity</option>{["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((level) => <option key={level} value={level}>{readableType(level)}</option>)}</select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status"><option value="ALL">All status</option><option value="OPEN">Open</option><option value="OVERDUE">Overdue</option><option value="ACKNOWLEDGED">Acknowledged</option></select>
        <label className="notification-date-filter"><span>From</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} aria-label="Created from date" /></label>
        <label className="notification-date-filter"><span>To</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} aria-label="Created to date" /></label>
        <button className="button button-secondary button-small notification-clear-filters" type="button" onClick={() => { setQuery(""); setTypeFilter("ALL"); setSeverityFilter("ALL"); setStatusFilter("ALL"); setFromDate(""); setToDate(""); }}>Clear</button>
      </div>
      <div className="notification-register-toolbar">
        <p>Select alerts to acknowledge them together.</p>
        <button className="button button-primary button-small" disabled={busy || selected.length === 0} onClick={() => acknowledge(selected)}>
          <CheckCircle2 size={15} /> Acknowledge selected ({selected.length})
        </button>
      </div>
      {items.length === 0
        ? <p className="muted">No alerts are available for this account.</p>
        : <div className="notification-table-wrap">
          <table className="notification-table">
            <thead><tr>
              <th><input type="checkbox" aria-label="Select all open alerts on this page" checked={filteredItems.filter((item) => !item.acknowledged).length > 0 && filteredItems.filter((item) => !item.acknowledged).every((item) => selected.includes(item.id))} onChange={(event) => setSelected((current) => event.target.checked
                ? [...new Set([...current, ...filteredItems.filter((item) => !item.acknowledged).map((item) => item.id)])]
                : current.filter((id) => !filteredItems.some((item) => item.id === id)))} disabled={busy || !filteredItems.some((item) => !item.acknowledged)} /></th>
              <th>#</th>
              <th>Application / Institution</th>
              <th>Alert type</th>
              <th>Message</th>
              <th>Severity</th>
              <th>Created</th>
              <th>Status</th>
              <th>Action</th>
            </tr></thead>
            <tbody>{filteredItems.length ? filteredItems.map((item, index) => {
              const context = alertContext(item, records);
              const status = statusFor(item);
              return <tr key={item.id}>
                <td><input type="checkbox" aria-label={`Select ${item.obligation}`} disabled={item.acknowledged || busy} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /></td>
                <td>{index + 1}</td>
                <td><div className="notification-application"><span><Building2 size={16} /></span><div><strong>{context.primary}</strong>{context.secondary && <small>{context.secondary}</small>}</div></div></td>
                <td><span className="notification-type">{readableType(item.channel)}</span></td>
                <td className="notification-message-preview">{displayMessage(item)}</td>
                <td><Badge variant={severityVariant[item.level] || "neutral"}>{item.level || "INFO"}</Badge></td>
                <td><span className="notification-created">{formatDate(item.createdAt)}</span></td>
                <td><span className={`notification-status ${status.toLowerCase()}`}>{status === "Overdue" ? <AlertTriangle size={13} /> : <Clock3 size={13} />}{status}</span></td>
                <td><button className="button button-secondary button-small notification-view-button" type="button" onClick={() => setViewingId(String(item.id))}><Eye size={14} /> View</button></td>
              </tr>;
            }) : <tr><td className="notification-empty-row" colSpan={9}>No alerts match your filters.</td></tr>}</tbody>
          </table>
        </div>}
      {items.length > 0 && <p className="notification-register-count">Showing {filteredItems.length} of {items.length} alert{items.length === 1 ? "" : "s"}</p>}
    </Card>

    <Dialog.Root open={Boolean(viewing)} onOpenChange={(open) => { if (!open) setViewingId(""); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="notification-detail-overlay" />
        {viewing && <Dialog.Content className="notification-detail-dialog" aria-describedby="notification-detail-message">
          <header className="notification-detail-header">
            <div className="notification-detail-icon"><Bell size={22} /></div>
            <div className="notification-detail-heading">
              <span className="notification-detail-eyebrow">NOTIFICATION DETAILS</span>
              <Dialog.Title>{viewing.obligation}</Dialog.Title>
              <p>{readableType(viewing.channel)}</p>
            </div>
            <Dialog.Close className="notification-detail-close" aria-label="Close notification details"><X size={20} /></Dialog.Close>
          </header>
          <div className="notification-detail-meta">
            <span className={`notification-status ${statusFor(viewing).toLowerCase()}`}>{statusFor(viewing) === "Overdue" ? <AlertTriangle size={14} /> : <Clock3 size={14} />}{statusFor(viewing)}</span>
            <Badge variant={severityVariant[viewing.level] || "neutral"}>{viewing.level || "INFO"} severity</Badge>
            <span><CalendarClock size={15} /> Created {formatDate(viewing.createdAt)}</span>
          </div>
          <section className="notification-detail-message">
            <h3>Message</h3>
            <p id="notification-detail-message">{displayMessage(viewing)}</p>
          </section>
          <div className="notification-detail-context">
            <span className="notification-context-icon"><Building2 size={17} /></span>
            <div><small>Application / institution</small><strong>{alertContext(viewing, records).primary}</strong>{alertContext(viewing, records).secondary && <span>{alertContext(viewing, records).secondary}</span>}</div>
          </div>
          {viewing.dueDate && <div className="notification-detail-due"><Clock3 size={16} /><span><strong>Due date</strong>{formatDate(viewing.dueDate)}</span></div>}
          <footer className="notification-detail-actions">
            {!viewing.acknowledged && <button className="button button-primary" type="button" disabled={busy} onClick={() => acknowledge([viewing.id])}><CheckCircle2 size={16} /> Acknowledge alert</button>}
            <Dialog.Close className="button button-secondary" type="button">Close</Dialog.Close>
          </footer>
        </Dialog.Content>}
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
