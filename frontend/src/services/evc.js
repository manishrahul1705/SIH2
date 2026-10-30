const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

async function request(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(method !== "GET" ? { "X-Requested-With": "XMLHttpRequest" } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Cannot reach the ApprovalTrack backend. Start it and try again.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || `Request failed (${response.status}).`);
    error.code = result?.error?.code;
    throw error;
  }
  return result?.data;
}

export const evcApi = {
  listCases: (tab) => request(`/evc/cases?tab=${encodeURIComponent(tab)}`),
  getDashboard: () => Promise.all([
    request("/evc/cases?tab=waiting_inspection"),
    request("/evc/cases?tab=waiting_approval"),
    request("/evc/cases?tab=completed_approval"),
  ]).then(([inspection, approval, completed]) => ({ inspection, approval, completed })),
  getCase: (id) => request(`/evc/cases/${encodeURIComponent(id)}`),
  scheduleInspection: (id, body) => request(`/evc/cases/${encodeURIComponent(id)}/schedule-inspection`, { method: "POST", body }),
  rejectApplication: (id, body) => request(`/evc/cases/${encodeURIComponent(id)}/reject`, { method: "POST", body }),
  approveApplication: (id, body) => request(`/evc/cases/${encodeURIComponent(id)}/approve`, { method: "POST", body }),
};
