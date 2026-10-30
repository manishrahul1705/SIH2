import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Audit: { withTransaction: vi.fn((callback) => callback(undefined)), writeAudit: vi.fn(async () => {}) },
  models: {
    CaseFinding: { findOneAndUpdate: vi.fn(), updateMany: vi.fn() },
    CaseObligation: { create: vi.fn(), updateOne: vi.fn() },
    CaseRecord: { findOne: vi.fn() },
    CaseStageHistory: { findOne: vi.fn(), create: vi.fn() },
    CaseTask: { findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
    OutboxEvent: { create: vi.fn() },
    Policy: { findOne: vi.fn() },
  },
  assignedHolder: vi.fn(async () => ({ holderType: "officer", holderId: "officer-1" })),
}));

vi.mock("../src/models/index.js", () => mocks.models);
vi.mock("../src/middleware/audit.js", () => mocks.Audit);
vi.mock("../src/modules/cases/assignment.js", () => ({ assignedHolder: mocks.assignedHolder }));

import { applyPlan } from "../src/modules/cases/applyPlan.js";

describe("transactional case plan application", () => {
  let record;
  const policyQuery = {
    select: () => ({ lean: async () => ({ pipelineSettings: { holderAssignment: "least_open_cases" } }) }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    record = {
      _id: "case-1",
      caseNo: "AT-2026-001",
      version: 3,
      currentStage: "submitted",
      status: "draft",
      route: ["submitted", "self_disclosure", "scrutiny", "decision"],
      completedStages: [],
      stageEnteredAt: new Date("2026-10-01T00:00:00.000Z"),
      save: vi.fn(async () => {}),
    };
    mocks.models.CaseRecord.findOne.mockResolvedValue(record);
    mocks.models.Policy.findOne.mockReturnValue(policyQuery);
    mocks.models.CaseStageHistory.findOne.mockReturnValue({ sort: () => Promise.resolve(null) });
    mocks.models.CaseStageHistory.create.mockResolvedValue([]);
    mocks.models.OutboxEvent.create.mockResolvedValue([]);
  });

  it("applies submission transition, holder assignment, stage history and audit in one transaction", async () => {
    const plan = {
      planHash: "stable-hash",
      actions: [
        { type: "SET_ROUTE", route: record.route },
        { type: "ASSIGN_HOLDER", stage: "scrutiny", holderType: "officer" },
        { type: "MOVE_STAGE", to: "scrutiny", reason: "Final submission", auto: true },
      ],
    };

    const result = await applyPlan({
      caseId: record._id,
      plan,
      expectedVersion: 3,
      intent: "SUBMIT",
      actorId: "institution-user",
      now: new Date("2026-10-29T00:00:00.000Z"),
    });

    expect(result.applied).toBe(true);
    expect(record.currentStage).toBe("scrutiny");
    expect(record.status).toBe("submitted");
    expect(record.completedStages).toEqual(["submitted", "self_disclosure"]);
    expect(record.holderId).toBe("officer-1");
    expect(record.version).toBe(4);
    expect(record.lastPlanHash).toBe("stable-hash");
    expect(mocks.models.CaseStageHistory.create).toHaveBeenCalledOnce();
    expect(mocks.models.CaseStageHistory.create.mock.calls[0][0][0]).toMatchObject({
      holderType: "officer",
      holderId: "officer-1",
    });
    expect(mocks.Audit.writeAudit).toHaveBeenCalledTimes(3);
    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledTimes(4);
  });

  it("does not reapply a plan with the same intent and hash", async () => {
    record.lastPlanIntent = "CHANGE";
    record.lastPlanHash = "stable-hash";
    const result = await applyPlan({
      caseId: record._id,
      plan: { planHash: "stable-hash", actions: [{ type: "SET_PRELIMINARY", state: "complete_clean" }] },
      expectedVersion: 3,
      intent: "CHANGE",
    });

    expect(result.applied).toBe(false);
    expect(record.save).not.toHaveBeenCalled();
    expect(mocks.Audit.writeAudit).not.toHaveBeenCalled();
  });

  it("records findings for a held plan without moving the case or assigning its next holder", async () => {
    const result = await applyPlan({
      caseId: record._id,
      plan: {
        planHash: "held-hash",
        actions: [
          { type: "HOLD", reason: "Resolve a high-severity finding." },
          { type: "RAISE_FINDING", finding: { code: "DOCUMENT_EXPIRED", ruleId: "DR-03", severity: "high", message: "Evidence expired.", scope: "case", evidence: { documentId: "doc-1" } } },
          { type: "SET_PRELIMINARY", state: "complete_with_findings" },
          { type: "MOVE_STAGE", to: "decision", reason: "Must not run while held." },
          { type: "ASSIGN_HOLDER", holderType: "officer" },
        ],
      },
      expectedVersion: 3,
      intent: "STAGE_COMPLETE",
    });

    expect(result).toMatchObject({ applied: true, held: true });
    expect(record.currentStage).toBe("submitted");
    expect(record.status).toBe("draft");
    expect(record.preliminary).toBe("complete_with_findings");
    expect(record.version).toBe(4);
    expect(mocks.models.CaseFinding.findOneAndUpdate).toHaveBeenCalledOnce();
    expect(mocks.assignedHolder).not.toHaveBeenCalled();
  });

  it("resubmits by reopening the re-scrutiny stage under the newly assigned holder", async () => {
    record.currentStage = "re_scrutiny";
    record.status = "returned";
    record.returnedToStage = "scrutiny";
    record.returnReason = "Provide updated evidence.";
    const result = await applyPlan({
      caseId: record._id,
      plan: {
        planHash: "resubmit-hash",
        actions: [
          { type: "ASSIGN_HOLDER", stage: "re_scrutiny", holderType: "officer" },
          { type: "RESUBMIT_CASE", reason: "Institution resubmitted the returned case." },
        ],
      },
      expectedVersion: 3,
      intent: "RESUBMIT",
      actorId: "institution-user",
      now: new Date("2026-10-29T00:00:00.000Z"),
    });

    expect(result.applied).toBe(true);
    expect(record.currentStage).toBe("re_scrutiny");
    expect(record.status).toBe("in_progress");
    expect(record.returnedToStage).toBe("");
    expect(record.returnReason).toBe("");
    expect(record.holderId).toBe("officer-1");
    expect(mocks.models.CaseStageHistory.create).toHaveBeenCalledOnce();
    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledTimes(3);
  });
});
