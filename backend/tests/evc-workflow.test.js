import { afterEach, describe, expect, it, vi } from "vitest";
import { isEvcInspectionDateAllowed, isEvcScheduleEditable } from "../src/modules/evc/router.js";
import { sendEvcRejectionEmailChain, sendEvcScheduledEmail } from "../src/modules/evc/emailService.js";
import { NotificationService } from "../src/modules/notifications/service.js";

afterEach(() => vi.restoreAllMocks());

describe("EVC inspection scheduling", () => {
  const now = new Date("2026-10-29T10:00:00.000Z");

  it("allows inspection dates beginning tomorrow", () => {
    expect(isEvcInspectionDateAllowed("2026-10-30", now)).toBe(true);
    expect(isEvcInspectionDateAllowed("2026-11-01", now)).toBe(true);
  });

  it("rejects today, earlier dates, and invalid calendar dates", () => {
    expect(isEvcInspectionDateAllowed("2026-10-29", now)).toBe(false);
    expect(isEvcInspectionDateAllowed("2026-10-28", now)).toBe(false);
    expect(isEvcInspectionDateAllowed("2026-02-30", now)).toBe(false);
    expect(isEvcInspectionDateAllowed("tomorrow", now)).toBe(false);
  });

  it("allows schedule edits only before an inspection report is uploaded", () => {
    expect(isEvcScheduleEditable({ status: "ACTIVE" })).toBe(true);
    expect(isEvcScheduleEditable({ status: "INSPECTION_SCHEDULED" })).toBe(true);
    expect(isEvcScheduleEditable({ status: "INSPECTION_SCHEDULED", inspectionReportDocumentId: "report-id" })).toBe(false);
    expect(isEvcScheduleEditable({ status: "WAITING_FOR_APPROVAL" })).toBe(false);
    expect(isEvcScheduleEditable({ status: "APPROVED" })).toBe(false);
  });

  it("queues a schedule notice for the institution and assigned EVC panel", async () => {
    const enqueue = vi.spyOn(NotificationService, "enqueue").mockImplementation(async (job) => job);
    const result = await sendEvcScheduledEmail({
      institution: { name: "Example College", contact_email: "principal@example.edu" },
      application: { _id: "case-1", caseNo: "AT-2026-001", currentStageIndex: 2, allocatedStages: [{}, {}, { requiredDocuments: ["Fire NOC"] }] },
      date: "2026-11-02",
      mode: "PHYSICAL",
      instructions: "Keep original records ready.",
      panelists: [{ _id: "user-1", name: "EVC Member", email: "evc@example.gov.in" }],
    });

    expect(result.queued).toBe(2);
    expect(result.institutionQueued).toBe(true);
    expect(result.panelistsQueued).toBe(1);
    expect(enqueue.mock.calls.map(([job]) => job.recipientEmail).sort()).toEqual(["evc@example.gov.in", "principal@example.edu"]);
    expect(enqueue.mock.calls[0][0].payload.body).toContain("2026-11-02");
    expect(enqueue.mock.calls[0][0].payload.body).toContain("Fire NOC");
  });

  it("queues rejection emails to the institution and every distinct prior stage officer", async () => {
    const enqueue = vi.spyOn(NotificationService, "enqueue").mockImplementation(async (job) => job);
    const result = await sendEvcRejectionEmailChain({
      institution: { name: "Example College", contact_email: "principal@example.edu" },
      application: { _id: "case-2", caseNo: "AT-2026-002", version: 3 },
      previousStageOfficers: [
        { _id: "scrutiny", email: "officer@example.gov.in", stageName: "Document Scrutiny, Regional Check" },
      ],
      rejectionCategory: "Critical Infrastructure Deficiency",
      reason: "The campus does not meet the minimum documented safety standards.",
      rejectedBy: { name: "EVC Chair" },
    });

    expect(result.queued).toBe(2);
    expect(result.institutionQueued).toBe(true);
    expect(result.previousStageOfficersQueued).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.find(([job]) => job.recipientEmail === "principal@example.edu")[0].payload.body).toContain("Standing Appellate Committee");
    expect(enqueue.mock.calls.find(([job]) => job.recipientEmail === "officer@example.gov.in")[0].payload.body).toContain("Document Scrutiny, Regional Check");
  });

  it("reports notification queue failures without exposing recipient addresses", async () => {
    vi.spyOn(NotificationService, "enqueue").mockImplementation(async (job) => {
      if (job.recipientEmail === "officer@example.gov.in") throw new Error("queue unavailable");
      return job;
    });
    const result = await sendEvcRejectionEmailChain({
      institution: { name: "Example College", contact_email: "principal@example.edu" },
      application: { _id: "case-3", caseNo: "AT-2026-003", version: 3 },
      previousStageOfficers: [{ _id: "scrutiny", email: "officer@example.gov.in", stageName: "Document Scrutiny" }],
      rejectionCategory: "Critical Infrastructure Deficiency",
      reason: "The campus does not meet the minimum documented safety standards.",
      rejectedBy: { name: "EVC Chair" },
    });

    expect(result).toEqual({
      queued: 1,
      failedCount: 1,
      institutionQueued: true,
      previousStageOfficersQueued: 0,
    });
  });
});
