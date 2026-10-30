import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertKeys: new Set(),
  models: {
    Alert: {
      updateOne: vi.fn(),
    },
    CaseRecord: {
      find: vi.fn(),
    },
    OutboxEvent: {
      create: vi.fn(async () => []),
    },
    User: {
      findOne: vi.fn(),
      find: vi.fn(),
    },
  },
  enqueue: vi.fn(async () => {}),
  recordIncident: vi.fn(async () => ({})),
  writeAudit: vi.fn(async () => {}),
}));

vi.mock("../src/models/index.js", () => mocks.models);
vi.mock("../src/config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));
vi.mock("../src/modules/notifications/service.js", () => ({ NotificationService: { enqueue: mocks.enqueue } }));
vi.mock("../src/modules/admin/incidents/service.js", () => ({ recordApplicationIncident: mocks.recordIncident }));
vi.mock("../src/modules/rules/engine.js", () => ({ DEFAULT_RULES: {} }));
vi.mock("../src/middleware/audit.js", () => ({
  withTransaction: async (callback) => callback(undefined),
  writeAudit: mocks.writeAudit,
}));
vi.mock("../src/modules/ai/pipeline.js", () => ({ processDocument: vi.fn() }));
vi.mock("../src/modules/cases/pipeline.js", () => ({ evaluateCasePipeline: vi.fn() }));

import { stageOverdueScanner } from "../src/modules/applications/overdueStageWorker.js";

describe("stage overdue scanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.alertKeys.clear();
    mocks.recordIncident.mockClear();
    mocks.models.User.findOne.mockImplementation((filter) => ({
      select: () => ({
        lean: async () => ({
          _id: filter._id,
          name: filter._id === "assist-user" ? "Assist Officer" : "Scrutiny Officer",
          role: filter._id === "assist-user" ? "EVC" : "SCRUTINY_OFFICER",
        }),
      }),
    }));
    mocks.models.User.find.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: "admin-user", name: "System Admin" }],
      }),
    });
    mocks.models.CaseRecord.find.mockReturnValue({
      lean: async () => [
        {
          _id: "case-active",
          caseNo: "AT-2026-ACTIVE",
          applicationType: "new_course",
          currentStageIndex: 0,
          region: "South",
          allocatedStages: [{
            name: "Document Scrutiny",
            assignedRole: "SCRUTINY_OFFICER",
            assignedUserId: "owner-user",
            status: "ACTIVE",
            stageDueAt: new Date("2026-10-28T00:00:00.000Z"),
            assistRequests: [],
          }],
        },
        {
          _id: "case-frozen",
          caseNo: "AT-2026-FROZEN",
          applicationType: "increase_in_intake",
          currentStageIndex: 0,
          region: "South",
          allocatedStages: [{
            name: "Document Scrutiny",
            assignedRole: "SCRUTINY_OFFICER",
            assignedUserId: "owner-user",
            status: "FROZEN_WAITING_FOR_ASSIST",
            stageDueAt: new Date("2026-10-28T00:00:00.000Z"),
            assistRequests: [{
              _id: "assist-1",
              assignedToUserId: "assist-user",
              targetRole: "EVC",
              status: "PENDING_ASSIST_DECISION",
              assistDueAt: new Date("2026-10-29T00:00:00.000Z"),
            }],
          }],
        },
        {
          _id: "case-completed-stage",
          caseNo: "AT-2026-COMPLETE",
          applicationType: "new_course",
          currentStageIndex: 0,
          region: "South",
          allocatedStages: [{
            name: "Document Scrutiny",
            assignedRole: "SCRUTINY_OFFICER",
            assignedUserId: "owner-user",
            status: "APPROVED",
            stageDueAt: new Date("2026-10-28T00:00:00.000Z"),
            assistRequests: [],
          }],
        },
      ],
    });
    mocks.models.Alert.updateOne.mockImplementation(async (filter) => {
      if (mocks.alertKeys.has(filter.dedupe_key)) return { upsertedCount: 0 };
      mocks.alertKeys.add(filter.dedupe_key);
      return { upsertedCount: 1 };
    });
  });

  it("alerts the assigned owner and administrators once, identifying the overdue stage owner", async () => {
    const now = new Date("2026-10-30T00:00:00.000Z");
    const first = await stageOverdueScanner(now);
    const second = await stageOverdueScanner(now);

    expect(first).toEqual({ scanned: 3, alertsCreated: 2 });
    expect(second).toEqual({ scanned: 3, alertsCreated: 0 });
    expect(mocks.models.Alert.updateOne).toHaveBeenCalledTimes(8);
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-user",
      type: "STAGE_DUE_DATE_EXCEEDED",
    }));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: "assist-user",
      type: "STAGE_DUE_DATE_EXCEEDED",
    }));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: "admin-user",
      type: "STAGE_DUE_DATE_EXCEEDED",
    }));
    const alertRecipients = mocks.models.Alert.updateOne.mock.calls.slice(0, 4).map(([filter, update]) => ({
      recipientId: update.$setOnInsert.target_user_id,
      dedupeKey: filter.dedupe_key,
      body: update.$setOnInsert.body,
    }));
    expect(alertRecipients.map(({ recipientId, dedupeKey }) => ({ recipientId, dedupeKey }))).toEqual([
      { recipientId: "owner-user", dedupeKey: "stage-overdue:case-active:0:none:STAGE_OVERDUE" },
      { recipientId: "admin-user", dedupeKey: "stage-overdue:case-active:0:none:STAGE_OVERDUE:admin:admin-user" },
      { recipientId: "assist-user", dedupeKey: "stage-overdue:case-frozen:0:assist-1:STAGE_OVERDUE" },
      { recipientId: "admin-user", dedupeKey: "stage-overdue:case-frozen:0:assist-1:STAGE_OVERDUE:admin:admin-user" },
    ]);
    expect(alertRecipients[0].body).toContain("Stage: Document Scrutiny");
    expect(alertRecipients[0].body).toContain("Assigned responsible user: Scrutiny Officer (SCRUTINY_OFFICER)");
    expect(alertRecipients[3].body).toContain("Stage owner: Scrutiny Officer");
    expect(alertRecipients[3].body).toContain("Overdue assist assignee: Assist Officer");
    expect(mocks.models.Alert.updateOne.mock.calls.every(([filter]) => !filter.dedupe_key.includes("case-completed-stage"))).toBe(true);
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "STAGE_DUE_DATE_EXCEEDED",
      after_json: expect.objectContaining({
        responsibleUserName: "Assist Officer",
        adminRecipientIds: ["admin-user"],
      }),
    }), expect.anything());
    expect(mocks.recordIncident).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "CASE_RECORD",
      applicationId: "case-active",
      dedupeKey: "stage-overdue:0:none:2026-10-28T00:00:00.000Z",
      stageName: "Document Scrutiny",
      responsibleOfficerName: "Scrutiny Officer",
    }));
    expect(mocks.recordIncident).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "CASE_RECORD",
      applicationId: "case-frozen",
      dedupeKey: "stage-overdue:0:assist-1:2026-10-29T00:00:00.000Z",
      stageName: "Document Scrutiny",
      responsibleOfficerName: "Assist Officer",
    }));
  });

  it("notifies Admin only after a CaseRecord stage has been overdue for 24 hours", async () => {
    const result = await stageOverdueScanner(new Date("2026-10-29T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 3, alertsCreated: 2 });
    const inserted = mocks.models.Alert.updateOne.mock.calls.map(([filter, update]) => ({
      caseId: String(update.$setOnInsert.case_id),
      recipientId: String(update.$setOnInsert.target_user_id),
      dedupeKey: filter.dedupe_key,
    }));
    expect(inserted).toEqual([
      { caseId: "case-active", recipientId: "owner-user", dedupeKey: "stage-overdue:case-active:0:none:STAGE_OVERDUE" },
      { caseId: "case-active", recipientId: "admin-user", dedupeKey: "stage-overdue:case-active:0:none:STAGE_OVERDUE:admin:admin-user" },
      { caseId: "case-frozen", recipientId: "assist-user", dedupeKey: "stage-overdue:case-frozen:0:assist-1:STAGE_OVERDUE" },
    ]);
  });
});
