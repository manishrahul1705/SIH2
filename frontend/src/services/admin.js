const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

async function adminRequest(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Cannot reach the ApprovalTrack backend. Check that it is running.");
  }

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your admin session expired. Sign in again.");
    throw new Error(result?.error?.message || `Admin request failed (${response.status}).`);
  }
  return result;
}

export const adminApi = {
  async getUsers(page = 1, pageSize = 100) {
    const result = await adminRequest(`/admin/users?page=${page}&pageSize=${pageSize}`);
    return { users: result.data, meta: result.meta };
  },
  async getInstitutions() {
    const result = await adminRequest("/admin/institutions?page=1&pageSize=100");
    return result.data;
  },
  async createUser(user) {
    const result = await adminRequest("/admin/users", { method: "POST", body: user });
    return result.data;
  },
  async setUserStatus(userId, status) {
    const result = await adminRequest(`/admin/users/${encodeURIComponent(userId)}/status`, {
      method: "PATCH",
      body: { status },
    });
    return result.data;
  },
  async getRules() {
    const result = await adminRequest("/admin/rules");
    return result.data;
  },
  async updateRule(ruleId, rule) {
    const result = await adminRequest(`/admin/rules/${encodeURIComponent(ruleId)}`, {
      method: "PATCH",
      body: rule,
    });
    return result.data;
  },
  async listIncidents(filters = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const result = await adminRequest(`/admin/incidents?${query.toString()}`);
    return { ...result.data, meta: result.meta };
  },
  async createIncident(body) {
    const result = await adminRequest("/admin/incidents", { method: "POST", body });
    return result.data;
  },
  async getApplicationIncidents(workflowType, applicationId) {
    const result = await adminRequest(`/admin/incidents/${encodeURIComponent(workflowType)}/${encodeURIComponent(applicationId)}`);
    return result.data;
  },
  async actOnIncident(incidentId, body) {
    const result = await adminRequest(`/admin/incidents/${encodeURIComponent(incidentId)}/actions`, {
      method: "POST",
      body,
    });
    return result.data;
  },
};

export const adminRoleLabels = Object.freeze({
  INSTITUTION: "Institution",
  SCRUTINY_OFFICER: "Scrutiny Officer",
  EVC: "EVC Member",
  EVC_CHAIRMAN: "EVC Chairman",
  SAC_SHC: "SAC / SHC Member",
  BUREAU_OFFICER: "Bureau Officer",
  SENIOR_AUTHORITY: "Senior Authority",
  ADMIN: "Admin",
  STUDENT: "Student",
  FACULTY: "Faculty",
  GRIEVANCE_OFFICER: "Institution Grievance Officer",
  OMBUDSPERSON: "Ombudsperson",
  UNIVERSITY_DTE_OFFICER: "University/DTE Officer",
});
