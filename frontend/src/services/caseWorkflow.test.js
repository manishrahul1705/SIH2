import test from "node:test";
import assert from "node:assert/strict";
import { caseWorkflowApi, waitForDocumentAnalysis, waitForDocumentBatch } from "./caseWorkflow.js";

test("checklist preview sends the selected application and applicability answers", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { checklist: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.previewChecklist({
    applicationType: "new_course",
    applicability: { landIsLeased: true },
    routeFlags: {},
  });
  assert.equal(requestUrl, "http://localhost:4000/api/v1/checklist/preview");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.credentials, "include");
  assert.equal(requestOptions.headers["X-Requested-With"], "XMLHttpRequest");
  assert.deepEqual(JSON.parse(requestOptions.body), {
    applicationType: "new_course",
    applicability: { landIsLeased: true },
    routeFlags: {},
  });
  assert.deepEqual(result, { checklist: [] });
});

test("lists cases from the authenticated backend with pagination", async (context) => {
  let requestUrl;
  context.mock.method(globalThis, "fetch", async (url) => {
    requestUrl = url;
    return new Response(JSON.stringify({ data: [{ caseNo: "AT-2026-0010" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.listCases({ page: 2, pageSize: 50 });
  assert.equal(requestUrl, "http://localhost:4000/api/v1/cases?page=2&pageSize=50");
  assert.deepEqual(result, [{ caseNo: "AT-2026-0010" }]);
});

test("lists only documents returned by the authenticated document endpoint", async (context) => {
  let requestUrl;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    assert.equal(options.credentials, "include");
    return new Response(JSON.stringify({ data: [{ _id: "doc-1", original_name: "permit.pdf" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.listDocuments({ page: 3, pageSize: 25 });
  assert.equal(requestUrl, "http://localhost:4000/api/v1/documents?page=3&pageSize=25");
  assert.deepEqual(result, [{ _id: "doc-1", original_name: "permit.pdf" }]);
  assert.equal(
    caseWorkflowApi.getDocumentDownloadUrl("doc-1"),
    "http://localhost:4000/api/v1/documents/doc-1/download",
  );
});

test("lists escalation alerts from the authenticated alerts endpoint", async (context) => {
  let requestedUrl = "";
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestedUrl = url;
    assert.equal(options.credentials, "include");
    return new Response(JSON.stringify({ data: [{ _id: "alert-1", type: "STAGE_DELAY_ESCALATED" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const alerts = await caseWorkflowApi.listAlerts({ page: 2, pageSize: 10 });
  assert.match(requestedUrl, /\/alerts\?page=2&pageSize=10$/);
  assert.equal(alerts[0].type, "STAGE_DELAY_ESCALATED");
});

test("acknowledges alerts through the authenticated backend", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { status: "ACKNOWLEDGED" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.updateAlertStatus("alert-1", "ACKNOWLEDGED");
  assert.equal(requestUrl, "http://localhost:4000/api/v1/alerts/alert-1");
  assert.equal(requestOptions.method, "PATCH");
  assert.equal(requestOptions.credentials, "include");
  assert.deepEqual(JSON.parse(requestOptions.body), { status: "ACKNOWLEDGED" });
  assert.deepEqual(result, { status: "ACKNOWLEDGED" });
});

test("case document upload sends multipart data without overriding its boundary", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { status: "UPLOADED" } }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  });

  const file = new Blob(["%PDF-1.7"], { type: "application/pdf" });
  const result = await caseWorkflowApi.uploadDocument("case/1", "fire", file);
  assert.equal(requestUrl, "http://localhost:4000/api/v1/cases/case%2F1/documents");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.credentials, "include");
  assert.equal(requestOptions.headers["X-Requested-With"], "XMLHttpRequest");
  assert.equal(requestOptions.headers["Content-Type"], undefined);
  assert.equal(requestOptions.body.get("doc_type_slot"), "fire");
  assert.equal(requestOptions.body.get("file").type, "application/pdf");
  assert.deepEqual(result, { status: "UPLOADED" });
});

test("starts AI detection for all uploaded documents in one request", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({
      data: { documents: [{ document_id: "doc-1", status: "UPLOADED" }], queued_count: 1 },
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.analyzeCaseDocuments("case-1");
  assert.equal(requestUrl, "http://localhost:4000/api/v1/cases/case-1/documents/analyze");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.credentials, "include");
  assert.deepEqual(JSON.parse(requestOptions.body), {});
  assert.equal(result.queued_count, 1);
});

test("shows backend field errors when a case request is rejected", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    data: null,
    error: { code: "MISSING_DOCUMENTS", message: "Required documents are missing", details: [{ slotId: "fire", label: "Fire safety" }] },
  }), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  }));
  await assert.rejects(
    caseWorkflowApi.submitCase("case-1", 2),
    /Fire safety/,
  );
});

test("waits until document analysis completes and returns its findings", async (context) => {
  const responses = [
    { document: { status: "PROCESSING" }, extraction: null },
    { document: { status: "AWAITING_CONFIRMATION" }, extraction: { rule_results_json: [] } },
  ];
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    data: responses.shift(),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));

  const result = await waitForDocumentAnalysis("document-1", { intervalMs: 0 });
  assert.equal(result.document.status, "AWAITING_CONFIRMATION");
  assert.deepEqual(result.extraction.rule_results_json, []);
});

test("reports a missing analysis status instead of treating it as success", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    data: { extraction: null },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));

  await assert.rejects(
    waitForDocumentAnalysis("document-1"),
    /analysis status is unavailable/,
  );
});

test("waits for the complete document batch and reports batch progress", async (context) => {
  const finished = [];
  context.mock.method(globalThis, "fetch", async (url) => {
    const documentId = decodeURIComponent(new URL(url).pathname.split("/").at(-2));
    return new Response(JSON.stringify({
      data: { document: { _id: documentId, status: "AWAITING_CONFIRMATION" }, extraction: { fields: [] } },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const results = await waitForDocumentBatch([
    { document_id: "doc-1" },
    { document_id: "doc-2" },
  ], {
    onProgress: (progress) => finished.push(progress),
  });
  assert.equal(results.length, 2);
  assert.equal(finished.length, 2);
  assert.deepEqual(finished.map(({ total }) => total), [2, 2]);
});
