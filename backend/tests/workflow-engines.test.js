import { describe, expect, it } from "vitest";
import { buildChecklist, CHECKLIST_SLOTS, DEFAULT_APPLICABILITY, missingChecklistItems, normalizeApplicability } from "../src/engine/checklist.js";
import { buildCaseRoute, returnTargetIsEarlier } from "../src/engine/routes.js";
import { computeActionScore, projectActionScore } from "../src/engine/score.js";
import { orderOfficerQueue } from "../src/engine/queue.js";
import {
  addOwnershipInterval,
  closesRenewalObligation,
  createAlertKey,
  dueStatus,
  isWithinReminderWindow,
  obligationReminderLevel,
  splitOwnershipTime,
} from "../src/engine/timeRules.js";
import { addMonthsAnniversary, computeLease, leaseEndDate, monthsBetweenLease, reconcileLease } from "../src/engine/leaseMath.js";
import { auditEntryHash, verifyAuditEntries } from "../src/middleware/audit.js";
import { caseFilterForUser } from "../src/modules/cases/router.js";

describe("workflow routes and checklist configuration", () => {
  it("keeps drafts out of every non-institution user's case scope", async () => {
    const officerFilter = await caseFilterForUser({ role: "SCRUTINY_OFFICER", _id: "officer", region: "South" });
    const adminFilter = await caseFilterForUser({ role: "ADMIN", _id: "admin" });
    const institutionId = "507f1f77bcf86cd799439011";
    const institutionFilter = await caseFilterForUser({ role: "INSTITUTION", institution_id: institutionId });

    expect(officerFilter.$and).toContainEqual({ status: { $ne: "draft" } });
    expect(adminFilter.$and).toContainEqual({ status: { $ne: "draft" } });
    expect(institutionFilter).toMatchObject({ institutionId });
    expect(institutionFilter.$and).toBeUndefined();
  });

  it("builds deterministic policy routes for all seven application types", () => {
    const expectedEvc = new Set(["new_institution", "conversion_diploma_to_degree", "collaboration_twinning", "restoration_of_intake"]);
    for (const type of ["new_institution", "new_course", "increase_in_intake", "extension_of_approval", "conversion_diploma_to_degree", "collaboration_twinning", "restoration_of_intake"]) {
      const route = buildCaseRoute(type);
      expect(route.slice(0, 2)).toEqual(["submitted", "self_disclosure"]);
      expect(route.at(-1)).toBe("decision");
      expect(route.includes("evc")).toBe(expectedEvc.has(type));
      expect(route.includes("re_scrutiny")).toBe(false);
    }
    expect(buildCaseRoute("new_course", {}, { evcRandomOrRequired: true })).toContain("evc");
    expect(buildCaseRoute("restoration_of_intake", {}, { hearingRequired: true })).toContain("shc");
  });

  it("only allows returns to earlier configured route stages", () => {
    const route = ["submitted", "self_disclosure", "scrutiny", "evc", "decision"];
    expect(returnTargetIsEarlier(route, "evc", "scrutiny")).toBe(true);
    expect(returnTargetIsEarlier(route, "scrutiny", "evc")).toBe(false);
    expect(returnTargetIsEarlier(route, "scrutiny", "unknown")).toBe(false);
  });

  it("marks unknown applicability for review rather than silently deducting", () => {
    const checklist = buildChecklist("new_course", {});
    expect(checklist.find((item) => item.slotId === "lease")).toMatchObject({ status: "review_required", required: false, reviewRequired: true });
    expect(checklist.find((item) => item.slotId === "fire")).toMatchObject({ status: "missing", required: true });
    expect(missingChecklistItems([
      { required: true, status: "uploaded" },
      { required: true, status: "pending_confirmation" },
      { required: true, status: "confirmed" },
    ])).toHaveLength(2);
    expect(checklist.find((item) => item.slotId === "collaboration_agreement")).toMatchObject({ status: "not_applicable" });
    expect(CHECKLIST_SLOTS.find((item) => item.slotId === "lease")).toMatchObject({ tracked: true, hasValidity: true, minLeaseTermYears: null });
  });

  it("defaults every application answer to No and shows conditional documents after Yes", () => {
    const defaults = normalizeApplicability({});
    expect(defaults).toEqual(DEFAULT_APPLICABILITY);

    const noAnswers = buildChecklist("new_course", defaults);
    expect(noAnswers.find((item) => item.slotId === "lease")).toMatchObject({ status: "not_applicable", required: false, reviewRequired: false });
    expect(noAnswers.find((item) => item.slotId === "structural")).toMatchObject({ status: "not_applicable", required: false, reviewRequired: false });

    const yesAnswers = normalizeApplicability({ landIsLeased: true, buildingOver30: true });
    const yesChecklist = buildChecklist("new_course", yesAnswers);
    expect(yesChecklist.find((item) => item.slotId === "lease")).toMatchObject({ status: "missing", required: true, reviewRequired: false });
    expect(yesChecklist.find((item) => item.slotId === "structural")).toMatchObject({ status: "missing", required: true, reviewRequired: false });
  });

  it("converts legacy building age answers to the new Yes/No applicability flag", () => {
    expect(normalizeApplicability({ buildingAgeYears: 31 }).buildingOver30).toBe(true);
    expect(normalizeApplicability({ buildingAgeYears: 30 }).buildingOver30).toBe(false);
  });

  it("uses the new building Yes/No answer with a previously saved policy condition", () => {
    const structural = CHECKLIST_SLOTS.find((item) => item.slotId === "structural");
    const legacyPolicySlot = {
      ...structural,
      conditions: { ...structural.conditions, new_course: "buildingAgeYears>30" },
    };
    const checklist = buildChecklist(
      "new_course",
      normalizeApplicability({ buildingOver30: true }),
      [],
      [legacyPolicySlot],
    );
    expect(checklist[0]).toMatchObject({ required: true, reviewRequired: false });
  });
});

describe("time rules", () => {
  const now = new Date("2026-10-26T18:30:00.000Z");
  it("returns due_now for a timestamp equal to now", () => {
    expect(dueStatus({ dueAt: now, now })).toBe("due_now");
  });
  it("returns overdue one millisecond after a timestamp deadline", () => {
    expect(dueStatus({ dueAt: now, now: new Date(now.getTime() + 1) })).toBe("overdue");
  });
  it("keeps a date-only deadline active at 23:59 India time on that day", () => {
    expect(dueStatus({ dueAt: "2026-10-26", dueKind: "date", now: new Date("2026-10-26T18:29:00.000Z") })).toBe("upcoming");
  });
  it("marks a date-only deadline overdue at the next local midnight", () => {
    expect(dueStatus({ dueAt: "2026-10-26", dueKind: "date", now: new Date("2026-10-26T18:30:00.000Z") })).toBe("overdue");
  });
  it("surfaces missing deadlines as data quality issues", () => {
    expect(dueStatus({ dueAt: null, now })).toBe("data_quality");
    expect(dueStatus({ dueAt: "2026-02-31", dueKind: "date", now })).toBe("data_quality");
  });
  it("splits five officer days and three institution days without mixing ownership", () => {
    const history = [
      { holderType: "officer", enteredAt: "2026-10-18T00:00:00Z", leftAt: "2026-10-23T00:00:00Z" },
      { holderType: "institution", enteredAt: "2026-10-23T00:00:00Z", leftAt: "2026-10-26T00:00:00Z" },
    ];
    expect(splitOwnershipTime(history)).toEqual({ institutionMs: 3 * 86_400_000, officerMs: 5 * 86_400_000, committeeMs: 0 });
  });
  it("starts a new institution ownership interval at the return timestamp", () => {
    const history = addOwnershipInterval([{ holderType: "officer", enteredAt: new Date("2026-10-25T00:00:00Z"), leftAt: new Date("2026-10-26T10:00:00Z") }], "institution", "2026-10-26T10:00:00Z", "2026-10-27T10:00:00Z");
    expect(history[1].enteredAt.toISOString()).toBe("2026-10-26T10:00:00.000Z");
    expect(splitOwnershipTime(history).institutionMs).toBe(86_400_000);
  });
  it("creates distinct alert keys when the deadline revision changes", () => {
    const common = { obligationId: "ob1", ruleVersion: "v1", level: "due", recipient: "user1", channel: "email" };
    expect(createAlertKey({ ...common, deadlineRevision: 1 })).not.toBe(createAlertKey({ ...common, deadlineRevision: 2 }));
  });
  it("keeps timestamp ordering in UTC over an India local-midnight boundary", () => {
    const history = [
      { holderType: "officer", enteredAt: "2026-10-26T18:29:59Z", leftAt: "2026-10-26T18:30:00Z" },
      { holderType: "institution", enteredAt: "2026-10-26T18:30:00Z", leftAt: "2026-10-26T18:30:01Z" },
    ];
    expect(splitOwnershipTime(history)).toEqual({ institutionMs: 1000, officerMs: 1000, committeeMs: 0 });
  });
  it("counts a zero-second institution-held interval as zero", () => {
    expect(splitOwnershipTime([{ holderType: "institution", enteredAt: now, leftAt: now }]).institutionMs).toBe(0);
  });
  it("counts an open ownership interval only through the explicit as-of time", () => {
    expect(splitOwnershipTime([{ holderType: "institution", enteredAt: now, leftAt: null }], new Date(now.getTime() + 1000)).institutionMs).toBe(1000);
  });
  it("includes exactly seven days in the reminder window and excludes eight days", () => {
    expect(isWithinReminderWindow(new Date(now.getTime() + 7 * 86_400_000), now, 7)).toBe(true);
    expect(isWithinReminderWindow(new Date(now.getTime() + 8 * 86_400_000), now, 7)).toBe(false);
  });
  it("uses configured reminder and overdue escalation thresholds for India date deadlines", () => {
    expect(obligationReminderLevel({
      dueAt: "2026-10-28",
      dueKind: "date",
      now: new Date("2026-10-27T08:00:00.000Z"),
      reminderDays: [1, 7],
      escalationAfterDays: [3],
    })).toBe("reminder_1d");
    expect(obligationReminderLevel({
      dueAt: "2026-10-26",
      dueKind: "date",
      now: new Date("2026-10-28T17:00:00.000Z"),
      reminderDays: [1, 7],
      escalationAfterDays: [2],
    })).toBe("escalation_2d");
    expect(obligationReminderLevel({
      dueAt: "not-a-date",
      dueKind: "date",
      now,
      reminderDays: [1],
    })).toBeNull();
  });
  it("closes a previous renewal obligation only after verification", () => {
    expect(closesRenewalObligation({ submission: "submitted", verification: "pending" })).toBe(false);
    expect(closesRenewalObligation({ submission: "submitted", verification: "verified" })).toBe(true);
  });
});

describe("lease arithmetic", () => {
  it.each([
    ["2024-01-31", 1, "2024-02-29"],
    ["2024-02-29", 12, "2025-02-28"],
    ["2024-04-01", 360, "2054-03-31"],
    ["2024-04-01", 11, "2025-02-28"],
    ["2020-01-15", 66, "2025-07-14"],
    ["2024-04-01", 1188, "2123-03-31"],
  ])("calculates inclusive lease end for %s + %i months", (start, months, expectedEnd) => {
    expect(leaseEndDate(start, months)).toBe(expectedEnd);
  });

  it("matches the Python lease term and handles mismatch, expiry, and one-day tolerance", () => {
    expect(addMonthsAnniversary("2024-01-31", 1).toISOString().slice(0, 10)).toBe("2024-03-01");
    expect(monthsBetweenLease("2024-04-01", "2054-03-31")).toBe(360);
    expect(computeLease({ start: "2024-04-01", end: "2054-03-31", termMonths: 360, asOf: "2026-10-26" })).toMatchObject({ status: "live", proposed_review_flag: false });
    expect(computeLease({ start: "2015-04-01", end: "2025-03-31", termMonths: 120, asOf: "2026-10-26" })).toMatchObject({ status: "expired", flag_reasons: ["EXPIRED"] });
    expect(computeLease({ start: "2024-04-01", end: "2040-03-31", termMonths: 360, asOf: "2026-10-26" })).toMatchObject({ status: "mismatch", flag_reasons: ["TERM_END_MISMATCH"] });
    expect(computeLease({ start: "2024-04-01", end: "2054-04-01", termMonths: 360, asOf: "2026-10-26" })).toMatchObject({ consistency: "consistent", status: "live" });
    expect(computeLease({ start: "2026-08-01", end: "2026-11-20", termMonths: null, asOf: "2026-10-26" })).toMatchObject({ status: "expires_soon", flag_reasons: ["EXPIRING_SOON"] });
    expect(reconcileLease("01-02-2024", null, null, { startAmbiguous: true })).toMatchObject({ state: "needs_review", reason: "start_ambiguous" });
  });
});

describe("action score and queue", () => {
  const facts = {
    assessmentComplete: true,
    obligations: [
      { id: "overdue-1", ownerType: "institution", dueAt: "2026-10-20", dueKind: "date", submission: "none" },
      { id: "due-soon", ownerType: "institution", dueAt: "2026-10-31", dueKind: "date", submission: "none" },
    ],
    documents: [
      { id: "fire-expired", validTo: "2026-10-01" },
      { id: "nba-expiring", validTo: "2026-11-20" },
    ],
    lease: { id: "lease", unconfirmedReviewFlag: true },
    evcObligations: [{ id: "evc-overdue", ownerType: "institution", dueAt: "2026-10-20", dueKind: "date" }],
    repeatedDeficiencies: [{ id: "return-1" }, { id: "return-2" }],
    curedMissedSubmissions: [],
  };

  it("matches the golden score and 30-day projection", () => {
    expect(computeActionScore(facts, "2026-10-26")).toMatchObject({ score: 63, band: "Attention needed" });
    expect(projectActionScore(facts, "2026-10-26", 30)).toMatchObject({ score: 50, date: "2026-11-25" });
    const afterRenewal = { ...facts, documents: [{ id: "fire-expired", validTo: "2026-10-01", acceptedRenewal: true }, facts.documents[1]], curedMissedSubmissions: [{ id: "fire-late" }] };
    expect(computeActionScore(afterRenewal, "2026-10-26").score).toBe(70);
    expect(computeActionScore(afterRenewal, "2026-10-26").score).toBe(70);
    expect(computeActionScore({ ...afterRenewal, lease: { officialConfirmedReviewFlag: true } }, "2026-10-26").score).toBe(60);
    expect(computeActionScore({ ...afterRenewal, lease: { officialConfirmedReviewFlag: true, expiredWithoutRenewal: true } }, "2026-10-26").score).toBe(55);
  });

  describe("append-only audit hash chain", () => {
    it("verifies the sequence and detects tampered audit payloads", () => {
      const first = {
        seq: 1,
        prevHash: "GENESIS",
        createdAt: new Date("2026-10-26T10:00:00.000Z"),
        actor_id: "user-1",
        action: "CASE_CREATED",
        entity: "CaseRecord",
        entity_id: "case-1",
        before_json: null,
        after_json: { caseNo: "AT-2026-0001", status: "draft" },
        outcome: "allowed",
        ip: "127.0.0.1",
      };
      first.hash = auditEntryHash(first);
      const second = {
        ...first,
        seq: 2,
        prevHash: first.hash,
        createdAt: new Date("2026-10-26T11:00:00.000Z"),
        action: "CASE_SCOPE_DENIED",
        outcome: "denied",
        after_json: { reason: "NOT_FOUND" },
      };
      second.hash = auditEntryHash(second);
      expect(verifyAuditEntries([second, first])).toMatchObject({ valid: true, checked: 2 });
      expect(verifyAuditEntries([first, { ...second, after_json: { reason: "changed" } }])).toMatchObject({ valid: false, invalidSequence: 2 });
    });
  });

  it("never substitutes a high score when required data is incomplete", () => {
    expect(computeActionScore({ assessmentComplete: false }, "2026-10-26")).toMatchObject({ score: null, band: "Assessment incomplete" });
  });

  it("orders officer work by urgency and excludes institution-held work", () => {
    const items = [
      { id: "soon", ownerType: "officer", dueAt: "2026-10-27T12:00:00Z" },
      { id: "overdue", ownerType: "officer", dueAt: "2026-10-25T12:00:00Z" },
      { id: "institution", ownerType: "institution", dueAt: "2026-10-25T12:00:00Z" },
      { id: "ready", ownerType: "unassigned", ready: true },
    ];
    expect(orderOfficerQueue(items, "2026-10-26T12:00:00Z").map((item) => item.id)).toEqual(["overdue", "soon", "ready"]);
  });
});
