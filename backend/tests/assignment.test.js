import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  CaseRecord: { aggregate: vi.fn() },
  User: { findOne: vi.fn() },
}));

vi.mock("../src/models/index.js", () => ({
  CaseRecord: mocks.CaseRecord,
  User: mocks.User,
}));
vi.mock("../src/engine/queue.js", () => ({
  chooseLeastLoadedOfficer: vi.fn(),
}));

import { assignedHolder, stageRole } from "../src/modules/cases/assignment.js";

describe("final decision assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the legacy final decision stage to the administrator role", () => {
    expect(stageRole("decision")).toEqual({ role: "ADMIN", holderType: "officer" });
  });

  it("assigns the final decision stage to an active administrator without region filtering", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue({ _id: "administrator-1" }),
    };
    mocks.User.findOne.mockReturnValue(query);

    await expect(assignedHolder("decision", "Western")).resolves.toEqual({
      holderType: "officer",
      holderId: "administrator-1",
    });
    expect(mocks.User.findOne).toHaveBeenCalledWith({
      role: "ADMIN",
      status: "ACTIVE",
      deleted_at: null,
    });
  });
});
