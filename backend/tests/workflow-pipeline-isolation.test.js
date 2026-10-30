import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: { _id: "case-1", version: 3, workflowVersion: "SIH26262-1.0", policyVersion: "v1" },
  CaseRecord: { findOne: vi.fn() },
  Policy: { findOne: vi.fn() },
  buildCaseFacts: vi.fn(async () => ({ caseId: "case-1" })),
  evaluateCase: vi.fn(() => ({ findings: [], actions: [], explain: [], planHash: "plan-1" })),
  applyPlan: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  CaseRecord: mocks.CaseRecord,
  Policy: mocks.Policy,
}));
vi.mock("../src/engine/evaluateCase.js", () => ({ evaluateCase: mocks.evaluateCase }));
vi.mock("../src/modules/cases/facts.js", () => ({ buildCaseFacts: mocks.buildCaseFacts }));
vi.mock("../src/modules/cases/applyPlan.js", () => ({ applyPlan: mocks.applyPlan }));
vi.mock("../src/config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config/env.js", () => ({ env: { QUEUE_MODE: "inline" } }));
vi.mock("../src/modules/jobs/queue.js", () => ({ enqueueQueuedJob: vi.fn() }));

import { evaluateCasePipeline } from "../src/modules/cases/pipeline.js";

describe("deterministic workflow isolation from the legacy case pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.CaseRecord.findOne.mockResolvedValue(mocks.record);
    mocks.Policy.findOne.mockReturnValue({ lean: async () => ({ version: "v1" }) });
    mocks.evaluateCase.mockReturnValue({ findings: [], actions: [{ type: "MOVE_STAGE", to: "evc" }], explain: [], planHash: "plan-1" });
  });

  it.each(["SUBMIT", "CHANGE", "STAGE_COMPLETE", "EVC_REPORT"])("does not apply legacy %s transitions to deterministic workflow cases", async (intent) => {
    const result = await evaluateCasePipeline({
      caseId: mocks.record._id,
      intent,
      apply: true,
    });

    expect(result.case).toBe(mocks.record);
    expect(result.actions).toEqual([{ type: "MOVE_STAGE", to: "evc" }]);
    expect(result.applied).toBe(false);
    expect(mocks.applyPlan).not.toHaveBeenCalled();
  });
});
