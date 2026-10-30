import { Worker } from "bullmq";
import { logger } from "../../config/logger.js";
import { jobHandlers } from "./run.js";
import { createRedisConnection, SCHEDULED_QUEUE_NAME } from "./queue.js";
import { evaluateCasePipeline } from "../cases/pipeline.js";

export function createJobWorker({
  WorkerClass = Worker,
  handlers = jobHandlers,
  connection = createRedisConnection(),
} = {}) {
  const worker = new WorkerClass(SCHEDULED_QUEUE_NAME, async (job) => {
    if (job.data?.type === "case-evaluation") {
      const result = await evaluateCasePipeline({
        caseId: job.data.caseId,
        intent: job.data.intent,
        actorId: job.data.actorId || null,
        apply: true,
      });
      logger.info({ caseId: job.data.caseId, intent: job.data.intent, planHash: result.planHash, queueJobId: job.id }, "Queued case evaluation completed");
      return { applied: result.applied, held: result.held, planHash: result.planHash };
    }
    if (job.data?.type !== "scheduled") {
      throw Object.assign(new Error(`Unknown queued job type: ${job.data?.type}`), { code: "UNKNOWN_JOB_TYPE" });
    }
    const handler = handlers[job.data?.name];
    if (!handler) throw Object.assign(new Error(`Unknown scheduled job: ${job.data?.name}`), { code: "UNKNOWN_JOB" });
    const summary = await handler(new Date());
    logger.info({ job: job.data.name, summary, queueJobId: job.id }, "Queued job completed");
    return summary;
  }, {
    connection,
    concurrency: 2,
    lockDuration: 300_000,
    stalledInterval: 30_000,
  });
  worker.on("failed", (job, error) => {
    logger.error({
      job: job?.data?.type === "case-evaluation" ? "case-evaluation" : job?.data?.name,
      caseId: job?.data?.caseId,
      queueJobId: job?.id,
      code: error.code || "JOB_FAILED",
    }, "Queued job failed");
  });
  worker.on("error", (error) => {
    logger.error({ err: error }, "Scheduled queue worker error");
  });
  return worker;
}
