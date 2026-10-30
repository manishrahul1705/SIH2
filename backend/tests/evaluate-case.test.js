import { describe, expect, it } from "vitest";
import { evaluateCase } from "../src/engine/evaluateCase.js";

const now = new Date("2026-10-29T00:00:00.000Z");
const route = ["submitted", "self_disclosure", "scrutiny", "decision"];
const basePolicy = {
  routes: { new_course: route },
  stageCompletion: { scrutiny: ["review_submitted_documents"] },
  blockSubmitOnMissing: false,
  blockAdvanceOnOpenHighFindings: false,
  expiringSoonDays: 30,
};
const baseFacts = {
  caseId: "case-1",
  version: 1,
  applicationType: "new_course",
  answers: {},
  policyVersion: "policy-1",
  route,
  stage: "scrutiny",
  status: "in_progress",
  holderType: "officer",
  region: "South",
  slots: [{ slotId: "fire", label: "Fire certificate", kind: "fire", required: true, applies: true, currentDocumentId: "doc-1", status: "confirmed" }],
  documents: [{ documentId: "doc-1", slotKind: "fire", docType: "fire", validTo: "2027-01-01", verification: "pending", quarantined: false, confirmedAt: "2026-10-20T00:00:00.000Z" }],
  openFindingCodes: [],
  evcTaskExists: false,
  openVerifyTaskDocumentIds: [],
  intent: "CHANGE",
};

describe("confirmed-facts case evaluation", () => {
  it("moves a draft to scrutiny on submission without waiting for analysis", () => {
    const plan = evaluateCase({ ...baseFacts, status: "draft", stage: "submitted", intent: "SUBMIT" }, basePolicy, now);
    expect(plan.actions).toEqual(expect.arrayContaining([
      { type: "MOVE_STAGE", to: "scrutiny", reason: "Final submission", auto: true },
      { type: "ASSIGN_HOLDER", stage: "scrutiny", holderType: "officer" },
    ]));
    expect(plan.explain).toContain("SA-02: document analysis is not a prerequisite for entering scrutiny.");
  });

  it("uses the rules plan to resume a returned case into re-scrutiny", () => {
    const plan = evaluateCase({
      ...baseFacts,
      status: "returned",
      stage: "re_scrutiny",
      intent: "RESUBMIT",
    }, basePolicy, now);
    expect(plan.actions).toEqual(expect.arrayContaining([
      { type: "RESUBMIT_CASE", reason: "Institution resubmitted the returned case." },
      { type: "ASSIGN_HOLDER", stage: "re_scrutiny", holderType: "officer" },
    ]));
  });

  it("marks an empty required slot incomplete without automatically returning the case", () => {
    const plan = evaluateCase({
      ...baseFacts,
      slots: [{ slotId: "lease", label: "Lease", required: true, applies: true, currentDocumentId: null, status: "missing" }],
      documents: [],
    }, basePolicy, now);
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: "REQUIRED_SLOT_MISSING", severity: "warning" }));
    expect(plan.actions).toContainEqual({ type: "SET_PRELIMINARY", state: "incomplete" });
    expect(plan.actions.some((action) => action.type === "MOVE_STAGE")).toBe(false);
    expect(plan.actions.some((action) => action.type === "RECOMMEND_RETURN")).toBe(false);
  });

  it("reports an expired confirmed document and recommends but does not execute a return", () => {
    const plan = evaluateCase({
      ...baseFacts,
      documents: [{ ...baseFacts.documents[0], validTo: "2026-01-01" }],
    }, basePolicy, now);
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: "DOCUMENT_EXPIRED", severity: "high" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "RECOMMEND_RETURN" }));
    expect(plan.actions.some((action) => action.type === "MOVE_STAGE")).toBe(false);
  });

  it("keeps daily clock reevaluations idempotent inside the expiring-soon window", () => {
    const facts = {
      ...baseFacts,
      documents: [{ ...baseFacts.documents[0], validTo: "2026-11-20" }],
    };
    const first = evaluateCase(facts, basePolicy, new Date("2026-10-29T00:00:00.000Z"));
    const nextDay = evaluateCase(facts, basePolicy, new Date("2026-10-30T00:00:00.000Z"));
    expect(first.findings).toContainEqual(expect.objectContaining({ code: "DOCUMENT_EXPIRING_SOON" }));
    expect(nextDay.planHash).toBe(first.planHash);
  });

  it("raises advisory findings only from confirmed document facts", () => {
    const plan = evaluateCase({
      ...baseFacts,
      documents: [
        {
          ...baseFacts.documents[0],
          issueDate: "2027-01-01",
          validFrom: "2026-01-01",
          validTo: "2026-01-01",
          certificateNumber: "NO SPACES",
          fileHash: "same-file",
          meanOcrConfidence: 0.2,
        },
        {
          ...baseFacts.documents[0],
          documentId: "doc-2",
          slotKind: "occupancy",
          fileHash: "same-file",
          certificateNumber: "no spaces",
          meanOcrConfidence: 0.99,
        },
      ],
    }, basePolicy, now);
    expect(plan.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "ISSUE_DATE_IN_FUTURE",
      "VALIDITY_DATE_ORDER",
      "CERTIFICATE_NUMBER_FORMAT",
      "LOW_OCR_CONFIDENCE",
      "DUPLICATE_DOCUMENT",
    ]));
    expect(JSON.stringify(plan)).not.toContain("ai_value");
  });

  it("creates the single EVC task when scrutiny completes on an EVC route", () => {
    const evcPolicy = {
      ...basePolicy,
      routes: { new_course: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"] },
    };
    const plan = evaluateCase({
      ...baseFacts,
      route: evcPolicy.routes.new_course,
      stage: "scrutiny",
      intent: "STAGE_COMPLETE",
      completedChecklist: ["review_submitted_documents"],
    }, evcPolicy, now);
    expect(plan.actions).toContainEqual({ type: "CREATE_TASK", task: "EVC", payload: { state: "queued" } });
    expect(plan.actions.filter((action) => action.type === "CREATE_TASK" && action.task === "EVC")).toHaveLength(1);
  });

  it("uses the frozen case route rather than replacing it with a later policy route", () => {
    const policy = { ...basePolicy, routes: { new_course: route } };
    const frozenRoute = ["submitted", "self_disclosure", "scrutiny", "evc", "decision"];
    const plan = evaluateCase({
      ...baseFacts,
      route: frozenRoute,
      intent: "STAGE_COMPLETE",
      completedChecklist: ["review_submitted_documents"],
    }, policy, now);
    expect(plan.actions).toContainEqual({ type: "MOVE_STAGE", to: "evc", reason: "Stage completed by authorised reviewer", auto: false });
    expect(plan.actions).toContainEqual({ type: "CREATE_TASK", task: "EVC", payload: { state: "queued" } });
  });

  it("keeps plan hashes independent from unconfirmed AI suggestions", () => {
    const first = evaluateCase({ ...baseFacts, unconfirmedSuggestions: [{ value: "fire" }] }, basePolicy, now);
    const second = evaluateCase({ ...baseFacts, unconfirmedSuggestions: [{ value: "lease", confidence: Math.random() }] }, basePolicy, now);
    expect(second.planHash).toBe(first.planHash);
    expect(JSON.stringify(first)).not.toContain("unconfirmedSuggestions");
  });

  it("produces the same hash for a repeated evaluation and avoids duplicate EVC tasks", () => {
    const facts = {
      ...baseFacts,
      route: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"],
      intent: "STAGE_COMPLETE",
      completedChecklist: ["review_submitted_documents"],
      stage: "scrutiny",
    };
    const policy = { ...basePolicy, routes: { new_course: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"] } };
    const first = evaluateCase(facts, policy, now);
    const repeated = evaluateCase(facts, policy, now);
    expect(repeated.planHash).toBe(first.planHash);
    expect(first.actions.filter((action) => action.type === "CREATE_TASK" && action.task === "EVC")).toHaveLength(1);
    const afterTaskCreated = evaluateCase({ ...facts, evcTaskExists: true }, policy, now);
    expect(afterTaskCreated.actions.some((action) => action.type === "CREATE_TASK" && action.task === "EVC")).toBe(false);
  });
});
