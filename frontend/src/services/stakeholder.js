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
  if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status}).`);
  return result?.data;
}

export const stakeholderApi = {
  getStudentProfile: () => request("/students?page=1&pageSize=1"),
  getFacultyProfile: () => request("/faculty?page=1&pageSize=1"),
  getInstitutions: () => request("/institutions"),
  getInstitution: (id) => request(`/institutions/${encodeURIComponent(id)}`),
  getYearlyReports: () => request("/yearly-reports?page=1&pageSize=100"),
  saveYearlyReport: (report) => request("/yearly-reports", { method: "POST", body: report }),
  submitYearlyReport: (id) => request(`/yearly-reports/${encodeURIComponent(id)}/submit`, { method: "PATCH", body: {} }),
};

export function reportSummary(report) {
  const data = report.report_data || {};
  const count = (value) => Array.isArray(value) ? value.length : 0;
  return `${count(data.courses_taught)} courses, ${count(data.publications)} publications, ${count(data.fdp_certifications)} FDP records.`;
}
