import cron from "node-cron";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { jobHandlers } from "./run.js";
import { createScheduledQueue } from "./queue.js";

const SCHEDULES = Object.freeze({
  stageDelayScanner: "0 * * * *",
  stageOverdueScanner: "*/5 * * * *",
  leaseExpiryScanner: "0 6 * * *",
  undertakingReportScanner: "0 7 * * *",
  grievanceAndInstitutionReportScanner: "30 7 * * *",
  pendingInstitutionScanner: "0 9 * * *",
  visitReminderScanner: "0 * * * *",
  notificationWorker: "* * * * *",
  documentProcessingScanner: "* * * * *",
  casePipelineScanner: "0 6 * * *",
  obligationScanner: "5 * * * *",
  complianceRecompute: "0 1 * * *",
  sessionCleanup: "0 2 * * *",
  weeklyDigest: "0 8 * * 1",
});

export async function startScheduler({
  schedule = cron.schedule,
  handlers = jobHandlers,
  queueMode = env.QUEUE_MODE,
  queueFactory = createScheduledQueue,
} = {}) {
  if (queueMode === "bullmq") {
    const queue = await queueFactory();
    try {
      for (const [name, expression] of Object.entries(SCHEDULES)) {
        await queue.add(name, { type: "scheduled", name }, {
          jobId: `approvaltrack-${name}`,
          repeat: { pattern: expression, tz: env.TZ },
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 5000 },
        });
      }
    } catch (error) {
      await queue.close();
      throw error;
    }
    return { async stop() { await queue.close(); } };
  }

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
