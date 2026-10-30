import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ evaluateCasePipeline: vi.fn() }));
vi.mock("../src/modules/cases/pipeline.js", () => ({ evaluateCasePipeline: mocks.evaluateCasePipeline }));
import { createJobWorker } from "../src/modules/jobs/worker.js";
import { SCHEDULED_QUEUE_NAME } from "../src/modules/jobs/queue.js";

class FakeWorker extends EventEmitter {
  constructor(name, processor, options) {
    super();
    this.name = name;
    this.processor = processor;
    this.options = options;
  }
}

describe("BullMQ scheduled worker", () => {
  it("runs only registered handlers with the current clock and bounded concurrency", async () => {
    const handler = vi.fn(async (now) => ({ at: now.toISOString() }));
    const worker = createJobWorker({
      WorkerClass: FakeWorker,
      handlers: { notificationWorker: handler },
      connection: { marker: "connection" },
    });
    const result = await worker.processor({ data: { type: "scheduled", name: "notificationWorker" }, id: "job-1" });

    expect(worker.name).toBe(SCHEDULED_QUEUE_NAME);
    expect(worker.options).toMatchObject({
      connection: { marker: "connection" },
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 30_000,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(result.at).toBe(handler.mock.calls[0][0].toISOString());
  });

  it("rejects unknown job names so they are not reported as successful", async () => {
    const worker = createJobWorker({ WorkerClass: FakeWorker, handlers: {}, connection: {} });
    await expect(worker.processor({ data: { type: "scheduled", name: "unregistered" } })).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
  });

  it("applies queued case evaluations through the version-checked pipeline", async () => {
    mocks.evaluateCasePipeline.mockResolvedValue({
      applied: true,
      held: false,
      planHash: "stable-plan-hash",
    });
    const worker = createJobWorker({ WorkerClass: FakeWorker, handlers: {}, connection: {} });
    await expect(worker.processor({
      id: "case-job-1",
      data: { type: "case-evaluation", caseId: "case-1", intent: "SUBMIT", actorId: "user-1" },
    })).resolves.toEqual({ applied: true, held: false, planHash: "stable-plan-hash" });
    expect(mocks.evaluateCasePipeline).toHaveBeenCalledWith({
      caseId: "case-1",
      intent: "SUBMIT",
      actorId: "user-1",
      apply: true,
    });
  });
});
