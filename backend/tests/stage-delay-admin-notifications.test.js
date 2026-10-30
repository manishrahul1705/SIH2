import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertKeys: new Set(),
  alerts: {
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
  applications: {
    find: vi.fn(),
  },
  stageConfigs: {
    findOne: vi.fn(),
  },
  stageHistory: {
    create: vi.fn(async () => ({})),
  },
  users: {
    find: vi.fn(),
    findOne: vi.fn(),
  },
  enqueue: vi.fn(async () => {}),
  recordIncident: vi.fn(async () => ({})),
  writeAudit: vi.fn(async () => {}),
}));

vi.mock("../src/models/index.js", () => ({
  Alert: mocks.alerts,
  Application: mocks.applications,
  AuditLog: {},
  CaseObligation: {},
  CaseRecord: {},
  Complaint: {},
  Document: {},
  Faculty: {},
  Institution: {},
  InstitutionAnnualReport: {},
  LeaseDetail: {},
  PendingItem: {},
  Policy: {},
  ProcessingRun: {},
  Session: {},
  StageConfig: mocks.stageConfigs,
  StageHistory: mocks.stageHistory,
  Undertaking: {},
  User: mocks.users,
  YearlyReport: {},
}));
vi.mock("../src/config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));
vi.mock("../src/modules/notifications/service.js", () => ({ NotificationService: { enqueue: mocks.enqueue } }));
vi.mock("../src/modules/rules/engine.js", () => ({ DEFAULT_RULES: { W6: { params: { maxDaysByStage: {} } } } }));
vi.mock("../src/middleware/audit.js", () => ({
  withTransaction: async (callback) => callback(undefined),
  writeAudit: mocks.writeAudit,
}));
vi.mock("../src/modules/ai/pipeline.js", () => ({ processDocument: vi.fn() }));
vi.mock("../src/modules/cases/pipeline.js", () => ({ evaluateCasePipeline: vi.fn() }));
vi.mock("../src/modules/applications/overdueStageWorker.js", () => ({ stageOverdueScanner: vi.fn() }));
vi.mock("../src/modules/admin/incidents/service.js", () => ({ recordApplicationIncident: mocks.recordIncident }));
vi.mock("../src/engine/timeRules.js", () => ({ createAlertKey: vi.fn(), obligationReminderLevel: vi.fn() }));

import { jobHandlers } from "../src/modules/jobs/run.js";

describe("legacy stage delay admin notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.alertKeys.clear();
    mocks.recordIncident.mockClear();
    mocks.applications.find.mockReturnValue({
      lean: async () => [{
        _id: "application-1",
        application_number: "AT-LEGACY-001",
        type: "new_course",
        current_stage: "SCRUTINY",
        stage_entered_at: new Date("2026-01-01T00:00:00.000Z"),
        assigned_officer_id: "officer-1",
      }],
    });
    mocks.stageConfigs.findOne.mockReturnValue({
      lean: async () => ({ max_days: 5, role_responsible: "SCRUTINY_OFFICER" }),
    });
    mocks.users.find.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: "admin-1", name: "System Admin" }] }),
    });
    mocks.users.findOne.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: "officer-1", name: "Review Officer", role: "SCRUTINY_OFFICER" }),
      }),
    });
    mocks.alerts.updateOne.mockImplementation(async (filter) => {
      if (mocks.alertKeys.has(filter.dedupe_key)) return { upsertedCount: 0 };
      mocks.alertKeys.add(filter.dedupe_key);
      return { upsertedCount: 1 };
    });
  });

  it("notifies the responsible officer and Admin with stage and owner, once per stage delay", async () => {
    const now = new Date("2026-01-09T00:00:00.000Z");
    const first = await jobHandlers.stageDelayScanner(now);
    const second = await jobHandlers.stageDelayScanner(now);

    expect(first).toEqual({ scanned: 1 });
    expect(second).toEqual({ scanned: 1 });
    expect(mocks.alerts.updateOne).toHaveBeenCalledTimes(4);
    expect(mocks.enqueue).toHaveBeenCalledTimes(5);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: "admin-1",
      type: "STAGE_DELAY_ADMIN_REVIEW",
      channel: "IN_APP",
      payload: expect.objectContaining({
        body: expect.stringContaining("stage SCRUTINY"),
      }),
    }));
    expect(mocks.alerts.updateOne).toHaveBeenCalledWith(
      { dedupe_key: "stage-delay:application-1:SCRUTINY:2026-01-01T00:00:00.000Z:admin-review:admin-1" },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({
        target_user_id: "admin-1",
        type: "STAGE_DELAY_ADMIN_REVIEW",
        body: expect.stringContaining("Review Officer (SCRUTINY_OFFICER)"),
      }) }),
      expect.objectContaining({ upsert: true, runValidators: true }),
    );
    expect(mocks.recordIncident).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "LEGACY_APPLICATION",
      applicationId: "application-1",
      dedupeKey: "stage-delay:SCRUTINY:2026-01-01T00:00:00.000Z",
      stageName: "SCRUTINY",
      responsibleOfficerName: "Review Officer",
    }));
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "STAGE_DELAY_ADMIN_REVIEW",
      after_json: expect.objectContaining({
        stage: "SCRUTINY",
        responsibleUserName: "Review Officer",
        notifiedAdminId: "admin-1",
      }),
    }));
  });
});
