import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarDays, CheckCircle2, Clock3, FileText, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import { Badge, Card, Toast } from "../../components/ui/primitives";
import DocumentEvidencePreview from "../../components/DocumentEvidencePreview";
import { caseWorkflowApi } from "../../services/caseWorkflow";
import { evcApi } from "../../services/evc";
import RejectEvcModal from "./RejectEvcModal";
import ScheduleInspectionModal from "./ScheduleInspectionModal";

const typeLabels = {
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration or twinning programme",
  restoration_of_intake: "Restoration of intake",
};
const tabDefinitions = [
  { id: "waiting_inspection", label: "Waiting for Inspection" },
  { id: "waiting_approval", label: "Waiting for Approval" },
];

function displayDate(value, options = {}) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not set" : date.toLocaleString(undefined, options);
}

function metadataText(value) {
  if (value === null || value === undefined || value === "") return "Not extracted";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ErrorState({ error, onRetry }) {
  return <div className="evc-state evc-error" role="alert">
    <AlertTriangle size={22} />
    <div><strong>We could not load the EVC workspace.</strong><p>{error}</p></div>
    <button className="button button-secondary button-small" type="button" onClick={onRetry}><RefreshCw size={15} /> Try again</button>
  </div>;
}

function InspectionStatus({ status }) {
  if (status.status === "SCHEDULED") return <Badge variant="info">Scheduled · {displayDate(status.scheduledDate, { dateStyle: "medium" })}</Badge>;
  if (status.status === "REPORT_UPLOADED") return <Badge variant="success">Report uploaded</Badge>;
  return <Badge variant="warning">Unscheduled</Badge>;
}

function ApplicationList({ cases, tab, onReload, basePath }) {
  const navigate = useNavigate();
  if (!cases.length) {
    return <div className="evc-empty">
      <CalendarDays size={26} />
      <strong>No applications are waiting here.</strong>
      <span>New work appears when an application is assigned to your EVC stage.</span>
      <button className="button button-secondary button-small" type="button" onClick={onReload}><RefreshCw size={14} /> Refresh</button>
    </div>;
  }
  return <div className="evc-table-wrap">
    <table className="evc-table">
      <thead><tr>
        <th>Application ID</th><th>Institution</th><th>Application type</th><th>Region</th>
        <th>Assigned date</th><th>Stage SLA due</th><th>Inspection status</th>
      </tr></thead>
      <tbody>{cases.map((item) => <tr
        key={item._id}
        tabIndex={0}
        aria-label={`Open application ${item.caseNo}`}
        onClick={() => navigate(`${basePath}/${item._id}?tab=${tab}`)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigate(`${basePath}/${item._id}?tab=${tab}`);
          }
        }}
      >
        <td><Link className="evc-case-link" to={`${basePath}/${item._id}?tab=${tab}`}>{item.caseNo}</Link></td>
        <td>{item.institution}</td>
        <td>{typeLabels[item.applicationType] || item.applicationType}</td>
        <td>{item.region || "—"}</td>
        <td>{displayDate(item.assignedAt, { dateStyle: "medium" })}</td>
        <td>{displayDate(item.stageDueAt, { dateStyle: "medium" })}</td>
        <td><InspectionStatus status={{ status: item.inspectionStatus, scheduledDate: item.scheduled_inspection_date }} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function EvcTabs({ activeTab, counts, onSelect }) {
  return <div className="evc-tabs" role="tablist" aria-label="EVC case queues">
    {tabDefinitions.map((tab) => <button
      className={`evc-tab ${activeTab === tab.id ? "active" : ""}`}
      type="button"
      role="tab"
      aria-selected={activeTab === tab.id}
      key={tab.id}
      onClick={() => onSelect(tab.id)}
    >{tab.label}<span className="evc-tab-count" aria-label={`${counts[tab.id]} cases`}>{counts[tab.id]}</span></button>)}
  </div>;
}

function DocumentCard({ document, onPreview }) {
  const extraction = document.extraction;
  const fields = extraction?.fields || [];
  const m2 = extraction?.m2_json;
  const m3 = extraction?.m3_json;
  return <article className="evc-document-card">
    <div className="evc-document-heading">
      <FileText size={19} />
      <div><strong>{document.doc_type_final || document.doc_type_slot || "Uploaded document"}</strong><small>{document.original_name}</small></div>
      <Badge variant={document.status === "CONFIRMED" ? "success" : "neutral"}>{document.status || "Uploaded"}</Badge>
    </div>
    <div className="evc-document-meta">
      <span><b>M1 document type</b>{extraction?.m1_type || "Not classified"}</span>
      <span><b>Human confirmation</b>{document.verification === "verified" || document.confirmed_at ? "Confirmed / verified" : document.verification === "not_verified" ? "Not verified" : "Awaiting confirmation"}</span>
    </div>
    {fields.length > 0 && <div className="evc-extracted-fields">
      {fields.map((field) => <div key={`${document._id}-${field.field_name}`}>
        <span>{field.field_name.replaceAll("_", " ")}</span>
        <strong>{field.confirmed_value ?? field.ai_value ?? "Not extracted"}</strong>
        <small>{field.confirmed_at ? "Human confirmed" : "AI extracted"}</small>
      </div>)}
    </div>}
    {(m2 || m3) && <details className="evc-model-metadata">
      <summary>View M2 and M3 extracted metadata</summary>
      {m2 && <pre><b>M2 dates / fields</b>{"\n"}{metadataText(m2)}</pre>}
      {m3 && <pre><b>M3 lease / parties</b>{"\n"}{metadataText(m3)}</pre>}
    </details>}
    {document.verification_reason && <p className="muted">Verification note: {document.verification_reason}</p>}
    <button className="button button-secondary button-small" type="button" onClick={() => onPreview(document)}>Preview document</button>
  </article>;
}

function InspectionDetails({ detail, busy, onApprove, onRaiseDeficiency, onUpload, onBack, onOpenSchedule, onOpenReject, previewDocument, setPreviewDocument, deficiency, setDeficiency, committeeRemarks, setCommitteeRemarks }) {
  const { case: record, stage, documents, findings, previousStageHistory, panelists, complianceChecklist } = detail;
  const leftColumnRef = useRef(null);
  const rightColumnRef = useRef(null);
  const [balancedColumnHeight, setBalancedColumnHeight] = useState(null);
  const isApproval = stage.status === "WAITING_FOR_APPROVAL";
  const isScheduled = stage.status === "INSPECTION_SCHEDULED";
  const isRejected = Boolean(stage.rejection_category) || record.overallStatus === "EVC_REJECTED";
  const isDeficiency = record.status === "returned" && !isRejected;
  const report = documents.find((document) => String(document._id) === String(stage.inspectionReportDocumentId));

  useLayoutEffect(() => {
    const columns = [leftColumnRef.current, rightColumnRef.current];
    if (columns.some((column) => !column)) return undefined;

    const updateHeight = () => {
      if (window.matchMedia("(max-width: 650px)").matches) {
        setBalancedColumnHeight(null);
        return;
      }

      const nextHeight = Math.min(...columns.map((column) => column.scrollHeight));
      setBalancedColumnHeight((currentHeight) => currentHeight === nextHeight ? currentHeight : nextHeight);
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateHeight);
    columns.forEach((column) => {
      observer?.observe(column);
      Array.from(column.children).forEach((child) => observer?.observe(child));
    });
    window.addEventListener("resize", updateHeight);
    updateHeight();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [detail]);

  return <div className="evc-details">
    <button className="evc-back-link" type="button" onClick={onBack}><ArrowLeft size={17} /> Back to EVC cases</button>
    <header className="evc-case-heading">
      <div><p className="eyebrow">APPLICATION INSPECTION DETAILS</p><h1>{record.caseNo}</h1><p>{detail.institution?.name || "Institution"} · {typeLabels[record.applicationType] || record.applicationType} · {record.region}</p></div>
      <div className="evc-case-heading-badges">
        <Badge variant={isRejected ? "danger" : isApproval ? "success" : isScheduled ? "info" : "warning"}>{isRejected ? "Rejected at EVC" : isDeficiency ? "Returned for correction" : isApproval ? "Waiting for EVC approval" : isScheduled ? "Inspection scheduled" : "Waiting for inspection"}</Badge>
        <span><Clock3 size={15} /> SLA due {displayDate(stage.stageDueAt, { dateStyle: "medium" })}</span>
      </div>
    </header>

    {detail.successMessage && <div className="evc-state evc-success" role="status"><CheckCircle2 size={20} /><span>{detail.successMessage}</span></div>}
    {detail.failureNotice && <div className="evc-state evc-error" role="alert"><AlertTriangle size={20} /><span>{detail.failureNotice}</span></div>}

    <div className="evc-detail-grid" style={{ "--evc-balanced-column-height": balancedColumnHeight === null ? "auto" : `${balancedColumnHeight}px` }}>
      <section className="evc-detail-column" ref={leftColumnRef}>
        <Card title="Application documents" description="Source documents, AI extraction and human confirmation status.">
          <div className="evc-document-list">
            {documents.length
              ? documents.map((document) => <DocumentCard key={document._id} document={document} onPreview={setPreviewDocument} />)
              : <p className="muted">No documents are attached to this application.</p>}
          </div>
          {previewDocument && <DocumentEvidencePreview documentId={previewDocument._id} fileName={previewDocument.original_name} onClose={() => setPreviewDocument(null)} />}
        </Card>
        {report && <Card title="EVC inspection report" description="Uploaded report required for committee sign-off.">
          <DocumentCard document={report} onPreview={setPreviewDocument} />
        </Card>}
      </section>

      <section className="evc-detail-column" ref={rightColumnRef}>
        <Card title={isApproval ? "Compliance review & committee sign-off" : "Inspection readiness"}>
          <h3 className="evc-subheading">Compliance checklist</h3>
          {complianceChecklist?.length
            ? <ul className="evc-checklist">{complianceChecklist.map((item) => <li key={item.name}><span>{item.uploaded ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}{item.name}</span><Badge variant={item.uploaded ? "success" : "warning"}>{item.uploaded ? "Available" : "Missing"}</Badge></li>)}</ul>
            : <p className="muted">No stage-specific document checklist is configured.</p>}

          <h3 className="evc-subheading">Verified parameters and findings</h3>
          {documents.some((document) => document.extraction?.fields?.some((field) => field.confirmed_value !== null && field.confirmed_value !== undefined)) && <ul className="evc-verified-parameters">
            {documents.flatMap((document) => (document.extraction?.fields || [])
              .filter((field) => field.confirmed_value !== null && field.confirmed_value !== undefined)
              .map((field) => <li key={`${document._id}-${field.field_name}`}><span>{field.field_name.replaceAll("_", " ")}</span><strong>{field.confirmed_value}</strong><small>Human confirmed</small></li>))}
          </ul>}
          {findings?.length
            ? <ul className="evc-findings">{findings.map((finding) => <li key={finding._id}><strong>{finding.title || finding.code || "Review finding"}</strong><span>{finding.description || finding.reason || finding.status}</span></li>)}</ul>
            : <p className="muted">No automated compliance findings are recorded.</p>}
          {isApproval
            ? <label className="field-label evc-remarks-input">Committee remarks
              <textarea rows={3} value={committeeRemarks} onChange={(event) => setCommitteeRemarks(event.target.value)} placeholder="Record the committee's review remarks." disabled={busy} />
            </label>
            : stage.remarks && <div className="evc-remarks"><strong>Committee remarks</strong><p>{stage.remarks}</p></div>}
          {panelists?.length > 0 && <div className="evc-panel-readonly"><strong>Assigned EVC panel</strong>{panelists.map((member) => <span key={member._id}>{member.name}{member.email ? ` · ${member.email}` : ""}</span>)}</div>}
          {isScheduled && <div className="evc-schedule-summary"><strong>Inspection schedule</strong><span>{displayDate(stage.scheduled_inspection_date, { dateStyle: "full" })}</span><span>{stage.inspection_mode}</span>{stage.inspection_instructions && <p>{stage.inspection_instructions}</p>}</div>}

          {!isApproval && !isRejected && !isDeficiency && (stage.status === "ACTIVE" || isScheduled) && <div className="evc-actions">
            {stage.status === "ACTIVE" && <button className="button button-primary" type="button" onClick={onOpenSchedule}><CalendarDays size={16} /> Conduct Inspection</button>}
            {isScheduled && <button className="button button-secondary" type="button" onClick={onOpenSchedule}><CalendarDays size={16} /> Edit inspection schedule</button>}
            <button className="button button-danger-outline" type="button" onClick={onOpenReject}>Reject Application</button>
          </div>}
          {!isApproval && !isRejected && isScheduled && <div className="evc-report-upload">
            <label className="button button-primary"><UploadCloud size={16} /> Upload completed inspection report
              <input aria-label="Upload EVC inspection report" type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={busy} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.target.value = "";
              }} />
            </label>
            <small>PDF, JPEG or PNG; maximum 20 MB. Uploading moves this case to Waiting for Approval.</small>
          </div>}
          {isApproval && !isRejected && <div className="evc-actions evc-approval-actions">
            <button className="button button-primary" type="button" disabled={busy || !report} onClick={onApprove}><ShieldCheck size={16} /> Approve &amp; Forward to Next Stage</button>
            <label className="field-label">Deficiency remarks
              <textarea rows={3} value={deficiency} onChange={(event) => setDeficiency(event.target.value)} placeholder="Explain what the institution must correct." disabled={busy} />
            </label>
            <button className="button button-secondary" type="button" disabled={busy || deficiency.trim().length < 1} onClick={onRaiseDeficiency}>Raise Deficiency</button>
          </div>}
          {isRejected && <div className="evc-state evc-error"><AlertTriangle size={18} /><span>Application rejected at the EVC stage. {stage.rejection_category}: {stage.rejection_reason}</span></div>}
          {isDeficiency && <div className="evc-state evc-error"><AlertTriangle size={18} /><span>Deficiency raised; application returned to the institution for correction.</span></div>}
        </Card>
        {previousStageHistory?.length > 0 && <Card title="Previous stage history">
          <ol className="evc-history">{previousStageHistory.map((item) => <li key={item._id || `${item.toStage}-${item.enteredAt}`}><strong>{item.fromStage || item.toStage} → {item.toStage}</strong><span>{item.reason || "Stage activity recorded"}</span><small>{displayDate(item.enteredAt)}</small></li>)}</ol>
        </Card>}
      </section>
    </div>
  </div>;
}

export default function EvcWorkspace({ basePath = "/evc/cases" }) {
  const { caseId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = tabDefinitions.some(({ id }) => id === searchParams.get("tab")) ? searchParams.get("tab") : "waiting_inspection";
  const [activeTab, setActiveTab] = useState(initialTab);
  const [cases, setCases] = useState({ waiting_inspection: null, waiting_approval: null });
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [previewDocument, setPreviewDocument] = useState(null);
  const [deficiency, setDeficiency] = useState("");
  const [committeeRemarks, setCommitteeRemarks] = useState("");

  const loadCases = useCallback(async () => {
    const [inspection, approval] = await Promise.all([
      evcApi.listCases("waiting_inspection"),
      evcApi.listCases("waiting_approval"),
    ]);
    setCases({ waiting_inspection: inspection, waiting_approval: approval });
  }, []);

  const loadDetail = useCallback(async () => {
    if (!caseId) return;
    const result = await evcApi.getCase(caseId);
    setDetail(result);
    setCommitteeRemarks(result.stage.remarks || "");
  }, [caseId]);

  const reload = useCallback(async () => {
    setError("");
    try {
      await Promise.all([loadCases(), ...(caseId ? [loadDetail()] : [])]);
    } catch (loadError) {
      setError(loadError.message || "The EVC workspace could not be loaded.");
    }
  }, [caseId, loadCases, loadDetail]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => { void loadCases().catch((loadError) => setError(loadError.message)); }, 30000);
    const unsubscribe = caseWorkflowApi.subscribeToCaseEvents(() => {
      void loadCases().catch((loadError) => setError(loadError.message));
      if (caseId) void loadDetail().catch((loadError) => setError(loadError.message));
    }, () => {});
    return () => { clearInterval(timer); unsubscribe(); };
  }, [caseId, loadCases, loadDetail]);

  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (tabDefinitions.some(({ id }) => id === requestedTab)) setActiveTab(requestedTab);
  }, [searchParams]);

  const counts = useMemo(() => ({
    waiting_inspection: cases.waiting_inspection?.length || 0,
    waiting_approval: cases.waiting_approval?.length || 0,
  }), [cases]);

  function selectTab(tab) {
    setActiveTab(tab);
    setSearchParams({ tab }, { replace: true });
  }

  async function runAction(action, successMessage) {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
      setDetail((current) => ({
        ...current,
        successMessage: message,
        failureNotice: "",
        ...(result?.case ? {
          case: result.case,
          stage: result.case.allocatedStages?.[result.case.currentStageIndex] || current.stage,
        } : {}),
      }));
      setShowSchedule(false);
      setShowReject(false);
      await loadCases();
      return result;
    } catch (actionError) {
      setError(actionError.message || "The EVC action could not be completed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function scheduleInspection(values) {
    const result = await runAction(
      () => evcApi.scheduleInspection(caseId, { ...values, expectedVersion: detail.case.version }),
      (scheduled) => `${detail.stage.status === "INSPECTION_SCHEDULED" ? "Inspection rescheduled" : "Inspection scheduled"} for ${values.scheduled_inspection_date}. Email notifications queued: ${scheduled.notificationResult?.queued ?? 0}.`,
    );
    if (result) {
      const queued = result.notificationResult?.queued ?? 0;
      const failed = result.notificationResult?.failedCount || 0;
      const panelistsQueued = result.notificationResult?.panelistsQueued ?? 0;
      const notice = `${detail.stage.status === "INSPECTION_SCHEDULED" ? "Inspection rescheduled" : "Inspection scheduled"} for ${values.scheduled_inspection_date}. Email notifications queued: ${queued} (${panelistsQueued} panelist${panelistsQueued === 1 ? "" : "s"})${failed ? `; ${failed} could not be queued` : ""}.`;
      await loadDetail();
      setDetail((current) => ({ ...current, successMessage: notice }));
      setToastMessage(notice);
    }
  }

  async function rejectApplication(values) {
    const result = await runAction(
      () => evcApi.rejectApplication(caseId, { ...values, expectedVersion: detail.case.version }),
      "Application rejected.",
    );
    if (result) {
      const queued = result.notificationResult?.queued ?? result.notificationsQueued ?? 0;
      const failed = result.notificationResult?.failedCount || 0;
      const institutionQueued = result.notificationResult?.institutionQueued;
      const previousQueued = result.notificationResult?.previousStageOfficersQueued ?? Math.max(0, queued - (institutionQueued ? 1 : 0));
      setDetail((current) => ({
        ...current,
        successMessage: `Application rejected. Notifications queued to ${institutionQueued ? "College" : "the available recipients"} and ${previousQueued} previous stage officer${previousQueued === 1 ? "" : "s"}.${failed ? ` ${failed} email notification${failed === 1 ? "" : "s"} could not be queued.` : ""}`,
        case: result.case,
      }));
      setToastMessage(`Application rejected. ${queued} email notification${queued === 1 ? "" : "s"} queued.`);
      await loadCases();
    }
  }

  async function uploadReport(file) {
    const result = await runAction(() => caseWorkflowApi.uploadEvcReport(caseId, file), "EVC inspection report uploaded; case is waiting for committee approval.");
    if (result) {
      setActiveTab("waiting_approval");
      setSearchParams({ tab: "waiting_approval" }, { replace: true });
      setCommitteeRemarks("");
      await loadDetail();
    }
  }

  async function approveApplication() {
    const result = await runAction(
      () => evcApi.approveApplication(caseId, { expectedVersion: detail.case.version, remarks: committeeRemarks }),
      "EVC approval recorded and the application forwarded to the next stage.",
    );
    if (result) {
      navigate(`${basePath}?tab=waiting_approval`, { replace: true });
    }
  }

  async function raiseDeficiency() {
    const result = await runAction(() => caseWorkflowApi.rejectStage(caseId, detail.case.currentStageIndex, {
      expectedVersion: detail.case.version,
      reason: deficiency.trim(),
    }), "Deficiency raised; application returned to the institution.");
    if (result) {
      navigate(`${basePath}?tab=waiting_approval`, { replace: true });
    }
  }

  const activeCases = cases[activeTab];
  if (!caseId) {
    return <main className="evc-workspace">
      <header className="evc-workspace-heading">
        <div><p className="eyebrow">EXPERT VISIT COMMITTEE</p><h1>EVC Stage Workspace</h1><p>Schedule and conduct inspections, review reports, and record committee outcomes.</p></div>
        <button className="button button-secondary button-small" type="button" onClick={() => void reload()}><RefreshCw size={15} /> Refresh</button>
      </header>
      {error && <ErrorState error={error} onRetry={() => void reload()} />}
      <EvcTabs activeTab={activeTab} counts={counts} onSelect={selectTab} />
      <Card title={tabDefinitions.find(({ id }) => id === activeTab)?.label || "EVC cases"} description="Case counts update automatically and refresh when workflow activity is received.">
        {activeCases === null ? <div className="loading-state" aria-label="Loading EVC cases"><i /><i /><i /></div> : <ApplicationList cases={activeCases} tab={activeTab} basePath={basePath} onReload={() => void reload()} />}
      </Card>
    </main>;
  }

  return <main className="evc-workspace">
    {error && <ErrorState error={error} onRetry={() => void reload()} />}
    {!detail
      ? error ? null : <div className="loading-state" aria-label="Loading EVC application"><i /><i /><i /></div>
      : <InspectionDetails
        detail={detail}
        busy={busy}
        onBack={() => navigate(`${basePath}?tab=${activeTab}`)}
        onOpenSchedule={() => setShowSchedule(true)}
        onOpenReject={() => setShowReject(true)}
        onApprove={() => void approveApplication()}
        onRaiseDeficiency={() => void raiseDeficiency()}
        onUpload={(file) => void uploadReport(file)}
        previewDocument={previewDocument}
        setPreviewDocument={setPreviewDocument}
        deficiency={deficiency}
        setDeficiency={setDeficiency}
        committeeRemarks={committeeRemarks}
        setCommitteeRemarks={setCommitteeRemarks}
      />}
    {showSchedule && detail && <ScheduleInspectionModal
      panelists={detail.panelists}
      busy={busy}
      initialSchedule={detail.stage.status === "INSPECTION_SCHEDULED" && !detail.stage.inspectionReportDocumentId ? detail.stage : null}
      onClose={() => setShowSchedule(false)}
      onSchedule={scheduleInspection}
    />}
    {showReject && detail && <RejectEvcModal
      busy={busy}
      onClose={() => setShowReject(false)}
      onReject={rejectApplication}
    />}
    {toastMessage && <Toast message={toastMessage} onClose={() => setToastMessage("")} />}
  </main>;
}
