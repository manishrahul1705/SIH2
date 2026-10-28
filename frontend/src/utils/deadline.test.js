import test from "node:test";
import assert from "node:assert/strict";
import { getDeadlineState } from "./deadline.js";

test("date-only deadlines remain active through their local calendar day", () => {
  const now = new Date("2026-10-26T18:30:00");
  assert.deepEqual(getDeadlineState("2026-10-26", now), { kind: "due", label: "Due now" });
  assert.deepEqual(getDeadlineState("2026-10-27", now), { kind: "upcoming", label: "Due in 1 day" });
  assert.deepEqual(getDeadlineState("2026-10-25", now), { kind: "overdue", label: "Overdue by 1 day" });
});

test("missing deadline is explicit and timestamps compare against the exact instant", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  assert.deepEqual(getDeadlineState(undefined, now), { kind: "missing", label: "No deadline set" });
  assert.deepEqual(getDeadlineState("2026-10-26T12:00:00Z", now), { kind: "due", label: "Due now" });
  assert.equal(getDeadlineState("2026-10-26T11:59:00Z", now).kind, "overdue");
});
