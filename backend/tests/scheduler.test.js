import { afterEach, describe, expect, it, vi } from "vitest";
import cron from "node-cron";
import { SCHEDULES, startScheduler } from "../src/modules/jobs/scheduler.js";
import { deadlineReminderLevel, grievanceEscalationRoles, regionalEscalationFilter, yearlyReportReminderLevel } from "../src/modules/jobs/run.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("uses the six lead-time reminders and a deduplicated overdue level", () => {
    expect([90, 60, 30, 15, 7, 1].map(yearlyReportReminderLevel)).toEqual(["T90", "T60", "T30", "T15", "T7", "T1"]);
    expect(yearlyReportReminderLevel(0)).toBeNull();
    expect(yearlyReportReminderLevel(8)).toBeNull();
    expect(yearlyReportReminderLevel(-1)).toBe("overdue");
  });

  it("uses configured deadline reminders for grievances and institutional reports", () => {
    expect([90, 60, 30, 15, 7, 1, 0, -1].map(deadlineReminderLevel)).toEqual(["T90", "T60", "T30", "T15", "T7", "T1", "due", "overdue"]);
    expect(deadlineReminderLevel(8)).toBeNull();
  });

  it("escalates grievances to supervisors after three days and regional authorities after seven", () => {
    expect(grievanceEscalationRoles(-1)).toEqual([]);
    expect(grievanceEscalationRoles(2)).toEqual([]);
    expect(grievanceEscalationRoles(3)).toEqual(["BUREAU_OFFICER"]);
    expect(grievanceEscalationRoles(6)).toEqual(["BUREAU_OFFICER"]);
    expect(grievanceEscalationRoles(7)).toEqual(["BUREAU_OFFICER", "SENIOR_AUTHORITY"]);
  });

  it("limits overdue reminder escalations to active users in the institution region", () => {
    expect(regionalEscalationFilter(" Southern ", 3)).toEqual({
      role: { $in: ["BUREAU_OFFICER"] },
      region: "Southern",
      status: "ACTIVE",
      deleted_at: null,
    });
    expect(regionalEscalationFilter("Southern", 7)).toEqual({
      role: { $in: ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] },
      region: "Southern",
      status: "ACTIVE",
      deleted_at: null,
    });
    expect(regionalEscalationFilter("", 7)).toBeNull();
    expect(regionalEscalationFilter("Southern", 2)).toBeNull();
  });
  it("uses valid schedules for every registered job", () => {
    expect(Object.keys(SCHEDULES).sort()).toEqual([
      "casePipelineScanner",
      "complianceRecompute",
      "documentProcessingScanner",
      "grievanceAndInstitutionReportScanner",
      "leaseExpiryScanner",
      "notificationWorker",
      "obligationScanner",
      "pendingInstitutionScanner",
      "sessionCleanup",
      "stageDelayScanner",
      "stageOverdueScanner",
      "undertakingReportScanner",
      "visitReminderScanner",
      "weeklyDigest",
    ]);
    for (const expression of Object.values(SCHEDULES)) expect(cron.validate(expression)).toBe(true);
  });

  it("uses the scheduler clock, dispatches jobs, and stops all cron tasks", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-27T09:00:00.000Z");
    vi.setSystemTime(now);
    const scheduled = [];
    const stop = vi.fn();
    const handlers = Object.fromEntries(Object.keys(SCHEDULES).map((name) => [name, vi.fn(async (value) => ({ at: value }))]));
    const scheduler = await startScheduler({
      handlers,
      schedule: (expression, callback, options) => {
        scheduled.push({ expression, callback, options });
        return { stop };
      },
    });

    await scheduled[0].callback();
    expect(handlers[Object.keys(SCHEDULES)[0]]).toHaveBeenCalledWith(now);
    expect(scheduled.every((item) => item.options.timezone === "Asia/Kolkata")).toBe(true);
    await scheduler.stop();
    expect(stop).toHaveBeenCalledTimes(Object.keys(SCHEDULES).length);
  });

  it("registers every scheduled handler as a timezone-aware BullMQ repeat job", async () => {
    const jobs = [];
    let closed = false;
    const scheduler = await startScheduler({
      queueMode: "bullmq",
      queueFactory: async () => ({
        async add(name, data, options) { jobs.push({ name, data, options }); },
        async close() { closed = true; },
      }),
    });

    expect(jobs).toHaveLength(Object.keys(SCHEDULES).length);
    for (const job of jobs) {
      expect(job.data).toEqual({ type: "scheduled", name: job.name });
      expect(job.options.repeat).toEqual({ pattern: SCHEDULES[job.name], tz: "Asia/Kolkata" });
      expect(job.options.attempts).toBe(3);
    }
    await scheduler.stop();
    expect(closed).toBe(true);
  });

  it("closes the queue and reports repeat-registration failures", async () => {
    const close = vi.fn(async () => {});
    await expect(startScheduler({
      queueMode: "bullmq",
      queueFactory: async () => ({
        async add() { throw new Error("Redis write failed"); },
        close,
      }),
    })).rejects.toThrow("Redis write failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
