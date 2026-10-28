import { RuleConfig } from "../../models/index.js";

export const DEFAULT_RULES = Object.freeze({
  D1: { enabled: true, basis: "SYNTHETIC", params: {} },
  D2: { enabled: true, basis: "REAL", params: { requiredByType: {
    EXTENSION_OF_APPROVAL: ["lease_deed", "fire_safety_certificate", "occupancy_certificate", "affidavit"],
  } } },
  D3: { enabled: true, basis: "SYNTHETIC", params: {} },
  D4: { enabled: true, basis: "SYNTHETIC", params: {} },
  D5: { enabled: true, basis: "REAL", params: {} },
  D6: { enabled: true, basis: "SYNTHETIC", params: { certificateNumberPattern: "^[A-Za-z0-9/-]{3,40}$" } },
  D7: { enabled: true, basis: "SYNTHETIC", params: {} },
  D8: { enabled: true, basis: "SYNTHETIC", params: {} },
  D9: { enabled: true, basis: "SYNTHETIC", params: { minOcrConfidence: 0.55 } },
  L1: { enabled: true, basis: "SYNTHETIC", params: {} },
  L2: { enabled: true, basis: "SYNTHETIC", params: { toleranceMonths: 1 } },
  L3: { enabled: true, basis: "REAL", params: {} },
  L4: { enabled: true, basis: "SYNTHETIC", params: {} },
  L5: { enabled: true, basis: "SYNTHETIC", params: { minLeaseTermYears: 30 } },
  L6: { enabled: true, basis: "SYNTHETIC", params: { expiryWarningDays: 60 } },
  W6: { enabled: true, basis: "SYNTHETIC", params: { maxDaysByStage: { SCRUTINY: 10, RE_SCRUTINY: 7, EVC: 15, SAC_SHC: 10, DECISION: 7 } } },
  ZONES: { enabled: true, basis: "SYNTHETIC", params: { greenMin: 0.85, amberMin: 0.6, issueDateMin: 0.7 } },
  ESCALATION: { enabled: true, basis: "SYNTHETIC", params: { waitDays: 3 } },
});

export async function getRuleConfig() {
  const stored = await RuleConfig.find().lean();
  const config = structuredClone(DEFAULT_RULES);
  for (const rule of stored) {
    if (config[rule.rule_id]) config[rule.rule_id] = { enabled: rule.enabled, basis: rule.basis, params: rule.params_json };
  }
  return config;
}

function result(ruleId, severity, passed, message) {
  return { ruleId, severity, passed, message, basis: DEFAULT_RULES[ruleId]?.basis || "SYNTHETIC" };
}

function documentTypeKey(value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = {
    lease: "lease",
    leasedeed: "lease",
    fire: "fire",
    firesafetycertificate: "fire",
    structural: "structural",
    structuralstabilitycertificate: "structural",
    occupancyorbuilding: "occupancy",
    occupancycertificate: "occupancy",
    buildingcertificate: "occupancy",
    nbaletter: "nba",
    nbaaccreditationletter: "nba",
    aicteapprovalletter: "aicte",
    other: "other",
    otherdocument: "other",
  };
  return aliases[key] || key;
}

function istDateParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function istDaysBetween(target, reference) {
  const end = istDateParts(target);
  const start = istDateParts(reference);
  return Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86400000);
}

export function evaluate(document = {}, fields = [], application = {}, config = DEFAULT_RULES, context = {}) {
  const rules = [];
  const enabled = (id) => config[id]?.enabled !== false;
  const field = (name) => fields.find((item) => item.field_name === name);
  const confirmedValue = (name) => {
    const item = field(name);
    return item?.confirmed_value ?? null;
  };
  const asDate = (value) => {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const issueDate = asDate(confirmedValue("issue_date"));
  const validFrom = asDate(confirmedValue("valid_from"));
  const validTo = asDate(confirmedValue("valid_to"));
  const today = asDate(context.today) || new Date();
  const expectedSlot = document.doc_type_slot;
  const detectedType = document.doc_type_final;

  const typeMatches = documentTypeKey(expectedSlot) === documentTypeKey(detectedType);
  if (enabled("D1") && expectedSlot && detectedType) rules.push(result("D1", "WARNING", typeMatches, typeMatches ? "Document type matches the uploaded slot." : "Detected document type differs from the selected upload slot."));
  if (enabled("D2") && application.type) {
    const required = config.D2?.params?.requiredByType?.[application.type] || [];
    const seen = new Set((context.applicationDocuments || []).filter((item) => item.status !== "SUPERSEDED").map((item) => item.doc_type_slot_key || item.doc_type_key || ""));
    const missing = required.filter((item) => !seen.has(item));
    rules.push(result("D2", "BLOCKER", missing.length === 0, missing.length ? `Required document slots are missing: ${missing.join(", ")}.` : "Required document slots are present."));
  }
  if (enabled("D3") && issueDate) {
    const notFuture = istDaysBetween(issueDate, today) <= 0;
    rules.push(result("D3", "WARNING", notFuture, notFuture ? "Issue date is not in the future." : "Issue date is in the future."));
  }
  if (enabled("D4") && validTo && (issueDate || validFrom)) {
    const start = issueDate || validFrom;
    const follows = istDaysBetween(validTo, start) > 0;
    rules.push(result("D4", "WARNING", follows, follows ? "Validity end follows the start date." : "Validity end must follow the issue or valid-from date."));
  }
  if (enabled("D5") && (documentTypeKey(detectedType) === "fire" || documentTypeKey(document.doc_type_slot) === "fire") && validTo) {
    const current = istDaysBetween(validTo, today) >= 0;
    rules.push(result("D5", "BLOCKER", current, current ? "Fire safety certificate is currently valid." : "Fire safety certificate has expired."));
  }
  if (enabled("D6")) {
    const certNo = confirmedValue("cert_no");
    const pattern = config.D6?.params?.certificateNumberPattern;
    if (certNo && pattern) {
      let matches = false;
      try { matches = new RegExp(pattern).test(certNo); } catch { matches = false; }
      rules.push(result("D6", "WARNING", matches, matches ? "Certificate number matches the configured format." : "Certificate number does not match the configured format."));
    }
  }
  if (enabled("D7")) {
    const red = fields.filter((item) => item.zone === "RED" && item.confirmed_value == null);
    const amber = fields.filter((item) => item.zone === "AMBER" && item.confirmed_value == null);
    if (red.length) rules.push(result("D7", "BLOCKER", false, `Manual entry required for: ${red.map((item) => item.field_name).join(", ")}.`));
    if (amber.length) rules.push(result("D7", "WARNING", false, `Confirmation required for: ${amber.map((item) => item.field_name).join(", ")}.`));
    if (!red.length && !amber.length) rules.push(result("D7", "INFO", true, "No unconfirmed red or amber fields."));
  }
  if (enabled("D8") && context.duplicate) rules.push(result("D8", "WARNING", false, "A duplicate document or certificate was found in this application."));
  if (enabled("D9") && Number.isFinite(context.meanOcrConfidence)) {
    const min = config.D9?.params?.minOcrConfidence ?? 0.55;
    rules.push(result("D9", "WARNING", context.meanOcrConfidence >= min, context.meanOcrConfidence >= min ? "OCR confidence is above the configured minimum." : "OCR quality is low; please re-upload a clearer document."));
  }

  const lease = context.lease || {};
  const leaseStart = asDate(lease.lease_start ?? confirmedValue("lease_start"));
  const leaseEnd = asDate(lease.lease_end ?? confirmedValue("lease_end"));
  if (enabled("L1") && (leaseStart || leaseEnd)) rules.push(result("L1", "BLOCKER", Boolean(leaseStart && leaseEnd && leaseEnd > leaseStart), leaseStart && leaseEnd && leaseEnd > leaseStart ? "Lease end follows lease start." : "Lease end must follow lease start."));
  if (enabled("L2") && leaseStart && leaseEnd && Number.isFinite(Number(lease.lease_term_years))) {
    const actualMonths = (leaseEnd.getUTCFullYear() - leaseStart.getUTCFullYear()) * 12 + leaseEnd.getUTCMonth() - leaseStart.getUTCMonth();
    const statedMonths = Number(lease.lease_term_years) * 12;
    const tolerance = Number(config.L2?.params?.toleranceMonths ?? 1);
    const consistent = Math.abs(actualMonths - statedMonths) <= tolerance;
    rules.push(result("L2", "WARNING", consistent, consistent ? "Stated lease term is consistent with the lease dates." : "TERM_INCONSISTENT: stated term differs from the date range."));
  }
  if (enabled("L3") && (documentTypeKey(document.doc_type_final) === "lease" || documentTypeKey(document.doc_type_slot) === "lease") && lease.confirmed_at) {
    rules.push(result("L3", "BLOCKER", lease.registered === true, lease.registered ? "Lease registration is confirmed." : "Registration of the lease deed must be confirmed by a person."));
  }
  if (enabled("L4") && leaseEnd && application.academic_year) {
    const endYear = Number(application.academic_year.slice(0, 4)) + 1;
    const academicEnd = new Date(Date.UTC(endYear, 2, 31));
    const coversYear = istDaysBetween(leaseEnd, academicEnd) >= 0;
    rules.push(result("L4", "WARNING", coversYear, coversYear ? "Lease covers the requested academic year." : "Lease expires before the requested academic year ends."));
  }
  if (enabled("L5") && Number.isFinite(Number(lease.lease_term_years))) {
    const minYears = Number(config.L5?.params?.minLeaseTermYears ?? 30);
    rules.push(result("L5", "WARNING", Number(lease.lease_term_years) >= minYears, Number(lease.lease_term_years) >= minYears ? "Lease term meets the configured minimum." : `Lease term is below the configured ${minYears}-year minimum (synthetic default; verify against current APH).`));
  }
  if (enabled("L6") && leaseEnd) {
    const daysLeft = istDaysBetween(leaseEnd, today);
    const status = daysLeft < 0 ? "EXPIRED" : daysLeft <= Number(config.L6?.params?.expiryWarningDays ?? 60) ? "EXPIRING" : "VALID";
    rules.push(result("L6", "INFO", status !== "EXPIRED", `Lease validity suggestion: ${status} (${daysLeft} days remaining).`));
  }
  return rules;
}

export function confidenceZone(confidence, fieldName, params = DEFAULT_RULES.ZONES.params) {
  const value = Number(confidence);
  if (!Number.isFinite(value) || value < (fieldName === "issue_date" ? params.issueDateMin : params.amberMin)) return "RED";
  if (value >= params.greenMin) return "GREEN";
  return "AMBER";
}
