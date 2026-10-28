import { createContext, useContext, useMemo, useState } from "react";
import {
  complaintCategories,
  departmentRoster,
  facultyProfile,
  sampleComplaints,
  sampleYearlyReports,
} from "../data/mockStakeholderData";
import { useAppStore } from "../store/useAppStore";

const STORAGE_KEY = "approvaltrack-stakeholder-demo";
const StakeholderContext = createContext(null);

function readStoredState(storageKey) {
  const saved = window.localStorage.getItem(storageKey);
  return saved ? JSON.parse(saved) : null;
}

function initialState(storageKey) {
  const saved = readStoredState(storageKey);
  return {
    complaints: saved?.complaints || sampleComplaints,
    reports: saved?.reports || sampleYearlyReports,
  };
}

export function StakeholderProvider({ children }) {
  const user = useAppStore((store) => store.user);
  const storageKey = `${STORAGE_KEY}:${user?.id || "anonymous"}`;
  const [state, setState] = useState(() => initialState(storageKey));

  function persist(next) {
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    setState(next);
  }

  const authenticatedRole = useAppStore((store) => store.role);
  const role = authenticatedRole === "Faculty" ? "faculty" : "student";

  function addComplaint(form) {
    const sequence = state.complaints.length + 483;
    const now = new Date();
    const complaint = {
      ...form,
      id: `CMP-${now.getFullYear()}-${String(sequence).padStart(5, "0")}`,
      role,
      createdAt: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString().slice(0, 10),
      status: form.privacyMode === "confidential" ? "Regional Scrutiny" : "Submitted",
      stage: form.privacyMode === "confidential" ? 1 : 0,
      officerRemark: "Submission received. No statutory or compliance finding has been made.",
      attachments: (form.attachments || []).map(({ name, size, type }) => ({ name, size, type })),
    };
    persist({ ...state, complaints: [complaint, ...state.complaints] });
    return complaint;
  }

  function escalateComplaint(id) {
    const complaint = state.complaints.find((item) => item.id === id);
    if (!complaint) throw new Error(`Complaint not found: ${id}`);
    const updated = state.complaints.map((item) => item.id === id
      ? {
          ...item,
          stage: Math.max(item.stage, 2),
          status: "Escalated to AICTE Regional Officer",
          updatedAt: new Date().toISOString().slice(0, 10),
          officerRemark: "Escalation request recorded for human review by the designated regional office.",
        }
      : item);
    persist({ ...state, complaints: updated });
  }

  function saveReport(form, submit = false) {
    const id = form.id || `FYR-${form.academic_year}-${String(state.reports.length + 1).padStart(4, "0")}`;
    const existing = state.reports.find((report) => report.id === id);
    const report = {
      ...form,
      id,
      year: form.academic_year,
      status: submit ? "Submitted to HOD" : "Draft",
      submittedAt: submit ? new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : existing?.submittedAt || "",
      returnedReason: "",
      summary: `${form.courses_taught?.length || 0} courses, ${form.publications?.length || 0} publications, ${form.fdp_certifications?.length || 0} FDP records.`,
    };
    const reports = existing
      ? state.reports.map((item) => item.id === id ? report : item)
      : [report, ...state.reports];
    persist({ ...state, reports });
    return report;
  }

  const value = useMemo(() => ({
    role,
    complaints: state.complaints,
    reports: state.reports,
    categories: complaintCategories[role],
    departments: [...departmentRoster.map((item) => item.department), "Campus-Wide / Administration"],
    faculty: facultyProfile,
    addComplaint,
    escalateComplaint,
    saveReport,
  }), [state, role]);

  return <StakeholderContext.Provider value={value}>{children}</StakeholderContext.Provider>;
}

export function useStakeholder() {
  const context = useContext(StakeholderContext);
  if (!context) throw new Error("useStakeholder must be used within StakeholderProvider");
  return context;
}
