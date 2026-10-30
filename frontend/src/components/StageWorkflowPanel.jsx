import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { caseWorkflowApi } from "../services/caseWorkflow";

const roleNames = {
  INSTITUTION: "Institution",
  SCRUTINY_OFFICER: "Scrutiny / Regional Officer",
  EVC: "EVC Member",
  SAC_SHC: "SAC/SHC Officer",
  BUREAU_OFFICER: "Bureau Officer",
  ADMIN: "Administrator",
};

const statusNames = {
  PENDING: "Pending",
  ACTIVE: "Active",
  FROZEN_WAITING_FOR_ASSIST: "Frozen for assistance",
  ACTIVE_UNFROZEN: "Active — assistance complete",
  INSPECTION_SCHEDULED: "Inspection scheduled",
  WAITING_FOR_APPROVAL: "Waiting for EVC approval",
  APPROVED: "Approved",
  REJECTED: "Returned for correction",
};

const assistRoles = ["SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "INSTITUTION"];

function isOwner(stage, role, user, record) {
  const stageRoleMatches = stage?.assignedRole === role
    || stage?.assignedRole === "EVC" && role === "EVC_CHAIRMAN";
  if (!stage || !stageRoleMatches) return false;
  const userId = String(user?.id || user?._id || "");
  if (!userId) return false;
  if (String(stage.assignedUserId) === userId) return true;
  if (stage.assignedRole === "EVC" && stage.assignedPanelUserIds?.some((id) => String(id) === userId)) return true;
  if (stage.assignedUserId) return false;
  return role === "ADMIN" || !user?.region || user.region === record.region;
}

export default function StageWorkflowPanel({
  record,
  role,
  user,
  documents = [],
  canConfirmFields = false,
  savingDocument = "",
  onConfirmFields,
  showExtractedFields = true,
  showStepper = true,
  showHeading = true,
}) {
  const navigate = useNavigate();
  const [targetRole, setTargetRole] = useState("EVC");
  const [assignees, setAssignees] = useState([]);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [requestNote, setRequestNote] = useState("");
  const [remarks, setRemarks] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [assistRemarks, setAssistRemarks] = useState("");
  const [undertakingTitle, setUndertakingTitle] = useState("");
  const [undertakingDueAt, setUndertakingDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingDocumentId, setEditingDocumentId] = useState("");
  const [editingValues, setEditingValues] = useState({});

  const stage = record.allocatedStages?.[record.currentStageIndex];
  const owner = isOwner(stage, role, user, record);
  const frozen = stage?.status === "FROZEN_WAITING_FOR_ASSIST";
  const assignedAssist = useMemo(() => (record.allocatedStages || [])
    .flatMap((item, stageIndex) => (item.assistRequests || []).map((assist) => ({ ...assist, stageIndex, stageName: item.name })))
    .find((assist) => assist.status === "PENDING_ASSIST_DECISION"
      && String(assist.assignedToUserId) === String(user?.id || user?._id)), [record.allocatedStages, user]);

  useEffect(() => {
    let active = true;
    if (!stage || !owner || frozen) return undefined;
    caseWorkflowApi.getStageAssignees(record._id, record.currentStageIndex, targetRole)
      .then((items) => {
        if (!active) return;
        setAssignees(items);
        setAssignedToUserId((current) => items.some((item) => String(item._id) === current) ? current : String(items[0]?._id || ""));
      })
      .catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [record._id, record.currentStageIndex, stage?.status, owner, frozen, targetRole]);

  if (!record.workflowVersion || !stage) return null;

  async function runAction(action, successMessage) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(successMessage);
      navigate("/cases", { replace: true });
    } catch (actionError) {
      setError(actionError.message || "The stage action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function requestAssist(event) {
    event.preventDefault();
    if (!assignedToUserId) {
      setError("Select an active user in the target role.");
      return;
    }
    return runAction(() => caseWorkflowApi.requestStageAssist(record._id, record.currentStageIndex, {
      expectedVersion: record.version,
      targetRole,
      assignedToUserId,
      note: requestNote,
      assistSlaDays: 3,
    }), "The stage is frozen and the assistance request was assigned.");
  }

  function approveStage(event) {
    event.preventDefault();
    const conditions = undertakingTitle.trim()
      ? [{ title: undertakingTitle.trim(), ...(undertakingDueAt ? { dueAt: new Date(undertakingDueAt).toISOString() } : {}) }]
      : [];
    return runAction(() => caseWorkflowApi.approveStage(record._id, record.currentStageIndex, {
      expectedVersion: record.version,
      remarks,
      conditions,
    }), stage.key === "final_approval" ? "Final approval recorded and the institution was notified." : "Stage approved and advanced to the next owner.");
  }

  function rejectStage(event) {
    event.preventDefault();
    return runAction(() => caseWorkflowApi.rejectStage(record._id, record.currentStageIndex, {
      expectedVersion: record.version,
      reason: rejectReason,
    }), "The application was returned to the institution with the recorded reason.");
  }

  function decideAssist(outcome) {
    return runAction(() => caseWorkflowApi.decideStageAssist(record._id, assignedAssist._id, {
      expectedVersion: record.version,
      outcome,
      remarks: assistRemarks,
    }), `Assistance ${outcome === "ASSIST_APPROVED" ? "approved" : "rejected"}; the stage owner can proceed.`);
  }

  const lastAssist = [...(stage.assistRequests || [])].reverse().find((item) => item.status !== "PENDING_ASSIST_DECISION");
  const hasActiveStageActions = owner && !frozen && ["ACTIVE", "ACTIVE_UNFROZEN"].includes(stage.status);
  const hasWorkflowContent = showHeading || showExtractedFields || showStepper || frozen && owner || lastAssist || assignedAssist || hasActiveStageActions || error || message;
  const reviewFields = documents.flatMap((document) => (document.extraction?.fields || [])
    .filter((field) => /^(issue_date|valid_from|valid_to|expiry_date|lease_start|lease_end|lease_term|lessor|lessee)$/i.test(field.field_name))
    .map((field) => ({ ...field, document, documentId: document._id, documentName: document.original_name, documentType: document.extraction?.m1_type || document.doc_type_final || document.doc_type_slot })));
  const reviewDocuments = [...new Map(reviewFields.map((field) => [String(field.documentId), field.document])).values()];

  if (!hasWorkflowContent) return null;

  return <section className="stage-workflow-panel" aria-label={showHeading ? "Allocated stage review" : "Case stage actions"}>
    {showHeading && <header className="stage-workflow-heading">
      <div>
        <p className="eyebrow">DETERMINISTIC WORKFLOW · {record.workflowVersion}</p>
        <h2>Stage review: {stage.name}</h2>
        <p>Stage {record.currentStageIndex + 1} of {record.allocatedStages.length} · {stage.slaDays}-day service target</p>
      </div>
      <span className={`stage-workflow-badge stage-${stage.status?.toLowerCase()}`}>{statusNames[stage.status] || stage.status}</span>
    </header>}

    {showExtractedFields && <section className="stage-extracted-fields" aria-label="Extracted fields review">
      <h3>Extracted fields & human confirmation</h3>
      {reviewFields.length
        ? <>
          {canConfirmFields && <div className="button-group stage-field-actions">{reviewDocuments.map((document) => {
            const isEditing = editingDocumentId === String(document._id);
            const isSaving = savingDocument === document._id;
            return <button
              className="button button-secondary button-small"
              type="button"
              key={document._id}
              disabled={isSaving}
              onClick={async () => {
                if (!isEditing) {
                  setEditingDocumentId(String(document._id));
                  setEditingValues(Object.fromEntries(reviewFields
                    .filter((field) => String(field.documentId) === String(document._id))
                    .map((field) => [field.field_name, field.confirmed_value ?? field.ai_value ?? ""])));
                  return;
                }
                const names = reviewFields.filter((field) => String(field.documentId) === String(document._id)).map((field) => field.field_name);
                const saved = await onConfirmFields(document, names, editingValues);
                if (saved !== false) {
                  setEditingDocumentId("");
                  setEditingValues({});
                }
              }}
            >{isSaving ? "Saving…" : isEditing ? "Save & confirm fields" : "Edit / confirm fields"}</button>;
          })}</div>}
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Document / field</th><th>Extracted value</th><th>Confidence</th><th>Human status</th></tr></thead><tbody>
          {reviewFields.map((field) => {
            const confidence = Number(field.ai_confidence);
            const confidenceClass = Number.isFinite(confidence) && confidence >= 0.9 ? "high" : Number.isFinite(confidence) && confidence >= 0.7 ? "medium" : "low";
            const value = field.confirmed_value ?? field.ai_value ?? "";
            return <tr key={`${field.documentId}:${field.field_name}`}>
              <td><strong>{field.documentType?.replaceAll("_", " ")}</strong><small>{field.field_name.replaceAll("_", " ")} · {field.documentName}</small></td>
              <td>{canConfirmFields && editingDocumentId === String(field.documentId)
                ? <input
                  type="text"
                  aria-label={`${field.field_name.replaceAll("_", " ")} for ${field.documentName}`}
                  value={editingValues[field.field_name] ?? ""}
                  onChange={(event) => setEditingValues((current) => ({ ...current, [field.field_name]: event.target.value }))}
                />
                : value || "—"}</td>
              <td><span className={`field-confidence ${confidenceClass}`}>{Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : "Manual"}</span></td>
              <td>{field.confirmed_at ? `CONFIRMED · ${new Date(field.confirmed_at).toLocaleString()}` : "PENDING_CONFIRMATION"}</td>
            </tr>;
          })}
          </tbody></table></div>
        </>
        : <p className="muted">No extracted document fields are available yet.</p>}
    </section>}

    {frozen && owner && <div className="stage-freeze-banner" role="status">
      <strong>Application Frozen for Your Stage</strong>
      <span>Waiting for a decision from {stage.assistRequests?.find((item) => item.status === "PENDING_ASSIST_DECISION")?.assignedToName || roleNames[stage.assistRequests?.find((item) => item.status === "PENDING_ASSIST_DECISION")?.targetRole] || "the assigned reviewer"}. You can proceed only after they respond.</span>
      <p>Approve, return, and request-assistance actions are disabled while this stage is frozen.</p>
    </div>}

    {lastAssist && <div className={`stage-assist-result ${lastAssist.status === "ASSIST_APPROVED" ? "approved" : "rejected"}`}>
      <strong>{lastAssist.status === "ASSIST_APPROVED" ? "Assistance approved" : "Assistance rejected"} by {lastAssist.decidedByName || roleNames[lastAssist.targetRole] || lastAssist.targetRole}</strong>
      <span>{lastAssist.remarks || "No remarks supplied."}</span>
    </div>}

    {showStepper && <ol className="stage-workflow-stepper">
      {record.allocatedStages.map((item, index) => <li className={`stage-step-item ${item.status.toLowerCase()} ${index === record.currentStageIndex ? "current" : ""}`} key={item.key}>
        <span className="stage-step-index">{index + 1}</span>
        <span className="stage-step-copy"><strong>{item.name}</strong><small>{roleNames[item.assignedRole] || item.assignedRole} · {item.slaDays} days</small></span>
        <span className="stage-step-status">{statusNames[item.status] || item.status}</span>
      </li>)}
    </ol>}

    {assignedAssist && <div className="stage-assist-decision">
      <h3>Assistance assigned to you</h3>
      <p>{assignedAssist.stageName}: {assignedAssist.note}</p>
      <p>Due {new Date(assignedAssist.assistDueAt).toLocaleString()}</p>
      <label className="field-label">Review remarks<textarea value={assistRemarks} onChange={(event) => setAssistRemarks(event.target.value)} placeholder="Explain your verification or reason for rejection" /></label>
      <div className="button-group">
        <button className="button button-primary" type="button" disabled={busy} onClick={() => decideAssist("ASSIST_APPROVED")}>{busy ? "Saving…" : "Approve Assist Request"}</button>
        <button className="button button-danger" type="button" disabled={busy || !assistRemarks.trim()} onClick={() => decideAssist("ASSIST_REJECTED")}>Reject Assist Request</button>
      </div>
    </div>}

    {owner && !frozen && ["ACTIVE", "ACTIVE_UNFROZEN"].includes(stage.status) && <div className="stage-owner-actions">
      <form className="stage-action-card" onSubmit={approveStage}>
        <h3>{stage.key === "final_approval" ? "Final Approval" : "Approve Stage & Move to Next"}</h3>
        <label className="field-label">Approval remarks<textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Record the stage review outcome" /></label>
        {stage.key === "final_approval" && <div className="stage-conditional-undertaking">
          <strong>Optional post-approval undertaking</strong>
          <label className="field-label">Undertaking title<input value={undertakingTitle} onChange={(event) => setUndertakingTitle(event.target.value)} placeholder="Conditional approval obligation" /></label>
          {undertakingTitle.trim() && <label className="field-label">Due date<input type="date" value={undertakingDueAt} onChange={(event) => setUndertakingDueAt(event.target.value)} /></label>}
        </div>}
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : stage.key === "final_approval" ? "Approve Application" : "Approve Stage & Move to Next"}</button>
      </form>

      <form className="stage-action-card" onSubmit={rejectStage}>
        <h3>Reject / Raise Deficiency</h3>
        <label className="field-label">Written reason (required)<textarea required minLength={1} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="Explain what the institution must correct" /></label>
        <button className="button button-danger" type="submit" disabled={busy || !rejectReason.trim()}>{busy ? "Saving…" : "Return to Institution"}</button>
      </form>

      <form className="stage-action-card" onSubmit={requestAssist}>
        <h3>Request Another User / Stage Help</h3>
        <label className="field-label">Target role<select value={targetRole} onChange={(event) => setTargetRole(event.target.value)}>{assistRoles.map((item) => <option value={item} key={item}>{roleNames[item]}</option>)}</select></label>
        <label className="field-label">Assign to<select required value={assignedToUserId} onChange={(event) => setAssignedToUserId(event.target.value)}>
          {assignees.map((item) => <option value={item._id} key={item._id}>{item.name} · {item.email}</option>)}
          {!assignees.length && <option value="">No active user in this role and scope</option>}
        </select></label>
        <label className="field-label">Request note<textarea required value={requestNote} onChange={(event) => setRequestNote(event.target.value)} placeholder="Describe the verification or clarification needed" /></label>
        <button className="button button-secondary" type="submit" disabled={busy || !assignedToUserId || !requestNote.trim()}>{busy ? "Sending…" : "Request Help & Freeze Stage"}</button>
      </form>
    </div>}

    {error && <p className="stage-workflow-error" role="alert">{error}</p>}
    {message && <p className="stage-workflow-success" role="status">{message}</p>}
  </section>;
}
