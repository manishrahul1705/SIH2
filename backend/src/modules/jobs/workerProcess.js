import { connectDatabase, disconnectDatabase } from "../../models/db.js";
import { logger } from "../../config/logger.js";
import { createRedisConnection } from "./queue.js";
import { createJobWorker } from "./worker.js";

await connectDatabase();
const connection = createRedisConnection();
const worker = createJobWorker({ connection });
await worker.waitUntilReady();
logger.info("ApprovalTrack BullMQ worker is ready");

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "BullMQ worker shutdown started");
  await worker.close();
  await connection.quit();
  await disconnectDatabase();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0)).catch((error) => {
      logger.fatal({ err: error }, "BullMQ worker shutdown failed");
      process.exit(1);
    });
  });
}
