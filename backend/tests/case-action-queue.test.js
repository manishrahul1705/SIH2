import { describe, expect, it } from "vitest";
import { caseActionQueueFilter } from "../src/modules/cases/router.js";

function findClause(query, predicate) {
  if (!query || typeof query !== "object") return null;
  for (const [key, value] of Object.entries(query)) {
    if (predicate(key, value)) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findClause(item, predicate);
        if (found) return found;
      }
    } else {
      const found = findClause(value, predicate);
      if (found) return found;
    }
  }
  return null;
}

describe("case action queue filtering", () => {
  it("keeps the assigned user's active and frozen stages, but not completed stages", () => {
    const userId = "scrutiny-user";
    const filter = caseActionQueueFilter({ _id: userId, role: "SCRUTINY_OFFICER" });
    const activeStage = findClause(filter, (key, value) => key === "allocatedStages" && value?.$elemMatch?.assignedRole);

    expect(activeStage.$elemMatch).toMatchObject({
      assignedRole: "SCRUTINY_OFFICER",
      assignedUserId: userId,
      status: { $in: ["ACTIVE", "ACTIVE_UNFROZEN", "FROZEN_WAITING_FOR_ASSIST", "INSPECTION_SCHEDULED", "WAITING_FOR_APPROVAL"] },
    });
    expect(filter.$or[1].status).toBe("in_progress");
    expect(filter.$or[0].status.$nin).toContain("approved");
    expect(filter.$or[0].status.$nin).toContain("rejected");
    expect(filter.$or[0].status.$nin).toContain("returned");
  });

  it("keeps a frozen application visible to its pending assist assignee", () => {
    const userId = "assist-user";
    const filter = caseActionQueueFilter({ _id: userId, role: "EVC" });
    const assistClause = findClause(filter, (key, value) => (
      key === "assistRequests" && value?.$elemMatch?.assignedToUserId
    ));

    expect(assistClause.$elemMatch).toMatchObject({
      assignedToUserId: userId,
      status: "PENDING_ASSIST_DECISION",
    });
  });

  it("keeps the active final-approval assignment in the Bureau Officer queue", () => {
    const userId = "bureau-user";
    const filter = caseActionQueueFilter({ _id: userId, role: "BUREAU_OFFICER" });
    const assignedStage = findClause(filter, (key, value) => key === "allocatedStages" && value?.$elemMatch?.assignedRole);

    expect(assignedStage.$elemMatch).toMatchObject({
      assignedRole: "BUREAU_OFFICER",
      status: { $in: ["ACTIVE", "ACTIVE_UNFROZEN", "FROZEN_WAITING_FOR_ASSIST", "INSPECTION_SCHEDULED", "WAITING_FOR_APPROVAL"] },
      assignedUserId: userId,
    });
  });

  it("routes an EVC chairman's assigned case through the EVC action queue", () => {
    const userId = "evc-chairman";
    const filter = caseActionQueueFilter({ _id: userId, role: "EVC_CHAIRMAN" });
    const assignedStage = findClause(filter, (key, value) => key === "allocatedStages" && value?.$elemMatch?.assignedRole);

    expect(assignedStage.$elemMatch).toMatchObject({
      assignedRole: "EVC",
    });
    expect(assignedStage.$elemMatch.$or).toEqual([
      { assignedUserId: userId },
      { assignedPanelUserIds: userId },
    ]);
  });

  it("does not put Bureau Officer final approvals in the administrator action queue", () => {
    const filter = caseActionQueueFilter({ _id: "admin-user", role: "ADMIN" });
    const assignedStage = findClause(filter, (key, value) => key === "allocatedStages" && value?.$elemMatch?.assignedRole);

    expect(assignedStage.$elemMatch.assignedRole).toBe("ADMIN");
  });
});
