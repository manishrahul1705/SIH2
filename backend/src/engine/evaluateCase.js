// Implements the deterministic, confirmed-facts-only rules in intake pipeline specification sections 9.1-9.3.
import { createHash } from "node:crypto";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function finding(code, ruleId, severity, message, evidence = {}) {
  return { code, ruleId, severity, blocking: false, scope: "case", message, evidence };
}

function utcDate(value) {
  if (!value) return null;
  const input = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(left, right) {
  return Math.floor((Date.UTC(left.getUTCFullYear(), left.getUTCMonth(), left.getUTCDate())
    - Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate())) / 86_400_000);
}

function addMonths(date, months) {
  const totalMonth = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(totalMonth / 12);
  const month = ((totalMonth % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day));
}

function buildFindings(facts, policy, now) {
  const settings = policy.pipelineSettings || policy;
  const findings = [];
  const requiredSlots = facts.slots.filter((slot) => slot.required && slot.applies !== false);
  for (const slot of facts.slots) {
    if (slot.applies === "unknown") {
      findings.push(finding("DR-02", "DR-02", "info", `Applicability for ${slot.label || slot.slotId} needs review.`, { slotId: slot.slotId }));
      continue;
    }
    if (!slot.required || slot.applies === false) continue;
    if (!slot.currentDocumentId || slot.status === "quarantined") {
      findings.push(finding("REQUIRED_SLOT_MISSING", "DR-02", (settings.blockSubmitOnMissing ?? policy.blockSubmitOnMissing) ? "high" : "warning", `Required document slot is missing: ${slot.label || slot.slotId}.`, { slotId: slot.slotId }));
    } else if (slot.status === "pending_confirmation" || slot.status === "uploaded") {
      findings.push(finding("UNCONFIRMED_AT_SUBMIT", "DR-07", "info", `${slot.label || slot.slotId} has not been confirmed.`, { slotId: slot.slotId, documentId: slot.currentDocumentId }));
    }
  }

  for (const document of facts.documents) {
    if (document.quarantined) {
      findings.push(finding("QUARANTINED", "DR-01", "high", "A document was quarantined and does not satisfy its checklist slot.", { documentId: document.documentId, slotKind: document.slotKind }));
      continue;
    }
    if (document.supersededBy) continue;
    const validTo = utcDate(document.validTo);
    const issueDate = utcDate(document.issueDate);
    const validFrom = utcDate(document.validFrom);
    if (issueDate && daysBetween(issueDate, now) > 0) {
      findings.push(finding("ISSUE_DATE_IN_FUTURE", "D3", "warning", `${document.slotKind} has a confirmed issue date in the future.`, { documentId: document.documentId, issueDate: document.issueDate }));
    }
    const validityStart = issueDate || validFrom;
    if (validTo && validityStart && validTo <= validityStart) {
      findings.push(finding("VALIDITY_DATE_ORDER", "D4", "warning", `${document.slotKind} validity end must follow its issue or valid-from date.`, { documentId: document.documentId, validTo: document.validTo }));
    }
    if (document.certificateNumber && !/^[A-Za-z0-9/-]{3,40}$/.test(document.certificateNumber)) {
      findings.push(finding("CERTIFICATE_NUMBER_FORMAT", "D6", "warning", `${document.slotKind} has a confirmed certificate number outside the configured format.`, { documentId: document.documentId }));
    }
    if (Number.isFinite(document.meanOcrConfidence) && document.meanOcrConfidence < Number(settings.minOcrConfidence ?? 0.55)) {
      findings.push(finding("LOW_OCR_CONFIDENCE", "D9", "warning", `${document.slotKind} OCR confidence is below the policy minimum.`, { documentId: document.documentId, meanOcrConfidence: document.meanOcrConfidence }));
    }
    if (validTo) {
      const remainingDays = daysBetween(validTo, now);
      if (remainingDays < 0) {
        findings.push(finding("DOCUMENT_EXPIRED", "DR-03", "high", `${document.slotKind} has expired.`, { documentId: document.documentId, validTo: document.validTo }));
      } else if (remainingDays <= Number(document.slotKind === "lease"
        ? settings.leaseExpiringSoonDays ?? 90
        : settings.expiringSoonDays ?? 30)) {
        findings.push(finding("DOCUMENT_EXPIRING_SOON", "DR-04", "warning", `${document.slotKind} expires within the configured reminder window.`, { documentId: document.documentId, validTo: document.validTo }));
      }
    }
    if (document.verification === "pending") {
      findings.push(finding("VERIFICATION_PENDING", "SA-12", "info", `${document.slotKind} is awaiting human verification.`, { documentId: document.documentId }));
    } else if (document.verification === "not_verified") {
      findings.push(finding("DOCUMENT_NOT_VERIFIED", "SA-12", "high", `${document.slotKind} was not verified by the assigned reviewer.`, { documentId: document.documentId }));
    }
    if (document.lease) {
      const start = utcDate(document.lease.start);
      const end = utcDate(document.lease.end);
      const statedMonths = Number(document.lease.termMonths);
      if (start && end && end <= start) {
        findings.push(finding("LEASE_PROBLEM", "DR-05", "high", "The confirmed lease end date must follow its start date.", { documentId: document.documentId, reason: "LEASE_DATE_ORDER" }));
      } else if (start && end && Number.isFinite(statedMonths)) {
        const expectedEnd = addMonths(start, statedMonths);
        if (Math.abs(daysBetween(end, expectedEnd)) > Number(settings.endToleranceDays ?? 1)) {
          findings.push(finding("LEASE_PROBLEM", "DR-05", "warning", "The confirmed lease term does not match the confirmed date range.", { documentId: document.documentId, reason: "TERM_END_MISMATCH" }));
        }
      }
      if (settings.minLeaseTermYears != null && Number.isFinite(Number(settings.minLeaseTermYears)) && Number.isFinite(statedMonths)
        && statedMonths < Number(settings.minLeaseTermYears) * 12) {
        findings.push(finding("LEASE_PROBLEM", "DR-05", "warning", "The confirmed lease term is below the configured policy minimum.", { documentId: document.documentId, reason: "LEASE_TOO_SHORT", minimumYears: settings.minLeaseTermYears }));
      }
    }
  }

  const fileHashOwners = new Map();
  const certificateOwners = new Map();
  for (const document of facts.documents) {
    if (document.quarantined || document.supersededBy) continue;
    const duplicateFile = document.fileHash && fileHashOwners.has(document.fileHash);
    const certificate = typeof document.certificateNumber === "string" ? document.certificateNumber.trim().toLowerCase() : "";
    const duplicateCertificate = certificate && certificateOwners.has(certificate);
    if (duplicateFile || duplicateCertificate) {
      const duplicateOf = duplicateFile
        ? fileHashOwners.get(document.fileHash)
        : certificateOwners.get(certificate);
      findings.push(finding("DUPLICATE_DOCUMENT", "D8", "warning", `${document.slotKind} duplicates evidence already submitted in this case.`, {
        documentId: document.documentId,
        duplicateOf,
      }));
    }
    if (document.fileHash) fileHashOwners.set(document.fileHash, document.documentId);
    if (certificate) certificateOwners.set(certificate, document.documentId);
  }

  const confirmedIds = new Set(facts.documents.filter((document) => !document.quarantined && !document.supersededBy).map((document) => document.documentId));
  for (const slot of requiredSlots) {
    if (slot.currentDocumentId && !confirmedIds.has(slot.currentDocumentId)) {
      findings.push(finding("UNCONFIRMED_AT_SUBMIT", "DR-07", "info", `${slot.label || slot.slotId} is not confirmed yet.`, { slotId: slot.slotId, documentId: slot.currentDocumentId }));
    }
  }
  return findings.filter((item, index, list) => list.findIndex((other) => (
    other.code === item.code && other.evidence.documentId === item.evidence.documentId
      && other.evidence.slotId === item.evidence.slotId
  )) === index);
}

function addStageActions(facts, policy, findings) {
  const settings = policy.pipelineSettings || policy;
  const actions = [];
  const explain = [];
  const route = facts.route?.length ? facts.route : policy.routes?.[facts.applicationType] || [];
  if (facts.intent === "SUBMIT" && facts.status === "draft") {
    actions.push({ type: "SET_ROUTE", route: [...route] });
    actions.push({ type: "ASSIGN_HOLDER", stage: "scrutiny", holderType: "officer" });
    actions.push({ type: "MOVE_STAGE", to: "scrutiny", reason: "Final submission", auto: true });
    explain.push("SA-01: final submission moves the case to scrutiny.");
    explain.push("SA-02: document analysis is not a prerequisite for entering scrutiny.");
  }

  if (facts.intent === "RESUBMIT" && facts.status === "returned" && facts.stage === "re_scrutiny") {
    actions.push({ type: "ASSIGN_HOLDER", stage: "re_scrutiny", holderType: "officer" });
    actions.push({ type: "RESUBMIT_CASE", reason: "Institution resubmitted the returned case." });
    explain.push("SA-13: resubmission returns the case to the configured re-scrutiny holder.");
  }

  if (facts.intent === "STAGE_COMPLETE") {
    if (facts.stage === "evc") {
      actions.push({ type: "HOLD", reason: "Upload the EVC report to advance from the EVC stage." });
      explain.push("SA-07: only the EVC report upload trigger advances the EVC stage.");
      return { actions, explain };
    }
    const missingChecks = (policy.stageCompletion?.[facts.stage] || []).filter((item) => !(facts.completedChecklist || []).includes(item));
    const highFindings = findings.filter((item) => item.severity === "high");
    if (missingChecks.length) {
      actions.push({ type: "HOLD", reason: `Complete the stage checklist: ${missingChecks.join(", ")}.` });
      explain.push("SA-05: stage completion is held until required checklist items are complete.");
      return { actions, explain };
    }
    if (settings.blockAdvanceOnOpenHighFindings && highFindings.length) {
      actions.push({ type: "HOLD", reason: "Resolve open high-severity findings before advancing." });
      explain.push("SA-05: policy blocks advancement while high-severity findings remain open.");
      return { actions, explain };
    }
    const index = route.indexOf(facts.stage);
    const next = route[index + 1];
    if (next) {
      actions.push({ type: "ASSIGN_HOLDER", stage: next, holderType: next === "evc" || next === "shc" || next === "sac" ? "committee" : next === "decision" ? "competent_authority" : "officer" });
      actions.push({ type: "MOVE_STAGE", to: next, reason: "Stage completed by authorised reviewer", auto: false });
      explain.push("SA-05: the authorised reviewer completed the current stage.");
      if (["scrutiny", "re_scrutiny"].includes(facts.stage) && route.includes("evc") && !facts.evcTaskExists) {
        actions.push({ type: "CREATE_TASK", task: "EVC", payload: { state: "queued" } });
        explain.push("SA-06: create the single EVC task required by the configured route.");
      }
    }
  }

  if (facts.intent === "EVC_REPORT" && facts.stage === "evc") {
    const index = route.indexOf("evc");
    const next = route[index + 1];
    if (next) {
      if (facts.openEvcTaskId) actions.push({ type: "COMPLETE_TASK", taskId: facts.openEvcTaskId });
      actions.push({ type: "ASSIGN_HOLDER", stage: next, holderType: next === "decision" ? "competent_authority" : "committee" });
      actions.push({ type: "MOVE_STAGE", to: next, reason: "EVC report uploaded", auto: true });
      explain.push("SA-07: the EVC report advances the case to the next configured route stage.");
    }
  }

  if (["scrutiny", "re_scrutiny"].includes(facts.stage)) {
    for (const document of facts.documents) {
      if (document.verification === "pending" && !facts.openVerifyTaskDocumentIds?.includes(document.documentId)) {
        actions.push({ type: "CREATE_TASK", task: "VERIFY_DOCUMENT", payload: { documentId: document.documentId } });
        explain.push("SA-12: confirmed documents require a separate human verification task.");
      }
      if (document.verification === "not_verified" && !facts.openDeficiencyTaskDocumentIds?.includes(document.documentId)) {
        actions.push({ type: "CREATE_TASK", task: "DEFICIENCY_RESPONSE", payload: { documentId: document.documentId, slotId: document.slotKind } });
        explain.push("SA-10: unverified evidence creates a human-addressable deficiency response task.");
      }
    }
    const highFindings = findings.filter((item) => item.severity === "high");
    if (highFindings.length) {
      actions.push({ type: "RECOMMEND_RETURN", reasons: highFindings.map((item) => item.message) });
      explain.push("SA-11: high-severity findings may be returned by an authorised person; the engine does not return the case.");
    }
  }
  return { actions, explain };
}

export function evaluateCase(facts, policy, now) {
  const settings = policy.pipelineSettings || policy;
  const route = facts.route?.length ? facts.route : policy.routes?.[facts.applicationType] || [];
  const effectiveFacts = { ...facts, route };
  const findings = buildFindings(effectiveFacts, policy, now);
  const { actions, explain } = addStageActions(effectiveFacts, policy, findings);
  for (const item of findings) {
    actions.push({ type: "RAISE_FINDING", finding: item });
  }
  for (const existing of facts.openFindings || []) {
    if (!findings.some((item) => item.code === existing.code
      && (item.evidence.documentId || "") === (existing.documentId || "")
      && (item.evidence.slotId || "") === (existing.slotId || ""))) {
      actions.push({
        type: "RESOLVE_FINDING",
        code: existing.code,
        ...(existing.documentId ? { documentId: existing.documentId } : {}),
        ...(existing.slotId ? { slotId: existing.slotId } : {}),
      });
    }
  }
  for (const slot of facts.slots) {
    if (slot.applies === "unknown" && !facts.openReviewTaskSlotIds?.includes(slot.slotId)) {
      actions.push({ type: "CREATE_TASK", task: "REVIEW", payload: { slotId: slot.slotId } });
      explain.push("DR-02: unknown applicability creates a review task instead of a deficiency.");
    }
  }
  const requiredMissing = facts.slots.some((slot) => slot.required && slot.applies !== false
    && (!slot.currentDocumentId || slot.status === "quarantined"));
  const hasFinding = findings.some((item) => ["high", "warning"].includes(item.severity));
  const state = requiredMissing ? "incomplete"
    : hasFinding || facts.documents.some((document) => document.verification !== "verified") ? "complete_with_findings"
      : "complete_clean";
  actions.push({ type: "SET_PRELIMINARY", state });
  explain.push("SA-04: preliminary validation was recomputed from checklist state and confirmed document facts.");

  if ((settings.prioritiseNewInstitutions || policy.prioritiseNewInstitutions) && facts.applicationType === "new_institution") {
    actions.push({ type: "NOTIFY", to: "regional_queue", template: "new_institution_priority" });
    explain.push("RT-04: the policy prioritises new institutions in the regional queue.");
  }

  const canonicalPlan = { actions, findings, explain };
  const planHash = createHash("sha256").update(stableJson(canonicalPlan)).digest("hex");
  return { ...canonicalPlan, planHash };
}
