import { afterEach, describe, expect, it, vi } from "vitest";
import cron from "node-cron";
import { SCHEDULES, startScheduler } from "../src/modules/jobs/scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("uses valid schedules for every registered job", () => {
    expect(Object.keys(SCHEDULES).sort()).toEqual([
      "complianceRecompute",
      "documentProcessingScanner",
      "leaseExpiryScanner",
      "notificationWorker",
      "obligationScanner",
      "pendingInstitutionScanner",
      "sessionCleanup",
      "stageDelayScanner",
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
    const scheduler = startScheduler({
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
});
