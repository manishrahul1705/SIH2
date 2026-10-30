const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

async function request(path, { method = "GET", body, multipart = false } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(method !== "GET" ? { "X-Requested-With": "XMLHttpRequest" } : {}),
        ...(body !== undefined && !multipart ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
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
  uploadYearlyReportEvidence: (id, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/yearly-reports/${encodeURIComponent(id)}/evidence`, { method: "POST", body: form, multipart: true });
  },
  async downloadYearlyReportEvidence(reportId, evidenceId) {
    const response = await fetch(`${API_BASE_URL}/yearly-reports/${encodeURIComponent(reportId)}/evidence/${encodeURIComponent(evidenceId)}`, { credentials: "include" });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error?.message || `Download failed (${response.status}).`);
    }
    return response.blob();
  },
  getInstitutionAnnualReports: () => request("/institution-annual-reports?page=1&pageSize=100"),
  saveInstitutionAnnualReport: (report) => request("/institution-annual-reports", { method: "POST", body: report }),
  submitInstitutionAnnualReport: (id) => request(`/institution-annual-reports/${encodeURIComponent(id)}/submit`, { method: "PATCH", body: {} }),
  uploadInstitutionAnnualReportEvidence: (id, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/institution-annual-reports/${encodeURIComponent(id)}/evidence`, { method: "POST", body: form, multipart: true });
  },
  async downloadInstitutionAnnualReportEvidence(reportId, evidenceId) {
    const response = await fetch(`${API_BASE_URL}/institution-annual-reports/${encodeURIComponent(reportId)}/evidence/${encodeURIComponent(evidenceId)}`, { credentials: "include" });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error?.message || `Download failed (${response.status}).`);
    }
    return response.blob();
  },
  getAnnouncements: () => request("/announcements?page=1&pageSize=50"),
  createAnnouncement: (announcement) => request("/announcements", { method: "POST", body: announcement }),
  updateAnnouncement: (id, announcement) => request(`/announcements/${encodeURIComponent(id)}`, { method: "PATCH", body: announcement }),
  getComplaints: () => request("/complaints?page=1&pageSize=100"),
  getMyComplaints: () => request("/complaints/my-complaints?page=1&pageSize=100"),
  getComplaintInstitutions: () => request("/complaints/institutions"),
  createComplaint: (complaint) => request("/complaints", { method: "POST", body: complaint }),
  getAdminComplaintSummary: () => request("/complaints/admin/colleges-summary"),
  getAdminCollegeComplaints: (institutionId) => request(`/complaints/admin/colleges/${encodeURIComponent(institutionId)}`),
  acknowledgeComplaint: (id, admin_remarks, evidence_reviewed) => request(`/complaints/admin/${encodeURIComponent(id)}/acknowledge`, { method: "POST", body: { admin_remarks, evidence_reviewed } }),
  resolveComplaint: (id, resolution_note) => request(`/complaints/admin/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { resolution_note } }),
  getInstitutionComplaints: () => request("/complaints/institution/my-college?page=1&pageSize=100"),
  replyToComplaint: (id, action_taken_report, file) => {
    const form = new FormData();
    form.append("action_taken_report", action_taken_report);
    if (file) form.append("file", file);
    return request(`/complaints/institution/${encodeURIComponent(id)}/reply`, { method: "POST", body: form, multipart: true });
  },
  updateComplaint: (id, update) => request(`/complaints/${encodeURIComponent(id)}`, { method: "PATCH", body: update }),
  submitStudentAppeal: (id, appeal) => request(`/complaints/${encodeURIComponent(id)}/appeals`, { method: "POST", body: appeal }),
  updateAppeal: (id, update) => request(`/complaints/${encodeURIComponent(id)}/appeals`, { method: "PATCH", body: update }),
  uploadComplaintEvidence: (id, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/complaints/${encodeURIComponent(id)}/evidence`, { method: "POST", body: form, multipart: true });
  },
  async downloadComplaintEvidence(complaintId, evidenceId) {
    const response = await fetch(`${API_BASE_URL}/complaints/${encodeURIComponent(complaintId)}/evidence/${encodeURIComponent(evidenceId)}`, { credentials: "include" });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error?.message || `Download failed (${response.status}).`);
    }
    return response.blob();
  },
};

export function reportSummary(report) {
  const data = report.report_data || {};
  const count = (value) => Array.isArray(value) ? value.length : 0;
  return `${count(data.courses_taught)} courses, ${count(data.publications)} publications, ${count(data.fdp_certifications)} FDP records.`;
}
