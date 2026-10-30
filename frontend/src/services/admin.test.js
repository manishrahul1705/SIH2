import test from "node:test";
import assert from "node:assert/strict";
import { adminApi } from "./admin.js";

test("admin service reads users and configurable rules from protected endpoints", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    const data = url.includes("/admin/users")
      ? [{ _id: "user-1", role: "ADMIN" }]
      : [{ rule_id: "D1", enabled: true, basis: "SYNTHETIC", params_json: {} }];
    return new Response(JSON.stringify({ data, meta: { total: data.length, pages: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const users = await adminApi.getUsers();
  const rules = await adminApi.getRules();
  assert.equal(users.users[0].role, "ADMIN");
  assert.equal(users.meta.total, 1);
  assert.equal(rules[0].rule_id, "D1");
  assert.equal(calls[0].url, "http://localhost:4000/api/v1/admin/users?page=1&pageSize=100");
  assert.equal(calls[1].options.credentials, "include");
});

test("admin service writes account status and rule changes with CSRF headers", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await adminApi.setUserStatus("user-1", "DISABLED");
  await adminApi.updateRule("D1", { enabled: false, params_json: {} });
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.headers["X-Requested-With"], "XMLHttpRequest");
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: "DISABLED" });
  assert.equal(calls[1].url, "http://localhost:4000/api/v1/admin/rules/D1");
  assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: false, params_json: {} });
});

test("admin incident service preserves filters and uses authenticated incident actions", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: { applications: [], incidents: [] }, meta: { total: 0 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await adminApi.listIncidents({ tab: "pending", page: 2, search: "AT-100", owner: "Officer A" });
  await adminApi.createIncident({ workflowType: "LEGACY_APPLICATION", applicationId: "app-1", type: "MANUAL_REPORT" });
  await adminApi.getApplicationIncidents("CASE_RECORD", "case/1");
  await adminApi.actOnIncident("incident-1", { action: "RESOLVE", resolutionSummary: "Evidence verified and the stage is now complete." });

  assert.match(calls[0].url, /\/admin\/incidents\?tab=pending&page=2&search=AT-100&owner=Officer\+A$/);
  assert.equal(calls[1].url, "http://localhost:4000/api/v1/admin/incidents");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[2].url, "http://localhost:4000/api/v1/admin/incidents/CASE_RECORD/case%2F1");
  assert.equal(calls[3].url, "http://localhost:4000/api/v1/admin/incidents/incident-1/actions");
  assert.equal(calls[3].options.method, "POST");
  assert.equal(calls[3].options.headers["X-Requested-With"], "XMLHttpRequest");
  assert.equal(JSON.parse(calls[3].options.body).action, "RESOLVE");
});
