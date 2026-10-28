const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

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
    throw new Error(detailMessage || result?.error?.message || `Request failed (${response.status}).`);
  }
  return result?.data;
}

export const caseWorkflowApi = {
  getApplicationTypes: () => request("/application-types"),
  previewChecklist: (body) => request("/checklist/preview", { method: "POST", body }),
  createDraft: (body) => request("/cases", { method: "POST", body }),
  listCases: ({ page = 1, pageSize = 100 } = {}) => request(`/cases?page=${page}&pageSize=${pageSize}`),
  listDocuments: ({ page = 1, pageSize = 100 } = {}) => request(`/documents?page=${page}&pageSize=${pageSize}`),
  listAlerts: ({ page = 1, pageSize = 100 } = {}) => request(`/alerts?page=${page}&pageSize=${pageSize}`),
  getDocumentDownloadUrl: (id) => `${API_BASE_URL}/documents/${encodeURIComponent(id)}/download`,
  updateAlertStatus: (id, status) => request(`/alerts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status },
  }),
  getCaseDocuments: (id) => request(`/cases/${encodeURIComponent(id)}/documents`),
  updateDraft: (id, body) => request(`/cases/${encodeURIComponent(id)}`, { method: "PUT", body }),
  getCase: (id) => request(`/cases/${encodeURIComponent(id)}`),
  getChecklist: (id) => request(`/cases/${encodeURIComponent(id)}/checklist`),
  analyzeCaseDocuments: (id) => request(`/cases/${encodeURIComponent(id)}/documents/analyze`, { method: "POST", body: {} }),
  uploadDocument: (id, slotId, file) => {
    const formData = new FormData();
    formData.append("doc_type_slot", slotId);
    formData.append("file", file);
    return request(`/cases/${encodeURIComponent(id)}/documents`, { method: "POST", formData });
  },
  getExtraction: (documentId) => request(`/documents/${encodeURIComponent(documentId)}/extraction`),
  confirmFields: (documentId, fields, complete = false) => request(`/documents/${encodeURIComponent(documentId)}/confirm`, {
    method: "POST",
    body: { fields, complete },
  }),
  submitCase: (id, expectedVersion) => request(`/cases/${encodeURIComponent(id)}/submit`, {
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
]);

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
