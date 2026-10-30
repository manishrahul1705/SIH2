const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

async function get(path) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  } catch {
    throw new Error("Cannot reach the ApprovalTrack backend. Start it and try again.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status}).`);
  return result?.data;
}

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86400000);
}

function presentCase(record) {
  const holder = record.holderType === "institution"
    ? "Institution"
    : record.holderType === "committee" ? "Committee" : "Officer";
  const elapsedDays = Math.max(0, Math.floor((Date.now() - new Date(record.stageEnteredAt).getTime()) / 86400000));
  const statusLabels = {
    draft: "Draft",
    submitted: "Submitted",
    in_progress: "In progress",
    returned: "Action required",
    approved: "Approved",
    rejected: "Rejected",
  };
  return {
    id: record.caseNo || record._id,
    caseId: record._id,
    type: record.applicationType,
    institution: record.institutionId?.name || "Institution",
    stage: record.currentStage,
    holder,
    institutionDays: holder === "Institution" ? elapsedDays : 0,
    officerDays: holder === "Institution" ? 0 : elapsedDays,
    status: statusLabels[record.status] || record.status,
    route: record.route || [],
    completedStages: record.completedStages || [],
    version: record.version,
    returnReason: record.returnReason || "",
    region: record.region,
    stageEnteredAt: record.stageEnteredAt,
    updatedAt: record.updatedAt,
  };
}

function presentDocument(document) {
  const validField = document.extraction?.fields?.find((field) => /valid|expir|lease.?end/i.test(field.field_name));
  const validTo = document.lease?.lease_end || validField?.confirmed_value || validField?.ai_value || null;
  return {
    ...document,
    id: document._id,
    type: document.doc_type_final || document.doc_type_slot || document.original_name,
    name: document.original_name,
    validTo,
    verification: document.status,
    aiFlag: ["PROCESSING", "AI_FAILED", "REJECTED"].includes(document.status),
  };
}

function presentUndertaking(item) {
  return {
    ...item,
    id: item._id,
    caseId: item.application_id,
    condition: item.title,
    dueDate: item.due_date,
    submission: item.status === "SUBMITTED" ? "Submitted" : "Not submitted",
    verification: item.status === "SUBMITTED" ? "Submitted" : "Pending",
    dueStatus: item.status === "OVERDUE" || daysUntil(item.due_date) < 0 ? "Overdue" : "Open",
    closure: item.status === "SUBMITTED" ? "Submitted" : "Open",
  };
}

function presentAlert(alert) {
  return {
    ...alert,
    id: alert._id,
    obligation: alert.title,
    recipient: alert.target_user_id,
    channel: alert.type,
    dueDate: alert.due_at,
    level: alert.severity,
    acknowledged: alert.status !== "OPEN",
  };
}

export const api = {
  async getDashboard(role) {
    const [overview, rawCases, rawDocuments, rawAlerts] = await Promise.all([
      get("/dashboard/overview"),
      get("/cases?page=1&pageSize=100"),
      get("/documents?page=1&pageSize=100"),
      get("/alerts?page=1&pageSize=100"),
    ]);
    const cases = rawCases.map(presentCase);
    const documents = rawDocuments.map(presentDocument);
    const notifications = rawAlerts.map(presentAlert);

    const optionalLists = [];
    if (["INSTITUTION", "SCRUTINY_OFFICER", "BUREAU_OFFICER", "ADMIN"].includes(role)) {
      optionalLists.push(get("/undertakings?page=1&pageSize=100").then((items) => ["undertakings", items]));
    }
    if (["EVC", "SCRUTINY_OFFICER", "BUREAU_OFFICER", "ADMIN"].includes(role)) {
      optionalLists.push(get("/visits?page=1&pageSize=100").then((items) => ["visits", items]));
    }
    if (role === "ADMIN") {
      optionalLists.push(
        get("/admin/audit-logs?page=1&pageSize=100").then((result) => ["audit", result]),
        get("/policies").then((items) => ["policyVersions", items]),
      );
    }
    if (role === "INSTITUTION") {
      optionalLists.push(get("/dashboard/action-score").then((score) => ["actionScore", score]));
    }
    if (["BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"].includes(role)) {
      optionalLists.push(get("/dashboard/analytics").then((analytics) => ["analytics", analytics]));
    }
    const optionalResults = await Promise.all(optionalLists);
    const optional = Object.fromEntries(optionalResults);
    const undertakings = (optional.undertakings || []).map(presentUndertaking);
    const openUndertakings = undertakings.filter((item) => item.submission !== "Submitted");
    const expiringDocuments = documents.filter((document) => {
      const days = daysUntil(document.validTo);
      return days !== null && days >= 0 && days <= 30;
    });

    const audit = (optional.audit || []).map((entry) => ({
      ...entry,
      id: entry._id,
      time: entry.createdAt,
      actor: entry.actor_id?.name || entry.actor_id?.email || "System",
      role: entry.actor_id?.role || "",
      caseId: entry.entity_id,
      denied: entry.outcome === "denied",
      reason: entry.after_json?.reason || "",
    }));

    return {
      cases,
      documents,
      undertakings,
      notifications,
      audit,
      evc: optional.visits || [],
      policy: {
        versions: (optional.policyVersions || []).map((policy) => ({
          ...policy,
          status: policy.status === "signed_off" ? "Signed off" : policy.status,
          signedOff: policy.signedOffAt,
        })),
        routes: {},
        timelines: {},
        applicationRoutes: {},
      },
      summary: {
        openUndertakings: openUndertakings.length,
        undertakingsDueIn7Days: openUndertakings.filter((item) => {
          const days = daysUntil(item.dueDate);
          return days !== null && days >= 0 && days <= 7;
        }).length,
        documentsExpiringIn30Days: expiringDocuments.length,
        casesInProgress: cases.filter((item) => item.status === "In progress").length,
        waitingOnOfficers: cases.filter((item) => item.holder !== "Institution").length,
        applications: overview.applications,
        openAlerts: overview.openAlerts,
      },
      analytics: optional.analytics || null,
      actionScore: optional.actionScore || null,
    };
  },
};
