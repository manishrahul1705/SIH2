import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ApplicationIncident } from "../src/models/ApplicationIncident.js";
import { requireRole } from "../src/middleware/auth.js";
import {
  applyIncidentAction,
  buildIncidentApplicationPage,
  sourceKey,
  sourceSnapshot,
  validateIncidentQuery,
} from "../src/modules/admin/incidents/service.js";
import { actionSchema, manualReportSchema } from "../src/modules/admin/incidents/router.js";

const ids = {
  appA: "507f1f77bcf86cd799439011",
  appB: "507f1f77bcf86cd799439012",
  appC: "507f1f77bcf86cd799439013",
  caseB: "507f1f77bcf86cd799439021",
  institutionA: "507f1f77bcf86cd799439031",
  institutionB: "507f1f77bcf86cd799439032",
  institutionC: "507f1f77bcf86cd799439033",
  ownerA: "507f1f77bcf86cd799439041",
};

function incident(id, workflowType, sourceId, status, severity, type, detectedAt, extra = {}) {
  const sourceField = workflowType === "LEGACY_APPLICATION" ? { applicationId: sourceId } : { caseRecordId: sourceId };
  return {
    _id: id,
    workflowType,
    ...sourceField,
    status,
    severity,
    type,
    summary: `Issue ${id}`,
    stageKey: "SCRUTINY",
    stageName: "Scrutiny",
    responsibleOfficerId: ids.ownerA,
    detectedAt: new Date(detectedAt),
    createdAt: new Date(detectedAt),
    events: [],
    ...extra,
  };
}

const sourceRows = [
  {
    workflowType: "LEGACY_APPLICATION",
    applicationId: ids.appA,
    applicationNumber: "APP-100",
    institutionId: ids.institutionA,
    applicationType: "NEW",
    currentStage: "DECISION",
    applicationStatus: "SUBMITTED",
    responsibleOfficerId: ids.ownerA,
  },
  {
    workflowType: "LEGACY_APPLICATION",
    applicationId: ids.appB,
    applicationNumber: "APP-200",
    institutionId: ids.institutionB,
    applicationType: "CLOSURE",
    currentStage: "EVC",
    applicationStatus: "IN_PROGRESS",
    responsibleOfficerId: null,
  },
  {
    workflowType: "CASE_RECORD",
    applicationId: ids.caseB,
    applicationNumber: "CASE-300",
    institutionId: ids.institutionC,
    applicationType: "NEW",
    currentStage: "EVC",
    applicationStatus: "IN_PROGRESS",
    responsibleOfficerId: null,
  },
];

const testIncidents = [
  incident("incident-a-open", "LEGACY_APPLICATION", ids.appA, "OPEN", "HIGH", "STAGE_OVERDUE", "2026-10-28T10:00:00Z"),
  incident("incident-a-resolved", "LEGACY_APPLICATION", ids.appA, "RESOLVED", "MEDIUM", "REVIEW_FLAG", "2026-10-29T10:00:00Z"),
  incident("incident-b-closed", "LEGACY_APPLICATION", ids.appB, "CLOSED", "CRITICAL", "REVIEW_FLAG", "2026-10-28T12:00:00Z"),
  incident("incident-case-open", "CASE_RECORD", ids.caseB, "OPEN", "CRITICAL", "STAGE_OVERDUE", "2026-10-29T12:00:00Z"),
];

describe("admin incident application listing", () => {
  const query = { tab: "pending", page: 1, pageSize: 10, search: "", severity: undefined, type: undefined, stage: undefined, ownerId: "", dateFrom: null, dateTo: null };
  const institutions = new Map([
    [ids.institutionA, { _id: ids.institutionA, name: "North Institute" }],
    [ids.institutionB, { _id: ids.institutionB, name: "South Institute" }],
    [ids.institutionC, { _id: ids.institutionC, name: "Central Institute" }],
  ]);
  const users = new Map([[ids.ownerA, { _id: ids.ownerA, name: "Officer A", role: "SCRUTINY_OFFICER" }]]);

  it("keeps legacy and CaseRecord rows separate and groups multiple incidents once per application", () => {
    const result = buildIncidentApplicationPage({
      incidents: testIncidents,
      sources: sourceRows,
      institutions,
      users,
      query,
      now: new Date("2026-10-30T00:00:00Z"),
    });
    expect(result.applications).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.summary).toEqual({
      affectedApplications: 3,
      pendingApplications: 2,
      completedApplications: 1,
      criticalOpenIncidents: 1,
    });
    const legacy = result.applications.find((row) => row.applicationId === ids.appA);
    const caseRecord = result.applications.find((row) => row.workflowType === "CASE_RECORD");
    expect(legacy).toMatchObject({
      workflowType: "LEGACY_APPLICATION",
      applicationNumber: "APP-100",
      incidentCount: 2,
      institutionName: "North Institute",
      responsibleOfficer: { id: ids.ownerA, name: "Officer A", role: "SCRUTINY_OFFICER" },
    });
    expect(caseRecord).toMatchObject({ workflowType: "CASE_RECORD", applicationId: ids.caseB, incidentCount: 1 });
    expect(sourceKey("LEGACY_APPLICATION", ids.appA)).not.toBe(sourceKey("CASE_RECORD", ids.appA));
  });

  it("applies incident filters before application grouping and paginates grouped rows", () => {
    const filtered = buildIncidentApplicationPage({
      incidents: testIncidents,
      sources: sourceRows,
      institutions,
      users,
      query: { ...query, severity: "CRITICAL", pageSize: 1, page: 1 },
    });
    expect(filtered.applications).toHaveLength(1);
    expect(filtered.applications[0].incidentCount).toBe(1);
    expect(filtered.total).toBe(1);
    expect(filtered.pages).toBe(1);
    expect(filtered.summary.criticalOpenIncidents).toBe(1);

    const completed = buildIncidentApplicationPage({
      incidents: testIncidents,
      sources: sourceRows,
      institutions,
      users,
      query: { ...query, tab: "completed", search: "South" },
    });
    expect(completed.applications).toHaveLength(1);
    expect(completed.applications[0].applicationId).toBe(ids.appB);
    expect(completed.applications[0].applicationStatus).toBe("IN_PROGRESS");
  });

  it("filters by stage, owner, and detection date without merging source records", () => {
    const result = buildIncidentApplicationPage({
      incidents: testIncidents,
      sources: sourceRows,
      institutions,
      users,
      query: {
        ...query,
        stage: "scru",
        ownerId: ids.ownerA,
        dateFrom: new Date("2026-10-28T00:00:00Z"),
      },
    });

    expect(result.applications).toHaveLength(2);
    expect(result.applications).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowType: "LEGACY_APPLICATION", applicationId: ids.appA, incidentCount: 2 }),
      expect.objectContaining({ workflowType: "CASE_RECORD", applicationId: ids.caseB, incidentCount: 1 }),
    ]));
  });

  it("keeps an incident under review in Pending and surfaces only unresolved severity", () => {
    const reviewIncident = incident("incident-review", "LEGACY_APPLICATION", ids.appA, "UNDER_REVIEW", "CRITICAL", "WORKFLOW_FAILURE", "2026-10-30T00:00:00Z");
    const result = buildIncidentApplicationPage({
      incidents: [reviewIncident],
      sources: sourceRows,
      institutions,
      users,
      query: { ...query, severity: undefined },
      now: new Date("2026-10-30T12:00:00Z"),
    });
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]).toMatchObject({
      overallIncidentStatus: "PENDING",
      highestSeverity: "CRITICAL",
      pendingDurationMs: 43_200_000,
    });
  });

  it("supports incident type and inclusive calendar date-to filters", () => {
    const dateQuery = validateIncidentQuery({ dateTo: "2026-10-28" });
    const result = buildIncidentApplicationPage({
      incidents: testIncidents,
      sources: sourceRows,
      institutions,
      users,
      query: { ...query, tab: "completed", type: "REVIEW_FLAG", dateTo: dateQuery.dateTo },
    });
    expect(result.summary.affectedApplications).toBe(1);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0].applicationId).toBe(ids.appB);
  });

  it("builds case stage and owner from the active allocated stage", () => {
    const snapshot = sourceSnapshot("CASE_RECORD", {
      _id: ids.caseB,
      caseNo: "CASE-300",
      institutionId: ids.institutionC,
      applicationType: "NEW",
      currentStage: "evc_inspection",
      currentStageIndex: 0,
      allocatedStages: [{
        key: "evc",
        name: "EVC Inspection",
        routeKey: "evc_inspection",
        assignedUserId: ids.ownerA,
        assignedRole: "EVC",
        stageStartedAt: new Date("2026-10-28T00:00:00Z"),
      }],
      overallStatus: "IN_PROGRESS",
    });
    expect(snapshot).toMatchObject({ currentStage: "EVC Inspection", responsibleOfficerId: ids.ownerA });
  });
});

describe("incident persistence and actions", () => {
  it("requires exactly one source reference matching the explicit workflow type", async () => {
    const base = { type: "STAGE_OVERDUE", severity: "HIGH", summary: "A long enough incident summary" };
    expect(new ApplicationIncident({
      ...base,
      workflowType: "LEGACY_APPLICATION",
      applicationId: ids.appA,
    }).validateSync()).toBeUndefined();
    expect(new ApplicationIncident({
      ...base,
      workflowType: "CASE_RECORD",
      caseRecordId: ids.caseB,
    }).validateSync()).toBeUndefined();
    const invalidLegacy = await new ApplicationIncident({
      ...base,
      workflowType: "LEGACY_APPLICATION",
      applicationId: ids.appA,
      caseRecordId: ids.caseB,
    }).validate().catch((error) => error);
    expect(invalidLegacy.errors.workflowType).toBeTruthy();
    const invalidCase = await new ApplicationIncident({
      ...base,
      workflowType: "CASE_RECORD",
      applicationId: ids.appA,
    }).validate().catch((error) => error);
    expect(invalidCase.errors.workflowType).toBeTruthy();
  });

  it("preserves source references and prior events while resolving and reopening", () => {
    const original = {
      workflowType: "LEGACY_APPLICATION",
      applicationId: ids.appA,
      caseRecordId: null,
      status: "OPEN",
      events: [{ eventId: "old", action: "DETECTED" }],
      resolvedAt: null,
      closedAt: null,
    };
    applyIncidentAction(original, "RESOLVE", { resolutionSummary: "Verified and corrected source evidence." }, { eventId: "resolved", timestamp: new Date() });
    expect(original.status).toBe("RESOLVED");
    expect(original.events.map((event) => event.eventId)).toEqual(["old", "resolved"]);
    expect(() => applyIncidentAction(original, "REVIEW", {}, { eventId: "invalid" })).toThrow(/Reopen/);
    applyIncidentAction(original, "CLOSE", {}, { eventId: "closed", timestamp: new Date() });
    applyIncidentAction(original, "REOPEN", { reason: "The issue has returned and needs another review." }, { eventId: "reopened", timestamp: new Date() });
    expect(original).toMatchObject({ status: "OPEN", applicationId: ids.appA, caseRecordId: null, resolvedAt: null, closedAt: null });
    expect(original.events.map((event) => event.eventId)).toEqual(["old", "resolved", "closed", "reopened"]);
    applyIncidentAction(original, "REVIEW", {}, { eventId: "review", timestamp: new Date() });
    expect(original.status).toBe("UNDER_REVIEW");
  });

  it("records corrective actions without changing incident or workflow status", () => {
    const incidentRecord = {
      workflowType: "CASE_RECORD",
      applicationId: null,
      caseRecordId: ids.caseB,
      status: "OPEN",
      events: [],
    };
    applyIncidentAction(incidentRecord, "CORRECTIVE_ACTION", { result: "Correction was recorded for follow-up." }, { eventId: "corrective" });
    expect(incidentRecord).toMatchObject({
      workflowType: "CASE_RECORD",
      applicationId: null,
      caseRecordId: ids.caseB,
      status: "CORRECTIVE_ACTION_PENDING",
    });
    expect(incidentRecord.events).toHaveLength(1);
    expect(incidentRecord.events[0].action).toBe("CORRECTIVE_ACTION");
  });

  it("validates manual reports and action-specific meaningful fields", () => {
    const report = manualReportSchema.safeParse({
      workflowType: "CASE_RECORD",
      applicationId: "CASE-300",
      type: "SUSPECTED_APPROVAL",
      severity: "HIGH",
      description: "Approval history needs an administrator review.",
      detectionSource: "ADMIN_REPORTED",
      evidence: "Audit entry sequence 41 appears out of order.",
    });
    expect(report.success).toBe(true);
    expect(actionSchema.safeParse({ action: "RESOLVE", resolutionSummary: "Done" }).success).toBe(false);
    expect(actionSchema.safeParse({ action: "RESOLVE", resolutionSummary: "Reviewed evidence and documented the correction." }).success).toBe(true);
    expect(actionSchema.safeParse({ action: "CLOSE" }).success).toBe(false);
    expect(actionSchema.safeParse({ action: "CLOSE", note: "The verified corrective action is complete." }).success).toBe(true);
    expect(actionSchema.safeParse({ action: "NOTE", note: "A useful review note.", requestId: "not-a-uuid" }).success).toBe(false);
    expect(actionSchema.safeParse({ action: "REOPEN", reason: "Short" }).success).toBe(false);
    expect(actionSchema.safeParse({ action: "NOTE" }).success).toBe(false);
  });
});

describe("admin-only incident route", () => {
  const app = createApp();

  it("requires an authenticated administrator before reading or writing incident data", async () => {
    const responses = await Promise.all([
      request(app).get("/api/v1/admin/incidents"),
      request(app).get(`/api/v1/admin/incidents/LEGACY_APPLICATION/${ids.appA}`),
      request(app).post("/api/v1/admin/incidents").set("X-Requested-With", "XMLHttpRequest").send({}),
      request(app).post(`/api/v1/admin/incidents/${ids.appA}/actions`).set("X-Requested-With", "XMLHttpRequest").send({}),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
  });

  it("rejects non-admin users", () => {
    const req = { user: { role: "SCRUTINY_OFFICER" } };
    const result = { statusCode: 0, body: null };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return this; },
    };
    requireRole("ADMIN")(req, res, () => { throw new Error("Non-admin request passed authorization"); });
    expect(result.statusCode).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });
});
