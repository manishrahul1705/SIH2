import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { PythonBridgeError, runPythonJson } from "../src/modules/ai/pythonBridge.js";

const servers = new Set();

async function listen(handler) {
  const server = http.createServer(handler);
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

describe("remote AI Python bridge", () => {
  it("uses only the allowlisted operation and sends JSON input with service authentication", async () => {
    let requestBody = "";
    let requestHeaders;
    const service = await listen((request, response) => {
      requestHeaders = request.headers;
      request.on("data", (chunk) => { requestBody += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ supported: true, pages: [] }));
      });
    });

    const result = await runPythonJson("C:\\models\\m2_extract.py", ["C:\\uploads\\permit.pdf", "--doc-type", "fire", "--ocr-json-stdin"], {
      serviceUrl: service.url,
      serviceToken: "test-token",
      input: "{\"pages\":[]}",
    });

    expect(result).toEqual({ supported: true, pages: [] });
    expect(requestHeaders["x-ai-service-token"]).toBe("test-token");
    expect(requestHeaders["content-type"]).toBe("application/json");
    expect(JSON.parse(requestBody)).toMatchObject({
      args: ["C:\\uploads\\permit.pdf", "--doc-type", "fire", "--ocr-json-stdin"],
      input: "{\"pages\":[]}",
    });
    expect(service.server).toBeTruthy();
  });

  it("rejects unknown scripts before making a remote request", async () => {
    await expect(runPythonJson("C:\\models\\unknown.py", [], { serviceUrl: "http://127.0.0.1:1" }))
      .rejects.toMatchObject({ code: "AI_OPERATION_NOT_ALLOWED" });
  });

  it("preserves structured service errors", async () => {
    const service = await listen((request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: { code: "AI_MODEL_UNAVAILABLE", message: "Model script missing" } }));
    });

    await expect(runPythonJson("predict_m1.py", ["--text-stdin"], { serviceUrl: service.url }))
      .rejects.toMatchObject({ code: "AI_MODEL_UNAVAILABLE", message: "Model script missing" });
  });

  it("enforces the configured response limit while streaming", async () => {
    const service = await listen((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "response too large" }));
    });

    await expect(runPythonJson("predict_m1.py", ["--text-stdin"], {
      serviceUrl: service.url,
      maxOutputBytes: 4,
    })).rejects.toBeInstanceOf(PythonBridgeError);
    await expect(runPythonJson("predict_m1.py", ["--text-stdin"], {
      serviceUrl: service.url,
      maxOutputBytes: 4,
    })).rejects.toMatchObject({ code: "PYTHON_OUTPUT_TOO_LARGE" });
  });

  it("reports interrupted response streams explicitly", async () => {
    const service = await listen((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write("{\"partial\":");
      setTimeout(() => response.destroy(), 25);
    });

    await expect(runPythonJson("predict_m1.py", ["--text-stdin"], { serviceUrl: service.url }))
      .rejects.toMatchObject({ code: "AI_SERVICE_RESPONSE_FAILED" });
  });
});
