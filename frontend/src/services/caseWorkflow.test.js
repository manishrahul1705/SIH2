import test from "node:test";
import assert from "node:assert/strict";
import { caseWorkflowApi, waitForDocumentAnalysis } from "./caseWorkflow.js";

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
