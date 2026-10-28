import test from "node:test";
import assert from "node:assert/strict";
import { api } from "./api.js";

test("dashboard data is fetched from authenticated backend endpoints without fixture fallback", async (context) => {
  const requests = [];
  const responses = {
    "/dashboard/overview": { applications: 0, openAlerts: 0 },
    "/cases?page=1&pageSize=100": [],
    "/documents?page=1&pageSize=100": [],
    "/alerts?page=1&pageSize=100": [],
    "/undertakings?page=1&pageSize=100": [],
  };
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const requestUrl = new URL(url);
    const path = requestUrl.pathname.replace("/api/v1", "") + requestUrl.search;
    requests.push(path);
    assert.equal(options.credentials, "include");
    return new Response(JSON.stringify({ data: responses[path] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const dashboard = await api.getDashboard("INSTITUTION");
  assert.deepEqual(requests.sort(), Object.keys(responses).sort());
  assert.deepEqual(dashboard.cases, []);
  assert.deepEqual(dashboard.documents, []);
  assert.deepEqual(dashboard.notifications, []);
  assert.deepEqual(dashboard.undertakings, []);
  assert.deepEqual(dashboard.summary, {
    openUndertakings: 0,
    undertakingsDueIn7Days: 0,
    documentsExpiringIn30Days: 0,
    casesInProgress: 0,
    waitingOnOfficers: 0,
    applications: 0,
    openAlerts: 0,
  });
});
