import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  withTransaction: vi.fn(async (callback) => callback(undefined)),
  writeAudit: vi.fn(async () => ({ _id: "audit-entry" })),
}));

vi.mock("../src/middleware/audit.js", () => auditMocks);

import { ApplicationIncident } from "../src/models/ApplicationIncident.js";
import { persistIncidentAction } from "../src/modules/admin/incidents/service.js";

const applicationId = "507f1f77bcf86cd799439011";
const incidentId = "507f1f77bcf86cd799439099";

describe("incident action persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the incident event and audit without changing the source application", async () => {
    const savedIncident = {
      _id: incidentId,
      workflowType: "LEGACY_APPLICATION",
      applicationId,
      caseRecordId: null,
      status: "OPEN",
      resolvedAt: null,
      closedAt: null,
      events: [{ eventId: "detected", action: "DETECTED" }],
      save: vi.fn(async () => undefined),
    };
    vi.spyOn(ApplicationIncident, "findById").mockResolvedValue(savedIncident);

    const result = await persistIncidentAction({
      incidentId,
      body: {
        action: "RESOLVE",
        resolutionSummary: "Evidence reviewed and the issue was corrected.",
        rootCause: "A required verification was not recorded.",
        resolutionEvidence: "Audit entry 44 and corrected report.",
        verificationResult: "A second reviewer verified the correction.",
        remainingLimitations: "Final authority decision remains a separate workflow step.",
      },
      actor: { _id: "507f1f77bcf86cd799439088" },
      ip: "127.0.0.1",
    });

    expect(result.incident.status).toBe("RESOLVED");
    expect(result.incident.events).toHaveLength(2);
    expect(result.incident.events[1]).toMatchObject({
      action: "RESOLVE",
      resolutionSummary: "Evidence reviewed and the issue was corrected.",
      rootCause: "A required verification was not recorded.",
      resolutionEvidence: "Audit entry 44 and corrected report.",
      verificationResult: "A second reviewer verified the correction.",
      remainingLimitations: "Final authority decision remains a separate workflow step.",
    });
    expect(result.incident).toMatchObject({ workflowType: "LEGACY_APPLICATION", applicationId, caseRecordId: null });
    expect(result.incident.save).toHaveBeenCalledOnce();
    expect(auditMocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "INCIDENT_RESOLVE",
      entity: "ApplicationIncident",
      entity_id: incidentId,
      before_json: { status: "OPEN", resolvedAt: null, closedAt: null },
    }), {});
  });

  it("does not save or audit a close action before resolution", async () => {
    const savedIncident = {
      _id: incidentId,
      workflowType: "CASE_RECORD",
      applicationId: null,
      caseRecordId: applicationId,
      status: "OPEN",
      resolvedAt: null,
      closedAt: null,
      events: [],
      save: vi.fn(async () => undefined),
    };
    vi.spyOn(ApplicationIncident, "findById").mockResolvedValue(savedIncident);

    await expect(persistIncidentAction({
      incidentId,
      body: { action: "CLOSE" },
      actor: { _id: "507f1f77bcf86cd799439088" },
      ip: "127.0.0.1",
    })).rejects.toMatchObject({ code: "RESOLUTION_REQUIRED" });
    expect(savedIncident.save).not.toHaveBeenCalled();
    expect(auditMocks.writeAudit).not.toHaveBeenCalled();
  });

  it("does not duplicate an action when the same request ID is retried", async () => {
    const requestId = "44eb0aa8-215f-4dc8-9317-6b58c0ae76c1";
    const savedIncident = {
      _id: incidentId,
      workflowType: "LEGACY_APPLICATION",
      applicationId,
      caseRecordId: null,
      status: "OPEN",
      resolvedAt: null,
      closedAt: null,
      events: [{ eventId: requestId, action: "NOTE", note: "Original persisted note." }],
      save: vi.fn(async () => undefined),
    };
    vi.spyOn(ApplicationIncident, "findById").mockResolvedValue(savedIncident);

    const result = await persistIncidentAction({
      incidentId,
      body: { action: "NOTE", note: "Original persisted note.", requestId },
      actor: { _id: "507f1f77bcf86cd799439088" },
      ip: "127.0.0.1",
    });

    expect(result.duplicate).toBe(true);
    expect(result.event.eventId).toBe(requestId);
    expect(savedIncident.save).not.toHaveBeenCalled();
    expect(auditMocks.writeAudit).not.toHaveBeenCalled();
  });
});
