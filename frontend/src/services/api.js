import cases from "../data/cases.json" with { type: "json" };
import undertakings from "../data/undertakings.json" with { type: "json" };
import documents from "../data/documents.json" with { type: "json" };
import notifications from "../data/notifications.json" with { type: "json" };
import audit from "../data/audit.json" with { type: "json" };
import policy from "../data/policy.json" with { type: "json" };
import dashboard from "../data/dashboard.json" with { type: "json" };

const enrich = (items, count, factory) => Array.from({ length: count }, (_, index) => (
  items[index] ?? factory(index + 1)
));
const fullCases = enrich(cases, 40, (n) => ({
  ...cases[(n - 1) % cases.length],
  id: `AT-2026-${String(41 - n).padStart(4, "0")}`,
}));
const fullUndertakings = enrich(undertakings, 12, (n) => ({
  ...undertakings[(n - 1) % undertakings.length],
  id: `UND-${1100 + n}`,
  title: ["Update faculty roster", "Submit accessibility report", "Provide equipment log", "Renew building insurance"][(n - 1) % 4],
}));
const fullDocuments = enrich(documents, 10, (n) => ({
  ...documents[(n - 1) % documents.length],
  id: `DOC-${4000 + n}`,
}));
const fullNotifications = enrich(notifications, 20, (n) => ({
  ...notifications[(n - 1) % notifications.length],
  id: `NTF-${2000 + n}`,
}));
const fullAudit = enrich(audit, 60, (n) => ({
  ...audit[3 + ((n - 1) % 3)],
  id: `AUD-${String(61 - n).padStart(4, "0")}`,
}));

const delay = () => new Promise((resolve) => window.setTimeout(resolve, 300 + Math.floor(Math.random() * 301)));

export const mockDataCounts = {
  cases: fullCases.length,
  undertakings: fullUndertakings.length,
  documents: fullDocuments.length,
  notifications: fullNotifications.length,
  audit: fullAudit.length,
  evc: 8,
};

export const api = {
  async getDashboard() {
    await delay();
    return {
      scoreInput: { assessmentComplete: true, deductions: { undertakings: 12, nonLeaseDocuments: 14, lease: 0, evcReadiness: 5, history: 6 }, caps: { undertakings: 30, nonLeaseDocuments: 30, lease: 10, evcReadiness: 20, history: 20 } },
      projectedScore: { score: 50, date: "2026-11-25", note: "This is a calculation from known dates, not a prediction." },
      cases: fullCases,
      undertakings: fullUndertakings,
      documents: fullDocuments,
      notifications: fullNotifications,
      audit: fullAudit,
      policy,
      summary: dashboard,
      evc: Array.from({ length: 8 }, (_, i) => ({ id: `EVC-${i + 1}`, caseId: fullCases[i].id, institution: fullCases[i].institution, status: ["Queued", "Scheduled", "Report uploaded", "Completed"][i % 4], priority: fullCases[i].type === "New institution" && policy.priorityNewInstitution ? "Priority per signed-off policy" : "Standard" })),
    };
  },
  async getCases() { await delay(); return fullCases; },
  async getNotifications() { await delay(); return fullNotifications; },
  async getAudit() { await delay(); return fullAudit; },
  async getPolicy() { await delay(); return policy; },
  async submitApplication(data) {
    await delay();
    const id = `AT-2026-${String(fullCases.length + 1).padStart(4, "0")}`;
    const record = {
      id,
      institution: "Demo Institute",
      type: data.type,
      route: data.route,
      stage: "Submitted",
      holder: "Officer",
      institutionDays: 0,
      officerDays: 0,
      region: "South",
      status: "Submitted",
    };
    fullCases.unshift(record);
    return { id, policy: policy.current, ...data };
  },
};
