import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(frontendDirectory, "..", "backend");
const apiPort = process.env.E2E_API_PORT || "4317";
const frontendPort = process.env.E2E_FRONTEND_PORT || "5174";
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
const demoPassword = process.env.E2E_DEMO_PASSWORD;

if (!demoPassword || demoPassword.length < 12) {
  throw new Error("Set E2E_DEMO_PASSWORD to a test-only password of at least 12 characters.");
}

const serviceEnvironment = {
  NODE_ENV: "test",
  PORT: apiPort,
  MONGODB_URI: process.env.MONGODB_URI || "",
  COOKIE_SECRET: "approvaltrack-e2e-cookie-secret-only-do-not-use",
  SESSION_COOKIE_NAME: "approvaltrack_e2e_session",
  FRONTEND_ORIGIN: frontendOrigin,
  QUEUE_MODE: "inline",
  NOTIFY_MODE: "log",
  DEMO_PASSWORD: demoPassword,
  PYTHON_BIN: process.env.PYTHON_BIN || "python",
  UPLOAD_DIR: path.resolve(backendDirectory, "uploads"),
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: frontendOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  globalSetup: "./e2e/global-setup.js",
  globalTeardown: "./e2e/global-teardown.js",
  webServer: [
    {
      command: "node src/server.js",
      cwd: backendDirectory,
      url: `${apiOrigin}/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: serviceEnvironment,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      cwd: frontendDirectory,
      url: frontendOrigin,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...process.env, VITE_API_BASE_URL: `${apiOrigin}/api/v1` },
    },
  ],
});
