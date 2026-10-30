import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mongoose: {
    connection: {
      db: { admin: () => ({ command: vi.fn(async () => ({ ok: 1, isWritablePrimary: true })) }) },
    },
  },
  logger: { warn: vi.fn() },
}));

vi.mock("../src/models/db.js", () => ({ mongoose: mocks.mongoose }));
vi.mock("../src/models/index.js", () => ({ AuditHead: {}, AuditLog: {} }));
vi.mock("../src/config/logger.js", () => ({ logger: mocks.logger }));

import { withTransaction } from "../src/middleware/audit.js";

describe("standalone MongoDB write serialization", () => {
  it("serializes concurrent writes while allowing nested writes to join the same context", async () => {
    mocks.mongoose.connection.db.admin = () => ({
      command: vi.fn(async () => ({ ok: 1, isWritablePrimary: true })),
    });
    const order = [];

    const first = withTransaction(async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await withTransaction(async () => { order.push("first-nested"); });
      order.push("first-end");
    });
    const second = withTransaction(async () => {
      order.push("second-start");
      order.push("second-end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-nested", "first-end", "second-start", "second-end"]);
  });
});
