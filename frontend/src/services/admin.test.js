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
