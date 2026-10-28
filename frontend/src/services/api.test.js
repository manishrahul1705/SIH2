import test from "node:test";
import assert from "node:assert/strict";
import { mockDataCounts } from "./api.js";

test("mock service includes the required fictional fixture sizes", () => {
  assert.deepEqual(mockDataCounts, {
    cases: 40,
    undertakings: 12,
    documents: 10,
    notifications: 20,
    audit: 60,
    evc: 8,
  });
});
