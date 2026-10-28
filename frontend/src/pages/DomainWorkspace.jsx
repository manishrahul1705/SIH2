import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Activity, AlertTriangle, ArrowRight, Bell, Check, CheckCircle2, ClipboardCheck, Clock3, Download, FileCheck2, FileText, Filter, MapPin, Plus, RefreshCw, ShieldCheck, UploadCloud, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../services/api";
import { adminApi, adminRoleLabels } from "../services/admin";
import { caseWorkflowApi, waitForDocumentAnalysis } from "../services/caseWorkflow";
import { useAppStore } from "../store/useAppStore";
import { buildRoute, routeForApplication } from "../utils/routeBuilder";
import { calculateScore, demoScoreInput } from "../utils/scoreCalculator";
import { Badge, Card, ConfirmDialog, DataTable, DeadlineBadge, AIFieldRow, FileDropzone, OwnershipClockBar, ProjectedScoreCard, ReasonDialog, ScoreBreakdownTable, ScoreGauge, StageStepper, StatCard, TabsView, Toast } from "../components/ui/primitives";

export const pageSettings = {
  dashboard: { title: "Institution dashboard", description: "A clear view of your applications, obligations and next actions.", eyebrow: "DEMO INSTITUTE", roles: ["Institution user"] },
  application: { title: "New application", description: "Prepare an application for submission under the policy in force.", eyebrow: "APPLICATION WORKSPACE", roles: ["Institution user"] },
  cases: { title: "My cases", description: "Follow each application through its policy-defined stages.", eyebrow: "CASE REGISTER", roles: ["Institution user", "Scrutiny / Regional officer"] },
  documents: { title: "Documents and validity", description: "Manage document validity, submissions and separate official verification.", eyebrow: "DOCUMENT REGISTER", roles: ["Institution user"] },
  documentReview: { title: "Document upload and AI review", description: "Review proposed certificate fields. Nothing starts until a person confirms the values.", eyebrow: "DOCUMENT REVIEW", roles: ["Institution user", "Scrutiny / Regional officer"] },
  undertakings: { title: "Undertakings", description: "Track submission, verification, due status and closure as separate states.", eyebrow: "OBLIGATION REGISTER", roles: ["Institution user"] },
  deficiencies: { title: "Deficiency responses", description: "Respond to returned items with evidence and a written explanation.", eyebrow: "RE-SCRUTINY", roles: ["Institution user"] },
  notifications: { title: "Notifications", description: "Review obligation reminders and escalations. Acknowledgement does not close an obligation.", eyebrow: "ALERT CENTRE", roles: ["All"] },
  audit: { title: "Audit trail", description: "Review recorded actions, state changes and denied attempts.", eyebrow: "SYSTEM RECORD", roles: ["Oversight"] },
  queue: { title: "My queue", description: "Officer-held work, ordered by urgency and service window.", eyebrow: "OFFICER WORKSPACE", roles: ["Scrutiny / Regional officer"] },
  caseControl: { title: "Case detail and stage control", description: "Review stage evidence, ownership time and policy route.", eyebrow: "CASE AT-2026-0040", roles: ["Scrutiny / Regional officer", "Institution user"] },
  verification: { title: "Verification", description: "Verify institution-submitted evidence as a separate official action.", eyebrow: "VERIFICATION QUEUE", roles: ["Scrutiny / Regional officer"] },
  evc: { title: "EVC queue and scheduling", description: "Manage queued visits, schedules and report submissions.", eyebrow: "EXPERT VISIT COMMITTEE", roles: ["EVC member", "Scrutiny / Regional officer"] },
  hearings: { title: "Hearings and appeals", description: "Review submitted reports and record a reasoned recommendation.", eyebrow: "SAC / SHC", roles: ["SAC/SHC member"] },
  decisions: { title: "Decisions", description: "Record a final decision as the competent authority.", eyebrow: "COMPETENT AUTHORITY", roles: ["Competent authority"] },
  region: { title: "Region dashboard", description: "Compare ageing, workload and bottlenecks by ownership and region.", eyebrow: "REGIONAL OVERSIGHT", roles: ["Senior authority", "Competent authority"] },
  reports: { title: "Reports", description: "Build operational reports from the demo register.", eyebrow: "REPORTING", roles: ["Senior authority", "Competent authority"] },
  policy: { title: "Policy and stages", description: "Review signed-off policy versions and configure draft routes.", eyebrow: "ADMINISTRATION", roles: ["Admin"] },
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
const stages = ["Submitted", "Self-disclosure", "Scrutiny", "Re-Scrutiny", "Regional Committee", "EVC", "SHC", "SAC", "Decision"];
const MODEL = "M2 Field extraction · v1.4";

function PageHeading({ config, action }) {
  return <div className="page-heading"><div><p className="eyebrow">{config.eyebrow}</p><h1>{config.title}</h1><p>{config.description}</p></div>{action}</div>;
}

function BusyState({ error, onRetry }) {
  if (error) return <div className="state-card state-error"><AlertTriangle size={22} /><h3>We could not load this workspace.</h3><p>{error}</p><button className="button button-secondary" onClick={onRetry}><RefreshCw size={15} /> Try again</button></div>;
  return <div className="loading-state" aria-label="Loading"><i /><i /><i /><i /></div>;
}

function Dashboard({ data, reload }) {
  const score = useAppStore((state) => state.score);
  const announcement = useAppStore((state) => state.scoreAnnouncement);
  const simulate = useAppStore((state) => state.simulateFireRenewal);
  const renewalSimulated = useAppStore((state) => state.fireRenewalSimulated);
  const confirmLease = useAppStore((state) => state.confirmLease);
  const [breakdown, setBreakdown] = useState(false);
  const [leaseDialog, setLeaseDialog] = useState(false);
  const [message, setMessage] = useState("");
  const deductions = useAppStore((state) => state.deductions);
  const activeScore = calculateScore({ ...demoScoreInput, deductions });
  const required = data.undertakings.filter((item) => item.submission === "Not submitted").slice(0, 4);
  return <div className="dashboard-page">
    {data.documents.some((document) => document.type === "Structural stability" && !document.validTo) && <div className="alert alert-warning"><AlertTriangle size={17} /><strong>Assessment incomplete.</strong> Some required validity data is missing.</div>}
    <div className="dashboard-score-row">
      <Card title="Your Action Score" description="Reflects actions within the institution's control." className="score-card"><ScoreGauge score={score} onBreakdown={() => setBreakdown(true)} /><div className="score-note"><ShieldCheck size={15} /> Officer delay does not reduce your score.</div></Card>
      <ProjectedScoreCard score={data.projectedScore.score} date="25 November 2026" current={score} />
      <div className="stat-grid compact-stats"><StatCard label="Open undertakings" value={data.summary.openUndertakings} note={`${data.summary.undertakingsDueIn7Days} due within 7 days`} icon={ClipboardCheck} /><StatCard label="Documents expiring in 30 days" value={data.summary.documentsExpiringIn30Days} note="Renewal action needed" icon={FileCheck2} /><StatCard label="Cases in progress" value={data.summary.casesInProgress} note="Across 4 stages" icon={Activity} /><StatCard label="Waiting on officers" value={data.summary.waitingOnOfficers} note="Does not lower your score" icon={Clock3} /></div>
    </div>
    <div className="dashboard-columns">
      <Card title="What you need to do" description="Institution-held obligations, sorted by urgency." action={<Link className="text-link" to="/undertakings">View all</Link>}>
        <div className="action-list">{required.map((item) => <div className="action-row" key={item.id}><span className="action-icon warning"><AlertTriangle size={16} /></span><div className="action-copy"><strong>{item.title}</strong><small>{item.caseId} · Institution action</small></div><DeadlineBadge deadline={item.dueDate} now={new Date("2026-10-26T12:00:00")} /><Link className="button button-secondary button-small" to="/undertakings">Open</Link></div>)}</div>
      </Card>
      <Card title="Waiting on an officer" description="These stages are currently officer- or committee-held."><div className="note info-note"><InfoIcon />This does not lower your score.</div>{data.cases.filter((item) => ["Officer", "Committee", "Competent authority"].includes(item.holder)).slice(0, 4).map((item) => <div className="compact-case-row" key={item.id}><div><strong>{item.stage}</strong><small>{item.id} · {item.holder}</small></div><Badge variant="info">{item.officerDays} days</Badge></div>)}</Card>
    </div>
    <Card title="Action Score breakdown" description={`${activeScore.totalDeductions} points deducted across institution-controlled factors.`} action={<button className="button button-secondary button-small" disabled={renewalSimulated} onClick={() => { simulate(); setMessage("Renewal upload simulated. Score increased by 7 points; verification will not change it."); }}>{renewalSimulated ? "Fire renewal simulated" : "Simulate: upload fire renewal"}</button>}><p className="score-equation">100 base points − {activeScore.totalDeductions} deductions = <strong aria-live="polite">{score}</strong> Action Score</p><ScoreBreakdownTable deductions={activeScore.deductions.reduce((result, item, index) => ({ ...result, [["undertakings", "nonLeaseDocuments", "lease", "evcReadiness", "history"][index]]: item.points }), {})} onLeaseConfirm={() => setLeaseDialog(true)} /></Card>
    <p className="screen-reader-live" aria-live="polite">{announcement}</p>
    <ConfirmDialog open={leaseDialog} onOpenChange={setLeaseDialog} title="Confirm lease flag" description="This will deduct 10 points from the institution's score." onConfirm={() => { confirmLease(); setLeaseDialog(false); setMessage("Lease flag confirmed. 10 points deducted."); }} /><Toast message={message} onClose={() => setMessage("")} />
    {breakdown && <div className="drawer-backdrop" onClick={() => setBreakdown(false)}><aside className="breakdown-drawer" onClick={(event) => event.stopPropagation()}><button className="drawer-close" onClick={() => setBreakdown(false)}>Close</button><h2>How the score is calculated</h2><p>Only institution-controlled obligations affect this score. Officer and committee waiting time is excluded.</p><ScoreBreakdownTable deductions={activeScore.deductions.reduce((result, item, index) => ({ ...result, [["undertakings", "nonLeaseDocuments", "lease", "evcReadiness", "history"][index]]: item.points }), {})} onLeaseConfirm={() => setLeaseDialog(true)} /></aside></div>}
  </div>;
}

function InfoIcon() { return <ShieldCheck size={17} />; }

function NewApplication({ data, setMessage }) {
  const [applicationTypes, setApplicationTypes] = useState(Object.entries(applicationTypeLabels).map(([id, label]) => ({ id, label })));
  const [applicationType, setApplicationType] = useState("");
  const [applicability, setApplicability] = useState({});
  const [preview, setPreview] = useState(null);
  const [checklist, setChecklist] = useState([]);
  const [caseRecord, setCaseRecord] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState({});
  const [busySlot, setBusySlot] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [extractions, setExtractions] = useState({});
  const [fieldValues, setFieldValues] = useState({});
  const [reviewingDocument, setReviewingDocument] = useState("");
  const [analysisWait, setAnalysisWait] = useState(null);

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

  async function uploadSlot(slot) {
    const file = selectedFiles[slot.slotId];
    if (!file || !applicationType) return;
    setBusySlot(slot.slotId);
    setAnalysisWait({ fileName: file.name, phase: "uploading" });
    setPageError("");
    setPageNotice("");
    try {
      const draft = await ensureDraft();
      const result = await caseWorkflowApi.uploadDocument(draft._id, slot.slotId, file);
      if (!result.document_id) throw new Error("The upload completed without a document reference. Refresh the case before retrying.");
      await refreshCase(draft._id);
      setAnalysisWait({ fileName: file.name, phase: "analyzing" });
      const analysis = await waitForDocumentAnalysis(result.document_id);
      setExtractions((current) => ({ ...current, [result.document_id]: analysis }));
      setReviewingDocument(result.document_id);
      for (const field of analysis.extraction?.fields || []) {
        setFieldValues((current) => ({
          ...current,
          [`${result.document_id}:${field.field_name}`]: field.confirmed_value ?? field.ai_value ?? "",
        }));
      }
      await refreshCase(draft._id);
      setSelectedFiles((current) => ({ ...current, [slot.slotId]: null }));
      if (analysis.document.status === "AI_FAILED") {
        const code = analysis.extraction?.processing_error_code;
        setPageError(`AI analysis could not complete${code ? ` (${code})` : ""}. The application remains a draft; review the document or upload a clearer file.`);
      } else {
        const failedRules = (analysis.extraction?.rule_results_json || []).filter((rule) => rule?.passed === false);
        setPageNotice(failedRules.length
          ? `AI analysis completed for ${file.name} with ${failedRules.length} finding${failedRules.length === 1 ? "" : "s"}. Review the reasons below; this does not automatically reject your application.`
          : `AI analysis completed for ${file.name}. Review and confirm the extracted suggestions below.`);
      }
      setMessage(`${slot.label} uploaded and analyzed.`);
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusySlot("");
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

  async function loadExtraction(documentId) {
    setReviewingDocument(documentId);
    if (extractions[documentId]?.extraction) return;
    setBusyAction(`extract:${documentId}`);
    setPageError("");
    try {
      const result = await caseWorkflowApi.getExtraction(documentId);
      setExtractions((current) => ({ ...current, [documentId]: result }));
      for (const field of result.extraction?.fields || []) {
        setFieldValues((current) => ({
          ...current,
          [`${documentId}:${field.field_name}`]: field.confirmed_value ?? field.ai_value ?? "",
        }));
      }
    } catch (error) {
      setPageError(error.message);
    } finally {
      setBusyAction("");
    }
  }

  async function confirmField(documentId, fieldName) {
    const valueKey = `${documentId}:${fieldName}`;
    setBusyAction(`confirm:${valueKey}`);
    setPageError("");
    try {
      const result = await caseWorkflowApi.confirmFields(documentId, [{
        field_name: fieldName,
        confirmed_value: fieldValues[valueKey] ?? "",
      }]);
      setExtractions((current) => ({ ...current, [documentId]: result }));
      if (caseRecord) await refreshCase();
      setPageNotice("Field confirmation has been recorded.");
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
      const result = await caseWorkflowApi.submitCase(draft._id, draft.version);
      setCaseRecord(result.case);
      setChecklist(result.checklist || []);
      setPageNotice(`Application ${result.case.caseNo} was submitted.`);
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
      if (value === "unknown" || value === "") delete next[name];
      else if (name === "buildingAgeYears") next[name] = Number(value);
      else next[name] = value === "yes";
      return next;
    });
  }

  const applicableSlots = checklist.filter((slot) => slot.required || slot.reviewRequired);
  const missingRequired = checklist.filter((slot) => slot.required && !["confirmed", "verified"].includes(slot.status));
  const route = preview?.route || [];
  const conditionQuestions = [
    ["landIsLeased", "Is the institution using leased land?"],
    ["newAreaAdded", "Is new land or area being added?"],
    ["buildingAgeYears", "What is the age of the building in years?"],
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
          setChecklist(preview?.checklist || []);
          setSelectedFiles({});
          setExtractions({});
          setPageNotice("Your saved draft remains available in the case register. You can start another application.");
        }}>Start another application</button>}
      >
        <label className="field-label application-type-field">Application type
          <select
            aria-label="Application type"
            value={applicationType}
            disabled={Boolean(caseRecord)}
            onChange={(event) => {
              setApplicationType(event.target.value);
              setApplicability({});
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
              {name === "buildingAgeYears"
                ? <input
                  type="number"
                  min="0"
                  max="500"
                  value={applicability[name] ?? ""}
                  placeholder="Not provided"
                  onChange={(event) => setAnswer(name, event.target.value)}
                />
                : <select value={applicability[name] === undefined ? "unknown" : applicability[name] ? "yes" : "no"} onChange={(event) => setAnswer(name, event.target.value)}>
                  <option value="unknown">Not provided</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>}
            </label>
          ))}
        </div>
      </Card>}

      {applicationType && <Card
        title="Required documents"
        description={loadingPreview ? "Updating the checklist…" : `${applicableSlots.length} document slots are required or need applicability review.`}
        action={caseRecord && <button className="button button-secondary button-small" disabled={busyAction === "refresh"} onClick={refreshChecklist}><RefreshCw size={14} /> Refresh</button>}
      >
        {pageError && !preview
          ? <div className="state-card state-error"><AlertTriangle size={22} /><h3>Checklist unavailable</h3><p>Document requirements cannot be shown until a signed-off policy is available.</p><button className="button button-secondary" disabled={loadingPreview} onClick={() => setApplicability((current) => ({ ...current }))}><RefreshCw size={15} /> Try again</button></div>
          : loadingPreview && !checklist.length
          ? <div className="loading-state" aria-label="Loading checklist"><i /><i /><i /></div>
          : applicableSlots.length
            ? <div className="case-document-list">{applicableSlots.map((slot) => {
              const documentId = slot.documentId;
              const extractionResult = documentId ? extractions[documentId] : null;
              const extractedFields = extractionResult?.extraction?.fields || [];
              const failedRules = (extractionResult?.extraction?.rule_results_json || []).filter((rule) => rule?.passed === false);
              return <article className="case-document-slot" key={slot.slotId}>
                <div className="case-document-slot-heading">
                  <div>
                    <h3>{slot.label}</h3>
                    <p>{slot.requirement === "R" ? "Required document" : slot.reviewRequired ? "Conditional — answer the application details to confirm if required" : "Required based on your answers"}</p>
                  </div>
                  <Badge variant={slot.status === "confirmed" || slot.status === "verified" ? "success" : slot.status === "pending_confirmation" ? "warning" : slot.reviewRequired ? "review" : "neutral"}>
                    {slot.status === "pending_confirmation" ? "AI review ready" : slot.status.replaceAll("_", " ")}
                  </Badge>
                </div>
                {slot.helpText && <p className="case-slot-help">{slot.helpText}</p>}
                <div className="case-slot-upload">
                  <label className="button button-secondary button-small">
                    <UploadCloud size={15} /> Choose PDF or image
                    <input
                      type="file"
                      accept={slot.acceptedFileTypes?.join(",") || "application/pdf,image/jpeg,image/png"}
                      disabled={Boolean(caseRecord && !["draft", "returned"].includes(caseRecord.status))}
                      onChange={(event) => setSelectedFiles((current) => ({ ...current, [slot.slotId]: event.target.files?.[0] || null }))}
                    />
                  </label>
                  <span className="case-file-name">{selectedFiles[slot.slotId]?.name || "PDF, JPG or PNG · up to 20 MB"}</span>
                  <button className="button button-primary button-small" disabled={!selectedFiles[slot.slotId] || busySlot === slot.slotId} onClick={() => uploadSlot(slot)}>
                    {busySlot === slot.slotId ? "Uploading…" : "Upload"}
                  </button>
                </div>
                {documentId && <div className="case-document-review">
                  <button className="text-link" disabled={busyAction === `extract:${documentId}`} onClick={() => loadExtraction(documentId)}>
                    {extractionResult ? "Hide / refresh AI suggestions" : "Review AI suggestions"}
                  </button>
                  {reviewingDocument === documentId && extractionResult?.extraction && <div className="case-extraction-fields">
                    {failedRules.length > 0 && <div className="case-ai-findings" role="status">
                      <strong>AI validation findings</strong>
                      <ul>{failedRules.map((rule, index) => <li key={rule.ruleId || index}>{rule.message || "A validation rule needs review."}</li>)}</ul>
                      <p>Review and correct the document information. AI findings do not automatically reject the application.</p>
                    </div>}
                    {extractedFields.length ? extractedFields.map((field) => {
                      const valueKey = `${documentId}:${field.field_name}`;
                      const confirmed = field.confirmed_value !== null && field.confirmed_value !== undefined;
                      return <div className="case-extraction-field" key={field.field_name}>
                        <div><strong>{field.field_name.replaceAll("_", " ")}</strong><small>AI suggestion: {field.ai_value || "No suggestion"} · {field.zone} review</small></div>
                        <input
                          aria-label={`Confirmed ${field.field_name.replaceAll("_", " ")}`}
                          value={fieldValues[valueKey] ?? field.confirmed_value ?? field.ai_value ?? ""}
                          onChange={(event) => setFieldValues((current) => ({ ...current, [valueKey]: event.target.value }))}
                        />
                        <button className="button button-secondary button-small" disabled={confirmed || busyAction === `confirm:${valueKey}`} onClick={() => confirmField(documentId, field.field_name)}>
                          {confirmed ? "Confirmed" : "Confirm value"}
                        </button>
                      </div>;
                    }) : <p className="muted">No fields were extracted. The uploaded document remains available for officer review.</p>}
                  </div>}
                </div>}
              </article>;
            })}</div>
            : <div className="state-card"><FileText size={22} /><h3>No required document slots</h3><p>Based on the answers provided, this application has no documents to upload.</p></div>}
        {caseRecord
          ? <div className="case-submit-bar">
            <div>
              <strong>Draft {caseRecord.caseNo}</strong>
              <span>{missingRequired.length ? `${missingRequired.length} required document${missingRequired.length === 1 ? "" : "s"} still need confirmation.` : "All required documents are confirmed."}</span>
            </div>
            <button className="button button-primary" disabled={busyAction === "submit" || missingRequired.length > 0 || !["draft", "returned"].includes(caseRecord.status)} onClick={submitCase}>
              {busyAction === "submit" ? "Submitting…" : missingRequired.length ? "Confirm required documents first" : "Submit application"}
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
    <aside className="case-application-sidebar">
      <Card title="Application route" description={preview ? `Policy ${preview.policyVersion}` : "Choose an application type to preview its route."}>
        {preview && <StageStepper className="stage-stepper-preview" route={route} current={route[0]} />}
        {caseRecord && <div className="case-draft-summary">
          <Badge variant={caseRecord.status === "draft" ? "warning" : "info"}>{caseRecord.status.replaceAll("_", " ")}</Badge>
          <p><strong>{caseRecord.caseNo}</strong></p>
          <Link className="button button-secondary button-small" to={`/case/${caseRecord._id}`}>Open case</Link>
        </div>}
      </Card>
    </aside>
    {analysisWait && <div className="case-analysis-backdrop" role="dialog" aria-modal="true" aria-labelledby="case-analysis-title" aria-describedby="case-analysis-description">
      <div className="case-analysis-dialog">
        <RefreshCw className="case-analysis-spinner" size={36} aria-hidden="true" />
        <h2 id="case-analysis-title">{analysisWait.phase === "uploading" ? "Uploading document" : "Analyzing document"}</h2>
        <p id="case-analysis-description">{analysisWait.phase === "uploading"
          ? "Your document is being securely uploaded. Please stay on this page."
          : "AI is reading the document and checking its contents. This page will update when analysis finishes."}</p>
        <strong className="case-analysis-filename">{analysisWait.fileName}</strong>
        <span className="screen-reader-live" role="status" aria-live="polite">
          {analysisWait.phase === "uploading" ? "Uploading document" : "Document analysis in progress"}
        </span>
      </div>
    </div>}
  </div>;
}

function CaseTable({ data, compact = false }) {
  const columns = useMemo(() => [
    { accessorKey: "id", header: "Case ID", cell: ({ row }) => <Link className="mono text-link" to={`/case/${row.original.id}`}>{row.original.id}</Link> },
    { accessorKey: "institution", header: "Institution" },
    { accessorKey: "type", header: "Application type" },
    { accessorKey: "route", header: "Policy route" },
    { accessorKey: "stage", header: "Current stage" },
    { accessorKey: "holder", header: "Holder", cell: ({ row }) => <Badge variant={row.original.holder === "Institution" ? "warning" : "info"}>{row.original.holder}</Badge> },
    { accessorKey: "institutionDays", header: "Institution days", cell: ({ getValue }) => <span className="mono">{getValue()}d</span> },
    { accessorKey: "officerDays", header: "Officer days", cell: ({ getValue }) => <span className="mono">{getValue()}d</span> },
    { accessorKey: "status", header: "Status", cell: ({ getValue }) => <Badge variant={getValue() === "Overdue" ? "danger" : "info"}>{getValue()}</Badge> },
  ], []);
  return <DataTable data={compact ? data.slice(0, 10) : data} columns={columns} />;
}

function CaseList({ data }) {
  const role = useAppStore((state) => state.role);
  const cases = role === "Institution user" ? data.cases.filter((item) => item.institution === "Demo Institute") : data.cases;
  const [selected, setSelected] = useState(cases[0]);
  if (!selected) return <Card title="No cases yet"><p className="muted">No cases are available in this workspace.</p><Link className="button button-primary" to="/applications/new">Start an application</Link></Card>;
  return <div className="case-layout"><div><Card title="Case register" description={`${cases.length} fictional cases across routes and stages.`}><div className="filter-bar"><select aria-label="Filter region"><option>All regions</option>{["North", "South", "East", "West", "Central"].map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Filter stage"><option>All stages</option>{stages.map((item) => <option key={item}>{item}</option>)}</select><button className="button button-secondary button-small"><Filter size={14} /> Filters</button></div><CaseTable data={cases} /></Card></div><aside className="case-detail-rail"><Card title="Case status" description={selected.id}><Badge variant="info">{selected.status}</Badge><p><strong>{selected.institution}</strong><br /><span className="muted">{selected.type}</span></p><StageStepper route={data.policy.routes[selected.route] || data.policy.routes.Other} current={selected.stage} holder={selected.holder} /><OwnershipClockBar institutionDays={selected.institutionDays} officerDays={selected.officerDays} /><div className="next-step"><strong>Next step for you</strong><p>{selected.holder === "Institution" ? "Submit the requested response or evidence." : "This case is waiting with the assigned reviewer."}</p></div><Link to={`/case/${selected.id}`} className="button button-secondary">Open case detail</Link></Card></aside><div className="case-mobile-actions">{cases.slice(0, 4).map((item) => <button key={item.id} className={`case-select ${selected.id === item.id ? "selected" : ""}`} onClick={() => setSelected(item)}>{item.id}</button>)}</div></div>;
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

function CaseControl({ data, setMessage }) {
  const { caseId = "AT-2026-0040" } = useParams();
  const item = data.cases.find((record) => record.id === caseId) || data.cases[0];
  const route = data.policy.routes[item.route] || data.policy.routes.Other;
  const [currentStage, setCurrentStage] = useState(item.stage);
  const [currentHolder, setCurrentHolder] = useState(item.holder);
  useEffect(() => setCurrentStage(item.stage), [item.id, item.stage]);
  useEffect(() => setCurrentHolder(item.holder), [item.id, item.holder]);
  const previousStages = route.slice(0, route.indexOf(currentStage));
  const [returnTarget, setReturnTarget] = useState(previousStages[previousStages.length - 1] || "");
  useEffect(() => setReturnTarget(previousStages[previousStages.length - 1] || ""), [currentStage]);
  const [reasonOpen, setReasonOpen] = useState(false);
  const logAudit = useAppStore((state) => state.logAudit);
  const role = useAppStore((state) => state.role);
  const isOfficer = role === "Scrutiny / Regional officer";
  const forbidden = role === "Institution user" && item.institution !== "Demo Institute";
  useEffect(() => {
    if (forbidden) logAudit({ actor: "Jordan Lee", role, action: "Attempted cross-institution case access", caseId: item.id, reason: "Access denied: institution scope mismatch", denied: true });
  }, [forbidden, item.id, logAudit, role]);
  if (forbidden) return <section className="access-denied"><ShieldCheck size={28} /><p className="eyebrow">INSTITUTION SCOPE</p><h2>Access denied</h2><p>This case belongs to another institution. The denied attempt has been recorded.</p><Link className="button button-primary" to="/cases">Return to my cases</Link></section>;
  function returnCase(reason) {
    logAudit({ actor: "Ravi Menon", role, action: `Returned case to ${returnTarget}`, caseId: item.id, reason, denied: false });
    setCurrentStage(returnTarget);
    setCurrentHolder("Institution");
    setReasonOpen(false);
    setMessage("Case returned with reason. The action is recorded in the audit trail.");
  }
  return <><div className="case-meta"><span className="mono">{item.id}</span><Badge variant="info">Policy v2026.2</Badge><Badge variant="neutral"><MapPin size={13} />{item.region} Region</Badge><Badge variant={currentHolder === "Institution" ? "warning" : "info"}>Current holder: {currentHolder}</Badge></div><div className="case-detail-grid"><div><Card title="Application route" description={item.route}><StageStepper route={route} current={currentStage} holder={currentHolder} returnedReason={item.status === "Action required" ? "Provide corrected faculty documents." : undefined} /><OwnershipClockBar institutionDays={item.institutionDays} officerDays={item.officerDays} /><div className="per-stage-table"><div><strong>Stage</strong><strong>Holder</strong><strong>Days</strong></div><div><span>{currentStage}</span><span>{currentHolder}</span><span className="mono">{item.institutionDays + item.officerDays}</span></div></div></Card><Card title="Scrutiny checklist" description="Record review findings against submitted items.">{["Institution details match registry", "Faculty evidence received", "Required documents verified", "Self-disclosure reviewed"].map((label, index) => <label className="check-row" key={label}><input type="checkbox" defaultChecked={index < 2} /><span>{label}</span><input aria-label={`Remarks for ${label}`} placeholder="Add review remarks" /></label>)}</Card><Card title="Documents"><div className="document-list">{data.documents.slice(0, 3).map((document) => <div className="document-row" key={document.id}><FileText size={18} /><div className="document-name"><strong>{document.type}</strong><small>{document.name}</small></div><Badge variant={document.verification === "Verified" ? "success" : "warning"}>{document.verification}</Badge></div>)}</div></Card><Card title="EVC task"><div className="note info-note"><InfoIcon />EVC task created once when policy says. This case is currently {currentStage === "EVC" ? "queued for the committee." : "not yet at the EVC stage."}</div></Card></div><aside><Card title="Actions"><p>Complete the current stage to advance to the next stage in the signed-off route.</p>{isOfficer && <><button className="button button-primary full-button" disabled={route.indexOf(currentStage) >= route.length - 1} onClick={() => { const next = route[route.indexOf(currentStage) + 1]; setCurrentStage(next); setCurrentHolder("Officer"); setMessage(`Stage completed. Case advanced to ${next}.`); }}>Complete stage and advance <ArrowRight size={15} /></button>{previousStages.length > 0 && <><label className="field-label">Return to stage<select value={returnTarget} onChange={(event) => setReturnTarget(event.target.value)}>{previousStages.map((stage) => <option key={stage}>{stage}</option>)}</select></label><button className="button button-secondary full-button" onClick={() => setReasonOpen(true)}>Return with reason</button></>}{route.includes("Regional Committee") && <button className="button button-secondary full-button" onClick={() => setMessage("Regional Committee referral recorded.")}>Refer to Regional Committee</button>}</>}<p className="muted">Final decision controls are only available to the competent authority.</p></Card><Card title="Audit entries"><Timeline items={data.audit.filter((entry) => entry.caseId === item.id).slice(0, 4)} /></Card></aside></div><ReasonDialog open={reasonOpen} onOpenChange={setReasonOpen} onConfirm={returnCase} /></>;
}

function Timeline({ items }) {
  return <div className="timeline">{items.map((entry) => <div className={`timeline-item ${entry.denied ? "denied" : ""}`} key={entry.id}><span className="timeline-dot" /><div><strong>{entry.action}</strong><small>{entry.actor} · {entry.role}</small><small>{entry.time.replace("T", " ").slice(0, 16)}</small>{entry.reason && <p>{entry.reason}</p>}</div></div>)}</div>;
}

function AuditPage({ data }) {
  const [deniedOnly, setDeniedOnly] = useState(false);
  const currentSessionAudit = useAppStore((state) => state.audit);
  const items = [...currentSessionAudit, ...data.audit].filter((entry) => !deniedOnly || entry.denied);
  const columns = useMemo(() => [
    { accessorKey: "time", header: "Time", cell: ({ getValue }) => <span className="mono">{getValue().replace("T", " ").slice(0, 16)}</span> },
    { accessorKey: "actor", header: "Actor" }, { accessorKey: "role", header: "Role" },
    { accessorKey: "action", header: "Action", cell: ({ row }) => <span className={row.original.denied ? "danger-copy" : ""}>{row.original.action}</span> },
    { accessorKey: "caseId", header: "Case" }, { accessorKey: "reason", header: "Reason" },
  ], []);
  return <Card title="Audit events" description={`${data.audit.length} demo events · two denied attempts are included.`}><div className="filter-bar"><label className="check-inline"><input type="checkbox" checked={deniedOnly} onChange={(event) => setDeniedOnly(event.target.checked)} />Denied attempts only</label><select aria-label="Filter action"><option>All actions</option><option>Stage changes</option><option>Verification</option><option>Access attempts</option></select><button className="button button-secondary button-small"><Download size={14} /> Export trail</button></div><DataTable data={items} columns={columns} /></Card>;
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

const institutionRoles = new Set(["INSTITUTION", "STUDENT", "FACULTY"]);
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
  const currentUserId = useAppStore((state) => state.user?.id);

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
    return <Card title="Configured validation rules" description="These settings are read from the backend. Changes are saved to the database and applied by document validation.">
      {error && <p className="login-error" role="alert">{error}</p>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Rule</th><th>Purpose</th><th>Basis</th><th>Parameters</th><th>Status</th></tr></thead>
        <tbody>{rules.map((rule) => <tr key={rule.rule_id}>
          <td><strong>{rule.rule_id}</strong></td>
          <td>{ruleDescriptions[rule.rule_id] || "Backend validation rule."}</td>
          <td><Badge variant={rule.basis === "REAL" ? "info" : "warning"}>{rule.basis}</Badge></td>
          <td><code>{JSON.stringify(rule.params_json || {})}</code></td>
          <td><label className="admin-rule-toggle"><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={() => changeRule(rule)} />{rule.enabled ? "Enabled" : "Disabled"}</label></td>
        </tr>)}</tbody>
      </table></div>
    </Card>;
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

function ReportsAndFallback({ kind, data, setMessage, aiEnabled, setAiEnabled, usersOnly }) {
  if (kind === "cases") return <CaseList data={data} />;
  if (kind === "undertakings") return <Undertakings data={data} setMessage={setMessage} />;
  if (kind === "deficiencies") return <Deficiencies data={data} setMessage={setMessage} />;
  if (kind === "notifications") return <Notifications data={data} setMessage={setMessage} />;
  if (kind === "audit") return <AuditPage data={data} />;
  if (kind === "queue") return <Queue data={data} />;
  if (kind === "caseControl") return <CaseControl data={data} setMessage={setMessage} />;
  if (kind === "verification") return <Verification data={data} setMessage={setMessage} />;
  if (kind === "evc") return <Evc data={data} setMessage={setMessage} />;
  if (kind === "hearings") return <Hearings data={data} setMessage={setMessage} />;
  if (kind === "decisions") return <Decisions data={data} setMessage={setMessage} />;
  if (kind === "region") return <Region data={data} />;
  if (kind === "reports") return <Reports data={data} />;
  if (kind === "policy") return <Policy data={data} setMessage={setMessage} />;
  if (kind === "alertRules") return <AlertRules usersOnly={usersOnly} setMessage={setMessage} />;
  if (kind === "aiService") return <AIService aiEnabled={aiEnabled} setAiEnabled={setAiEnabled} setMessage={setMessage} />;
  return null;
}

export default function DomainWorkspace({ kind, usersOnly = false }) {
  const { pathname } = useLocation();
  const config = kind === "alertRules" && usersOnly
    ? { ...pageSettings.alertRules, title: "Users and roles", description: "Create accounts, review stored roles, and manage account status." }
    : kind === "evc" && pathname === "/evc/visits"
      ? { ...pageSettings.evc, title: "My EVC visits", description: "View scheduled committee visits and upcoming appointments." }
      : pageSettings[kind];
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const aiEnabled = useAppStore((state) => state.aiEnabled);
  const setAiEnabled = useAppStore((state) => state.setAiEnabled);
  const confirmLease = useAppStore((state) => state.confirmLease);
  const setNotifications = useAppStore((state) => state.setNotifications);
  async function load() {
    setError("");
    try {
      const result = await api.getDashboard();
      setData(result);
      setNotifications(result.notifications);
    } catch (loadError) { setError(loadError.message || "Unexpected service error."); }
  }
  useEffect(() => { if (kind !== "alertRules") load(); }, [kind]);

  const action = kind === "dashboard" ? <Link className="button button-primary" to="/applications/new"><Plus size={16} /> New application</Link> : null;
  if (kind === "alertRules") return <><PageHeading config={config} /><ReportsAndFallback kind={kind} data={data} setMessage={setMessage} aiEnabled={aiEnabled} setAiEnabled={setAiEnabled} usersOnly={usersOnly} /><Toast message={message} onClose={() => setMessage("")} /></>;
  if (!data) return <><PageHeading config={config} action={action} /><BusyState error={error} onRetry={load} /></>;

  return <><PageHeading config={config} action={action} />
    {kind === "dashboard" ? <Dashboard data={data} reload={load} /> :
      kind === "application" ? <NewApplication data={data} setMessage={setMessage} /> :
      kind === "documents" || kind === "documentReview" ? <Documents data={data} aiEnabled={aiEnabled} setMessage={setMessage} onLeaseConfirm={confirmLease} /> :
      kind === "design" ? <DesignSystem /> :
      <ReportsAndFallback kind={kind} data={data} setMessage={setMessage} aiEnabled={aiEnabled} setAiEnabled={setAiEnabled} usersOnly={usersOnly} />}
    <Toast message={message} onClose={() => setMessage("")} />
  </>;
}

function DesignSystem() {
  return <div className="design-system"><Card title="Status and action badges"><div className="design-row">{["success", "warning", "danger", "info", "neutral", "ai", "review"].map((variant) => <Badge variant={variant} key={variant}>{variant}</Badge>)}</div></Card><Card title="Ownership clock"><OwnershipClockBar institutionDays={4} officerDays={9} /></Card><Card title="Stage stepper"><StageStepper route={["Submitted", "Self-disclosure", "Scrutiny", "Re-Scrutiny", "EVC", "Decision"]} current="Scrutiny" holder="Officer" /></Card><Card title="AI field states"><div className="design-row"><AIFieldRow label="High confidence" value="14 March 2027" confidence={.96} /><AIFieldRow label="Please check" value="14 March 2027" confidence={.72} /><AIFieldRow label="Low confidence" value="" confidence={.42} /><AIFieldRow label="Manual entry" value="" aiEnabled={false} /></div></Card><Card title="Deadline states"><div className="design-row"><DeadlineBadge deadline="2026-10-25" now={new Date("2026-10-26T10:00:00")} /><DeadlineBadge deadline="2026-11-02" now={new Date("2026-10-26T10:00:00")} /><DeadlineBadge deadline={null} /></div></Card><Card title="Action Score"><ScoreGauge score={63} onBreakdown={() => {}} /><p>Score band labels are “Lower action burden”, “Attention needed”, and “High action burden”.</p></Card></div>;
}
