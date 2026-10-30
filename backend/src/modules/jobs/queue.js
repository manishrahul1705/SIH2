import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env.js";

export const SCHEDULED_QUEUE_NAME = "approvaltrack-scheduled";
let queuePromise;

export function createRedisConnection(redisUrl = env.REDIS_URL) {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createScheduledQueue() {
  if (queuePromise) return queuePromise;
  queuePromise = createQueueHandle();
  return queuePromise;
}

async function createQueueHandle() {
  const connection = createRedisConnection();
  const queue = new Queue(SCHEDULED_QUEUE_NAME, { connection });
  try {
    await queue.waitUntilReady();
    return {
      add: (...args) => queue.add(...args),
      async close() {
        await queue.close();
        queuePromise = null;
      },
    };
  } catch (error) {
    queuePromise = null;
    await connection.quit();
    throw error;
  }
}

export async function enqueueQueuedJob(name, data, options) {
  const queue = await createScheduledQueue();
  return queue.add(name, data, options);
}
