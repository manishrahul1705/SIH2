import test from "node:test";
import assert from "node:assert/strict";
import {
  ambiguousDateChoices,
  areUploadedDocumentsReadyForRoute,
  caseWorkflowApi,
  waitForDocumentAnalysis,
  waitForDocumentBatch,
} from "./caseWorkflow.js";

test("policy route is shown only after every uploaded document reaches a terminal analysis state", () => {
  assert.equal(areUploadedDocumentsReadyForRoute([]), false);
  assert.equal(areUploadedDocumentsReadyForRoute([
    { documentId: "doc-1", status: "pending_confirmation" },
    { documentId: "doc-2", status: "uploaded" },
  ]), false);
  assert.equal(areUploadedDocumentsReadyForRoute([
    { documentId: "doc-1", status: "pending_confirmation" },
    { documentId: "doc-2", status: "pending_confirmation" },
  ]), true);
  assert.equal(areUploadedDocumentsReadyForRoute([
    { documentId: null, status: "missing" },
    { documentId: "doc-1", status: "confirmed" },
  ]), true);
});

test("ambiguous numeric dates require an explicit choice and expose both valid interpretations", () => {
  assert.deepEqual(ambiguousDateChoices({
    source_text: "Validity until 04/05/2027",
    ai_value: "2027-05-04",
  }), [
    { value: "2027-05-04", label: "4/5/2027 (day/month/year)" },
    { value: "2027-04-05", label: "5/4/2027 (month/day/year)" },
  ]);
  assert.deepEqual(ambiguousDateChoices({ source_text: "13/05/2027" }), []);
});

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

test("loads scoped case stage history from the case history endpoint", async (context) => {
  let requestUrl = "";
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    assert.equal(options.credentials, "include");
    return new Response(JSON.stringify({ data: [{ toStage: "scrutiny", enteredAt: "2026-05-01T10:00:00Z" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const history = await caseWorkflowApi.getCaseHistory("case / 1");
  assert.equal(requestUrl, "http://localhost:4000/api/v1/cases/case%20%2F%201/history");
  assert.deepEqual(history, [{ toStage: "scrutiny", enteredAt: "2026-05-01T10:00:00Z" }]);
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

test("downloads a document blob through the authenticated document endpoint", async (context) => {
  let requestUrl;
  let requestOptions;
  const documentBlob = new Blob(["pdf data"], { type: "application/pdf" });
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(documentBlob, {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  });

  const result = await caseWorkflowApi.downloadDocument("doc / 1");
  assert.equal(requestUrl, "http://localhost:4000/api/v1/documents/doc%20%2F%201/download");
  assert.equal(requestOptions.credentials, "include");
  assert.equal(result.type, "application/pdf");
  assert.equal(await result.text(), "pdf data");
});

test("surfaces backend errors when a protected document download is rejected", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    data: null,
    error: { code: "NOT_FOUND", message: "Document not found" },
  }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  }));

  await assert.rejects(caseWorkflowApi.downloadDocument("missing-doc"), /Document not found/);
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

test("lists open alerts for the navbar drawer", async (context) => {
  let requestedUrl = "";
  context.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await caseWorkflowApi.listAlerts({ pageSize: 100, status: "OPEN" });
  assert.match(requestedUrl, /\/alerts\?page=1&pageSize=100&status=OPEN$/);
});

test("creates workflow drafts through the requested applications endpoint", async (context) => {
  let requestedUrl = "";
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestedUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { _id: "case-1" } }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });

  await caseWorkflowApi.createDraft({ applicationType: "new_institution" });
  assert.equal(requestedUrl, "http://localhost:4000/api/v1/applications");
  assert.equal(requestOptions.method, "POST");
});

test("confirms case document fields through the application-scoped PATCH endpoint", async (context) => {
  let requestedUrl = "";
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestedUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { document: { _id: "doc-1" } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await caseWorkflowApi.confirmFields("doc-1", [{ field_name: "valid_to", confirmed_value: "2027-10-29" }], true, [], "case-1");
  assert.equal(requestedUrl, "http://localhost:4000/api/v1/applications/case-1/documents/doc-1/confirm-fields");
  assert.equal(requestOptions.method, "PATCH");
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

test("case processing and finding views use the scoped backend endpoints", async (context) => {
  const requestedUrls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestedUrls.push(url);
    assert.equal(options.credentials, "include");
    const data = url.endsWith("/processing") ? { tasks: [], findings: [] } : [];
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(await caseWorkflowApi.getCaseProcessing("case-1"), { tasks: [], findings: [] });
  assert.deepEqual(await caseWorkflowApi.getCaseFindings("case-1"), []);
  assert.deepEqual(requestedUrls, [
    "http://localhost:4000/api/v1/cases/case-1/processing",
    "http://localhost:4000/api/v1/cases/case-1/findings",
  ]);
});

test("verifies a document with an explicit human outcome and reason", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { verification: "not_verified" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.verifyDocument("doc-1", {
    verification: "not_verified",
    reason: "The issuer details do not match.",
  });
  assert.equal(requestUrl, "http://localhost:4000/api/v1/documents/doc-1/verify");
  assert.equal(requestOptions.method, "POST");
  assert.deepEqual(JSON.parse(requestOptions.body), {
    verification: "not_verified",
    reason: "The issuer details do not match.",
  });
  assert.deepEqual(result, { verification: "not_verified" });
});

test("uploads the EVC report as multipart data", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { pipelineStatus: "pending_retry" } }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  });

  const file = new Blob(["%PDF-1.7"], { type: "application/pdf" });
  const result = await caseWorkflowApi.uploadEvcReport("case-1", file);
  assert.equal(requestUrl, "http://localhost:4000/api/v1/cases/case-1/evc-report");
  assert.equal(requestOptions.headers["Content-Type"], undefined);
  assert.equal(requestOptions.body.get("file").type, "application/pdf");
  assert.deepEqual(result, { pipelineStatus: "pending_retry" });
});

test("resubmits a returned case with its expected version", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { case: { _id: "case-1", status: "in_progress" } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await caseWorkflowApi.resubmitCase("case-1", 7);
  assert.equal(requestUrl, "http://localhost:4000/api/v1/cases/case-1/resubmit");
  assert.equal(requestOptions.method, "POST");
  assert.deepEqual(JSON.parse(requestOptions.body), { expectedVersion: 7 });
  assert.equal(result.case.status, "in_progress");
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
    (error) => error.message === "Fire safety" && error.code === "MISSING_DOCUMENTS",
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
