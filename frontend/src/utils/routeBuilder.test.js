import test from "node:test";
import assert from "node:assert/strict";
import policy from "../data/policy.json" with { type: "json" };
import { buildRoute, routeForApplication } from "./routeBuilder.js";

test("route builder preserves policy order and skips unconfigured stages", () => {
  assert.deepEqual(buildRoute("Scrutiny + EVC", policy.routes), ["Submitted", "Self-disclosure", "Scrutiny", "Re-Scrutiny", "EVC", "Decision"]);
  assert.equal(buildRoute("Only EVC", policy.routes).includes("Scrutiny"), false);
});

test("application type route comes from signed-off policy mapping", () => {
  assert.equal(routeForApplication("New institution", policy.applicationRoutes), "EVC + SAC/SHC");
});
