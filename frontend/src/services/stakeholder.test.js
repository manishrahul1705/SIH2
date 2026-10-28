import test from "node:test";
import assert from "node:assert/strict";
import { reportSummary, stakeholderApi } from "./stakeholder.js";

test("yearly report summary uses values returned by the backend", () => {
  assert.equal(reportSummary({
    report_data: {
      courses_taught: ["Course 1", "Course 2"],
      publications: ["Publication"],
      fdp_certifications: [],
    },
  }), "2 courses, 1 publications, 0 FDP records.");
});

test("yearly report actions call the authenticated backend endpoints", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ data: { _id: "report-id" } }),
    };
  });

  const report = await stakeholderApi.saveYearlyReport({
    academic_year: "2025-26",
    due_date: "2026-03-31",
    report_data: { courses_taught: ["Course 1"] },
  });
  await stakeholderApi.submitYearlyReport(report._id);

  assert.equal(calls[0].url, "http://localhost:4000/api/v1/yearly-reports");
  assert.equal(calls[0].options.credentials, "include");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    academic_year: "2025-26",
    due_date: "2026-03-31",
    report_data: { courses_taught: ["Course 1"] },
  });
  assert.equal(calls[1].url, "http://localhost:4000/api/v1/yearly-reports/report-id/submit");
  assert.equal(calls[1].options.method, "PATCH");
});

test("yearly report errors are surfaced to the caller", async (context) => {
  context.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: "Faculty profile not found" } }),
  }));
  await assert.rejects(stakeholderApi.getYearlyReports(), /Faculty profile not found/);
});
