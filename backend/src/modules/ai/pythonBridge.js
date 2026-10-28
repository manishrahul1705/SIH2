import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "../../config/env.js";

export class PythonBridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PythonBridgeError";
    this.code = code;
  }
}

export function runPythonJson(scriptPath, args, { timeoutMs = 120_000, maxOutputBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const modelDirectories = [env.M1_SCRIPT_PATH, env.M2_SCRIPT_PATH, env.M3_SCRIPT_PATH]
      .map((configuredPath) => path.dirname(path.resolve(process.cwd(), configuredPath)));
    const ocrDirectories = modelDirectories.map((directory) => path.resolve(directory, "..", "ocr"));
    const pythonPath = [...new Set([...modelDirectories, ...ocrDirectories, process.env.PYTHONPATH].filter(Boolean))]
      .join(path.delimiter);
    const child = spawn(env.PYTHON_BIN, [scriptPath, ...args.map(String)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      if (code !== 0) return finish(new PythonBridgeError(`Python exited with status ${code}${stderr ? `: ${stderr}` : ""}`, "PYTHON_EXIT_NONZERO"));
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new PythonBridgeError("Python did not return valid JSON", "PYTHON_INVALID_JSON"));
      }
    });
  });
}
