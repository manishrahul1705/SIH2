import { dueStatus, isWithinReminderWindow } from "./timeRules.js";

const SCORE_CAPS = Object.freeze({
  undertakings: 30,
  documents: 25,
  lease: 15,
  evcReadiness: 10,
  repeatedDeficiencies: 10,
  curedMissedSubmissions: 10,
});

function capped(value, limit) {
  return Math.min(value, limit);
}

function pointsForDocument(document, asOf) {
  if (document.acceptedRenewal) return 0;
  if (!document.validTo) return 0;
  const end = new Date(`${document.validTo}T23:59:59.999Z`);
  const now = new Date(asOf);
  if (Number.isNaN(end.getTime())) return 0;
  if (end < now) return 12;
  if (isWithinReminderWindow(end, now, 7)) return 4;
  if (isWithinReminderWindow(end, now, 30)) return 2;
  return 0;
}

export function computeActionScore(facts, asOf = new Date()) {
  const date = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(date.getTime())) throw new TypeError("asOf must be a valid date");
  if (facts.assessmentComplete === false || (facts.dataQualityIssues || []).length > 0) {
    return {
      score: null,
      band: "Assessment incomplete",
      assessmentComplete: false,
      deductions: [],
      totalDeduction: null,
    };
  }

  const deductions = [];
  const institutionItems = (facts.obligations || []).filter((item) => item.ownerType === "institution");
  const overdueMissing = institutionItems.filter((item) => (
    item.submission !== "submitted" && dueStatus({ dueAt: item.dueAt, dueKind: item.dueKind, now: date }) === "overdue"
  ));
  overdueMissing.forEach((item, index) => deductions.push({
    category: "undertakings",
    points: index === 0 ? 10 : 5,
    recordId: item.id,
    reason: "Overdue institution obligation without a submission",
  }));
  for (const item of institutionItems) {
    if (item.submission === "submitted") continue;
    if (item.dueAt && isWithinReminderWindow(item.dueAt, date, 7)
      && dueStatus({ dueAt: item.dueAt, dueKind: item.dueKind, now: date }) !== "overdue") {
      deductions.push({ category: "undertakings", points: 2, recordId: item.id, reason: "Institution obligation due within 7 days" });
    }
  }

  for (const document of facts.documents || []) {
    const points = pointsForDocument(document, date);
    if (points > 0) deductions.push({
      category: "documents",
      points,
      recordId: document.id,
      reason: points === 12 ? "Expired document without accepted renewal" : "Document expiry approaching",
    });
  }
  const leasePoints = Math.max(
    facts.lease?.officialConfirmedReviewFlag ? 10 : 0,
    facts.lease?.expiredWithoutRenewal ? 15 : 0,
  );
  if (leasePoints > 0) {
    deductions.push({
      category: "lease",
      points: leasePoints,
      recordId: facts.lease.id,
      reason: leasePoints === 15 ? "Expired lease without renewal" : "Officially confirmed lease review flag",
    });
  }
  const overdueEvc = (facts.evcObligations || []).filter((item) => (
    item.ownerType === "institution" && item.dueAt
    && dueStatus({ dueAt: item.dueAt, dueKind: item.dueKind, now: date }) === "overdue"
  ));
  overdueEvc.forEach((item) => deductions.push({
    category: "evcReadiness",
    points: 5,
    recordId: item.id,
    reason: "Overdue institution-controlled EVC obligation",
  }));
  for (const item of facts.repeatedDeficiencies || []) {
    deductions.push({ category: "repeatedDeficiencies", points: 3, recordId: item.id, reason: "Repeated attributable deficiency" });
  }
  for (const item of facts.curedMissedSubmissions || []) {
    deductions.push({ category: "curedMissedSubmissions", points: 5, recordId: item.id, reason: "Cured missed submission" });
  }

  const categoryCaps = {
    undertakings: SCORE_CAPS.undertakings,
    documents: SCORE_CAPS.documents,
    lease: SCORE_CAPS.lease,
    evcReadiness: SCORE_CAPS.evcReadiness,
    repeatedDeficiencies: SCORE_CAPS.repeatedDeficiencies,
    curedMissedSubmissions: SCORE_CAPS.curedMissedSubmissions,
  };
  let totalDeduction = 0;
  const cappedDeductions = [];
  for (const [category, cap] of Object.entries(categoryCaps)) {
    let remaining = cap;
    for (const item of deductions.filter((entry) => entry.category === category)) {
      const points = capped(item.points, remaining);
      if (points > 0) cappedDeductions.push({ ...item, points });
      remaining -= points;
    }
    totalDeduction += cap - remaining;
  }
  const score = Math.max(0, 100 - totalDeduction);
  return {
    score,
    band: score >= 80 ? "Lower action burden" : score >= 50 ? "Attention needed" : "High action burden",
    assessmentComplete: true,
    deductions: cappedDeductions,
    totalDeduction,
  };
}

export function projectActionScore(facts, asOf, days = 30) {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days must be an integer >= 0");
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) throw new TypeError("asOf must be a valid date");
  date.setUTCDate(date.getUTCDate() + days);
  const result = computeActionScore(facts, date);
  return { ...result, date: date.toISOString().slice(0, 10), note: `If nothing changes, your score will be ${result.score ?? "incomplete"} on ${date.toISOString().slice(0, 10)}.` };
}
