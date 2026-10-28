import cron from "node-cron";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { jobHandlers } from "./run.js";

const SCHEDULES = Object.freeze({
  stageDelayScanner: "0 * * * *",
  leaseExpiryScanner: "0 6 * * *",
  undertakingReportScanner: "0 7 * * *",
  pendingInstitutionScanner: "0 9 * * *",
  visitReminderScanner: "0 * * * *",
  notificationWorker: "* * * * *",
  documentProcessingScanner: "* * * * *",
  obligationScanner: "5 * * * *",
  complianceRecompute: "0 1 * * *",
  sessionCleanup: "0 2 * * *",
  weeklyDigest: "0 8 * * 1",
});

export function startScheduler({ schedule = cron.schedule, handlers = jobHandlers } = {}) {
  const activeJobs = new Set();
  const tasks = Object.entries(SCHEDULES).map(([name, expression]) => schedule(expression, async () => {
    const execution = Promise.resolve().then(() => handlers[name](new Date()));
    activeJobs.add(execution);
    try {
      const summary = await execution;
      logger.info({ job: name, summary }, "Scheduled job completed");
    } catch (error) {
      logger.error({ job: name, code: error.code || "JOB_FAILED" }, "Scheduled job failed");
    } finally {
      activeJobs.delete(execution);
    }
  }, { timezone: env.TZ }));
  return {
    async stop() {
      for (const task of tasks) task.stop();
      await Promise.allSettled(activeJobs);
    },
  };
}

export { SCHEDULES };
