import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { API_PREFIX } from "./config/constants.js";
import { logger } from "./config/logger.js";
import { mongoose } from "./models/db.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { authRouter, csrfProtection } from "./middleware/auth.js";
import { writeAudit } from "./middleware/audit.js";
import { applicationsRouter } from "./modules/applications/router.js";
import { peopleRouter } from "./modules/people/router.js";
import { resendWebhookRouter } from "./modules/notifications/webhook.js";
import { documentsRouter } from "./modules/documents/router.js";
import { workflowRouter } from "./modules/workflow/router.js";
import { institutionsRouter } from "./modules/institutions/router.js";
import { adminRouter } from "./modules/admin/router.js";
import { dashboardRouter } from "./modules/dashboard/router.js";
import { casesRouter } from "./modules/cases/router.js";
import { stakeholdersRouter } from "./modules/stakeholders/router.js";
import { evcRouter } from "./modules/evc/router.js";
import { adminIncidentsRouter } from "./modules/admin/incidents/router.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const providedId = req.get("x-request-id") || "";
    req.id = /^[A-Za-z0-9._:-]{1,100}$/.test(providedId) ? providedId : crypto.randomUUID();
    res.setHeader("x-request-id", req.id);
    next();
  });
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: env.NODE_ENV !== "test",
    redact: { paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-api-key']"], censor: "[REDACTED]" },
  }));
  app.use(helmet({ strictTransportSecurity: env.NODE_ENV === "production" ? undefined : false }));
  app.use(cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Requested-With", "X-Request-Id"],
  }));
  app.use(express.json({ limit: "1mb", verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(`${API_PREFIX}/auth`, rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.NODE_ENV === "test" ? 300 : 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }));

  app.get("/health", async (req, res) => {
    const uploadDirectory = path.resolve(process.cwd(), env.UPLOAD_DIR);
    let uploadWritable = false;
    let pythonAvailable = false;
    try {
      await fs.mkdir(uploadDirectory, { recursive: true });
      await fs.access(uploadDirectory, fs.constants.W_OK);
      uploadWritable = true;
    } catch (error) {
      logger.warn({ err: error }, "Upload directory health check failed");
    }
    if (env.AI_SERVICE_URL) {
      try {
        const response = await fetch(`${env.AI_SERVICE_URL.replace(/\/+$/, "")}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        pythonAvailable = response.ok;
      } catch {
        pythonAvailable = false;
      }
    } else {
      try {
        const { spawn } = await import("node:child_process");
        pythonAvailable = await new Promise((resolve) => {
          const child = spawn(env.PYTHON_BIN, ["--version"], { windowsHide: true });
          const timeout = setTimeout(() => {
            child.kill();
            resolve(false);
          }, 2000);
          child.once("error", () => { clearTimeout(timeout); resolve(false); });
          child.once("close", (code) => { clearTimeout(timeout); resolve(code === 0); });
        });
      } catch {
        pythonAvailable = false;
      }
    }
    const mongoReady = mongoose.connection.readyState === 1;
    const status = mongoReady && uploadWritable ? 200 : 503;
    res.status(status).json({
      data: { status: status === 200 ? "ok" : "degraded", checks: {
        mongodb: mongoReady ? "ok" : "unavailable",
        uploadDirectory: uploadWritable ? "ok" : "unavailable",
        python: pythonAvailable ? "ok" : "unavailable",
      } },
      error: null,
      meta: { requestId: req.id },
    });
  });

  app.get(`${API_PREFIX}`, (req, res) => res.json({
    data: { name: "ApprovalTrack API", version: "v1", status: "ready" },
    error: null,
    meta: { requestId: req.id },
  }));
  app.use("/webhooks/resend", resendWebhookRouter());
  app.use(`${API_PREFIX}`, csrfProtection);
  app.use(`${API_PREFIX}/auth`, authRouter({ audit: writeAudit }));
  app.use(`${API_PREFIX}`, peopleRouter());
  app.use(`${API_PREFIX}/institutions`, institutionsRouter());
  app.use(`${API_PREFIX}`, casesRouter());
  app.use(`${API_PREFIX}/applications`, applicationsRouter());
  app.use(`${API_PREFIX}`, documentsRouter());
  app.use(`${API_PREFIX}`, workflowRouter());
  app.use(`${API_PREFIX}/dashboard`, dashboardRouter());
  app.use(`${API_PREFIX}`, adminRouter());
  app.use(`${API_PREFIX}/admin`, adminRouter());
  app.use(`${API_PREFIX}/admin/incidents`, adminIncidentsRouter());
  app.use(`${API_PREFIX}`, stakeholdersRouter());
  app.use(`${API_PREFIX}/evc`, evcRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
