const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

export const backendRoleToWorkspace = Object.freeze({
  INSTITUTION: "Institution user",
  SCRUTINY_OFFICER: "Scrutiny / Regional officer",
  EVC: "EVC member",
  EVC_CHAIRMAN: "EVC chairman",
  SAC_SHC: "SAC/SHC member",
  BUREAU_OFFICER: "Competent authority",
  SENIOR_AUTHORITY: "Senior authority",
  ADMIN: "Admin",
  STUDENT: "Student",
  FACULTY: "Faculty",
  GRIEVANCE_OFFICER: "Grievance officer",
  OMBUDSPERSON: "Ombudsperson",
  UNIVERSITY_DTE_OFFICER: "University/DTE Officer",
});

export function workspaceRoleFor(user) {
  const role = backendRoleToWorkspace[user?.role];
  if (!role) throw new Error("This account has an unsupported role. Contact your administrator.");
  return role;
}

async function request(path, { method = "GET", body } = {}) {
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
    throw new Error("Cannot reach the ApprovalTrack backend. Start the backend and try again.");
  }

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Email or password is incorrect, or your session has expired.");
    throw new Error(result?.error?.message || "Sign-in failed. Please try again.");
  }
  return result?.data;
}

export const authApi = {
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  me: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
};
