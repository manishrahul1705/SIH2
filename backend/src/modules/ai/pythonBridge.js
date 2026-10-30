import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "../../config/env.js";

const remoteOperations = Object.freeze({
  "ocr_extract.py": "ocr",
  "predict_m1.py": "m1",
  "m2_extract.py": "m2",
  "m3_extract.py": "m3",
});

export class PythonBridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PythonBridgeError";
    this.code = code;
  }
}

async function readBoundedBody(response, maxOutputBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxOutputBytes) {
      await reader.cancel();
      throw new PythonBridgeError("AI service output exceeded the configured limit", "PYTHON_OUTPUT_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runRemoteJson(scriptPath, args, { timeoutMs, maxOutputBytes, input, serviceUrl, serviceToken }) {
  const operation = remoteOperations[path.basename(scriptPath).toLowerCase()];
  if (!operation) throw new PythonBridgeError("Python script is not allowlisted for remote execution", "AI_OPERATION_NOT_ALLOWED");
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (serviceToken) headers["X-AI-Service-Token"] = serviceToken;
  let response;
  try {
    response = await fetch(`${serviceUrl.replace(/\/+$/, "")}/v1/inference/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ args: args.map(String), input, timeout_ms: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 1000),
    });
  } catch (error) {
    const code = error.name === "TimeoutError" || error.name === "AbortError" ? "AI_SERVICE_TIMEOUT" : "AI_SERVICE_UNAVAILABLE";
    throw new PythonBridgeError("The remote AI service could not complete the request", code);
  }
  let responseText;
  try {
    responseText = await readBoundedBody(response, maxOutputBytes);
  } catch (error) {
    if (error instanceof PythonBridgeError) throw error;
    throw new PythonBridgeError("The AI service response could not be read", "AI_SERVICE_RESPONSE_FAILED");
  }
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new PythonBridgeError("AI service returned invalid JSON", "PYTHON_INVALID_JSON");
  }
  if (!response.ok) {
    const detail = result?.detail;
    throw new PythonBridgeError(
      typeof detail?.message === "string" ? detail.message : "The AI service rejected the inference request",
      typeof detail?.code === "string" ? detail.code : "AI_SERVICE_REQUEST_FAILED",
    );
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PythonBridgeError("AI service response must be a JSON object", "PYTHON_INVALID_JSON");
  }
  return result;
}

export function runPythonJson(scriptPath, args, {
  timeoutMs = 120_000,
  maxOutputBytes = 10 * 1024 * 1024,
  input = "",
  maxInputBytes = 20 * 1024 * 1024,
  acceptedExitCodes = [0],
  serviceUrl = env.AI_SERVICE_URL,
  serviceToken = env.AI_SERVICE_TOKEN,
} = {}) {
  if (Buffer.byteLength(input, "utf8") > maxInputBytes) {
    return Promise.reject(new PythonBridgeError("Python input exceeded the configured limit", "PYTHON_INPUT_TOO_LARGE"));
  }
  if (serviceUrl) return runRemoteJson(scriptPath, args, { timeoutMs, maxOutputBytes, input, serviceUrl, serviceToken });
  return new Promise((resolve, reject) => {
    const modelDirectories = [env.M1_SCRIPT_PATH, env.M2_SCRIPT_PATH, env.M3_SCRIPT_PATH]
      .map((configuredPath) => path.dirname(path.resolve(process.cwd(), configuredPath)));
    const ocrDirectories = modelDirectories.map((directory) => path.resolve(directory, "..", "ocr"));
    const pythonPath = [...new Set([...modelDirectories, ...ocrDirectories, process.env.PYTHONPATH].filter(Boolean))]
      .join(path.delimiter);
    const child = spawn(env.PYTHON_BIN, [scriptPath, ...args.map(String)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: pythonPath,
        M3_OCR_DIR: ocrDirectories[0],
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new PythonBridgeError("Python model timed out", "PYTHON_TIMEOUT"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", (error) => finish(new PythonBridgeError(`Could not send Python input: ${error.message}`, "PYTHON_INPUT_FAILED")));
    child.stdin.end(input);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill();
        finish(new PythonBridgeError("Python output exceeded the configured limit", "PYTHON_OUTPUT_TOO_LARGE"));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.once("error", (error) => finish(new PythonBridgeError(`Could not start Python: ${error.message}`, "PYTHON_START_FAILED")));
    child.once("close", (code) => {
      if (settled) return;
      if (!acceptedExitCodes.includes(code)) {
        return finish(new PythonBridgeError(`Python exited with status ${code}${stderr ? `: ${stderr}` : ""}`, "PYTHON_EXIT_NONZERO"));
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new PythonBridgeError("Python did not return valid JSON", "PYTHON_INVALID_JSON"));
      }
    });
  });
}
