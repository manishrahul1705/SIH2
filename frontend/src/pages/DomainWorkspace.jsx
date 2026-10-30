import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, Bell, Check, CheckCircle2, ClipboardCheck, Clock3, Download, Eye, FileCheck2, FileText, History as HistoryIcon, MapPin, Plus, RefreshCw, Search, ShieldCheck, UploadCloud, Users, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../services/api";
import { adminApi, adminRoleLabels } from "../services/admin";
import { ambiguousDateChoices, caseWorkflowApi, waitForDocumentBatch } from "../services/caseWorkflow";
import DocumentsLive from "./DocumentsLive";
import VerificationWorkspace from "./VerificationWorkspace";
import NotificationsLive from "./NotificationsLive";
import QueueLive from "./QueueLive";
import UndertakingsLive from "./UndertakingsLive";
import EvcVisitsLive from "./EvcVisitsLive";
import PolicyLive from "./PolicyLive";
import RegionLive from "./RegionLive";
import ReportsLive from "./ReportsLive";
import AIServiceLive from "./AIServiceLive";
import DecisionsLive from "./DecisionsLive";
import HearingsLive from "./HearingsLive";
import DeficienciesLive from "./DeficienciesLive";
import { useAppStore } from "../store/useAppStore";
import { buildRoute, routeForApplication } from "../utils/routeBuilder";
import { calculateScore, demoScoreInput } from "../utils/scoreCalculator";
import { Badge, Card, ConfirmDialog, DataTable, DeadlineBadge, AIFieldRow, FileDropzone, OwnershipClockBar, ProjectedScoreCard, ReasonDialog, ScoreBreakdownTable, ScoreGauge, StageStepper, StatCard, TabsView, Toast } from "../components/ui/primitives";
import DocumentEvidencePreview from "../components/DocumentEvidencePreview";
import DocumentPreviewDialog from "../components/DocumentPreviewDialog";
import StageWorkflowPanel from "../components/StageWorkflowPanel";

export const pageSettings = {
  dashboard: { title: "Institution dashboard", description: "A clear view of your applications, obligations and next actions.", eyebrow: "INSTITUTION WORKSPACE", roles: ["Institution user"] },
  application: { title: "New application", description: "Prepare an application for submission under the policy in force.", eyebrow: "APPLICATION WORKSPACE", roles: ["Institution user"] },
  cases: { title: "My cases", description: "Follow each application through its policy-defined stages.", eyebrow: "CASE REGISTER", roles: ["Institution user", "Scrutiny / Regional officer"] },
  documents: { title: "Documents and validity", description: "Choose an application to review its documents, verification status, and extracted fields.", eyebrow: "DOCUMENT REGISTER", roles: ["Institution user"] },
  documentReview: { title: "Evidence documents", description: "View documents in your authorized case scope.", eyebrow: "DOCUMENT REGISTER", roles: ["Institution user", "Scrutiny / Regional officer"] },
  undertakings: { title: "Undertakings", description: "Review actual undertaking records and due dates.", eyebrow: "OBLIGATION REGISTER", roles: ["Institution user"] },
  deficiencies: { title: "Deficiency responses", description: "Respond to returned items with evidence and a written explanation.", eyebrow: "RE-SCRUTINY", roles: ["Institution user"] },
  notifications: { title: "Notifications", description: "Review obligation reminders and escalations. Acknowledgement does not close an obligation.", eyebrow: "ALERT CENTRE", roles: ["All"] },
  audit: { title: "Audit trail", description: "Review recorded backend audit events.", eyebrow: "SYSTEM RECORD", roles: ["Admin"] },
  queue: { title: "My queue", description: "Officer-held work, ordered by urgency and service window.", eyebrow: "OFFICER WORKSPACE", roles: ["Scrutiny / Regional officer"] },
  caseControl: { title: "Case detail and stage control", description: "Review stage evidence, ownership and policy route.", eyebrow: "CASE WORKSPACE", roles: ["Scrutiny / Regional officer", "Institution user", "EVC member", "EVC chairman", "SAC/SHC member", "Competent authority", "Senior authority", "Admin"] },
  verification: { title: "Verification", description: "Verify institution-submitted evidence as a separate official action.", eyebrow: "VERIFICATION QUEUE", roles: ["Scrutiny / Regional officer"] },
  evc: { title: "EVC visits", description: "Review visit records assigned to your account.", eyebrow: "EXPERT VISIT COMMITTEE", roles: ["EVC member", "EVC chairman", "Scrutiny / Regional officer"] },
  hearings: { title: "Committee cases", description: "Review cases assigned to SHC or SAC stages.", eyebrow: "SAC / SHC", roles: ["SAC/SHC member"] },
  decisions: { title: "Legacy decisions", description: "Record a final decision for legacy cases whose configured route is complete.", eyebrow: "ADMINISTRATOR", roles: ["Admin"] },
  region: { title: "Region dashboard", description: "Compare ageing, workload and bottlenecks by ownership and region.", eyebrow: "REGIONAL OVERSIGHT", roles: ["Senior authority", "Competent authority"] },
  reports: { title: "Reports", description: "Review backend analytics for applications and institutions.", eyebrow: "REPORTING", roles: ["Senior authority", "Competent authority"] },
  policy: { title: "Policy and stages", description: "Review policy versions stored in the backend.", eyebrow: "ADMINISTRATION", roles: ["Admin"] },
  alertRules: { title: "Alert rules", description: "Review and update backend validation rules.", eyebrow: "ADMINISTRATION", roles: ["Admin"] },
  aiService: { title: "AI service status", description: "Control AI availability. Manual entry remains available when the service is off.", eyebrow: "ADMINISTRATION", roles: ["Admin"] },
  design: { title: "Design system", description: "Shared accessible components, states and product tokens.", eyebrow: "COMPONENT LIBRARY", roles: ["Admin"] },
};

const applicationTypeLabels = {
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration or twinning programme",
  restoration_of_intake: "Restoration of intake",
};
const defaultApplicability = {
  landIsLeased: false,
  newAreaAdded: false,
  buildingOver30: false,
  claimsAccreditation: false,
  landChanged: false,
  premisesShared: false,
  premisesUsed: false,
  affiliatingBodyRequired: false,
};
const MODEL = "M2 Field extraction · v1.4";

function PageHeading({ config, action }) {
  return <div className="page-heading"><div><p className="eyebrow">{config.eyebrow}</p><h1>{config.title}</h1><p>{config.description}</p></div>{action}</div>;
}

function BusyState({ error, onRetry }) {
  if (error) return <div className="state-card state-error"><AlertTriangle size={22} /><h3>We could not load this workspace.</h3><p>{error}</p><button className="button button-secondary" onClick={onRetry}><RefreshCw size={15} /> Try again</button></div>;
  return <div className="loading-state" aria-label="Loading"><i /><i /><i /><i /></div>;
}

function Dashboard({ data, reload }) {
  const required = data.undertakings.filter((item) => item.submission === "Not submitted").slice(0, 4);
  return <div className="dashboard-page">
    <div className="stat-grid compact-stats">
      <StatCard label="Applications" value={data.summary.applications} icon={FileText} />
      <StatCard label="Cases in progress" value={data.summary.casesInProgress} icon={Activity} />
      <StatCard label="Open undertakings" value={data.summary.openUndertakings} note={`${data.summary.undertakingsDueIn7Days} due within 7 days`} icon={ClipboardCheck} />
      <StatCard label="Documents expiring in 30 days" value={data.summary.documentsExpiringIn30Days} icon={FileCheck2} />
      <StatCard label="Open alerts" value={data.summary.openAlerts} icon={Bell} />
    </div>
    <div className="dashboard-columns">
      {data.actionScore && <Card title="Live Compliance Action Score" description={data.actionScore.note}>
        {data.actionScore.assessmentComplete
          ? <div className="score-dashboard">
            <ScoreGauge score={data.actionScore.current.score} onBreakdown={() => document.getElementById("action-score-breakdown")?.scrollIntoView({ behavior: "smooth" })} />
            <div><strong>30-day projection: {data.actionScore.projected.score ?? "Incomplete"}</strong><p className="muted">As of {new Date(data.actionScore.assessedAt).toLocaleString()}. Projection assumes no new uploads or obligation changes.</p></div>
            <div id="action-score-breakdown" className="table-wrap"><table className="data-table"><thead><tr><th>Deduction</th><th>Reason</th><th>Points</th></tr></thead><tbody>
              {data.actionScore.current.deductions.length ? data.actionScore.current.deductions.map((item, index) => <tr key={`${item.recordId}-${index}`}><td>{item.category}</td><td>{item.reason}</td><td>{item.points}</td></tr>) : <tr><td colSpan="3">No current deductions</td></tr>}
            </tbody></table></div>
          </div>
          : <p className="muted">Score is incomplete until active case evidence has been assessed under the configured policy.</p>}
      </Card>}
      <Card title="Institution actions" description="Open undertakings recorded for your applications." action={<Link className="text-link" to="/undertakings">View all</Link>}>
        {required.length ? <div className="action-list">{required.map((item) => <div className="action-row" key={item.id}><span className="action-icon warning"><AlertTriangle size={16} /></span><div className="action-copy"><strong>{item.title}</strong><small>{item.caseId}</small></div><DeadlineBadge deadline={item.dueDate} /><Link className="button button-secondary button-small" to="/undertakings">Open</Link></div>)}</div> : <p className="muted">No open undertakings.</p>}
      </Card>
      <Card title="Recently updated cases" description="Applications in your authorized case scope.">
        {data.cases.slice(0, 5).map((item) => <div className="compact-case-row" key={item.caseId}><div><strong>{item.id}</strong><small>{item.type} · {item.stage}</small></div><Badge variant={item.status === "Approved" ? "success" : item.status === "Action required" ? "warning" : "info"}>{item.status}</Badge></div>)}
        {!data.cases.length && <p className="muted">No cases are available in your scope.</p>}
      </Card>
    </div>
  </div>;
}

function InfoIcon() { return <ShieldCheck size={17} />; }

function NewApplication({ data, setMessage }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const resumeCaseId = searchParams.get("caseId");
  const [applicationTypes, setApplicationTypes] = useState(Object.entries(applicationTypeLabels).map(([id, label]) => ({ id, label })));
  const [applicationType, setApplicationType] = useState("");
  const [applicability, setApplicability] = useState(defaultApplicability);
  const [preview, setPreview] = useState(null);
  const [checklist, setChecklist] = useState([]);
  const [caseRecord, setCaseRecord] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState({});
  const [busyAction, setBusyAction] = useState("");
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [extractions, setExtractions] = useState({});
  const [fieldValues, setFieldValues] = useState({});
  const [resolvedAmbiguities, setResolvedAmbiguities] = useState({});
  const [analysisWait, setAnalysisWait] = useState(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [previewDocument, setPreviewDocument] = useState(null);

  useEffect(() => {
    if (!resumeCaseId) return undefined;
    let active = true;
    setLoadingDraft(true);
    setPageError("");
    Promise.all([
      caseWorkflowApi.getCase(resumeCaseId),
      caseWorkflowApi.getChecklist(resumeCaseId),
      caseWorkflowApi.getCaseDocuments(resumeCaseId),
    ]).then(async ([record, checklistResult, documents]) => {
      if (!["draft", "returned"].includes(record.status)) {
        throw new Error("Only a draft or returned application can be continued here.");
      }
      const extractionResults = await Promise.all(documents.map(async (document) => ({
        document,
        result: await caseWorkflowApi.getExtraction(document._id),
      })));
      if (!active) return;
      setCaseRecord(record);
      setApplicationType(record.applicationType);
      setApplicability({ ...defaultApplicability, ...(record.applicability || {}) });
      setChecklist(checklistResult.checklist || []);
      setExtractions(Object.fromEntries(extractionResults.map(({ document, result }) => [document._id, result])));
      setFieldValues(Object.fromEntries(extractionResults.flatMap(({ document, result }) => (result.extraction?.fields || []).map((field) => [
        `${document._id}:${field.field_name}`,
        field.confirmed_value ?? (field.prefill ? field.ai_value : ""),
      ]))));
      setResolvedAmbiguities(Object.fromEntries(extractionResults.flatMap(({ document, result }) => (result.extraction?.fields || [])
        .filter((field) => field.ambiguous && field.confirmed_value != null)
        .map((field) => [`${document._id}:${field.field_name}`, true]))));
      setPageNotice(`Draft ${record.caseNo} was restored. Continue reviewing its documents.`);
    }).catch((error) => {
      if (active) setPageError(error.message || "The saved application could not be restored.");
    }).finally(() => {
      if (active) setLoadingDraft(false);
    });
    return () => { active = false; };
  }, [resumeCaseId]);

  useEffect(() => {
    let active = true;
    caseWorkflowApi.getApplicationTypes()
      .then((items) => {
        if (active && Array.isArray(items) && items.length) {
          setApplicationTypes(items.map((item) => ({
            id: item.id,
            label: applicationTypeLabels[item.id] || item.label,
          })));
        }
      })
      .catch((error) => { if (active) setPageError(error.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!applicationType) {
      setPreview(null);
      setChecklist([]);
      return undefined;
    }
    const hasDraft = Boolean(caseRecord);
    let active = true;
    setLoadingPreview(true);
    setPageError("");
    caseWorkflowApi.previewChecklist({ applicationType, applicability, routeFlags: {} })
      .then((result) => {
        if (active) {
          setPreview(result);
          if (!hasDraft) setChecklist(result.checklist || []);
          else setChecklist((current) => result.checklist.map((slot) => {
            const existing = current.find((item) => item.slotId === slot.slotId);
            return existing ? { ...slot, status: existing.status, documentId: existing.documentId } : slot;
          }));
        }
      })
      .catch((error) => { if (active) setPageError(error.message); })
      .finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [applicationType, applicability, Boolean(caseRecord)]);

  async function refreshCase(id = caseRecord?._id) {
    if (!id) return;
    const [record, result] = await Promise.all([
      caseWorkflowApi.getCase(id),
      caseWorkflowApi.getChecklist(id),
    ]);
    setCaseRecord(record);
    setChecklist(result.checklist || []);
  }

  async function ensureDraft() {
    if (!preview) throw new Error("The document checklist is unavailable until a signed-off policy is configured.");
    if (caseRecord) {
      const currentApplicability = JSON.stringify(caseRecord.applicability || {});
      const requestedApplicability = JSON.stringify(applicability);
      if (currentApplicability !== requestedApplicability) {
        const updated = await caseWorkflowApi.updateDraft(caseRecord._id, {
          expectedVersion: caseRecord.version,
          applicability,
        });
        setCaseRecord(updated);
        return updated;
      }
      return caseRecord;
    }
    const created = await caseWorkflowApi.createDraft({ applicationType, applicability });
    setCaseRecord(created);
    return created;
  }

  async function saveDraft() {
    if (!preview) return;
    setBusyAction("save-draft");
    setPageError("");
    setPageNotice("");
    try {
      const draft = await ensureDraft();
      await refreshCase(draft._id);
      setPageNotice(`Draft ${draft.caseNo} is saved. Upload the required documents when ready.`);
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusyAction("");
    }
  }

  async function uploadAndDetectDocuments() {
    if (!applicationType || busyAction === "detect-all") return;
    const filesToUpload = applicableSlots
      .filter((slot) => selectedFiles[slot.slotId])
      .map((slot) => ({ slot, file: selectedFiles[slot.slotId] }));
    const existingDocuments = applicableSlots.filter((slot) => slot.documentId);
    if (!filesToUpload.length && !existingDocuments.length) return;
    setBusyAction("detect-all");
    setAnalysisWait({
      phase: filesToUpload.length ? "uploading" : "analyzing",
      current: 0,
      total: filesToUpload.length || existingDocuments.length,
      fileName: filesToUpload[0]?.file.name || "",
    });
    setPageError("");
    setPageNotice("");
    try {
      const draft = await ensureDraft();
      for (const [index, { slot, file }] of filesToUpload.entries()) {
        setAnalysisWait({
          phase: "uploading",
          current: index + 1,
          total: filesToUpload.length,
          fileName: file.name,
        });
        const uploaded = await caseWorkflowApi.uploadDocument(draft._id, slot.slotId, file);
        if (!uploaded.document_id) {
          throw new Error(`${file.name} did not return a document reference. Refresh the case before retrying.`);
        }
        setSelectedFiles((current) => ({ ...current, [slot.slotId]: null }));
      }
      await refreshCase(draft._id);
      setAnalysisWait({
        phase: "analyzing",
        current: 0,
        total: existingDocuments.length + filesToUpload.length,
        fileName: "",
      });
      const batch = await caseWorkflowApi.analyzeCaseDocuments(draft._id);
      const total = batch.documents.length;
      setAnalysisWait({ phase: "analyzing", current: 0, total, fileName: "" });
      const results = await waitForDocumentBatch(batch.documents, {
        onProgress: ({ completed, document }) => setAnalysisWait({
          phase: "analyzing",
          current: completed,
          total,
          fileName: document.file_name || document.slot_id || "",
        }),
      });
      setExtractions((current) => {
        const next = { ...current };
        for (const { document, result } of results) next[document.document_id] = result;
        return next;
      });
      setFieldValues((current) => {
        const next = { ...current };
        for (const { document, result } of results) {
          for (const field of result.extraction?.fields || []) {
            const key = `${document.document_id}:${field.field_name}`;
            if (!Object.hasOwn(next, key)) next[key] = field.confirmed_value ?? (field.prefill ? field.ai_value : "");
          }
        }
        return next;
      });
      await refreshCase(draft._id);
      const failedDocuments = results.filter(({ result }) => result.document.status === "AI_FAILED");
      const findingCount = results.reduce((count, { result }) => count
        + (result.extraction?.rule_results_json || []).filter((rule) => rule?.passed === false).length, 0);
      setPageNotice(failedDocuments.length
        ? `Detection finished. ${failedDocuments.length} document${failedDocuments.length === 1 ? "" : "s"} could not be analyzed; enter the missing fields below.`
        : findingCount
          ? `Detection finished for ${results.length} documents. ${findingCount} AI finding${findingCount === 1 ? "" : "s"} need review below.`
          : `Detection finished for ${results.length} documents. Review the fields below and save each document once.`);
      setMessage(`Text detection finished for ${results.length} document${results.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusyAction("");
      setAnalysisWait(null);
    }
  }

  async function refreshChecklist() {
    if (!caseRecord) return;
    setBusyAction("refresh");
    setPageError("");
    try {
      await refreshCase();
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusyAction("");
    }
  }

  async function saveDocumentFields(documentId, fields) {
    setBusyAction(`save-fields:${documentId}`);
    setPageError("");
    try {
      const confirmedFields = fields.map((field) => ({
        field_name: field.field_name,
        confirmed_value: fieldValues[`${documentId}:${field.field_name}`] ?? field.confirmed_value ?? (field.prefill ? field.ai_value : ""),
      }));
      const resolved = fields
        .filter((field) => resolvedAmbiguities[`${documentId}:${field.field_name}`])
        .map((field) => field.field_name);
      const result = await caseWorkflowApi.confirmFields(documentId, confirmedFields, true, resolved, caseRecord?._id);
      setExtractions((current) => ({ ...current, [documentId]: result }));
      if (caseRecord) await refreshCase();
      setPageNotice("All fields for this document have been saved together.");
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusyAction("");
    }
  }

  async function submitCase() {
    setBusyAction("submit");
    setPageError("");
    setPageNotice("");
    try {
      const draft = await ensureDraft();
      let result;
      let refreshedAfterConflict = false;
      try {
        result = await caseWorkflowApi.submitCase(draft._id, draft.version);
      } catch (submitError) {
        if (!["VERSION_CONFLICT", "CASE_VERSION_CONFLICT"].includes(submitError.code)) throw submitError;
        const latest = await caseWorkflowApi.getCase(draft._id);
        const draftInputsUnchanged = latest.status === "draft"
          && latest.applicationType === draft.applicationType
          && JSON.stringify(latest.applicability || {}) === JSON.stringify(draft.applicability || {})
          && JSON.stringify(latest.route || []) === JSON.stringify(draft.route || []);
        if (!draftInputsUnchanged) throw submitError;
        setCaseRecord(latest);
        result = await caseWorkflowApi.submitCase(latest._id, latest.version);
        refreshedAfterConflict = true;
      }
      const notice = refreshedAfterConflict
        ? `Application ${result.case.caseNo} was submitted after refreshing its latest saved version.`
        : `Application ${result.case.caseNo} was submitted.`;
      setCaseRecord(null);
      setApplicationType("");
      setApplicability(defaultApplicability);
      setPreview(null);
      setChecklist([]);
      setSelectedFiles({});
      setExtractions({});
      setFieldValues({});
      setResolvedAmbiguities({});
      setLoadingPreview(false);
      setAnalysisWait(null);
      setPreviewDocument(null);
      setSearchParams({}, { replace: true });
      setPageNotice(notice);
      setMessage(`Application ${result.case.caseNo} submitted.`);
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusyAction("");
    }
  }

  function setAnswer(name, value) {
    setApplicability((current) => {
      const next = { ...current };
      next[name] = value === "yes";
      return next;
    });
  }

  const applicableSlots = checklist.filter((slot) => slot.required || slot.reviewRequired);
  const missingRequired = checklist.filter((slot) => slot.required && !["confirmed", "verified"].includes(slot.status));
  const selectedFileCount = applicableSlots.filter((slot) => selectedFiles[slot.slotId]).length;
  const attachedDocumentCount = applicableSlots.filter((slot) => slot.documentId).length;
  const requiredDocumentCount = checklist.filter((slot) => slot.required).length;
  const selectedOrUploadedRequiredCount = checklist.filter((slot) => slot.required
    && (slot.documentId || selectedFiles[slot.slotId])).length;
  const documentProgress = requiredDocumentCount
    ? Math.round((selectedOrUploadedRequiredCount / requiredDocumentCount) * 100)
    : 100;
  const applicabilityReviewCount = checklist.filter((slot) => slot.reviewRequired).length;
  const conditionQuestions = [
    ["landIsLeased", "Is the institution using leased land?"],
    ["newAreaAdded", "Is new land or area being added?"],
    ["buildingOver30", "Is the building more than 30 years old?"],
    ["claimsAccreditation", "Is accreditation being claimed?"],
    ["landChanged", "Has the land or ownership changed?"],
    ["premisesShared", "Are the premises shared?"],
    ["premisesUsed", "Are the premises already in use?"],
    ["affiliatingBodyRequired", "Is approval from an affiliating body required?"],
  ];

  return <div className="case-application-page">
    <div className="case-application-main">
      {pageError && <div className="alert alert-warning" role="alert"><AlertTriangle size={17} />{pageError}</div>}
      {pageNotice && <div className="alert alert-success" role="status"><CheckCircle2 size={17} />{pageNotice}</div>}
      <Card
        title="Choose your application"
        description="Select an application type to load its document checklist."
        action={caseRecord && <button className="button button-secondary button-small" onClick={() => {
          setCaseRecord(null);
          setApplicationType("");
          setApplicability(defaultApplicability);
          setPreview(null);
          setChecklist([]);
          setSelectedFiles({});
          setExtractions({});
          setFieldValues({});
          setResolvedAmbiguities({});
          setSearchParams({}, { replace: true });
          setPageNotice("Your saved draft remains available in the case register. You can start another application.");
        }}>Start another application</button>}
      >
        <label className="field-label application-type-field">Application type
          <select
            aria-label="Application type"
            value={applicationType}
            disabled={Boolean(caseRecord) || loadingDraft}
            onChange={(event) => {
              setApplicationType(event.target.value);
              setApplicability(defaultApplicability);
              setPreview(null);
              setChecklist([]);
              setSelectedFiles({});
              setExtractions({});
              setPageError("");
              setPageNotice("");
            }}
          >
            <option value="">Select an application type</option>
            {applicationTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </Card>

      {applicationType && <Card
        title="Application details"
        description="These answers determine which conditional documents apply."
        className="application-conditions-card"
      >
        <div className="application-condition-grid">
          {conditionQuestions.map(([name, label]) => (
            <label className="field-label" key={name}>
              {label}
              <select
                value={applicability[name] ? "yes" : "no"}
                onChange={(event) => setAnswer(name, event.target.value)}
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          ))}
        </div>
      </Card>}

      {applicationType && <Card
        title="Required documents"
        description={loadingPreview ? "Updating the checklist…" : `${applicableSlots.length} document slots are required or need applicability review.`}
        className="application-documents-panel"
        action={caseRecord && <button className="button button-secondary button-small" disabled={busyAction === "refresh"} onClick={refreshChecklist}><RefreshCw size={14} /> Refresh</button>}
      >
        <div className="application-document-summary">
          <div className="application-document-summary-copy">
            <span className="application-document-summary-icon"><FileCheck2 size={20} /></span>
            <div><strong>{selectedOrUploadedRequiredCount} of {requiredDocumentCount} required files selected or uploaded</strong><small>{applicabilityReviewCount ? `${applicabilityReviewCount} conditional document${applicabilityReviewCount === 1 ? "" : "s"} need an applicability answer.` : "Requirements are based on the selected application and your answers."}</small></div>
          </div>
          <div className="application-document-progress" role="progressbar" aria-label="Required documents selected or uploaded" aria-valuemin={0} aria-valuemax={100} aria-valuenow={documentProgress}><span style={{ width: `${documentProgress}%` }} /></div>
          <span className="application-document-progress-label">{documentProgress}%</span>
        </div>
        {pageError && !preview
          ? <div className="state-card state-error"><AlertTriangle size={22} /><h3>Checklist unavailable</h3><p>Document requirements cannot be shown until a signed-off policy is available.</p><button className="button button-secondary" disabled={loadingPreview} onClick={() => setApplicability((current) => ({ ...current }))}><RefreshCw size={15} /> Try again</button></div>
          : loadingPreview && !checklist.length
          ? <div className="loading-state" aria-label="Loading checklist"><i /><i /><i /></div>
          : applicableSlots.length
            ? <div className="case-document-scroll-region"><div className="case-document-list">{applicableSlots.map((slot) => {
              const documentId = slot.documentId;
              const selectedFile = selectedFiles[slot.slotId];
              const extractionResult = documentId ? extractions[documentId] : null;
              const extractedFields = extractionResult?.extraction?.fields || [];
              const failedRules = (extractionResult?.extraction?.rule_results_json || []).filter((rule) => rule?.passed === false);
              const saved = extractionResult?.document?.status === "CONFIRMED";
              const verification = extractionResult?.document?.verification;
              const documentStatus = extractionResult?.document?.status;
              const normalizedDocumentStatus = documentStatus || slot.status?.toUpperCase();
              const uploadStatus = selectedFile
                ? { label: "New file selected", variant: "warning" }
                : normalizedDocumentStatus === "QUARANTINED"
                  ? { label: "Quarantined", variant: "danger" }
                  : normalizedDocumentStatus === "AI_FAILED"
                    ? { label: "Analysis failed", variant: "danger" }
                    : normalizedDocumentStatus === "REJECTED"
                      ? { label: "Processing rejected", variant: "danger" }
                      : normalizedDocumentStatus === "PROCESSING"
                        ? { label: "Processing", variant: "info" }
                        : normalizedDocumentStatus === "AI_DONE"
                          ? { label: "Ready to confirm", variant: "warning" }
                          : normalizedDocumentStatus === "AWAITING_CONFIRMATION" || slot.status === "pending_confirmation"
                            ? { label: "Confirmation needed", variant: "warning" }
                            : normalizedDocumentStatus === "CONFIRMED" || slot.status === "confirmed" || slot.status === "verified"
                              ? { label: "Confirmed", variant: "success" }
                              : documentId || slot.status === "uploaded" || normalizedDocumentStatus === "UPLOADED"
                                ? { label: "Uploaded", variant: "info" }
                                : slot.reviewRequired
                                  ? { label: "Applicability review", variant: "review" }
                                  : { label: "Not uploaded", variant: "neutral" };
              const verificationStatus = documentId && !selectedFile
                ? verification === "verified" || slot.status === "verified"
                  ? { label: "Verified", variant: "success" }
                  : verification === "not_verified"
                    ? { label: "Not verified", variant: "danger" }
                    : { label: "Verification pending", variant: "warning" }
                : null;
              const suggestedType = extractionResult?.extraction?.m1_type;
              const suggestedTypeConfidence = Number(extractionResult?.extraction?.m1_confidence);
              return <article className="case-document-slot" key={slot.slotId}>
                <div className="case-document-slot-heading">
                  <div>
                    <h3>{slot.label}</h3>
                    <p>{slot.requirement === "R" ? "Required document" : slot.reviewRequired ? "Conditional — answer the application details to confirm if required" : "Required based on your answers"}</p>
                  </div>
                  <div className="case-document-statuses">
                    <Badge variant={uploadStatus.variant}>{uploadStatus.label}</Badge>
                    {verificationStatus && <Badge variant={verificationStatus.variant}>{verificationStatus.label}</Badge>}
                  </div>
                </div>
                {slot.helpText && <p className="case-slot-help">{slot.helpText}</p>}
                {suggestedType && <div className="case-ai-findings" role="status">
                  <strong>AI document type suggestion</strong>
                  <p>{suggestedType}{Number.isFinite(suggestedTypeConfidence) ? ` · ${Math.round(suggestedTypeConfidence * 100)}% confidence` : ""}. This suggestion does not choose the application route.</p>
                </div>}
                <div className="case-slot-upload">
                  <label className="button button-secondary button-small">
                    <UploadCloud size={15} /> Choose PDF or image
                    <input
                      type="file"
                      accept={slot.acceptedFileTypes?.join(",") || "application/pdf,image/jpeg,image/png"}
                      disabled={busyAction === "detect-all" || Boolean(caseRecord && !["draft", "returned"].includes(caseRecord.status))}
                      onChange={(event) => setSelectedFiles((current) => ({ ...current, [slot.slotId]: event.target.files?.[0] || null }))}
                    />
                  </label>
                  <span className="case-file-name">
                    {selectedFile?.name || (documentId ? extractionResult?.document?.original_name || "Document uploaded · choose a new file to replace it" : "PDF, JPG or PNG · up to 20 MB")}
                  </span>
                  <button
                    className="button button-secondary button-small case-document-view"
                    type="button"
                    disabled={!selectedFile && !documentId}
                    aria-label={`View ${slot.label}`}
                    onClick={() => setPreviewDocument({
                      file: selectedFile || null,
                      documentId: selectedFile ? null : documentId,
                      fileName: selectedFile?.name || extractionResult?.document?.original_name || slot.label,
                      mimeType: selectedFile?.type || extractionResult?.document?.mime || "",
                    })}
                  ><Eye size={14} /> View</button>
                </div>
                {documentId && <div className="case-document-review">
                  {extractionResult?.extraction && <>
                    {extractionResult.document?.status === "QUARANTINED" && <div className="case-ai-findings" role="alert">
                      <strong>Document quarantined</strong>
                      <p>{extractionResult.document.quarantine_reason || "This file did not pass the local safety checks. Upload a safe replacement."}</p>
                    </div>}
                    {extractionResult.document?.status === "AI_FAILED" && <div className="case-ai-findings" role="alert">
                      <strong>Text detection could not complete</strong>
                      <p>{extractionResult.extraction.processing_error_code || "Enter any fields that were not detected, then save them below."}</p>
                    </div>}
                    {failedRules.length > 0 && <div className="case-ai-findings" role="status">
                      <strong>AI validation findings</strong>
                      <ul>{failedRules.map((rule, index) => <li key={`${rule.ruleId || "rule"}-${index}`}>{rule.message || "A validation rule needs review."}</li>)}</ul>
                      <p>Review and correct the document information. AI findings do not automatically reject the application.</p>
                    </div>}
                    <div className="case-extraction-fields">
                      <p className="case-extraction-intro">Detected fields are suggestions. Fill any blank values, review the entries, then save all fields together.</p>
                      {extractedFields.map((field) => {
                      const valueKey = `${documentId}:${field.field_name}`;
                      const dateField = /(?:date|valid_from|valid_to|lease_start|lease_end)$/.test(field.field_name);
                      const dateChoices = field.ambiguous ? ambiguousDateChoices(field) : [];
                      const fieldLabel = {
                        issue_date: "Issue Date",
                        valid_from: "Valid From",
                        valid_to: "Valid To",
                        cert_no: "Certificate Number",
                        issuer: "Issuer",
                      }[field.field_name] || field.field_name.replaceAll("_", " ");
                      return <div className="case-extraction-field" key={field.field_name}>
                        <div><strong>{fieldLabel}</strong><small>
                          {field.ai_value ? `Detected: ${field.ai_value}` : "Not detected — enter a value if available"}
                          {field.source_text ? ` · Source: ${field.source_text}` : ""}
                          {field.ai_value ? ` · ${field.zone} review` : ""}
                          {field.ambiguous ? " · Ambiguous date: choose the intended interpretation" : ""}
                        </small></div>
                        {field.ambiguous && dateChoices.length
                          ? <select
                            aria-label={`Resolve ambiguous ${fieldLabel} for ${slot.label}`}
                            value={resolvedAmbiguities[valueKey] ? fieldValues[valueKey] ?? "" : ""}
                            disabled={saved}
                            onChange={(event) => {
                              setFieldValues((current) => ({ ...current, [valueKey]: event.target.value }));
                              setResolvedAmbiguities((current) => ({ ...current, [valueKey]: Boolean(event.target.value) }));
                            }}
                          >
                            <option value="">Choose the intended date</option>
                            {dateChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                          </select>
                          : <input
                            type={dateField ? "date" : "text"}
                            aria-label={`${fieldLabel} for ${slot.label}`}
                            value={fieldValues[valueKey] ?? field.confirmed_value ?? (field.prefill ? field.ai_value : "")}
                            disabled={saved}
                            onChange={(event) => setFieldValues((current) => ({ ...current, [valueKey]: event.target.value }))}
                          />}
                        {field.ambiguous && !dateChoices.length && <label className="field-label case-ambiguity-resolution">
                          <input
                            type="checkbox"
                            checked={Boolean(resolvedAmbiguities[valueKey])}
                            disabled={saved}
                            onChange={(event) => setResolvedAmbiguities((current) => ({ ...current, [valueKey]: event.target.checked }))}
                          />
                          I reviewed the source and selected the intended date
                        </label>}
                      </div>;
                      })}
                      <button
                        className="button button-secondary button-small case-save-fields"
                        disabled={!extractedFields.length || saved || busyAction === `save-fields:${documentId}`}
                        onClick={() => saveDocumentFields(documentId, extractedFields)}
                      >
                        {saved ? "All fields saved" : busyAction === `save-fields:${documentId}` ? "Saving fields…" : "Save all fields for this document"}
                      </button>
                    </div>
                    {extractionResult.extraction.extracted_lines?.length > 0 && <details className="case-ocr-text">
                      <summary>View detected text line by line ({extractionResult.extraction.extracted_lines.length} lines)</summary>
                      <ol>{extractionResult.extraction.extracted_lines.map((line, index) => <li key={`${documentId}-line-${index}`}>{line}</li>)}</ol>
                    </details>}
                  </>}
                </div>}
              </article>;
            })}</div></div>
            : <div className="state-card"><FileText size={22} /><h3>No required document slots</h3><p>Based on the answers provided, this application has no documents to upload.</p></div>}
        {applicableSlots.length > 0 && <div className="case-detect-all">
          <div>
            <strong>Upload and detect every selected document together</strong>
            <span>
              {selectedFileCount
                ? `${selectedFileCount} selected file${selectedFileCount === 1 ? "" : "s"} · ${attachedDocumentCount} already uploaded`
                : `${attachedDocumentCount} uploaded document${attachedDocumentCount === 1 ? "" : "s"} ready for detection`}
              {" · "}Processing runs one document at a time; this may take a few minutes.
            </span>
          </div>
          <button
            className="button button-primary"
            disabled={busyAction === "detect-all" || (!selectedFileCount && !attachedDocumentCount) || Boolean(caseRecord && !["draft", "returned"].includes(caseRecord.status))}
            onClick={uploadAndDetectDocuments}
          >
            {busyAction === "detect-all"
              ? "Processing all documents…"
              : selectedFileCount ? "Upload & detect text for all documents" : "Detect text for all documents"}
          </button>
        </div>}
        {caseRecord
          ? <div className="case-submit-bar">
            <div>
              <strong>Draft {caseRecord.caseNo}</strong>
              <span>{missingRequired.length
                ? `${missingRequired.length} required document${missingRequired.length === 1 ? "" : "s"} are missing or still need confirmation. The active policy determines whether submission is allowed.`
                : "All required documents are confirmed."}</span>
            </div>
            <button className="button button-primary" disabled={busyAction === "submit" || !["draft", "returned"].includes(caseRecord.status)} onClick={submitCase}>
              {busyAction === "submit" ? "Submitting…" : "Submit application"}
            </button>
          </div>
          : <div className="case-submit-bar">
            <div><strong>Start an application draft</strong><span>Your draft is saved before any document is uploaded.</span></div>
            <button className="button button-primary" disabled={busyAction === "save-draft" || !preview} onClick={saveDraft}>
              {busyAction === "save-draft" ? "Saving…" : "Save draft"}
            </button>
          </div>}
      </Card>}
    </div>
    {analysisWait && <div className="case-analysis-backdrop" role="dialog" aria-modal="true" aria-labelledby="case-analysis-title" aria-describedby="case-analysis-description">
      <div className="case-analysis-dialog">
        <RefreshCw className="case-analysis-spinner" size={36} aria-hidden="true" />
        <h2 id="case-analysis-title">{analysisWait.phase === "uploading" ? "Uploading selected documents" : "Detecting text in all documents"}</h2>
        <p id="case-analysis-description">{analysisWait.phase === "uploading"
          ? "Your selected files are being securely uploaded before the batch starts."
          : "Documents are being read one at a time, line by line. Please stay on this page while fields are extracted."}</p>
        <strong className="case-analysis-filename">
          {analysisWait.fileName || `${analysisWait.current} of ${analysisWait.total} documents processed`}
        </strong>
        <progress className="case-analysis-progress" value={analysisWait.current} max={Math.max(analysisWait.total, 1)} />
        <small>{analysisWait.phase === "uploading"
          ? `Uploading ${analysisWait.current} of ${analysisWait.total}`
          : `Analyzed ${analysisWait.current} of ${analysisWait.total}`}</small>
        <span className="screen-reader-live" role="status" aria-live="polite">
          {analysisWait.phase === "uploading" ? "Uploading document" : "Document analysis in progress"}
        </span>
      </div>
    </div>}
    {previewDocument && <DocumentPreviewDialog document={previewDocument} onClose={() => setPreviewDocument(null)} />}
  </div>;
}

const caseStageLabels = {
  submitted: "Submitted",
  self_disclosure: "Self-disclosure",
  scrutiny: "Scrutiny",
  re_scrutiny: "Re-Scrutiny",
  regional_committee: "Regional Committee",
  evc: "EVC",
  shc: "SHC",
  sac: "SAC",
  decision: "Decision",
};

const caseStatusLabels = {
  draft: "Draft",
  submitted: "Submitted",
  in_progress: "In progress",
  returned: "Action required",
  approved: "Approved",
  rejected: "Rejected",
};

function CaseList() {
  const role = useAppStore((state) => state.role);
  const [cases, setCases] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const pageSize = 8;

  useEffect(() => {
    let active = true;
    async function loadCases() {
      try {
        const records = [];
        for (let page = 1; ; page += 1) {
          const batch = await caseWorkflowApi.listCases({ page, pageSize: 100 });
          if (!Array.isArray(batch)) throw new Error("The case register returned an invalid response.");
          records.push(...batch);
          if (batch.length < 100) break;
        }
        if (active) setCases(records.map((record) => {
          const currentStage = record.allocatedStages?.[record.currentStageIndex];
          return {
            id: record.caseNo,
            caseId: record._id,
            institution: record.institutionId?.name || "Institution",
            type: applicationTypeLabels[record.applicationType] || record.applicationType,
            stage: caseStageLabels[record.currentStage] || record.currentStage,
            stageStatus: currentStage?.status || "",
            status: caseStatusLabels[record.status] || record.status,
            updatedAt: record.updatedAt,
          };
        }));
      } catch (loadError) {
        if (active) setError(loadError.message || "Could not load applications.");
      }
    }
    loadCases();
    return () => { active = false; };
  }, [reloadKey]);

  const visibleCases = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (cases || []).filter((item) => {
      const matchesSearch = !query || [item.id, item.institution, item.type]
        .some((value) => value?.toLocaleLowerCase().includes(query));
      return matchesSearch
        && (typeFilter === "all" || item.type === typeFilter)
        && (stageFilter === "all" || item.stage === stageFilter)
        && (statusFilter === "all" || item.status === statusFilter);
    });
  }, [cases, search, typeFilter, stageFilter, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(visibleCases.length / pageSize));
  const pageCases = visibleCases.slice((page - 1) * pageSize, page * pageSize);
  const summary = useMemo(() => ({
    total: (cases || []).length,
    inProgress: (cases || []).filter((item) => item.status === "In progress").length,
    drafts: (cases || []).filter((item) => item.status === "Draft").length,
    submitted: (cases || []).filter((item) => item.status === "Submitted").length,
    actionRequired: (cases || []).filter((item) => item.status === "Action required").length,
  }), [cases]);
  const applicationTypes = [...new Set((cases || []).map((item) => item.type))].sort();
  const stages = [...new Set((cases || []).map((item) => item.stage).filter(Boolean))].sort();

  function updateFilter(setter, value) {
    setter(value);
    setPage(1);
  }

  if (cases === null) {
    return error
      ? <Card title="Applications unavailable"><p className="muted">{error}</p><button className="button button-secondary" onClick={() => { setError(""); setCases(null); setReloadKey((key) => key + 1); }}>Retry</button></Card>
      : <Card title="Your applications"><div className="loading-state" aria-label="Loading applications"><i /><i /><i /></div></Card>;
  }

  const cards = [
    { label: "Total applications", value: summary.total, icon: FileText, tone: "blue" },
    { label: "In progress", value: summary.inProgress, icon: Clock3, tone: "blue" },
    { label: "Draft", value: summary.drafts, icon: FileText, tone: "amber" },
    { label: "Submitted", value: summary.submitted, icon: CheckCircle2, tone: "green" },
    { label: "Action required", value: summary.actionRequired, icon: AlertTriangle, tone: "red" },
  ];

  return <section className="cases-workspace">
    <div className="cases-summary-grid" aria-label="Application summary">
      {cards.map(({ label, value, icon: Icon, tone }) => <article className={`cases-summary-card cases-summary-${tone}`} key={label}>
        <span className="cases-summary-icon"><Icon size={20} aria-hidden="true" /></span>
        <div><strong>{value}</strong><span>{label}</span></div>
      </article>)}
    </div>
    <section className="cases-register-card">
      <header className="cases-register-heading">
        <div><h2>{role === "Institution user" ? "Your applications" : "Cases"}</h2><p>{role === "Institution user" ? "Open applications and returned applications that need your response." : "Applications assigned to your active stage, including frozen stages awaiting assistance."}</p></div>
        {role === "Institution user" && <Link className="button button-primary cases-new-application" to="/applications/new"><Plus size={16} /> New application</Link>}
      </header>
      <div className="cases-register-filters">
        <label className="cases-search-field"><Search size={16} /><input aria-label="Search applications" placeholder="Search by Case ID, institution name or application type…" value={search} onChange={(event) => updateFilter(setSearch, event.target.value)} /></label>
        <label className="screen-reader-only" htmlFor="cases-type-filter">Application type</label>
        <select id="cases-type-filter" value={typeFilter} onChange={(event) => updateFilter(setTypeFilter, event.target.value)}><option value="all">All application types</option>{applicationTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select>
        <label className="screen-reader-only" htmlFor="cases-stage-filter">Application stage</label>
        <select id="cases-stage-filter" value={stageFilter} onChange={(event) => updateFilter(setStageFilter, event.target.value)}><option value="all">All stages</option>{stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select>
        <label className="screen-reader-only" htmlFor="cases-status-filter">Application status</label>
        <select id="cases-status-filter" value={statusFilter} onChange={(event) => updateFilter(setStatusFilter, event.target.value)}><option value="all">All statuses</option>{[...new Set(cases.map((item) => item.status))].sort().map((status) => <option key={status} value={status}>{status}</option>)}</select>
      </div>
      {cases.length
        ? <>
          <div className="cases-table-scroll">
            <table className="cases-table">
              <thead><tr><th scope="col">#</th><th scope="col">Case ID</th><th scope="col">Application type</th><th scope="col">Current stage</th><th scope="col">Status</th><th scope="col">Last updated</th><th scope="col"><span className="screen-reader-only">Actions</span></th></tr></thead>
              <tbody>{pageCases.length ? pageCases.map((item, index) => {
                const statusVariant = item.status === "Rejected" ? "danger" : item.status === "Approved" ? "success" : item.status === "Action required" ? "warning" : item.status === "Draft" ? "neutral" : "info";
                const updated = item.updatedAt ? new Date(item.updatedAt) : null;
                return <tr key={item.caseId}>
                  <td className="cases-row-number">{(page - 1) * pageSize + index + 1}</td>
                  <td><div className="cases-id-cell"><Link to={`/case/${item.caseId}`}>{item.id}</Link><small>{item.institution}</small></div></td>
                  <td><span className="cases-type-pill">{item.type}</span></td>
                  <td>{item.stageStatus === "FROZEN_WAITING_FOR_ASSIST"
                    ? <span className="cases-stage-frozen">{item.stage}<small>Assistance requested</small></span>
                    : item.stage || "—"}</td>
                  <td><Badge variant={statusVariant}>{item.status}</Badge></td>
                  <td>{updated && !Number.isNaN(updated.getTime()) ? <time dateTime={updated.toISOString()} className="cases-updated"><span>{updated.toLocaleDateString()}</span><small>{updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></time> : "—"}</td>
                  <td><Link className="button button-secondary button-small cases-view-button" to={`/case/${item.caseId}`}><Eye size={14} /> View</Link></td>
                </tr>;
              }) : <tr><td className="cases-empty-row" colSpan={7}>No applications match these filters.</td></tr>}</tbody>
            </table>
          </div>
          <footer className="cases-table-footer">
            <span>{visibleCases.length ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, visibleCases.length)} of ${visibleCases.length} applications` : "Showing 0 applications"}</span>
            <div className="cases-pagination" aria-label="Application pages">
              <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button>
              {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => <button type="button" aria-label={`Page ${pageNumber}`} aria-current={pageNumber === page ? "page" : undefined} className={pageNumber === page ? "active" : ""} key={pageNumber} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}
              <button type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>›</button>
            </div>
          </footer>
        </>
        : <div className="state-card cases-empty-state"><FileText size={24} /><h3>{role === "Institution user" ? "No applications yet" : "No cases available"}</h3><p>{role === "Institution user" ? "Your institution’s applications will appear here after you save an application draft." : "Applications assigned to your active stage will appear here."}</p>{role === "Institution user" && <Link className="button button-primary" to="/applications/new">Start an application</Link>}</div>}
    </section>
  </section>;
}

function Documents({ data, aiEnabled, setMessage, onLeaseConfirm }) {
  const [type, setType] = useState("All");
  const [documentType, setDocumentType] = useState("Fire safety certificate");
  const [uploaded, setUploaded] = useState(false);
  const [confirmedFields, setConfirmedFields] = useState([]);
  const [manualValues, setManualValues] = useState({
    documentType: "Fire safety certificate",
    issueDate: "2026-03-14",
    validTo: "",
    certificateNumber: "FS-2026-1182",
    issuer: "Fire and Emergency Services",
  });
  const [ambiguousChoice, setAmbiguousChoice] = useState("");
  const requiredFields = ["documentType", "issueDate", "validTo", "certificateNumber", "issuer"];
  const confirmed = aiEnabled && documentType !== "Blurred fire certificate"
    ? requiredFields.every((field) => confirmedFields.includes(field))
    : confirmedFields.includes("manual") && requiredFields.every((field) => manualValues[field].trim());
  const markConfirmed = (field) => setConfirmedFields((current) => current.includes(field) ? current : [...current, field]);
  const updateManualValue = (field, value) => {
    setManualValues((current) => ({ ...current, [field]: value }));
    setConfirmedFields((current) => current.filter((confirmedField) => confirmedField !== field && confirmedField !== "manual"));
  };
  const resetReview = (nextDocumentType = "Fire safety certificate") => {
    setDocumentType(nextDocumentType);
    setUploaded(false);
    setConfirmedFields([]);
    setAmbiguousChoice("");
    setManualValues({
      documentType: nextDocumentType,
      issueDate: nextDocumentType === "Blurred fire certificate" ? "" : "2026-03-14",
      validTo: "",
      certificateNumber: nextDocumentType === "Blurred fire certificate" ? "" : "FS-2026-1182",
      issuer: nextDocumentType === "Blurred fire certificate" ? "" : "Fire and Emergency Services",
    });
  };
  const [leaseConfirm, setLeaseConfirm] = useState(false);
  const docs = data.documents.filter((document) => type === "All" || document.type === type);
  return <div className="documents-layout"><div><Card title="Documents and validity" description="Institution submission and official verification are distinct states." action={<Link className="button button-primary" to="/document-review"><Plus size={15} /> Upload renewal</Link>}><div className="filter-bar"><select value={type} onChange={(event) => setType(event.target.value)} aria-label="Document type filter"><option>All</option>{[...new Set(data.documents.map((item) => item.type))].map((item) => <option key={item}>{item}</option>)}</select><span className="muted">{docs.length} records</span></div><div className="document-list">{docs.map((doc) => <article className="document-row" key={doc.id}><span className="file-icon"><FileText size={18} /></span><div className="document-name"><strong>{doc.type}</strong><small className="mono">{doc.name} · {doc.id}</small></div><div><small className="muted">Valid to</small><strong>{doc.validTo}</strong></div><Badge variant={doc.verification === "Verified" ? "success" : "warning"}>{doc.verification}</Badge>{doc.aiFlag ? <><Badge variant="review">Under review</Badge><button className="text-link" onClick={() => setLeaseConfirm(true)}>Review flag</button></> : <button className="button button-secondary button-small" onClick={() => resetReview(doc.type)}>View record</button>}</article>)}</div></Card></div><aside><Card title="AI document review" description="Nothing counts until you confirm. A verifier will still verify separately."><div className="doc-preview">{uploaded ? <div className={`fake-document ${documentType.toLowerCase().includes("fire") ? "blurred" : ""}`}><span className="doc-seal"><ShieldCheck /></span><strong>{documentType}</strong><small>DEMO CERTIFICATE · SAMPLE</small><div className="highlight-box highlight-one">Valid to: 14 March 2027</div><div className="highlight-box highlight-two">Certificate No. FS-2026-1182</div>{documentType.toLowerCase().includes("fire") && <em>Blurred certificate sample</em>}</div> : <div className="preview-empty"><FileText size={32} /><p>Select an uploaded file to review</p><FileDropzone onFile={(file) => { if (file) { resetReview(file.name.toLowerCase().includes("blur") ? "Blurred fire certificate" : "Fire safety certificate"); setUploaded(true); } }} /><button className="button button-secondary button-small" onClick={() => { resetReview("Blurred fire certificate"); setUploaded(true); }}>Use blurred certificate sample</button></div>}</div>  {uploaded && <div className="ai-fields">{!aiEnabled && <div className="note info-note"><InfoIcon />AI service unavailable. Enter values manually.</div>}{aiEnabled && documentType !== "Blurred fire certificate" ? <><AIFieldRow label="Document type" value={documentType} confidence={.96} model={MODEL} onConfirm={() => markConfirmed("documentType")} /><AIFieldRow label="Valid-to date" value={ambiguousChoice ? (ambiguousChoice === "04-05" ? "4 May 2027" : "5 April 2027") : "04/05/2027"} confidence={ambiguousChoice ? .78 : .42} model={MODEL} onConfirm={() => { updateManualValue("validTo", ambiguousChoice === "04-05" ? "2027-05-04" : "2027-04-05"); markConfirmed("validTo"); }} /><label className="field-label">Issue date<input type="date" value={manualValues.issueDate} onChange={(event) => updateManualValue("issueDate", event.target.value)} /></label><AIFieldRow label="Issue date confirmation" value={manualValues.issueDate || "14 March 2026"} confidence={.78} model={MODEL} onConfirm={() => markConfirmed("issueDate")} /><label className="field-label">Certificate or application number<input value={manualValues.certificateNumber} onChange={(event) => updateManualValue("certificateNumber", event.target.value)} /></label><AIFieldRow label="Certificate number confirmation" value={manualValues.certificateNumber || "FS-2026-1182"} confidence={.96} model={MODEL} onConfirm={() => markConfirmed("certificateNumber")} /><label className="field-label">Issuer<input value={manualValues.issuer} onChange={(event) => updateManualValue("issuer", event.target.value)} /></label><AIFieldRow label="Issuer confirmation" value={manualValues.issuer || "Fire and Emergency Services"} confidence={.78} model={MODEL} onConfirm={() => markConfirmed("issuer")} /><div className="note warning-note"><AlertTriangle size={16} />Ambiguous date, please choose: 04/05/2027. The date has not been parsed.</div><label className="field-label">Choose the intended date<select value={ambiguousChoice} onChange={(event) => { setAmbiguousChoice(event.target.value); setConfirmedFields((current) => current.filter((field) => field !== "validTo")); }}><option value="">Choose a date interpretation</option><option value="04-05">4 May 2027</option><option value="05-04">5 April 2027</option></select></label></> : <><label className="field-label">Document type<select value={manualValues.documentType} onChange={(event) => updateManualValue("documentType", event.target.value)}><option>Fire safety certificate</option><option>Structural stability certificate</option><option>Occupancy certificate</option><option>NBA letter</option></select></label><label className="field-label">Issue date<input type="date" value={manualValues.issueDate} onChange={(event) => updateManualValue("issueDate", event.target.value)} /></label><label className="field-label">Valid-to date<input type="date" value={manualValues.validTo} onChange={(event) => updateManualValue("validTo", event.target.value)} /></label><label className="field-label">Certificate or application number<input value={manualValues.certificateNumber} onChange={(event) => updateManualValue("certificateNumber", event.target.value)} /></label><label className="field-label">Issuer<input value={manualValues.issuer} onChange={(event) => updateManualValue("issuer", event.target.value)} /></label>{documentType === "Blurred fire certificate" && <div className="note warning-note"><AlertTriangle size={16} />The certificate is blurred. Extracted values are blank. Enter and confirm values manually.</div>}<label className="check-inline"><input type="checkbox" checked={confirmedFields.includes("manual")} onChange={(event) => event.target.checked ? markConfirmed("manual") : setConfirmedFields((current) => current.filter((field) => field !== "manual"))} /> I confirm the values entered manually.</label></>}</div>}<div className="form-footer"><button className="button button-secondary" onClick={() => resetReview(documentType)}>Clear AI values</button><button className="button button-secondary" onClick={() => setMessage("Draft saved for this document review.")}>Save draft</button><button className="button button-primary" disabled={!confirmed} onClick={() => { const typeLabel = aiEnabled && documentType !== "Blurred fire certificate" ? documentType : manualValues.documentType; const validTo = manualValues.validTo || (ambiguousChoice === "04-05" ? "2027-05-04" : ambiguousChoice === "05-04" ? "2027-04-05" : "2027-03-14"); const [year, month, day] = validTo.split("-").map(Number); const formattedDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(new Date(year, month - 1, day)); setMessage(`Clock started for ${typeLabel}, valid to ${formattedDate}.`); setConfirmedFields([]); }}>Confirm values and start clock</button></div><p className="muted">The clock starts only after a person confirms all required values.</p><div className="note warning-note"><AlertTriangle size={16} />Suspicious file demo: suspicious_application.exe is quarantined. No processing was attempted.</div></Card><Card title="Lease arithmetic" description="Under review"><p>Lease start <strong>01 April 2024</strong></p><p>Lease end <strong>31 March 2029</strong></p><p>Lease term <strong>5 years</strong></p><Badge variant="review">Under review</Badge><p className="muted">Not counted until an authorised official confirms.</p><button className="button button-secondary" onClick={() => setLeaseConfirm(true)}>Authorised confirmation</button></Card></aside><ConfirmDialog open={leaseConfirm} onOpenChange={setLeaseConfirm} title="Confirm lease flag" description="This will deduct 10 points from the institution's score." onConfirm={() => { onLeaseConfirm(); setLeaseConfirm(false); setMessage("Lease flag confirmed. 10 points deducted from the Action Score."); }} /></div>;
}

function Notifications({ data, setMessage }) {
  const acknowledge = useAppStore((state) => state.acknowledge);
  const notifications = useAppStore((state) => state.notifications);
  const [filter, setFilter] = useState("All");
  const [selected, setSelected] = useState([]);
  const items = notifications.length ? notifications : data.notifications;
  const visible = items.filter((item) => filter === "All" || item.level === filter);
  return <><div className="notification-summary"><StatCard label="Unread alerts" value={data.notifications.filter((item) => !item.acknowledged).length} note="Across all obligations" icon={Bell} /><StatCard label="Overdue" value={data.notifications.filter((item) => item.level === "Overdue").length} note="Review required" icon={AlertTriangle} /><StatCard label="Escalated" value={data.notifications.filter((item) => item.level === "Escalation").length} note="Officer-held" icon={Activity} /></div><Card title="Obligation notifications" description="Acknowledging does not fulfil the obligation."><div className="filter-bar"><div className="tabs-list inline-tabs">{["All", "Reminder", "Due", "Overdue", "Escalation"].map((item) => <button className={`tab-trigger ${filter === item ? "active" : ""}`} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div><select aria-label="Obligation type"><option>All obligation types</option><option>Document validity</option><option>Undertakings</option><option>Case stage</option></select><button className="button button-secondary button-small" onClick={() => { selected.forEach(acknowledge); setMessage("Acknowledged. The obligation is still open."); }}>Acknowledge selected ({selected.length})</button></div><div className="notification-list">{visible.map((item) => <article className="notification-item" key={item.id}><input type="checkbox" aria-label={`Select ${item.obligation}`} checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><Badge variant={item.level === "Overdue" || item.level === "Escalation" ? "danger" : "warning"}>{item.level}</Badge><div className="notification-copy"><strong>{item.obligation}</strong><small>{item.recipient} · {item.channel} · Deadline {item.dueDate}</small><small className="warning-copy">Acknowledging does not fulfil the obligation.</small></div><button className="button button-secondary button-small" disabled={item.acknowledged} onClick={() => { acknowledge(item.id); setMessage("Acknowledged. The obligation is still open."); }}>Acknowledge</button></article>)}</div></Card></>;
}

function Queue({ data }) {
  const groups = [["1. Overdue tasks and unresolved escalations", (item) => item.status === "Overdue"], ["2. Unfinished work due within 24 hours", (item) => item.status === "Awaiting decision"], ["3. Ready work outside urgent windows", (item) => ["Submitted", "In review"].includes(item.status)], ["4. Upcoming reminder-window work", (item) => ["Queued", "Scheduled"].includes(item.status)]];
  const officerWork = data.cases.filter((item) => item.holder !== "Institution");
  return <><div className="stat-grid"><StatCard label="Overdue" value="3" note="Includes unresolved escalation" icon={AlertTriangle} /><StatCard label="Due in 24 hours" value="5" note="Officer-held tasks" icon={Clock3} /><StatCard label="Ready" value="12" note="Outside urgent windows" icon={CheckCircle2} /><StatCard label="Upcoming" value="8" note="Reminder window" icon={Bell} /></div><div className="filter-bar"><div className="tabs-list inline-tabs"><button className="tab-trigger active">My queue</button><button className="tab-trigger">Supervisor queue · 4 unassigned</button></div><select aria-label="Filter region"><option>All regions</option><option>South</option><option>North</option></select><select aria-label="Filter stage"><option>All stages</option>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></div>{groups.map(([heading, predicate]) => <Card className="queue-group" key={heading} title={heading}><div className="queue-list">{officerWork.filter(predicate).slice(0, 5).map((item) => <div className="queue-row" key={item.id}><span className="queue-priority"><AlertTriangle size={16} /></span><div className="queue-main"><Link to={`/case/${item.id}`} className="text-link mono">{item.id}</Link><strong>{item.institution}</strong><small>{item.stage} · {item.institutionDays + item.officerDays} days in stage · {item.holder}</small></div><Badge variant={item.status === "Overdue" ? "danger" : "info"}>{item.status}</Badge><Link className="button button-secondary button-small" to={`/case/${item.id}`}>Review</Link></div>)}</div></Card>)}<details className="institution-rollup"><summary>Institution-held roll-up · 7 items</summary><p>Items requiring institution action are not included in your officer queue.</p></details></>;
}

function CaseControl() {
  const { caseId } = useParams();
  const role = useAppStore((state) => state.role);
  const user = useAppStore((state) => state.user);
  const backendRole = useAppStore((state) => state.user?.role);
  const [record, setRecord] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [processing, setProcessing] = useState(null);
  const [fieldValues, setFieldValues] = useState({});
  const [resolvedAmbiguities, setResolvedAmbiguities] = useState({});
  const [stageChecks, setStageChecks] = useState([]);
  const [verificationReasons, setVerificationReasons] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [savingDocument, setSavingDocument] = useState("");
  const [savingVerification, setSavingVerification] = useState("");
  const [sourcePreviewField, setSourcePreviewField] = useState(null);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(true);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [caseHistory, setCaseHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const canEdit = role === "Institution user";

  useEffect(() => {
    let active = true;
    async function loadCase() {
      try {
        setError("");
        const [caseResult, documentResults, processingResult] = await Promise.all([
          caseWorkflowApi.getCase(caseId),
          caseWorkflowApi.getCaseDocuments(caseId),
          caseWorkflowApi.getCaseProcessing(caseId),
        ]);
        if (!Array.isArray(documentResults)) throw new Error("Case documents could not be loaded.");
        if (!active) return;
        setRecord(caseResult);
        const processingRuns = new Map((processingResult?.documents || []).map((document) => [
          String(document._id),
          document.processingRun || null,
        ]));
        setDocuments(documentResults.map((document) => ({
          ...document,
          processingRun: processingRuns.get(String(document._id)),
        })));
        setSelectedDocumentId((current) => documentResults.some((document) => String(document._id) === current)
          ? current
          : String(documentResults[0]?._id || ""));
        const firstEvidence = documentResults.flatMap((document) => (document.extraction?.fields || [])
          .filter((field) => field.source_bbox?.length === 4)
          .map((field) => ({ documentId: document._id, source_page: field.source_page || 1, source_bbox: field.source_bbox, confidence: field.ai_confidence })))[0];
        setSourcePreviewField(firstEvidence || null);
        setProcessing(processingResult);
        setFieldValues((current) => {
          const next = { ...current };
          for (const document of documentResults) {
            for (const field of document.extraction?.fields || []) {
              const key = `${document._id}:${field.field_name}`;
              if (!Object.hasOwn(next, key)) next[key] = field.confirmed_value ?? (field.prefill ? field.ai_value : "") ?? "";
            }
          }
          return next;
        });
      } catch (loadError) {
        if (active) setError(loadError.message || "The case could not be loaded.");
      }
    }
    loadCase();
    return () => { active = false; };
  }, [caseId, reloadKey]);

  useEffect(() => caseWorkflowApi.subscribeToCaseEvents(() => {
    setReloadKey((key) => key + 1);
  }), [caseId]);

  if (!record) {
    return error
      ? <Card title="Case unavailable"><p className="muted">{error}</p><Link className="button button-secondary" to="/cases">Return to cases</Link></Card>
      : <Card title="Loading case"><div className="loading-state" aria-label="Loading case"><i /><i /></div></Card>;
  }

  const editable = canEdit && ["draft", "returned"].includes(record.status);
  const activeStage = record.allocatedStages?.[record.currentStageIndex];
  const canOverrideConfirmedFields = Boolean(record.workflowVersion
    && activeStage
    && activeStage.status !== "FROZEN_WAITING_FOR_ASSIST"
    && (activeStage.assignedRole === backendRole
      || activeStage.assignedRole === "EVC" && backendRole === "EVC_CHAIRMAN")
    && (
      !activeStage.assignedUserId
      || String(activeStage.assignedUserId) === String(user?.id || user?._id)
      || activeStage.assignedRole === "EVC"
        && activeStage.assignedPanelUserIds?.some((id) => String(id) === String(user?.id || user?._id))
    ));
  const route = record.route.map((stage) => caseStageLabels[stage] || stage);
  const currentStage = record.status === "draft" ? "Draft" : caseStageLabels[record.currentStage] || record.currentStage;
  const currentHolder = record.holderType === "institution" ? "Institution" : record.holderType === "committee" ? "Committee" : "Officer";
  const labelBySlot = new Map((record.checklist || []).map((slot) => [slot.slotId, slot.label]));
  const missingRequired = (record.checklist || []).filter((slot) => slot.required && ["missing", "quarantined"].includes(slot.status));
  const isCurrentHolder = role === "Admin"
    || (role === "Institution user" && record.holderType === "institution" && String(record.institutionId) === String(user?.institution_id))
    || (record.holderId && String(record.holderId) === String(user?._id));
  const canVerifyDocuments = role === "Admin" || (role === "Scrutiny / Regional officer" && isCurrentHolder);

  async function submitDraft() {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const result = await caseWorkflowApi.submitCase(record._id, record.version);
      setRecord({ ...result.case, checklist: result.checklist || [] });
      setReloadKey((key) => key + 1);
      setNotice(result.warning || `Application ${result.case.caseNo} was submitted.`);
    } catch (submitError) {
      setError(submitError.message || "The application could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  async function resubmitReturnedCase() {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const result = await caseWorkflowApi.resubmitCase(record._id, record.version);
      setNotice(`Application ${result.case.caseNo} was resubmitted for re-scrutiny.`);
      setReloadKey((key) => key + 1);
    } catch (submitError) {
      setError(submitError.message || "The returned application could not be resubmitted.");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveFields(document, fieldNames, valueOverrides) {
    setSavingDocument(document._id);
    setError("");
    try {
      const fields = (document.extraction?.fields || [])
        .filter((field) => !fieldNames || fieldNames.includes(field.field_name))
        .map((field) => ({
          field_name: field.field_name,
          confirmed_value: valueOverrides && Object.hasOwn(valueOverrides, field.field_name)
            ? valueOverrides[field.field_name]
            : fieldValues[`${document._id}:${field.field_name}`] ?? field.confirmed_value ?? (field.prefill ? field.ai_value : "") ?? "",
        }));
      if (!fields.length) throw new Error("No extracted fields are available to confirm.");
      await caseWorkflowApi.confirmFields(document._id, fields, document.status === "AI_FAILED", resolvedAmbiguities[document._id] || [], record._id);
      setReloadKey((key) => key + 1);
      return true;
    } catch (saveError) {
      setError(saveError.message || "Document fields could not be saved.");
      return false;
    } finally {
      setSavingDocument("");
    }
  }

  async function advanceStage() {
    setSubmitting(true);
    setError("");
    try {
      await caseWorkflowApi.advanceCase(record._id, { expectedVersion: record.version, completedChecklist: stageChecks });
      setNotice("Stage checklist completed and the case route was advanced.");
      setStageChecks([]);
      setReloadKey((key) => key + 1);
    } catch (advanceError) {
      setError(advanceError.message || "The case could not be advanced.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyDocument(document, verification) {
    setSavingVerification(document._id);
    setError("");
    try {
      await caseWorkflowApi.verifyDocument(document._id, {
        verification,
        reason: verificationReasons[document._id] || "",
      });
      setNotice(verification === "verified" ? "Document verified." : "Document marked not verified; the reason was recorded.");
      setReloadKey((key) => key + 1);
    } catch (verifyError) {
      setError(verifyError.message || "Document verification could not be saved.");
    } finally {
      setSavingVerification("");
    }
  }

  async function uploadEvcReport(file) {
    if (!file) return;
    setSubmitting(true);
    setError("");
    try {
      await caseWorkflowApi.uploadEvcReport(record._id, file);
      setNotice("EVC report uploaded. The case is advancing to its next configured stage.");
      setReloadKey((key) => key + 1);
    } catch (uploadError) {
      setError(uploadError.message || "The EVC report could not be uploaded.");
    } finally {
      setSubmitting(false);
    }
  }

  async function openCaseHistory() {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const entries = await caseWorkflowApi.getCaseHistory(record._id);
      if (!Array.isArray(entries)) throw new Error("Case history could not be read.");
      setCaseHistory(entries);
    } catch (historyLoadError) {
      setHistoryError(historyLoadError.message || "Case history could not be loaded.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function downloadCaseReport() {
    const csvValue = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [
      ["Section", "Field", "Value"],
      ["Case", "Case number", record.caseNo],
      ["Case", "Application type", applicationTypeLabels[record.applicationType] || record.applicationType],
      ["Case", "Status", caseStatusLabels[record.status] || record.status],
      ["Case", "Current stage", currentStage],
      ["Case", "Current holder", currentHolder],
      ["Case", "Policy version", record.policyVersion],
      ["Case", "Version", record.version],
      ...((record.allocatedStages || []).map((stage, index) => [
        "Route",
        `Stage ${index + 1}: ${stage.name}`,
        `${stage.status}${stage.stageStartedAt ? `; started ${stage.stageStartedAt}` : ""}${stage.stageDueAt ? `; due ${stage.stageDueAt}` : ""}`,
      ])),
      ...documents.map((document) => [
        "Document",
        document.original_name,
        `${document.doc_type_slot}; ${document.status}; verification ${document.verification || "not recorded"}`,
      ]),
      ...(processing?.tasks || []).map((task) => ["Task", task.type, `${task.state}; ${task.createdByRule}`]),
      ...(processing?.findings || []).map((finding) => ["Finding", finding.code, `${finding.severity}; ${finding.status}; ${finding.message}`]),
    ];
    const blob = new Blob([rows.map((row) => row.map(csvValue).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${record.caseNo || "case"}-report.csv`;
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const selectedDocument = documents.find((document) => String(document._id) === selectedDocumentId) || documents[0] || null;
  const timelineStages = record.allocatedStages?.length
    ? record.allocatedStages
    : route.map((name, index) => ({ key: String(index), name, status: name === currentStage ? "ACTIVE" : "PENDING" }));
  const timelineCurrentIndex = Number.isInteger(record.currentStageIndex)
    ? record.currentStageIndex
    : Math.max(0, route.findIndex((stage) => stage === currentStage));

  return <>
    <header className="case-detail-header">
      <div>
        <p className="eyebrow">CASE WORKSPACE</p>
        <h1>{record.caseNo}</h1>
        <p>{applicationTypeLabels[record.applicationType] || record.applicationType} · {record.region || "Region not recorded"}</p>
      </div>
      <div className="case-detail-actions">
        <button className="button button-secondary" type="button" onClick={openCaseHistory}><HistoryIcon size={16} /> Case history</button>
        <button className="button button-primary" type="button" onClick={downloadCaseReport}><Download size={16} /> Download report</button>
      </div>
    </header>
    {error && <div className="alert alert-warning" role="alert"><AlertTriangle size={17} />{error}</div>}
    {notice && <div className="alert alert-success" role="status"><CheckCircle2 size={17} />{notice}</div>}
    <div className="case-meta case-detail-meta">
      <Badge variant={record.status === "approved" ? "success" : record.status === "rejected" ? "danger" : "info"}>{caseStatusLabels[record.status] || record.status}</Badge>
      <Badge variant="neutral">Version {record.version}</Badge>
      <Badge variant="neutral">{record.policyVersion}</Badge>
      <Badge variant={currentHolder === "Institution" ? "warning" : "info"}>Current holder: {currentHolder}</Badge>
    </div>
    <Card className="case-route-card" title="Application route" description="Progress across the stages configured for this application.">
      <ol className="case-route-timeline">
        {timelineStages.map((stage, index) => {
          const completed = record.status === "approved" || stage.status === "APPROVED";
          const active = record.status !== "draft" && !completed && index === timelineCurrentIndex;
          const returned = stage.status === "REJECTED" || record.status === "returned" && active;
          const status = completed ? "Completed" : returned ? "Returned" : active ? "In progress" : "Pending";
          const date = stage.approvedAt || stage.stageStartedAt || stage.enteredAt;
          return <li className={`case-route-step ${completed ? "completed" : ""} ${active ? "active" : ""} ${returned ? "returned" : ""}`} key={stage.key || index}>
            <span className="case-route-marker">{completed ? <Check size={14} /> : index + 1}</span>
            <span className="case-route-copy"><strong>{stage.name}</strong><small>{status}</small>{date && <time dateTime={date}>{new Date(date).toLocaleDateString()}</time>}</span>
          </li>;
        })}
      </ol>
    </Card>
    <div className="case-detail-overview">
      <div className="case-detail-left-column">
        <Card title="Application details" description={record.status === "returned"
          ? "Returned — edit the required fields and resubmit for re-scrutiny."
          : editable ? "Draft — you can edit document fields." : "Submitted application information."}
        action={canEdit && record.status === "draft" && <button className="button button-primary button-small" disabled={submitting || (record.blockSubmitOnMissing && missingRequired.length > 0)} onClick={submitDraft}>
          {submitting ? "Submitting…" : record.blockSubmitOnMissing && missingRequired.length ? "Upload required documents first" : "Submit application"}
        </button> || canEdit && record.status === "returned" && <button className="button button-primary button-small" disabled={submitting || (record.blockSubmitOnMissing && missingRequired.length > 0)} onClick={resubmitReturnedCase}>
          {submitting ? "Resubmitting…" : record.blockSubmitOnMissing && missingRequired.length ? "Upload required documents first" : "Resubmit for re-scrutiny"}
        </button>}>
          <dl className="case-application-facts">
            <div><dt>Application type</dt><dd>{applicationTypeLabels[record.applicationType] || record.applicationType || "—"}</dd></div>
            <div><dt>Current stage</dt><dd>{currentStage || "—"}</dd></div>
            <div><dt>Submitted</dt><dd>{record.submittedAt ? new Date(record.submittedAt).toLocaleDateString() : record.status === "draft" ? "Not submitted" : "—"}</dd></div>
            <div><dt>Policy version</dt><dd>{record.policyVersion || "—"}</dd></div>
            <div><dt>Region</dt><dd>{record.region || "—"}</dd></div>
            <div><dt>Current holder</dt><dd>{currentHolder}</dd></div>
          </dl>
          {record.status === "draft" && <div className="note info-note">This draft is visible only to your institution. Workflow stages become visible after submission.</div>}
        </Card>
        <Card className="case-analysis-card" title={`Document analysis checks${selectedDocument?.extraction?.rule_results_json?.length ? ` (${selectedDocument.extraction.rule_results_json.length})` : ""}`} description="Review recorded checks for the selected document.">
          {selectedDocument?.extraction?.rule_results_json?.length
            ? <ul className="case-analysis-check-list">{selectedDocument.extraction.rule_results_json.map((check, index) => <li key={`${selectedDocument._id}-${check.ruleId || "check"}-${index}`}>
              <div><strong>{check.ruleId || "Document check"}</strong><span className={check.passed ? "analysis-check-pass" : "analysis-check-fail"}>{check.passed ? "Passed" : check.severity || "Needs review"}</span></div>
              <p>{check.message}</p>
            </li>)}</ul>
            : <p className="muted">{selectedDocument ? "No document analysis checks have been recorded." : "Analysis checks will appear here after a document is uploaded and processed."}</p>}
        </Card>
      </div>
      {selectedDocument
        ? <Card className="case-primary-document" title="Document preview" description={`${labelBySlot.get(selectedDocument.doc_type_slot) || selectedDocument.doc_type_slot.replaceAll("_", " ")} · ${selectedDocument.original_name}`}>
          <div className="case-primary-document-status">
            <Badge variant={selectedDocument.status === "CONFIRMED" ? "success" : selectedDocument.status === "AI_FAILED" ? "danger" : "warning"}>{selectedDocument.status.replaceAll("_", " ")}</Badge>
            {selectedDocument.antivirus_status && <Badge variant={selectedDocument.antivirus_status === "CLEAN" ? "success" : "warning"}>{selectedDocument.antivirus_status === "CLEAN" ? "Virus scan clean" : "Virus scan not configured"}</Badge>}
          </div>
          {sourcePreviewOpen
            ? <DocumentEvidencePreview
              documentId={selectedDocument._id}
              fileName={selectedDocument.original_name}
              page={sourcePreviewField?.documentId === selectedDocument._id ? sourcePreviewField.source_page : 1}
              bbox={sourcePreviewField?.documentId === selectedDocument._id ? sourcePreviewField.source_bbox : undefined}
              confidence={sourcePreviewField?.documentId === selectedDocument._id ? sourcePreviewField.confidence : undefined}
              showSourceDetails={sourcePreviewField?.documentId === selectedDocument._id}
              onClose={() => {
                setSourcePreviewField(null);
                setSourcePreviewOpen(false);
              }}
            />
            : <button className="button button-secondary button-small" type="button" onClick={() => setSourcePreviewOpen(true)}>Show document preview</button>}
        </Card>
        : <Card className="case-primary-document" title="Document preview" description="No supporting documents have been uploaded for this application.">
          <div className="state-card"><FileText size={22} /><h3>No documents uploaded</h3><p>Uploaded certificates will appear here.</p></div>
        </Card>}
    </div>
    <div className="case-evidence-workspace case-detail-workspace">
    <div className="stage-review-documents"><Card title="Selected Documents" description="Choose a certificate and review its extracted fields and verification state."
    action={<div className="case-document-actions">
      {editable && <Link className="button button-secondary button-small" to={`/applications/new?caseId=${record._id}`}>Continue draft</Link>}
    </div>}>
    {selectedDocument
      ? <div className="case-document-scroll-region">
        <div className="case-document-selection-list" aria-label="Application certificates">
          {documents.map((document) => <button
            className={`case-document-selection${String(document._id) === String(selectedDocument._id) ? " selected" : ""}`}
            type="button"
            key={document._id}
            aria-pressed={String(document._id) === String(selectedDocument._id)}
            onClick={() => {
              setSelectedDocumentId(String(document._id));
              setSourcePreviewField(null);
              setSourcePreviewOpen(true);
            }}
          >
            <span className="case-document-selection-copy"><FileText size={17} aria-hidden="true" /><span><strong>{labelBySlot.get(document.doc_type_slot) || document.doc_type_slot.replaceAll("_", " ")}</strong><small>{document.original_name}</small></span></span>
            <Badge variant={document.status === "CONFIRMED" ? "success" : document.status === "AI_FAILED" ? "danger" : "warning"}>{document.status.replaceAll("_", " ")}</Badge>
          </button>)}
        </div>
        <div className="case-document-list">{[selectedDocument].map((document) => {
          const fields = document.extraction?.fields || [];
          const saved = document.status === "CONFIRMED";
          const hasVerificationTask = processing?.tasks?.some((task) => task.type === "VERIFY_DOCUMENT" && String(task.documentId) === String(document._id) && ["open", "queued"].includes(task.state));
          const unresolvedAmbiguities = resolvedAmbiguities[document._id] || [];
          return <article className="case-document-slot" key={document._id}>
            <div className="case-document-slot-heading">
              <div>
                <h3>{labelBySlot.get(document.doc_type_slot) || document.doc_type_slot.replaceAll("_", " ")}</h3>
                <p>{document.original_name}</p>
                {document.extraction?.m1_type && <small className="case-m1-type">M1 document type: <strong>{document.extraction.m1_type}</strong> · {Math.round((document.extraction.m1_confidence || 0) * 100)}% confidence</small>}
              </div>
              <div className="case-document-statuses">
                <Badge variant={saved ? "success" : document.status === "AI_FAILED" ? "danger" : "warning"}>{document.status.replaceAll("_", " ")}</Badge>
                {document.antivirus_status && <Badge variant={document.antivirus_status === "CLEAN" ? "success" : "warning"}>
                  {document.antivirus_status === "CLEAN" ? "Virus scan clean" : "Virus scan not configured"}
                </Badge>}
              </div>
            </div>
            {document.processingRun && <small className="case-processing-run">
              AI run {document.processingRun.status}
              {document.processingRun.modelVersions && ` · ${Object.entries(document.processingRun.modelVersions).map(([name, version]) => `${name.toUpperCase()} ${version || "unavailable"}`).join(" · ")}`}
              {document.processingRun.errorCode && ` · ${document.processingRun.errorCode}`}
            </small>}
            {fields.length
              ? <div className="case-extraction-fields">
                {!editable && !canOverrideConfirmedFields && <p className="case-extraction-intro">This case has been submitted. Extracted and confirmed values are view-only.</p>}
                {fields.map((field) => {
                  const key = `${document._id}:${field.field_name}`;
                  const choices = field.ambiguous ? ambiguousDateChoices(field) : [];
                  return <div className="case-extraction-field" key={field.field_name}>
                    <strong>{field.field_name.replaceAll("_", " ")}</strong>
                    <input
                      type={/(?:date|valid_to|lease_start|lease_end)$/.test(field.field_name)
                        && /^\d{4}-\d{2}-\d{2}$/.test(fieldValues[key] ?? field.confirmed_value ?? field.ai_value ?? "")
                        ? "date" : "text"}
                      aria-label={`${field.field_name.replaceAll("_", " ")} for ${document.original_name}`}
                      value={fieldValues[key] ?? field.confirmed_value ?? (field.prefill ? field.ai_value : "") ?? ""}
                      readOnly={(!editable && !canOverrideConfirmedFields) || saved && !canOverrideConfirmedFields}
                      onChange={(event) => setFieldValues((current) => ({ ...current, [key]: event.target.value }))}
                    />
                    {field.ambiguous && editable && !saved && (choices.length
                      ? <label className="field-label">Resolve ambiguous date
                        <select value={unresolvedAmbiguities.includes(field.field_name) ? fieldValues[key] || "" : ""} onChange={(event) => {
                          const value = event.target.value;
                          if (!value) return;
                          setFieldValues((current) => ({ ...current, [key]: value }));
                          setResolvedAmbiguities((current) => ({ ...current, [document._id]: [...new Set([...(current[document._id] || []), field.field_name])] }));
                        }}>
                          <option value="">Choose the confirmed interpretation</option>
                          {choices.map((choice) => <option value={choice.value} key={choice.value}>{choice.label}</option>)}
                        </select>
                      </label>
                      : <label className="check-inline"><input type="checkbox" checked={unresolvedAmbiguities.includes(field.field_name)} onChange={(event) => setResolvedAmbiguities((current) => ({
                        ...current,
                        [document._id]: event.target.checked
                          ? [...new Set([...(current[document._id] || []), field.field_name])]
                          : (current[document._id] || []).filter((name) => name !== field.field_name),
                      }))} />I manually resolved this ambiguous date</label>)}
                    <small>{field.zone} · {Math.round((field.ai_confidence || 0) * 100)}% confidence{field.source_page ? ` · page ${field.source_page}` : ""}{field.prefill ? " · prefill eligible" : " · manual confirmation required"}</small>
                    {field.source_bbox?.length === 4 && <small>Source box: {field.source_bbox.join(", ")}</small>}
                    <small className={field.confirmed_at ? "field-confirmation confirmed" : "field-confirmation pending"}>
                      {field.confirmed_at ? `CONFIRMED · ${new Date(field.confirmed_at).toLocaleString()}` : "PENDING CONFIRMATION"}
                    </small>
                    {field.source_bbox?.length === 4 && <button className="button button-secondary button-small source-preview-trigger" type="button" onClick={() => {
                      setSourcePreviewField({
                        documentId: document._id,
                        source_page: field.source_page || 1,
                        source_bbox: field.source_bbox,
                        confidence: field.ai_confidence,
                      });
                      setSourcePreviewOpen(true);
                    }}>Show source highlight</button>}
                  </div>;
                })}
                {(editable || canOverrideConfirmedFields) && <button className="button button-secondary button-small case-save-fields" disabled={saved && !canOverrideConfirmedFields || savingDocument === document._id} onClick={() => saveFields(document)}>
                  {saved && !canOverrideConfirmedFields ? "Fields saved" : savingDocument === document._id ? "Saving…" : canOverrideConfirmedFields ? "Confirm / override fields" : "Save all document fields"}
                </button>}
              </div>
              : <p className="muted">{["UPLOADED", "PROCESSING"].includes(document.status) ? "Text detection is still in progress." : "No extracted fields are available for this document."}</p>}
            {document.status === "QUARANTINED" && <div className="alert alert-warning" role="alert">Quarantined: {document.quarantine_reason || "This file cannot be used or downloaded."}</div>}
            {canVerifyDocuments && hasVerificationTask && <div className="document-verification-controls">
              <label className="field-label">Verification reason<textarea value={verificationReasons[document._id] || ""} onChange={(event) => setVerificationReasons((current) => ({ ...current, [document._id]: event.target.value }))} placeholder="Required if this evidence is not verified" /></label>
              <button className="button button-primary button-small" disabled={savingVerification === document._id} onClick={() => verifyDocument(document, "verified")}>Verify document</button>
              <button className="button button-danger button-small" disabled={savingVerification === document._id || !(verificationReasons[document._id] || "").trim()} onClick={() => verifyDocument(document, "not_verified")}>Mark not verified</button>
            </div>}
            {document.extraction?.extracted_lines?.length > 0 && <details className="case-ocr-text">
              <summary>View detected text ({document.extraction.extracted_lines.length} lines)</summary>
              <ol>{document.extraction.extracted_lines.map((line, index) => <li key={`${document._id}-${index}`}>{line}</li>)}</ol>
            </details>}
          </article>;
        })}</div></div>
        : <div className="state-card"><FileText size={22} /><h3>No documents uploaded</h3><p>Documents uploaded for this application will appear here.</p></div>}
    </Card>
    </div>
    </div>
    {!editable && <div className="note info-note">Submitted application documents and extracted fields cannot be changed here.</div>}
    {record.workflowVersion && <div className="case-stage-actions"><StageWorkflowPanel
          record={record}
          role={backendRole}
          user={user}
          documents={documents}
          canConfirmFields={editable || canOverrideConfirmedFields}
          savingDocument={savingDocument}
          onConfirmFields={saveFields}
          showExtractedFields={false}
          showStepper={false}
          showHeading={false}
        /></div>}
    {!record.workflowVersion && record.status !== "draft" && (record.currentStage === "evc" && ["EVC member", "EVC chairman"].includes(role)
      || record.currentStage !== "evc" && record.stageRequirements?.length > 0 && isCurrentHolder) && <Card className="case-legacy-stage-actions" title="Stage actions" description={currentStage}>
      {!record.workflowVersion && record.currentStage === "evc" && ["EVC member", "EVC chairman"].includes(role) && <label className="field-label">Upload EVC report<input type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={submitting} onChange={(event) => uploadEvcReport(event.target.files?.[0])} /></label>}
      {!record.workflowVersion && record.currentStage !== "evc" && record.stageRequirements?.length > 0 && isCurrentHolder && <div className="stage-completion">
        {record.stageRequirements.map((requirement) => <label className="check-inline" key={requirement}>
          <input type="checkbox" checked={stageChecks.includes(requirement)} onChange={(event) => setStageChecks((current) => event.target.checked
            ? [...new Set([...current, requirement])]
            : current.filter((item) => item !== requirement))} />
          {requirement.replaceAll("_", " ")}
        </label>)}
        <button className="button button-primary" disabled={submitting || record.stageRequirements.some((item) => !stageChecks.includes(item))} onClick={advanceStage}>
          {submitting ? "Advancing…" : "Complete stage and advance"}
        </button>
      </div>}
    </Card>}
    {historyOpen && <div className="case-history-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setHistoryOpen(false);
    }}>
      <section className="case-history-dialog" role="dialog" aria-modal="true" aria-labelledby="case-history-title">
        <header><div><p className="eyebrow">CASE RECORD</p><h2 id="case-history-title">Case history</h2><p>{record.caseNo} · stage transitions</p></div><button className="icon-button" type="button" aria-label="Close case history" onClick={() => setHistoryOpen(false)}><X size={18} /></button></header>
        {historyLoading
          ? <div className="loading-state"><i /><i /><i /></div>
          : historyError
            ? <div className="alert alert-warning" role="alert">{historyError}</div>
            : caseHistory.length
              ? <ol className="case-history-list">{caseHistory.map((entry) => <li key={entry._id}>
                <span className="case-history-marker" />
                <div><strong>{entry.fromStage ? `${caseStageLabels[entry.fromStage] || entry.fromStage} → ` : ""}{caseStageLabels[entry.toStage] || entry.toStage}</strong>
                  <small>{entry.holderType?.replaceAll("_", " ")} · {entry.enteredAt ? new Date(entry.enteredAt).toLocaleString() : "Time not recorded"}</small>
                  {entry.leftAt && <small>Stage ended {new Date(entry.leftAt).toLocaleString()}</small>}
                  {entry.reason && <p>{entry.reason}</p>}
                </div>
              </li>)}</ol>
              : <p className="muted">No stage transitions have been recorded for this case.</p>}
      </section>
    </div>}
  </>;
}

function Timeline({ items }) {
  return <div className="timeline">{items.map((entry) => <div className={`timeline-item ${entry.denied ? "denied" : ""}`} key={entry.id}><span className="timeline-dot" /><div><strong>{entry.action}</strong><small>{entry.actor} · {entry.role}</small><small>{entry.time.replace("T", " ").slice(0, 16)}</small>{entry.reason && <p>{entry.reason}</p>}</div></div>)}</div>;
}

function AuditPage({ data }) {
  const [deniedOnly, setDeniedOnly] = useState(false);
  const items = data.audit.filter((entry) => !deniedOnly || entry.denied);
  const columns = useMemo(() => [
    { accessorKey: "time", header: "Time", cell: ({ getValue }) => <span className="mono">{getValue().replace("T", " ").slice(0, 16)}</span> },
    { accessorKey: "actor", header: "Actor" }, { accessorKey: "role", header: "Role" },
    { accessorKey: "action", header: "Action", cell: ({ row }) => <span className={row.original.denied ? "danger-copy" : ""}>{row.original.action}</span> },
    { accessorKey: "caseId", header: "Case" }, { accessorKey: "reason", header: "Reason" },
  ], []);
  return <Card title="Audit events" description={`${data.audit.length} events returned by the audit service.`}><div className="filter-bar"><label className="check-inline"><input type="checkbox" checked={deniedOnly} onChange={(event) => setDeniedOnly(event.target.checked)} />Denied attempts only</label></div><DataTable data={items} columns={columns} /></Card>;
}

function Verification({ data, setMessage }) {
  const [selected, setSelected] = useState(data.documents[0]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmLease = useAppStore((state) => state.confirmLease);
  return <><div className="note info-note"><ShieldCheck size={17} />Submission and verification are separate steps. A timely renewal waiting for verification costs 0 points.</div><div className="verification-layout"><Card title="Awaiting verification" description="Evidence submitted by institutions."><div className="document-list">{data.documents.filter((item) => item.verification !== "Verified").map((item) => <button className={`verification-record ${selected.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelected(item)}><FileText size={18} /><span><strong>{item.type}</strong><small>{item.institution} · {item.id}</small></span><Badge variant="warning">{item.verification}</Badge></button>)}</div></Card><Card title="Verification decision" description={selected.name}><div className="doc-preview"><div className="fake-document"><FileText size={30} /><strong>{selected.type}</strong><small>{selected.name}</small></div></div><label className="field-label">Verification remarks<textarea placeholder="Add a reason or verification note…" /></label><div className="form-footer"><button className="button button-danger" onClick={() => setMessage("Not verified. A written reason is required in the audit record.")}>Not verified</button><button className="button button-primary" onClick={() => setMessage("Evidence verified. The Action Score remains unchanged.")}>Verify evidence</button></div><p className="muted">A timely renewal pending official verification costs 0 points.</p><button className="button button-secondary" onClick={() => setConfirmOpen(true)}>Confirm lease flag</button></Card></div><ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title="Confirm lease flag" description="This will deduct 10 points from the institution's score." onConfirm={() => { confirmLease(); setConfirmOpen(false); setMessage("Lease flag confirmed. 10 points deducted from the Action Score."); }} /></>;
}

function AIService({ aiEnabled, setAiEnabled, setMessage }) {
  const [confirm, setConfirm] = useState(false);
  return <><Card title="Service status"><div className="ai-status"><span className={`service-indicator ${aiEnabled ? "on" : "off"}`} /><div><strong>AI service {aiEnabled ? "On" : "Off"}</strong><small>{aiEnabled ? "Suggestions are available for document review." : "AI service unavailable. Enter values manually."}</small></div><button className={`switch ${aiEnabled ? "enabled" : ""}`} role="switch" aria-checked={aiEnabled} aria-label="AI service" onClick={() => aiEnabled ? setConfirm(true) : setAiEnabled(true)}><span /></button></div></Card><Card title="Model register"><div className="table-wrap"><table className="data-table"><thead><tr><th>Model</th><th>Version</th><th>Last evaluated</th><th>Held-out set</th><th>Target metric</th></tr></thead><tbody>{[["M1 Document type", "1.2", "20 Oct 2026", "1,200 documents", "Macro-F1 target: 0.92"], ["M2 Field extraction", "1.4", "20 Oct 2026", "840 fields", "Span-F1 target: 0.90"], ["M3 Lease reading", "0.8", "18 Oct 2026", "220 leases", "Span-F1 target: 0.88"]].map((row) => <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody></table></div></Card><Card title="Service controls"><button className="button button-secondary" onClick={() => setConfirm(true)}>Stop AI service</button></Card><Card title="Recent suggestions"><div className="notification-list">{["Fire certificate valid-to date · accepted after review", "Lease term · edited by authorised reviewer", "Document type · rejected and manually corrected"].map((item) => <div className="notification-item" key={item}><Badge variant="ai">AI-suggested</Badge><div className="notification-copy"><strong>{item}</strong><small>M2 Field extraction · v1.4</small></div><Badge variant="neutral">Reviewed</Badge></div>)}</div></Card><ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Turn off AI service?" description="AI suggestions will stop. All forms remain available for manual entry." onConfirm={() => { setAiEnabled(false); setConfirm(false); setMessage("AI service stopped. Manual entry remains available."); }} /></>;
}

function Policy({ data, setMessage }) {
  const [route, setRoute] = useState("Scrutiny + EVC");
  const [evc, setEvc] = useState(true);
  return <><div className="policy-cards">{data.policy.versions.map((item) => <Card key={item.version} title={item.version}><Badge variant={item.status === "Signed off" ? "success" : item.status === "Draft" ? "warning" : "neutral"}>{item.status}</Badge><p className="muted">{item.signedOff ? `Signed off ${item.signedOff}` : "Not signed off"}</p></Card>)}</div><div className="split-content"><Card title="Route builder" description="Stages appear in policy order for the selected route."><label className="field-label">Application route<select value={route} onChange={(event) => setRoute(event.target.value)}>{Object.keys(data.policy.routes).map((item) => <option key={item}>{item}</option>)}</select></label><ol className="route-builder-list">{data.policy.routes[route].map((stage, index) => <li key={stage}><span>{index + 1}</span><strong>{stage}</strong><label>Holder<select defaultValue={stage === "EVC" ? "Committee" : stage === "Decision" ? "Competent authority" : "Officer"}><option>Institution</option><option>Officer</option><option>Committee</option><option>Competent authority</option></select></label><label>Timeline days<input type="number" defaultValue={data.policy.timelines[stage] || 15} /></label></li>)}</ol><p className="muted">Timelines are editable settings, not AICTE values.</p><button className="button button-secondary" onClick={() => setMessage("Draft route saved. Signed-off case routes remain unchanged.")}>Save draft route</button></Card><div><Card title="Policy rules"><div className="table-wrap"><table className="data-table"><thead><tr><th>Application type</th><th>Route</th></tr></thead><tbody>{Object.entries(data.policy.applicationRoutes).map(([type, routeName]) => <tr key={type}><td>{type}</td><td><Badge variant="info">{routeName}</Badge></td></tr>)}</tbody></table></div></Card><Card title="Policy controls"><label className="check-row"><input type="checkbox" checked={evc} onChange={() => setEvc(!evc)} /><span>Create EVC task once when policy says</span></label><label className="check-row"><input type="checkbox" defaultChecked /><span>Priority for new institutions, where policy says</span></label><button className="button button-primary" onClick={() => setMessage("Sign-off is a demo. No policy changes are applied to registered cases.")}>Sign off policy version</button><p className="muted">Cases always retain the policy version they were registered under.</p></Card></div></div></>;
}

function Region({ data }) {
  const [tableView, setTableView] = useState(false);
  const stageStats = stages.map((stage) => data.cases.filter((item) => item.stage === stage).reduce((summary, item) => ({
    name: stage,
    institution: summary.institution + item.institutionDays,
    officer: summary.officer + item.officerDays,
  }), { name: stage, institution: 0, officer: 0 })).filter((item) => item.institution || item.officer);
  const regionStats = data.summary.regionStats.map((item) => ({ name: item.region, institution: item.institutionDays, officer: item.officerDays, cases: item.cases }));
  const averageAge = (data.cases.reduce((sum, item) => sum + item.officerDays + item.institutionDays, 0) / data.cases.length).toFixed(1);
  return <><div className="filter-bar"><select aria-label="Region filter"><option>All regions</option>{["South", "North", "East", "West", "Central"].map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Stage filter"><option>All stages</option>{stages.map((item) => <option key={item}>{item}</option>)}</select><button className="button button-secondary button-small" onClick={() => setTableView(!tableView)}>{tableView ? "Chart view" : "Table view"}</button></div><div className="stat-grid"><StatCard label="Open cases" value={data.cases.length} note="Across five regions" icon={FilesIcon} /><StatCard label="Overdue" value={data.notifications.filter((item) => item.level === "Overdue").length} note="Officer- and institution-held" icon={AlertTriangle} /><StatCard label="Escalated" value={data.notifications.filter((item) => item.level === "Escalation").length} note="Unresolved alerts" icon={Activity} /><StatCard label="Average age" value={`${averageAge} days`} note="Institution and officer clocks" icon={Clock3} /></div>{tableView ? <div className="chart-grid"><Card title="Ageing by stage"><SimpleTable items={stageStats} secondLabel="Institution days" thirdLabel="Officer days" secondKey="institution" thirdKey="officer" /></Card><Card title="Cases by region"><SimpleTable items={regionStats} secondLabel="Open cases" thirdLabel="Officer days" secondKey="cases" thirdKey="officer" /></Card><Card title="Workload per officer"><SimpleTable items={data.summary.officerWorkload.map((item) => ({ name: item.name, count: item.cases }))} secondLabel="Open cases" secondKey="count" /></Card></div> : <div className="chart-grid"><Card title="Ageing by stage" description="Separate ownership clocks (days)."><ResponsiveContainer width="100%" height={230}><BarChart data={stageStats}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis /><ChartTooltip /><Bar dataKey="institution" stackId="a" fill="#d28727" name="Institution days" /><Bar dataKey="officer" stackId="a" fill="#315d89" name="Officer days" /></BarChart></ResponsiveContainer></Card><Card title="Cases by region" description="Fictional case distribution."><ResponsiveContainer width="100%" height={230}><BarChart data={regionStats}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis /><ChartTooltip /><Bar dataKey="cases" fill="#315d89" name="Open cases" /></BarChart></ResponsiveContainer></Card><Card title="Workload per officer" description="Assigned cases by officer."><ResponsiveContainer width="100%" height={210}><BarChart data={data.summary.officerWorkload} layout="vertical"><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" /><YAxis dataKey="name" type="category" width={85} /><ChartTooltip /><Bar dataKey="cases" fill="#547c9f" /></BarChart></ResponsiveContainer></Card><Card title="Top bottlenecks"><ol className="bottleneck-list">{stageStats.sort((a, b) => b.officer - a.officer).slice(0, 3).map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.officer} officer days · {item.institution} institution days</span></li>)}</ol></Card></div>}<Card title="Escalation register"><CaseTable data={data.cases.filter((item) => item.status === "Overdue" || item.officerDays > 7)} compact /></Card></>;
}

function SimpleTable({ items, secondLabel, thirdLabel, secondKey, thirdKey }) {
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Category</th><th>{secondLabel}</th>{thirdLabel && <th>{thirdLabel}</th>}</tr></thead><tbody>{items.map((item) => <tr key={item.name}><td>{item.name}</td><td>{item[secondKey]}</td>{thirdLabel && <td>{item[thirdKey]}</td>}</tr>)}</tbody></table></div>;
}

function FilesIcon() { return <FileText size={18} />; }

function Evc({ data, setMessage }) {
  const { pathname } = useLocation();
  const [view, setView] = useState(pathname === "/evc/visits" ? "Calendar" : "List");
  const [open, setOpen] = useState(false);
  useEffect(() => setView(pathname === "/evc/visits" ? "Calendar" : "List"), [pathname]);
  const evcCount = (status) => data.evc.filter((item) => item.status === status).length;
  return <><div className="filter-bar"><div className="tabs-list inline-tabs">{["List", "Calendar"].map((item) => <button className={`tab-trigger ${view === item ? "active" : ""}`} onClick={() => setView(item)} key={item}>{item} view</button>)}</div><button className="button button-primary" onClick={() => setOpen(!open)}><Plus size={15} /> Schedule visit</button></div>{open && <Card title="Schedule EVC visit"><div className="form-grid"><label className="field-label">Visit date<input type="date" /></label><label className="field-label">Mode<select><option>Online</option><option>Offline</option></select></label><label className="field-label">Panel member<select><option>Asha Iyer</option><option>Vikram Sen</option></select></label><label className="field-label">Notes<input placeholder="Scheduling notes" /></label></div><div className="note warning-note"><AlertTriangle size={16} />Conflict warning: Asha Iyer has another visit at this time.</div><button className="button button-primary" onClick={() => { setOpen(false); setMessage("EVC visit scheduled. Reminder timeline started."); }}>Confirm schedule</button></Card>}<div className="stat-grid"><StatCard label="Queued" value={evcCount("Queued")} note="Policy-based priority" icon={Clock3} /><StatCard label="Scheduled" value={evcCount("Scheduled")} note="Upcoming visits" icon={CalendarIcon} /><StatCard label="Completed" value={evcCount("Completed")} note="Report pending" icon={CheckCircle2} /><StatCard label="Report uploaded" value={evcCount("Report uploaded")} note="Ready for review" icon={FileCheck2} /></div>{view === "Calendar" ? <Card title="October 2026 visit calendar"><div className="calendar-grid">{Array.from({ length: 35 }, (_, index) => <div className="calendar-cell" key={index}>{index < 4 || index > 34 ? "" : index - 3}{index === 13 && <span>2 visits</span>}</div>)}</div></Card> : <Card title="EVC queue" description="New institutions are prioritised only where signed-off policy says."><div className="queue-list">{data.evc.map((item) => <div className="queue-row" key={item.id}><span className="queue-priority"><CalendarIcon /></span><div className="queue-main"><Link className="text-link mono" to={`/case/${item.caseId}`}>{item.caseId}</Link><strong>{item.institution}</strong><small>{item.priority}</small></div><Badge variant={item.status === "Queued" ? "warning" : "info"}>{item.status}</Badge><button className="button button-secondary button-small" onClick={() => setMessage("EVC task is already created once under this policy.")}>Review</button></div>)}</div></Card>}<Card title="Report upload"><label className="upload-zone compact-upload"><UploadCloud size={22} /><strong>Upload EVC report</strong><input type="file" accept=".pdf" aria-label="Upload EVC report" /></label></Card></>;
}

function CalendarIcon() { return <Clock3 size={17} />; }

function Decisions({ data, setMessage }) {
  const [confirm, setConfirm] = useState(false);
  const [decision, setDecision] = useState("Approve");
  return <div className="split-content"><Card title="Case summary" description="AT-2026-0036 · Demo Institute"><Badge variant="info">Policy v2026.2</Badge><StageStepper route={data.policy.routes["Scrutiny + EVC"]} current="Decision" holder="Competent authority" /><TabsView items={["Scrutiny", "Re-Scrutiny", "EVC", "Regional Committee"]}>{(item) => <div className="report-preview"><FileText size={22} /><strong>{item} report</strong><p>Reviewed and recorded under the policy version in force.</p></div>}</TabsView></Card><div><Card title="Final decision" description="Only the competent authority may record a final decision."><label className="field-label">Decision<select value={decision} onChange={(event) => setDecision(event.target.value)}><option>Approve</option><option>Approve subject to undertakings</option><option>Reject</option></select></label>{decision !== "Approve" && <label className="field-label">{decision.includes("Reject") ? "Reason for rejection" : "Undertaking condition"}<textarea required placeholder="Enter reason or conditions and due dates…" /></label>}{decision.includes("undertakings") && <label className="field-label">Due date<input type="date" /></label>}<button className="button button-primary full-button" onClick={() => setConfirm(true)}>Record decision</button></Card><Card title="Process safeguard"><p className="statutory-note">Alerts and recommendations support the process. They never replace statutory scrutiny or the decision of the competent authority.</p></Card></div><ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Confirm final decision" description={`Record “${decision}” for this case? This action will be added to the audit trail.`} onConfirm={() => { setConfirm(false); setMessage(`Decision recorded: ${decision}. Audit entry and undertaking obligations created.`); }} /></div>;
}

function Reports({ data }) {
  const [kind, setKind] = useState("Pendency");
  const kinds = ["Pendency", "EVC scheduling", "Undertakings", "Document validity", "Escalations"];
  return <div className="reports-layout"><Card title="Create report" description="Choose a report and preview fictional operational records."><div className="report-type-grid">{kinds.map((item) => <button className={`report-type ${kind === item ? "selected" : ""}`} onClick={() => setKind(item)} key={item}><FileText size={18} /><strong>{item}</strong><small>Build a filtered report</small></button>)}</div><div className="form-grid"><label className="field-label">Region<select><option>All regions</option>{["South", "North", "East", "West", "Central"].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field-label">From date<input type="date" defaultValue="2026-10-01" /></label><label className="field-label">To date<input type="date" defaultValue="2026-10-26" /></label></div><button className="button button-primary">Generate preview</button></Card><Card title={`${kind} preview`} action={<div className="button-group"><button className="button button-secondary button-small"><Download size={14} /> CSV</button><button className="button button-secondary button-small">PDF placeholder</button></div>}><CaseTable data={data.cases.slice(0, 5)} compact /></Card><Card title="Saved reports"><p className="muted">No saved reports in this demo session.</p><button className="button button-secondary">Save current configuration</button></Card></div>;
}

const ruleDescriptions = {
  D1: "Warn when the detected document type differs from its upload slot.",
  D2: "Check required document slots for an application type.",
  D3: "Warn when a confirmed issue date is in the future.",
  D4: "Check that certificate validity ends after its start date.",
  D5: "Check whether a fire safety certificate is currently valid.",
  D6: "Validate a certificate number against its configured pattern.",
  D7: "Require human confirmation for amber and red AI fields.",
  D8: "Flag duplicate certificate documents within an application.",
  D9: "Warn when OCR confidence is below the configured minimum.",
  L1: "Check that the lease end date follows its start date.",
  L2: "Compare the stated lease term with the lease date range.",
  L3: "Require a person to confirm lease registration.",
  L4: "Check lease coverage for the requested academic year.",
  L5: "Check the lease term against the configured minimum.",
  L6: "Flag leases that are expired or approaching expiry.",
  W6: "Configure maximum stage durations for workflow monitoring.",
  ZONES: "Configure AI confidence thresholds for review zones.",
  ESCALATION: "Configure the delay before workflow escalation.",
};

const institutionRoles = new Set(["INSTITUTION", "STUDENT", "FACULTY", "GRIEVANCE_OFFICER"]);
const userStatuses = ["ACTIVE", "PENDING_VERIFICATION", "LOCKED", "DISABLED"];
const initialUserForm = {
  name: "",
  email: "",
  phone: "",
  password: "",
  role: "SCRUTINY_OFFICER",
  institution_id: "",
  region: "",
};

function AlertRules({ usersOnly = false, setMessage }) {
  const [rules, setRules] = useState([]);
  const [users, setUsers] = useState([]);
  const [institutions, setInstitutions] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(initialUserForm);
  const [userError, setUserError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [basisFilter, setBasisFilter] = useState("ALL");
  const currentUserId = useAppStore((state) => state.user?.id);
  const summary = useMemo(() => {
    const total = rules.length;
    const enabled = rules.filter((rule) => rule.enabled).length;
    const real = rules.filter((rule) => rule.basis === "REAL").length;
    return { total, enabled, real, disabled: total - enabled };
  }, [rules]);
  const basisOptions = useMemo(() => ["ALL", ...new Set(rules.map((rule) => rule.basis).filter(Boolean))], [rules]);
  const filteredRules = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return rules.filter((rule) => {
      const matchesQuery = !query || [rule.rule_id, ruleDescriptions[rule.rule_id] || "", JSON.stringify(rule.params_json || {})].some((value) => String(value).toLowerCase().includes(query));
      const matchesBasis = basisFilter === "ALL" || rule.basis === basisFilter;
      return matchesQuery && matchesBasis;
    });
  }, [basisFilter, rules, searchQuery]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      if (usersOnly) {
        const [userResult, institutionResult] = await Promise.all([
          adminApi.getUsers(page, 100),
          adminApi.getInstitutions(),
        ]);
        setUsers(userResult.users);
        setPages(userResult.meta.pages || 1);
        setInstitutions(institutionResult);
      } else {
        setRules(await adminApi.getRules());
      }
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [usersOnly, page]);

  async function changeRule(rule) {
    setBusy(true);
    setError("");
    try {
      const saved = await adminApi.updateRule(rule.rule_id, {
        enabled: !rule.enabled,
        params_json: rule.params_json || {},
      });
      setRules((items) => items.map((item) => item.rule_id === saved.rule_id ? saved : item));
      setMessage(`${saved.rule_id} ${saved.enabled ? "enabled" : "disabled"}.`);
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setBusy(true);
    setUserError("");
    try {
      await adminApi.createUser({
        ...form,
        email: form.email.trim(),
        phone: form.phone.trim(),
        region: form.region.trim(),
        ...(form.institution_id ? {} : { institution_id: undefined }),
      });
      setForm(initialUserForm);
      setShowForm(false);
      setMessage("User account created.");
      await load();
    } catch (createError) {
      setUserError(createError.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeUserStatus(user, status) {
    setBusy(true);
    setError("");
    try {
      await adminApi.setUserStatus(user._id, status);
      setUsers((items) => items.map((item) => item._id === user._id ? { ...item, status } : item));
      setMessage(`${user.email} is now ${status.toLowerCase().replaceAll("_", " ")}.`);
    } catch (statusError) {
      setError(statusError.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Card title={usersOnly ? "User accounts" : "Rule configuration"}><div className="loading-state"><i /><i /><i /><i /></div></Card>;
  if (error && (usersOnly ? users.length === 0 : rules.length === 0)) {
    return <Card title={usersOnly ? "User accounts" : "Rule configuration"}><div className="state-card state-error"><AlertTriangle size={22} /><p>{error}</p><button className="button button-secondary" onClick={load}><RefreshCw size={15} /> Retry</button></div></Card>;
  }

  if (!usersOnly) {
    return <div className="alert-rules-page">
      <div className="alert-rules-summary">
        <div className="alert-rules-stat">
          <span className="alert-rules-stat-label">Total rules</span>
          <strong>{summary.total}</strong>
          <small>{summary.enabled} currently active</small>
        </div>
        <div className="alert-rules-stat accent">
          <span className="alert-rules-stat-label">Enabled</span>
          <strong>{summary.enabled}</strong>
          <small>Ready for live checks</small>
        </div>
        <div className="alert-rules-stat warning">
          <span className="alert-rules-stat-label">Real basis</span>
          <strong>{summary.real}</strong>
          <small>Production-backed logic</small>
        </div>
        <div className="alert-rules-stat neutral">
          <span className="alert-rules-stat-label">Disabled</span>
          <strong>{summary.disabled}</strong>
          <small>Temporarily inactive</small>
        </div>
      </div>

      <section className="alert-rules-panel card" aria-label="Configured validation rules">
        <div className="card-heading alert-rules-header">
          <div>
            <p className="eyebrow">Validation controls</p>
            <h2>Configured validation rules</h2>
            <p>These settings are read from the backend. Changes are saved to the database and applied by document validation.</p>
          </div>
          <button className="button button-secondary button-small" onClick={load}><RefreshCw size={14} /> Refresh</button>
        </div>

        <div className="alert-rules-toolbar">
          <label className="alert-rules-search">
            <Search size={14} />
            <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search rules or parameters" aria-label="Search validation rules" />
          </label>
          <label className="alert-rules-filter">
            <span>Basis</span>
            <select value={basisFilter} onChange={(event) => setBasisFilter(event.target.value)} aria-label="Filter validation rules by basis">
              {basisOptions.map((option) => <option value={option} key={option}>{option === "ALL" ? "All basis" : option}</option>)}
            </select>
          </label>
        </div>

        {error && <p className="login-error" role="alert">{error}</p>}
        <div className="table-wrap alert-rules-table-wrap"><table className="data-table"><thead><tr><th>Rule</th><th>Purpose</th><th>Basis</th><th>Parameters</th><th>Status</th></tr></thead>
          <tbody>{filteredRules.length ? filteredRules.map((rule) => <tr key={rule.rule_id} className="alert-rule-row">
            <td><div className="rule-cell"><span className="rule-code">{rule.rule_id}</span><small>{rule.enabled ? "Live" : "Paused"}</small></div></td>
            <td><div className="rule-description"><strong>{ruleDescriptions[rule.rule_id] || "Backend validation rule."}</strong><small>{rule.rule_id} · validation logic</small></div></td>
            <td><Badge variant={rule.basis === "REAL" ? "info" : "warning"}>{rule.basis}</Badge></td>
            <td><code>{JSON.stringify(rule.params_json || {})}</code></td>
            <td><label className="admin-rule-toggle"><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={() => changeRule(rule)} /><span className="toggle-pill">{rule.enabled ? "Enabled" : "Disabled"}</span></label></td>
          </tr>) : <tr><td className="empty-cell" colSpan={5}>No rules match the current filters.</td></tr>}</tbody>
        </table></div>
      </section>
    </div>;
  }

  return <div className="admin-users-page">
    <Card title="User accounts" description="Manage backend accounts and their stored roles. A user's role determines the workspace available after sign-in." action={<button className="button button-primary button-small" onClick={() => { setShowForm((open) => !open); setUserError(""); }}><Plus size={15} />{showForm ? "Cancel" : "Add user"}</button>}>
      {error && <p className="login-error" role="alert">{error}</p>}
      {showForm && <form className="admin-user-form" onSubmit={createUser}>
        <label className="field-label">Full name<input required minLength={2} maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="field-label">Email<input required type="email" maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="field-label">Initial password<input required type="password" minLength={12} maxLength={128} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><small>Use at least 12 characters.</small></label>
        <label className="field-label">Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, institution_id: institutionRoles.has(event.target.value) ? form.institution_id : "" })}>{Object.entries(adminRoleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        {institutionRoles.has(form.role) && <label className="field-label">Institution<select required value={form.institution_id} onChange={(event) => setForm({ ...form, institution_id: event.target.value })}><option value="">Select an institution</option>{institutions.map((item) => <option value={item._id} key={item._id}>{item.name} ({item.aicte_id})</option>)}</select></label>}
        <label className="field-label">Phone<input maxLength={32} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label className="field-label">Region<input maxLength={100} value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} /></label>
        {userError && <p className="login-error" role="alert">{userError}</p>}
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Name / Email</th><th>Role</th><th>Institution</th><th>Region</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{users.map((user) => <tr key={user._id}>
          <td><strong>{user.name}</strong><small className="table-subtitle">{user.email}</small></td>
          <td>{adminRoleLabels[user.role] || user.role}</td>
          <td>{institutions.find((item) => item._id === user.institution_id)?.name || "—"}</td>
          <td>{user.region || "—"}</td>
          <td><Badge variant={user.status === "ACTIVE" ? "success" : user.status === "DISABLED" ? "danger" : "warning"}>{user.status.replaceAll("_", " ")}</Badge></td>
          <td><select aria-label={`Set status for ${user.email}`} value={user.status} disabled={busy || String(user._id) === String(currentUserId)} onChange={(event) => changeUserStatus(user, event.target.value)}>{userStatuses.map((status) => <option value={status} key={status}>{status.replaceAll("_", " ")}</option>)}</select></td>
        </tr>)}</tbody>
      </table></div>
      {pages > 1 && <div className="button-group admin-pagination"><button className="button button-secondary button-small" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="button button-secondary button-small" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>}
    </Card>
  </div>;
}

function Undertakings({ data, setMessage }) {
  const rows = data.undertakings.map((item) => ({ ...item, deadline: item.dueDate }));
  const columns = useMemo(() => [
    { accessorKey: "title", header: "Undertaking", cell: ({ row }) => <><strong>{row.original.title}</strong><small className="table-subtitle">{row.original.id} · {row.original.caseId}</small></> },
    { accessorKey: "condition", header: "Condition" },
    { accessorKey: "dueDate", header: "Due date", cell: ({ row }) => <><span className="mono">{row.original.dueDate}</span><br /><DeadlineBadge deadline={row.original.dueDate} now={new Date("2026-10-26T12:00:00")} /></> },
    { accessorKey: "submission", header: "Submission", cell: ({ getValue }) => <Badge variant={getValue() === "Submitted" ? "info" : "warning"}>{getValue()}</Badge> },
    { accessorKey: "verification", header: "Verification" },
    { accessorKey: "dueStatus", header: "Due status", cell: ({ getValue }) => <Badge variant={getValue() === "Overdue" ? "danger" : "warning"}>{getValue()}</Badge> },
    { accessorKey: "closure", header: "Closure" },
    { accessorKey: "id", header: "Action", cell: () => <button className="button button-secondary button-small" onClick={() => setMessage("Undertaking details opened. Upload evidence to submit.")}>Open</button> },
  ], [setMessage]);
  return <><div className="stat-grid"><StatCard label="Open" value="7" icon={ClipboardCheck} /><StatCard label="Due within 7 days" value="3" icon={Clock3} /><StatCard label="Overdue" value="2" icon={AlertTriangle} /><StatCard label="Submitted" value="4" icon={FileCheck2} /><StatCard label="Verified" value="3" icon={CheckCircle2} /></div><Card title="Undertaking register" description="Late submission and pending verification are separate dimensions."><DataTable data={rows} columns={columns} /></Card><div className="note info-note"><InfoIcon />A late submission can show both “Pending review” and “Submitted late”. Acknowledging an alert never closes an undertaking.</div></>;
}

function Deficiencies({ data, setMessage }) {
  const [returnId, setReturnId] = useState("AT-2026-0038");
  const returnedCases = data.cases.filter((item) => item.status === "Action required").slice(0, 4);
  return <div className="split-content deficiency-layout"><div className="deficiency-left"><Card title="Returned applications"><div className="queue-list">{returnedCases.map((item) => <button className={`verification-record ${returnId === item.id ? "selected" : ""}`} onClick={() => setReturnId(item.id)} key={item.id}><AlertTriangle size={17} /><span><strong>{item.id} · {item.type}</strong><small>{item.institution} · returned by Scrutiny</small></span></button>)}</div></Card><Card title="Resubmission checklist" description="A clear response helps the reviewer verify the corrected items."><ol className="deficiency-checklist"><li><span>1</span><p><strong>Address each return reason</strong><small>Explain how the requested correction has been completed.</small></p></li><li><span>2</span><p><strong>Attach supporting evidence</strong><small>Upload the revised documents that support your response.</small></p></li><li><span>3</span><p><strong>Resubmit for verification</strong><small>The case remains pending until an officer verifies the response.</small></p></li></ol></Card></div><Card title="Deficiency response" description={`${returnId} · APH clause 2.7`}><div className="reason-block"><strong>Reason for return</strong><p>Provide updated faculty appointment evidence and correct the programme intake figures. APH clause 2.7 applies.</p></div><div className="response-stepper"><Badge variant="danger">Returned</Badge><ArrowRight size={15} /><Badge variant="warning">Response submitted</Badge><ArrowRight size={15} /><Badge variant="neutral">Pending verification</Badge><ArrowRight size={15} /><Badge variant="neutral">Verified</Badge></div><label className="field-label">Response remarks<textarea placeholder="Explain how each listed deficiency is addressed…" /></label><label className="upload-zone compact-upload"><UploadCloud size={22} /><strong>Upload evidence</strong><input type="file" aria-label="Upload deficiency evidence" /></label><p className="muted">Re-Scrutiny checks only the deficiencies listed.</p><button className="button button-primary" onClick={() => setMessage("Deficiency response submitted. Verification is a separate officer action.")}>Resubmit</button></Card></div>;
}

function Hearings({ data, setMessage }) {
  return <><div className="stat-grid"><StatCard label="Hearings scheduled" value="4" icon={Clock3} /><StatCard label="Reports ready" value="6" icon={FileCheck2} /><StatCard label="Appeals" value="2" icon={ScaleIcon} /></div><div className="split-content"><Card title="Hearings and appeals"><div className="queue-list">{data.cases.filter((item) => ["SHC", "SAC"].includes(item.stage)).slice(0, 5).map((item) => <div className="queue-row" key={item.id}><span className="queue-priority"><Users size={17} /></span><div className="queue-main"><strong>{item.id} · {item.institution}</strong><small>{item.stage} · {item.route}</small></div><Badge variant="info">{item.status}</Badge><button className="button button-secondary button-small">Review</button></div>)}</div></Card><Card title="Hearing notes" description="Use the fixed case record. Do not generate decision text."><TabsView items={["Scrutiny", "Re-Scrutiny", "EVC", "Regional Committee"]}>{(item) => <div className="report-preview"><FileText size={22} /><strong>{item} report</strong><p>Institution evidence received and recorded. View the report in the case file.</p></div>}</TabsView><label className="field-label">Hearing notes<textarea placeholder="Record factual notes from the hearing…" /></label><label className="field-label">Recommendation<select><option>Recommend to competent authority</option><option>Return for deficiency</option></select></label><label className="field-label">Reason<textarea required placeholder="Required for a return recommendation" /></label><button className="button button-primary" onClick={() => setMessage("Recommendation submitted to the competent authority.")}>Submit recommendation</button></Card></div></>;
}

function ScaleIcon() { return <ShieldCheck size={17} />; }

function ReportsAndFallback({ kind, data, setMessage, usersOnly }) {
  if (kind === "cases") return <CaseList />;
  if (kind === "undertakings") return <UndertakingsLive data={data} />;
  if (kind === "deficiencies") return <DeficienciesLive data={data} />;
  if (kind === "notifications") return <NotificationsLive data={data} setMessage={setMessage} />;
  if (kind === "audit") return <AuditPage data={data} />;
  if (kind === "queue") return <QueueLive data={data} />;
  if (kind === "caseControl") return <CaseControl />;
  if (kind === "verification") return <VerificationWorkspace cases={data.cases} />;
  if (kind === "evc") return <EvcVisitsLive data={data} />;
  if (kind === "hearings") return <HearingsLive data={data} />;
  if (kind === "decisions") return <DecisionsLive data={data} setMessage={setMessage} />;
  if (kind === "region") return <RegionLive data={data} />;
  if (kind === "reports") return <ReportsLive data={data} />;
  if (kind === "policy") return <PolicyLive data={data} />;
  if (kind === "alertRules") return <AlertRules usersOnly={usersOnly} setMessage={setMessage} />;
  if (kind === "aiService") return <AIServiceLive />;
  return null;
}

export default function DomainWorkspace({ kind, usersOnly = false }) {
  const { pathname } = useLocation();
  const { applicationId } = useParams();
  const config = kind === "documents" && applicationId
    ? { ...pageSettings.documents, title: "Application Documents", description: "Review uploaded documents, verification status, and extracted fields for this application.", eyebrow: "DOCUMENT REGISTER" }
    : kind === "alertRules" && usersOnly
    ? { ...pageSettings.alertRules, title: "Users and roles", description: "Create accounts, review stored roles, and manage account status." }
    : kind === "evc" && pathname === "/evc/visits"
      ? { ...pageSettings.evc, title: "My EVC visits", description: "View scheduled committee visits and upcoming appointments." }
      : pageSettings[kind];
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const backendRole = useAppStore((state) => state.user?.role);
  async function load() {
    setError("");
    try {
      const result = await api.getDashboard(backendRole);
      setData(result);
    } catch (loadError) { setError(loadError.message || "Unexpected service error."); }
  }
  useEffect(() => {
    if (["application", "cases", "caseControl", "documents", "documentReview"].includes(kind)) {
      setData({});
      setError("");
    } else if (kind !== "alertRules") {
      load();
    }
  }, [kind, backendRole]);

  const action = kind === "dashboard"
    ? <Link className="button button-primary" to="/applications/new"><Plus size={16} /> New application</Link>
    : kind === "documents" && applicationId
      ? <Link className="button button-secondary button-small" to="/documents"><ArrowLeft size={15} /> Back to applications</Link>
      : null;
  if (kind === "alertRules") return <><PageHeading config={config} /><ReportsAndFallback kind={kind} data={data} setMessage={setMessage} usersOnly={usersOnly} /><Toast message={message} onClose={() => setMessage("")} /></>;
  if (kind === "caseControl") return <><ReportsAndFallback kind={kind} data={data} setMessage={setMessage} usersOnly={usersOnly} /><Toast message={message} onClose={() => setMessage("")} /></>;
  if (!data) return <><PageHeading config={config} action={action} /><BusyState error={error} onRetry={load} /></>;

  return <><PageHeading config={config} action={action} />
    {kind === "dashboard" ? <Dashboard data={data} reload={load} /> :
      kind === "application" ? <NewApplication data={data} setMessage={setMessage} /> :
      kind === "documents" || kind === "documentReview" ? <DocumentsLive title={config.title} allowNewApplication={kind === "documents"} /> :
      kind === "design" ? <DesignSystem /> :
      <ReportsAndFallback kind={kind} data={data} setMessage={setMessage} usersOnly={usersOnly} />}
    <Toast message={message} onClose={() => setMessage("")} />
  </>;
}

function DesignSystem() {
  return <div className="design-system"><Card title="Status and action badges"><div className="design-row">{["success", "warning", "danger", "info", "neutral", "ai", "review"].map((variant) => <Badge variant={variant} key={variant}>{variant}</Badge>)}</div></Card><Card title="Ownership clock"><OwnershipClockBar institutionDays={4} officerDays={9} /></Card><Card title="Stage stepper"><StageStepper route={["Submitted", "Self-disclosure", "Scrutiny", "Re-Scrutiny", "EVC", "Decision"]} current="Scrutiny" holder="Officer" /></Card><Card title="AI field states"><div className="design-row"><AIFieldRow label="High confidence" value="14 March 2027" confidence={.96} /><AIFieldRow label="Please check" value="14 March 2027" confidence={.72} /><AIFieldRow label="Low confidence" value="" confidence={.42} /><AIFieldRow label="Manual entry" value="" aiEnabled={false} /></div></Card><Card title="Deadline states"><div className="design-row"><DeadlineBadge deadline="2026-10-25" now={new Date("2026-10-26T10:00:00")} /><DeadlineBadge deadline="2026-11-02" now={new Date("2026-10-26T10:00:00")} /><DeadlineBadge deadline={null} /></div></Card><Card title="Action Score"><ScoreGauge score={63} onBreakdown={() => {}} /><p>Score band labels are “Lower action burden”, “Attention needed”, and “High action burden”.</p></Card></div>;
}
