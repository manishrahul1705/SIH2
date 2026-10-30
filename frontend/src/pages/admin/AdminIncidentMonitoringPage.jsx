import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Clock3, FileSearch, RefreshCw, ShieldAlert } from "lucide-react";
import { adminApi, adminRoleLabels } from "../../services/admin";
import { Badge, Card, StatCard } from "../../components/ui/primitives";

const PAGE_SIZE = 20;
const ACTIONS = [
  ["REVIEW", "Start review"],
  ["NOTE", "Add investigation note"],
  ["REQUEST_CLARIFICATION", "Request clarification"],
  ["ESCALATE", "Escalate"],
  ["CORRECTIVE_ACTION", "Record corrective action"],
  ["RESOLVE", "Resolve"],
  ["CLOSE", "Close"],
  ["REOPEN", "Reopen"],
];
const ACTION_PROMPTS = {
  NOTE: { label: "Investigation note", required: true, min: 5 },
  REQUEST_CLARIFICATION: { label: "Clarification requested", required: true, min: 10 },
  ESCALATE: { label: "Escalation reason", required: true, min: 10 },
  CORRECTIVE_ACTION: { label: "Corrective action details", required: true, min: 10 },
  RESOLVE: { label: "Resolution summary", field: "resolutionSummary", required: true, min: 30 },
  CLOSE: { label: "Closure summary", required: true, min: 10 },
  REOPEN: { label: "Reason for reopening", field: "reason", required: true, min: 10 },
};
const INCIDENT_TYPES = [
  ["SUSPECTED_INCORRECT_APPROVAL", "Suspected incorrect approval"],
  ["WORKFLOW_FAILURE", "Workflow failure"],
  ["VALIDATION_FAILURE", "Validation failure"],
  ["MANUAL_REPORT", "Other administrative issue"],
];

function display(value, fallback = "Not available") {
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function dateLabel(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function severityVariant(value) {
  if (value === "CRITICAL" || value === "HIGH") return "danger";
  if (value === "MEDIUM") return "warning";
  return "info";
}

function statusVariant(value) {
  if (["RESOLVED", "CLOSED"].includes(value)) return "success";
  if (["UNDER_REVIEW", "AWAITING_CLARIFICATION", "ESCALATED", "CORRECTIVE_ACTION_PENDING", "RESOLUTION_PENDING_VERIFICATION"].includes(value)) return "warning";
  return "danger";
}

function statusLabel(value) {
  return value ? String(value).replaceAll("_", " ") : "OPEN";
}

function eventActor(event) {
  return event.actor?.name || event.actorName || (event.actor ? adminRoleLabels[event.actor.role] : null) || (event.source === "SYSTEM" ? "System" : "Not recorded");
}

function ReportIncidentDialog({ onClose, onSubmit, busy, requestError }) {
  const [requestId] = useState(() => window.crypto.randomUUID());
  const [form, setForm] = useState({
    workflowType: "LEGACY_APPLICATION",
    applicationId: "",
    type: "SUSPECTED_INCORRECT_APPROVAL",
    severity: "HIGH",
    stageName: "",
    responsibleUserId: "",
    description: "",
    evidence: "",
  });
  const [error, setError] = useState("");

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (form.description.trim().length < 30) {
      setError("Describe the concern using at least 30 characters. Keep allegations marked as suspected until verified.");
      return;
    }
    if (form.evidence.trim().length < 5) {
      setError("Add a short evidence reference or explain that no supporting evidence is available.");
      return;
    }
    setError("");
    await onSubmit({
      ...form,
      requestId,
      applicationId: form.applicationId.trim(),
      stageName: form.stageName.trim(),
      responsibleUserId: form.responsibleUserId.trim() || undefined,
      description: form.description.trim(),
      evidence: form.evidence.trim(),
      detectionSource: "ADMIN_REPORTED",
    });
  }

  return <div className="incident-dialog-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="incident-dialog" role="dialog" aria-modal="true" aria-labelledby="incident-report-title">
      <header><div><p className="eyebrow">INCIDENT INTAKE</p><h2 id="incident-report-title">Report an application issue</h2></div><button className="button button-secondary button-small" type="button" onClick={onClose} disabled={busy}>Close</button></header>
      <form onSubmit={submit}>
        <div className="incident-form-grid">
          <label className="field-label">Workflow
            <select value={form.workflowType} onChange={(event) => update("workflowType", event.target.value)}>
              <option value="LEGACY_APPLICATION">Legacy Application</option>
              <option value="CASE_RECORD">CaseRecord</option>
            </select>
          </label>
          <label className="field-label">Application ID <span aria-hidden="true">*</span>
            <input required value={form.applicationId} onChange={(event) => update("applicationId", event.target.value)} />
          </label>
          <label className="field-label">Issue type
            <select value={form.type} onChange={(event) => update("type", event.target.value)}>{INCIDENT_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
          </label>
          <label className="field-label">Severity
            <select value={form.severity} onChange={(event) => update("severity", event.target.value)}>{["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((item) => <option key={item}>{item}</option>)}</select>
          </label>
          <label className="field-label">Affected stage<input value={form.stageName} onChange={(event) => update("stageName", event.target.value)} placeholder="Optional" /></label>
          <label className="field-label">Responsible user ID<input value={form.responsibleUserId} onChange={(event) => update("responsibleUserId", event.target.value)} placeholder="Optional" /></label>
        </div>
        <label className="field-label">What happened? <span aria-hidden="true">*</span>
          <textarea rows={4} required minLength={30} maxLength={3000} value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Record verified facts or clearly mark this as a concern requiring investigation." />
          <small>{form.description.trim().length} / 30 minimum characters</small>
        </label>
        <label className="field-label">Evidence reference or unavailable reason <span aria-hidden="true">*</span>
          <textarea rows={2} required minLength={5} maxLength={2000} value={form.evidence} onChange={(event) => update("evidence", event.target.value)} placeholder="Reference existing audit/document records; do not attach sensitive credentials." />
        </label>
        {(error || requestError) && <p className="incident-error" role="alert">{error || requestError}</p>}
        <footer><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Create incident record"}</button></footer>
      </form>
    </section>
  </div>;
}

function incidentEvents(incident) {
  return Array.isArray(incident.events) ? incident.events : Array.isArray(incident.history) ? incident.history : [];
}

function IncidentActionDialog({ action, onClose, onSubmit, busy, requestError }) {
  const prompt = ACTION_PROMPTS[action];
  const [text, setText] = useState("");
  const [targetRole, setTargetRole] = useState(action === "REQUEST_CLARIFICATION" ? "" : "SENIOR_AUTHORITY");
  const [resolution, setResolution] = useState({ rootCause: "", resolutionEvidence: "", verificationResult: "", remainingLimitations: "" });
  const [error, setError] = useState("");
  const [requestId] = useState(() => window.crypto.randomUUID());

  async function submit(event) {
    event.preventDefault();
    if (prompt?.required && text.trim().length < prompt.min) {
      setError(`${prompt.label} must contain at least ${prompt.min} characters.`);
      return;
    }
    setError("");
    await onSubmit({
      action,
      requestId,
      ...(action === "ESCALATE" ? { reason: text.trim(), targetRole } : {}),
      ...(action === "REQUEST_CLARIFICATION" && targetRole ? { targetRole } : {}),
      ...(action === "RESOLVE" ? { resolutionSummary: text.trim(), ...resolution } : {}),
      ...(action === "REOPEN" ? { reason: text.trim() } : {}),
      ...(["NOTE", "REQUEST_CLARIFICATION", "CORRECTIVE_ACTION", "CLOSE"].includes(action) ? { note: text.trim() } : {}),
    });
  }

  return <div className="incident-dialog-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="incident-dialog" role="dialog" aria-modal="true" aria-labelledby="incident-action-title">
      <header><div><p className="eyebrow">ADMINISTRATIVE ACTION</p><h2 id="incident-action-title">{ACTIONS.find(([key]) => key === action)?.[1] || action}</h2></div><button className="button button-secondary button-small" type="button" onClick={onClose} disabled={busy}>Close</button></header>
      <form onSubmit={submit}>
        {action === "ESCALATE" && <label className="field-label">Escalate to
          <select value={targetRole} onChange={(event) => setTargetRole(event.target.value)}>
            <option value="SENIOR_AUTHORITY">Senior Authority</option>
            <option value="BUREAU_OFFICER">Bureau Officer</option>
          </select>
        </label>}
        {action === "REQUEST_CLARIFICATION" && <label className="field-label">Send clarification request to
          <select value={targetRole} onChange={(event) => setTargetRole(event.target.value)}>
            <option value="">Assigned responsible officer</option>
            <option value="INSTITUTION">Institution contact</option>
          </select>
        </label>}
        {prompt && <label className="field-label">{prompt.label}{prompt.required ? " *" : ""}
          <textarea rows={5} value={text} onChange={(event) => setText(event.target.value)} required={prompt.required} minLength={prompt.min} maxLength={3000} />
          {prompt.min && <small>{text.trim().length} / {prompt.min} minimum characters</small>}
        </label>}
        {action === "RESOLVE" && <div className="incident-resolution-fields">
          <label className="field-label">Root cause, if established<textarea rows={2} maxLength={3000} value={resolution.rootCause} onChange={(event) => setResolution((current) => ({ ...current, rootCause: event.target.value }))} /></label>
          <label className="field-label">Resolution evidence or evidence reference<textarea rows={2} maxLength={4000} value={resolution.resolutionEvidence} onChange={(event) => setResolution((current) => ({ ...current, resolutionEvidence: event.target.value }))} /></label>
          <label className="field-label">Verification result<textarea rows={2} maxLength={3000} value={resolution.verificationResult} onChange={(event) => setResolution((current) => ({ ...current, verificationResult: event.target.value }))} /></label>
          <label className="field-label">Remaining limitations / follow-up<textarea rows={2} maxLength={3000} value={resolution.remainingLimitations} onChange={(event) => setResolution((current) => ({ ...current, remainingLimitations: event.target.value }))} /></label>
        </div>}
        {action === "REVIEW" && <p className="muted">Mark this incident as under review. This does not change the application's approval status.</p>}
        {(error || requestError) && <p className="incident-error" role="alert">{error || requestError}</p>}
        <footer><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Confirm action"}</button></footer>
      </form>
    </section>
  </div>;
}

function ApplicationDetail({ detail, loading, error, onBack, onAction }) {
  if (loading) return <Card title="Application incident history"><p className="muted">Loading persisted application and incident records…</p></Card>;
  if (error) return <Card title="Application incident history"><div className="note warning-note" role="alert">{error}</div><button className="button button-secondary" onClick={onBack}><ArrowLeft size={15} /> Back to applications</button></Card>;
  if (!detail) return null;

  const application = detail.application || {};
  const incidents = detail.incidents || [];
  const institution = application.institution || application.institutionId || {};
  const applicationNumber = application.application_number || application.applicationNumber || application.caseNo || application.applicationId;
  const stage = application.current_stage || application.currentStage?.name || application.currentStage || application.currentStageName;
  const applicationStatus = application.status || application.overallStatus;
  const timeline = detail.timeline || incidents.flatMap((incident) => incidentEvents(incident).map((event) => ({ ...event, incidentTitle: incident.title || incident.type })))
    .sort((left, right) => new Date(left.timestamp || left.createdAt || 0) - new Date(right.timestamp || right.createdAt || 0));
  const unresolvedIncidents = incidents.filter((incident) => !["RESOLVED", "CLOSED"].includes(incident.status));
  const completedIncidentCount = incidents.length - unresolvedIncidents.length;
  const nextOwner = unresolvedIncidents.map((incident) => incident.responsibleUser || incident.responsibleOfficer).find((owner) => owner?.name || owner?.email);

  return <div className="incident-detail">
    <div className="incident-detail-back"><button className="button button-secondary button-small" onClick={onBack}><ArrowLeft size={15} /> Back to applications</button><span className="muted">{display(application.workflowType || detail.workflowType)}</span></div>
    <div className="incident-detail-heading"><div><p className="eyebrow">APPLICATION INCIDENT HISTORY</p><h2>{display(applicationNumber)}</h2><p>{display(institution.name || application.institutionName)} · {display(application.type || application.applicationType, "Workflow type unavailable")}</p></div><Badge variant={incidents.some((item) => !["RESOLVED", "CLOSED"].includes(item.status)) ? "danger" : "success"}>{incidents.some((item) => !["RESOLVED", "CLOSED"].includes(item.status)) ? "Administrative action pending" : "Incidents completed"}</Badge></div>
    <div className="incident-overview-grid">
      <div><small>Application status</small><strong>{display(applicationStatus)}</strong></div>
      <div><small>Current stage</small><strong>{display(stage)}</strong></div>
      <div><small>Current stage owner</small><strong>{display(application.currentOwner?.name || application.responsibleOfficer?.name || application.assignedOfficer?.name || application.stageOwner?.name)}</strong></div>
      <div><small>Submitted</small><strong>{dateLabel(application.submitted_at || application.submittedAt)}</strong></div>
      <div><small>Current stage deadline</small><strong>{dateLabel(application.stageDueAt)}</strong></div>
    </div>
    {!detail.historyComplete && <p className="note warning-note">Historical audit data is incomplete or unavailable for some events. The timeline below contains only recorded records.</p>}
    <Card title="Incident Details / What Happened" description="Each issue is stored independently and remains separate from the application's approval decision.">
      {incidents.length === 0 ? <p className="muted">No incidents are recorded for this application.</p> : <div className="incident-record-list">{incidents.map((incident) => {
        const owner = incident.responsibleUser || incident.responsibleOfficer || {};
        const events = incidentEvents(incident);
        const resolutionEvent = [...events].reverse().find((event) => event.action === "RESOLVE");
        const unresolved = !["RESOLVED", "CLOSED"].includes(incident.status);
        return <article className="incident-record" key={incident._id || incident.id}>
          <div className="incident-record-head"><div><strong>{display(incident.title || incident.type, "Recorded incident")}</strong><small>{display(incident.incidentId || incident._id || incident.id)} · {display(incident.stageName || incident.affectedStage || incident.stage?.name || incident.stage?.key || incident.stage, "Stage unavailable")}</small></div><div><Badge variant={severityVariant(incident.severity)}>{display(incident.severity, "UNRATED")}</Badge> <Badge variant={statusVariant(incident.status)}>{statusLabel(incident.status)}</Badge></div></div>
          <p>{display(incident.details || incident.description || incident.summary, "Incident description was not recorded.")}</p>
          {(incident.evidence || incident.evidenceReferences || incident.evidence_references) && <p><strong>Evidence:</strong> {Array.isArray(incident.evidence || incident.evidenceReferences || incident.evidence_references) ? (incident.evidence || incident.evidenceReferences || incident.evidence_references).join(", ") : (incident.evidence || incident.evidenceReferences || incident.evidence_references)}</p>}
          <div className="incident-overview-grid compact">
            <div><small>Detection source</small><strong>{display(incident.detectionSource || incident.source)}</strong></div>
            <div><small>Detection details</small><strong>{display(incident.sourceDetails)}</strong></div>
            <div><small>Responsible stage user</small><strong>{owner.name || owner.email || "Not recorded"}</strong></div>
            <div><small>Detected</small><strong>{dateLabel(incident.createdAt || incident.detectedAt)}</strong></div>
            <div><small>Deadline</small><strong>{dateLabel(incident.dueAt)}</strong></div>
            <div><small>Resolution</small><strong>{unresolved ? "Not Resolved — Administrative Action Required" : display(incident.resolutionSummary || incident.resolution_summary || resolutionEvent?.resolutionSummary)}</strong></div>
          </div>
          {(incident.resolutionSummary || resolutionEvent?.resolutionSummary) && <p className="incident-resolution"><strong>Resolution summary:</strong> {incident.resolutionSummary || resolutionEvent?.resolutionSummary}</p>}
          <div className="incident-actions">{ACTIONS.map(([key, label]) => {
            if (["CLOSE"].includes(key) && incident.status !== "RESOLVED") return null;
            if (key === "REOPEN" && !["RESOLVED", "CLOSED"].includes(incident.status)) return null;
            if (["REVIEW", "NOTE", "REQUEST_CLARIFICATION", "ESCALATE", "CORRECTIVE_ACTION", "RESOLVE"].includes(key) && !unresolved) return null;
            return <button key={key} className={`button ${["RESOLVE", "CLOSE"].includes(key) ? "button-primary" : "button-secondary"} button-small`} onClick={() => onAction(incident, key)}>{label}</button>;
          })}</div>
          <div className="incident-event-history"><strong>Actions Taken</strong>{events.length === 0
            ? <p className="muted">No investigation actions have been recorded.</p>
            : <ul>{[...events].reverse().map((event, index) => <li key={event._id || event.id || `${event.timestamp || event.at}-${index}`}><span>{display(event.description || event.action || event.notes)}{(event.comment || event.note || event.reason || event.resolutionSummary) && <small className="incident-subtext">{event.comment || event.note || event.reason || event.resolutionSummary}</small>}</span><small>{eventActor(event)} · {dateLabel(event.timestamp || event.at || event.createdAt)}{(event.result || event.outcome || event.status) && ` · ${event.result || event.outcome || event.status}`}</small></li>)}</ul>}
          </div>
          <section className="incident-resolution-summary"><h4>Resolution Summary</h4>{unresolved
            ? <p className="incident-unresolved"><strong>Not Resolved — Administrative Action Required</strong><br />{display(incident.nextAction || incident.next_action, "Review the incident and record the next corrective action.")}</p>
            : <dl>
              <div><dt>Root cause</dt><dd>{display(incident.rootCause || incident.root_cause || resolutionEvent?.rootCause)}</dd></div>
              <div><dt>Resolution evidence</dt><dd>{display(incident.resolutionEvidence || resolutionEvent?.resolutionEvidence || incident.evidence)}</dd></div>
              <div><dt>Corrective action</dt><dd>{display(incident.correctiveAction || incident.corrective_action || resolutionEvent?.result || incident.resolutionSummary || incident.resolution_summary || resolutionEvent?.resolutionSummary)}</dd></div>
              <div><dt>Resolved by / date</dt><dd>{display(incident.resolvedBy?.name || incident.resolvedByName || resolutionEvent?.actor?.name)} · {dateLabel(incident.resolvedAt || incident.resolved_at || resolutionEvent?.at || resolutionEvent?.timestamp)}</dd></div>
              <div><dt>Verification</dt><dd>{display(incident.verificationResult || incident.verification_result || resolutionEvent?.verificationResult)}</dd></div>
              <div><dt>Remaining follow-up</dt><dd>{display(incident.remainingLimitations || incident.remaining_limitations || resolutionEvent?.remainingLimitations)}</dd></div>
            </dl>}
          </section>
        </article>;
      })}</div>}
    </Card>
    <Card title="Current Situation" description="Application workflow state and incident resolution state are intentionally separate.">
      <div className="incident-current-summary">
        <p><strong>Application status:</strong> {display(applicationStatus)}</p>
        <p><strong>Current workflow stage:</strong> {display(stage)}</p>
        <p><strong>Unresolved incidents:</strong> {unresolvedIncidents.length}</p>
        <p><strong>Resolved / closed incidents:</strong> {completedIncidentCount}</p>
        <p><strong>Responsible for next action:</strong> {nextOwner?.name || nextOwner?.email || (unresolvedIncidents.length ? "Admin review required; no assigned owner is recorded" : "No pending action recorded")}</p>
        <p><strong>Next step:</strong> {unresolvedIncidents[0]?.nextAction || unresolvedIncidents[0]?.next_action || (unresolvedIncidents.length ? "Review the unresolved incidents and record the required corrective action." : "No unresolved incident action is recorded.")}</p>
      </div>
    </Card>
    <Card title="Timeline of Events" description={detail.historyComplete ? "Recorded workflow and incident events in chronological order." : "Recorded events only; historical records are incomplete."}>
      {timeline.length === 0 ? <p className="muted">No event history was recorded.</p> : <ol className="incident-timeline">{timeline.map((event, index) => <li key={event._id || event.id || `${event.at || event.timestamp}-${index}`}><span className="incident-timeline-dot" /><div><strong>{display(event.description || event.action || event.eventType || event.type)}</strong><small>{eventActor(event)}{event.recipient?.name ? ` · To ${event.recipient.name}` : ""} · {dateLabel(event.at || event.timestamp || event.createdAt)}{event.outcome || event.status ? ` · ${event.outcome || event.status}` : ""}{event.incidentTitle ? ` · ${event.incidentTitle}` : ""}</small>{(event.note || event.reason || event.resolutionSummary || event.result) && <small className="incident-subtext">{event.note || event.reason || event.resolutionSummary || event.result}</small>}</div></li>)}</ol>}
    </Card>
  </div>;
}

export default function AdminIncidentMonitoringPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") === "completed" ? "completed" : "pending");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [severity, setSeverity] = useState(searchParams.get("severity") || "");
  const [type, setType] = useState(searchParams.get("type") || "");
  const [stage, setStage] = useState(searchParams.get("stage") || "");
  const [owner, setOwner] = useState(searchParams.get("ownerId") || "");
  const [dateFrom, setDateFrom] = useState(searchParams.get("dateFrom") || "");
  const [dateTo, setDateTo] = useState(searchParams.get("dateTo") || "");
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get("page")) || 1));
  const [result, setResult] = useState({ applications: [], summary: {}, total: 0, pages: 0 });
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportError, setReportError] = useState("");
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [action, setAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");

  const workflowType = searchParams.get("workflowType");
  const applicationId = searchParams.get("applicationId");
  const query = useMemo(() => ({
    tab,
    page,
    pageSize: PAGE_SIZE,
    search,
    severity,
    type,
    stage,
    ownerId: owner,
    dateFrom,
    dateTo,
  }), [tab, page, search, severity, type, stage, owner, dateFrom, dateTo]);

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      setResult(await adminApi.listIncidents(query));
    } catch (error) {
      setListError(error.message || "Incident applications could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadDetail = useCallback(async () => {
    if (!workflowType || !applicationId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError("");
    try {
      setDetail(await adminApi.getApplicationIncidents(workflowType, applicationId));
    } catch (error) {
      setDetailError(error.message || "Application incident history could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  }, [workflowType, applicationId]);

  useEffect(() => {
    const timer = window.setTimeout(loadList, 250);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  function updateUrl(updates, remove = []) {
    const next = new URLSearchParams(searchParams);
    for (const key of remove) next.delete(key);
    for (const [key, value] of Object.entries(updates)) {
      if (value === "" || value === null || value === undefined) next.delete(key);
      else next.set(key, String(value));
    }
    setSearchParams(next, { replace: true });
  }

  function changeTab(nextTab) {
    setTab(nextTab);
    setPage(1);
    updateUrl({ tab: nextTab, page: 1 });
  }

  function updateFilter(setter, key, value) {
    setter(value);
    setPage(1);
    updateUrl({ [key]: value, page: 1 });
  }

  function openApplication(row) {
    updateUrl({ tab, workflowType: row.workflowType, applicationId: row.applicationId });
  }

  function closeDetail() {
    updateUrl({ tab }, ["workflowType", "applicationId"]);
    setDetail(null);
  }

  async function submitAction(payload) {
    if (!selectedIncident?._id && !selectedIncident?.id) return;
    setBusy(true);
    setMessage("");
    try {
      await adminApi.actOnIncident(selectedIncident._id || selectedIncident.id, payload);
      setAction("");
      setSelectedIncident(null);
      setActionError("");
      setMessage("Incident action saved to the administrative history.");
      await Promise.all([loadDetail(), loadList()]);
    } catch (error) {
      setActionError(error.message || "The incident action could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function submitIncident(payload) {
    setBusy(true);
    setReportError("");
    try {
      await adminApi.createIncident(payload);
      setReportOpen(false);
      setTab("pending");
      setPage(1);
      updateUrl({ tab: "pending", page: 1 }, ["workflowType", "applicationId"]);
      setMessage("Incident created and recorded for administrative review.");
    } catch (error) {
      setReportError(error.message || "The incident could not be created.");
    } finally {
      setBusy(false);
    }
  }

  const summary = result.summary || {};
  const applications = result.applications || [];

  return <main className="admin-incident-page">
    <div className="page-heading"><div><p className="eyebrow">ADMINISTRATIVE OVERSIGHT</p><h1>Legacy Application Monitoring</h1><p>Monitor delayed applications, investigate workflow incidents, track interventions, and review resolved issues. Incident status never changes the application approval decision.</p></div><div className="incident-page-actions"><button className="button button-secondary" onClick={() => { loadList(); loadDetail(); }} disabled={loading}><RefreshCw size={15} /> Refresh</button><button className="button button-primary" onClick={() => { setReportError(""); setReportOpen(true); }}>Report an issue</button></div></div>
    <div className="stat-grid">
      <StatCard label="Affected applications" value={summary.affectedApplications ?? "—"} icon={FileSearch} />
      <StatCard label="Pending applications" value={summary.pendingApplications ?? "—"} icon={Clock3} />
      <StatCard label="Completed applications" value={summary.completedApplications ?? "—"} icon={ShieldAlert} />
      <StatCard label="Critical unresolved issues" value={summary.criticalOpenIncidents ?? "—"} icon={AlertTriangle} variant="danger" />
    </div>

    {message && <div className="note success-note" role="status">{message}</div>}
    {workflowType && applicationId
      ? <ApplicationDetail detail={detail} loading={detailLoading} error={detailError} onBack={closeDetail} onAction={(incident, nextAction) => { setActionError(""); setSelectedIncident(incident); setAction(nextAction); }} />
      : <>
        <div className="incident-tabs" role="tablist" aria-label="Application incidents">
          <button role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "active" : ""} onClick={() => changeTab("pending")}>Pending <span>{summary.pendingApplications ?? "—"}</span></button>
          <button role="tab" aria-selected={tab === "completed"} className={tab === "completed" ? "active" : ""} onClick={() => changeTab("completed")}>Completed <span>{summary.completedApplications ?? "—"}</span></button>
        </div>
        <Card title={tab === "pending" ? "Applications requiring action" : "Applications with completed incidents"} description="Applications appear once per list. Any unresolved issue keeps the application in Pending.">
          <div className="incident-filter-grid">
            <label className="field-label">Search application, institution, or incident<input value={search} onChange={(event) => updateFilter(setSearch, "search", event.target.value)} placeholder="Application number or institution" /></label>
            <label className="field-label">Incident type<select value={type} onChange={(event) => updateFilter(setType, "type", event.target.value)}><option value="">All types</option><option value="STAGE_DUE_DATE_EXCEEDED">Stage delay</option><option value="STAGE_DELAY_ADMIN_REVIEW">Admin stage-delay review</option><option value="SUSPECTED_INCORRECT_APPROVAL">Suspected incorrect approval</option><option value="WORKFLOW_FAILURE">Workflow failure</option><option value="VALIDATION_FAILURE">Validation failure</option><option value="MANUAL_REPORT">Manually reported</option></select></label>
            <label className="field-label">Severity<select value={severity} onChange={(event) => updateFilter(setSeverity, "severity", event.target.value)}><option value="">All severities</option>{["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="field-label">Workflow stage<input value={stage} onChange={(event) => updateFilter(setStage, "stage", event.target.value)} placeholder="Search stage" /></label>
            <label className="field-label">Responsible officer ID<input value={owner} onChange={(event) => updateFilter(setOwner, "ownerId", event.target.value)} placeholder="User ID" /></label>
            <label className="field-label">Detected from<input type="date" value={dateFrom} onChange={(event) => updateFilter(setDateFrom, "dateFrom", event.target.value)} /></label>
            <label className="field-label">Detected to<input type="date" value={dateTo} onChange={(event) => updateFilter(setDateTo, "dateTo", event.target.value)} /></label>
          </div>
          {listError && <div className="note warning-note" role="alert">{listError}</div>}
          {loading && <p className="muted" role="status">Loading application incidents…</p>}
          {!loading && !listError && applications.length === 0 && <div className="state-card"><FileSearch size={22} /><h3>No {tab} applications</h3><p>{tab === "pending" ? "There are no recorded unresolved incidents matching these filters." : "No application has all tracked incidents resolved yet."}</p></div>}
          {!loading && applications.length > 0 && <div className="table-wrap incident-table-wrap"><table className="data-table"><thead><tr><th>Application</th><th>Institution</th><th>Workflow / stage</th><th>Issues</th><th>Severity</th><th>Incident status</th><th>Responsible officer</th><th>Earliest unresolved</th><th>Latest incident</th><th>Latest resolution</th><th /></tr></thead><tbody>{applications.map((row) => <tr key={`${row.workflowType}:${row.applicationId}`} onClick={() => openApplication(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") openApplication(row); }}>
            <td><strong>{display(row.applicationNumber || row.applicationId)}</strong><small className="incident-subtext">{display(row.workflowType)}</small></td>
            <td>{display(row.institutionName)}</td>
            <td>{display(row.currentStage)}<small className="incident-subtext">Application: {display(row.applicationStatus)}</small></td>
            <td>{row.incidentCount ?? 0}{row.incidents?.slice(0, 2).map((incident) => <small className="incident-subtext" key={incident.id}>{incident.type}: {incident.summary}</small>)}</td>
            <td><Badge variant={severityVariant(row.highestSeverity)}>{display(row.highestSeverity, "NONE")}</Badge></td>
            <td><Badge variant={row.overallIncidentStatus === "COMPLETED" ? "success" : "warning"}>{display(row.overallIncidentStatus)}</Badge><small className="incident-subtext">{row.resolvedIncidentCount || 0} resolved / closed</small></td>
            <td>{row.responsibleOfficer?.name || row.responsibleOfficer?.email || "Not recorded"}{row.responsibleOfficer?.role && <small className="incident-subtext">{adminRoleLabels[row.responsibleOfficer.role] || row.responsibleOfficer.role}</small>}</td>
            <td>{dateLabel(row.earliestIncidentAt)}</td>
            <td>{dateLabel(row.latestIncidentAt)}{row.pendingDurationMs > 0 && <small className="incident-subtext">Pending {Math.floor(row.pendingDurationMs / 86_400_000)} day(s)</small>}{row.lastAction && <small className="incident-subtext">Latest action: {row.lastAction.action}</small>}</td>
            <td>{dateLabel(row.mostRecentResolutionAt)}</td>
            <td><button className="text-link" type="button" onClick={(event) => { event.stopPropagation(); openApplication(row); }}>Review</button></td>
          </tr>)}</tbody></table></div>}
          <div className="incident-pagination"><span>{result.total ?? 0} application(s) · Page {page} of {Math.max(1, result.pages || 1)}</span><div><button className="button button-secondary button-small" disabled={loading || page <= 1} onClick={() => { const next = page - 1; setPage(next); updateUrl({ page: next }); }}><ChevronLeft size={15} /> Previous</button><button className="button button-secondary button-small" disabled={loading || page >= (result.pages || 1)} onClick={() => { const next = page + 1; setPage(next); updateUrl({ page: next }); }}>Next <ChevronRight size={15} /></button></div></div>
        </Card>
      </>}
    {action && <IncidentActionDialog key={action} action={action} busy={busy} requestError={actionError} onClose={() => { if (!busy) { setAction(""); setActionError(""); setSelectedIncident(null); } }} onSubmit={submitAction} />}
    {reportOpen && <ReportIncidentDialog busy={busy} requestError={reportError} onClose={() => { if (!busy) setReportOpen(false); }} onSubmit={submitIncident} />}
  </main>;
}
