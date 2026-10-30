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

test("complaints and announcements use authenticated API routes", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: { _id: "created" } }) };
  });
  await stakeholderApi.createComplaint({ category: "FEES", subject: "Fee issue", description: "A sufficiently detailed complaint description." });
  await stakeholderApi.getComplaints();
  await stakeholderApi.getAnnouncements();
  await stakeholderApi.createAnnouncement({ title: "Notice title", body: "Announcement body with sufficient length." });
  assert.equal(calls[0].url, "http://localhost:4000/api/v1/complaints");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[1].url, "http://localhost:4000/api/v1/complaints?page=1&pageSize=100");
  assert.equal(calls[2].url, "http://localhost:4000/api/v1/announcements?page=1&pageSize=50");
  assert.equal(calls[3].url, "http://localhost:4000/api/v1/announcements");
});

test("grievance portals use role-scoped endpoints and submit institution replies as multipart data", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: [] }) };
  });
  await stakeholderApi.getMyComplaints();
  await stakeholderApi.getComplaintInstitutions();
  await stakeholderApi.getAdminComplaintSummary();
  await stakeholderApi.getAdminCollegeComplaints("college-id");
  await stakeholderApi.acknowledgeComplaint("complaint-id", "Please respond.", true);
  await stakeholderApi.getInstitutionComplaints();
  await stakeholderApi.replyToComplaint("complaint-id", "We have completed the action.", new Blob(["proof"]));

  assert.equal(calls[0].url, "http://localhost:4000/api/v1/complaints/my-complaints?page=1&pageSize=100");
  assert.equal(calls[1].url, "http://localhost:4000/api/v1/complaints/institutions");
  assert.equal(calls[2].url, "http://localhost:4000/api/v1/complaints/admin/colleges-summary");
  assert.equal(calls[3].url, "http://localhost:4000/api/v1/complaints/admin/colleges/college-id");
  assert.equal(calls[4].url, "http://localhost:4000/api/v1/complaints/admin/complaint-id/acknowledge");
  assert.equal(calls[4].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[4].options.body), { admin_remarks: "Please respond.", evidence_reviewed: true });
  assert.equal(calls[5].url, "http://localhost:4000/api/v1/complaints/institution/my-college?page=1&pageSize=100");
  assert.equal(calls[6].url, "http://localhost:4000/api/v1/complaints/institution/complaint-id/reply");
  assert.ok(calls[6].options.body instanceof FormData);
  assert.equal(calls[6].options.headers["Content-Type"], undefined);
});
