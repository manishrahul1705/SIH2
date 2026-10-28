import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : process.env.LOG_LEVEL || "info",
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", "password", "token", "otp", "payload"],
    censor: "[REDACTED]",
  },
  base: { service: "approvaltrack-api", environment: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
});
