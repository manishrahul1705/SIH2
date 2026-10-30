const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";
const CASE_EVENT_TYPES = [
  "case.created", "case.draft_updated", "case.submitted", "case.updated", "case.stage_moved",
  "case.stage_advanced", "case.returned", "case.resubmitted", "case.document_ai_ready",
  "case.document_ai_failed", "case.document_confirmation_updated", "case.route_updated",
  "case.holder_assigned", "case.preliminary_updated", "case.task_created", "case.task_completed",
  "case.finding_raised", "case.finding_resolved", "case.evc_report_uploaded",
  "case.decision_recorded", "case.obligation_created", "case.obligation_closed",
  "case.notification_requested", "document.confirmed", "document.analyzed",
  "case.stage_workflow_activated", "case.stage_assist_requested", "case.stage_assist_decided",
  "case.stage_approved", "case.stage_returned", "case.stage_resubmitted", "case.final_approved",
  "case.stage_overdue_alert_created", "document.quarantined", "document.verified", "obligation.evidence_submitted",
  "obligation.evidence_verified", "case.evc_inspection_scheduled", "case.evc_rejected",
];

async function request(path, { method = "GET", body, formData } = {}) {
  const headers = {};
  if (method !== "GET") headers["X-Requested-With"] = "XMLHttpRequest";
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(formData ? { body: formData } : {}),
    });
  } catch {
    throw new Error("Cannot reach the ApprovalTrack backend. Start it and try again.");
  }

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const details = result?.error?.details;
    const detailMessage = Array.isArray(details)
      ? details.map((item) => item.label || item.message).filter(Boolean).join(", ")
      : "";
      const error = new Error(detailMessage || result?.error?.message || `Request failed (${response.status}).`);
      error.code = result?.error?.code;
      throw error;
  }
  return result?.data;
}

async function downloadDocumentBlob(id) {
  let response;
  try {
    response = await fetch(caseWorkflowApi.getDocumentDownloadUrl(id), { credentials: "include" });
  } catch {
    throw new Error("Cannot reach the ApprovalTrack backend. Start it and try again.");
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error?.message || `Document preview failed (${response.status}).`);
  }
  return response.blob();
}

export const caseWorkflowApi = {
  getApplicationTypes: () => request("/application-types"),
  previewChecklist: (body) => request("/checklist/preview", { method: "POST", body }),
  createDraft: (body) => request("/applications", { method: "POST", body }),
  listCases: ({ page = 1, pageSize = 100 } = {}) => request(`/cases?page=${page}&pageSize=${pageSize}`),
  listDocuments: ({ page = 1, pageSize = 100 } = {}) => request(`/documents?page=${page}&pageSize=${pageSize}`),
  listAlerts: ({ page = 1, pageSize = 100, status } = {}) => request(`/alerts?page=${page}&pageSize=${pageSize}${status ? `&status=${encodeURIComponent(status)}` : ""}`),
  getDocumentDownloadUrl: (id) => `${API_BASE_URL}/documents/${encodeURIComponent(id)}/download`,
  downloadDocument: downloadDocumentBlob,
  updateAlertStatus: (id, status) => request(`/alerts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status },
  }),
  getCaseDocuments: (id) => request(`/cases/${encodeURIComponent(id)}/documents`),
  updateDraft: (id, body) => request(`/cases/${encodeURIComponent(id)}`, { method: "PUT", body }),
  getCase: (id) => request(`/cases/${encodeURIComponent(id)}`),
  getCaseHistory: (id) => request(`/cases/${encodeURIComponent(id)}/history`),
  getChecklist: (id) => request(`/cases/${encodeURIComponent(id)}/checklist`),
  getCaseFindings: (id) => request(`/cases/${encodeURIComponent(id)}/findings`),
  getCaseProcessing: (id) => request(`/cases/${encodeURIComponent(id)}/processing`),
  getMyAssistRequests: () => request("/assist-requests/my"),
  getStageAssignees: (id, stageIndex, role) => request(`/cases/${encodeURIComponent(id)}/stages/${stageIndex}/assignees?role=${encodeURIComponent(role)}`),
  requestStageAssist: (id, stageIndex, body) => request(`/cases/${encodeURIComponent(id)}/stages/${stageIndex}/request-assist`, { method: "POST", body }),
  decideStageAssist: (id, assistId, body) => request(`/cases/${encodeURIComponent(id)}/assist-requests/${encodeURIComponent(assistId)}/decide`, { method: "POST", body }),
  approveStage: (id, stageIndex, body) => request(`/cases/${encodeURIComponent(id)}/stages/${stageIndex}/approve`, { method: "POST", body }),
  rejectStage: (id, stageIndex, body) => request(`/cases/${encodeURIComponent(id)}/stages/${stageIndex}/reject`, { method: "POST", body }),
  evaluateCasePipeline: (id, body) => request(`/cases/${encodeURIComponent(id)}/pipeline/evaluate`, { method: "POST", body }),
  advanceCase: (id, body) => request(`/cases/${encodeURIComponent(id)}/advance`, { method: "POST", body }),
  verifyDocument: (id, body) => request(`/documents/${encodeURIComponent(id)}/verify`, { method: "POST", body }),
  uploadEvcReport: (id, file) => {
    const formData = new FormData();
    formData.append("file", file);
    return request(`/cases/${encodeURIComponent(id)}/evc-report`, { method: "POST", formData });
  },
  subscribeToCaseEvents: (onEvent, onError) => {
    if (typeof EventSource === "undefined") return () => {};
    const source = new EventSource(`${API_BASE_URL}/cases/events`, { withCredentials: true });
    for (const eventType of CASE_EVENT_TYPES) {
      source.addEventListener(eventType, (event) => {
        let payload = {};
        try {
          payload = JSON.parse(event.data);
        } catch {
          onError?.(new Error("A case update could not be read."));
        }
        onEvent({ type: eventType, payload });
      });
    }
    source.onerror = () => onError?.(new Error("Live case updates are temporarily unavailable."));
    return () => source.close();
  },
  analyzeCaseDocuments: (id) => request(`/cases/${encodeURIComponent(id)}/documents/analyze`, { method: "POST", body: {} }),
  uploadDocument: (id, slotId, file) => {
    const formData = new FormData();
    formData.append("doc_type_slot", slotId);
    formData.append("file", file);
    return request(`/cases/${encodeURIComponent(id)}/documents`, { method: "POST", formData });
  },
  getExtraction: (documentId) => request(`/documents/${encodeURIComponent(documentId)}/extraction`),
  confirmFields: (documentId, fields, complete = false, resolvedAmbiguities = [], caseId) => request(
    caseId
      ? `/applications/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/confirm-fields`
      : `/documents/${encodeURIComponent(documentId)}/confirm`,
    {
      method: caseId ? "PATCH" : "POST",
      body: { fields, complete, resolved_ambiguities: resolvedAmbiguities },
    },
  ),
  submitCase: (id, expectedVersion) => request(`/cases/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    body: { expectedVersion },
  }),
  resubmitCase: (id, expectedVersion) => request(`/cases/${encodeURIComponent(id)}/resubmit`, {
    method: "POST",
    body: { expectedVersion },
  }),
  recordDecision: (id, body) => request(`/cases/${encodeURIComponent(id)}/decision`, { method: "POST", body }),
};

const completedAnalysisStatuses = new Set([
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "AI_FAILED",
  "REJECTED",
  "SUPERSEDED",
  "QUARANTINED",
]);

const routeReadySlotStatuses = new Set([
  "pending_confirmation",
  "confirmed",
  "verified",
  "rejected",
  "expired",
  "quarantined",
]);

export function areUploadedDocumentsReadyForRoute(slots) {
  const uploadedSlots = slots.filter((slot) => slot.documentId);
  return uploadedSlots.length > 0
    && uploadedSlots.every((slot) => routeReadySlotStatuses.has(String(slot.status).toLowerCase()));
}

function isoDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

export function ambiguousDateChoices(field) {
  const source = `${field.source_text || ""} ${field.ai_value || ""}`;
  const match = source.match(/(?:^|\D)(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})(?!\d)/);
  if (!match) return [];
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  if (first === second || first > 12 || second > 12) return [];
  const choices = [
    { value: isoDate(year, second, first), label: `${first}/${second}/${year} (day/month/year)` },
    { value: isoDate(year, first, second), label: `${second}/${first}/${year} (month/day/year)` },
  ].filter((choice) => choice.value);
  return choices;
}

export async function waitForDocumentAnalysis(documentId, {
  intervalMs = 1500,
  timeoutMs = 120000,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await caseWorkflowApi.getExtraction(documentId);
    const status = result?.document?.status;
    if (!status) throw new Error("The document analysis status is unavailable.");
    if (completedAnalysisStatuses.has(status)) return result;
    if (Date.now() >= deadline) {
      throw new Error("Document analysis is taking longer than expected. It may still be processing; refresh the AI suggestions to check again.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForDocumentBatch(documents, { onProgress, ...options } = {}) {
  let completed = 0;
  const total = documents.length;
  return Promise.all(documents.map(async (document) => {
    const result = await waitForDocumentAnalysis(document.document_id, options);
    completed += 1;
    onProgress?.({ completed, total, document });
    return { document, result };
  }));
}
