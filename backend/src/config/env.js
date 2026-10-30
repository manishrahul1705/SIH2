import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/approvaltrack?replicaSet=rs0"),
  QUEUE_MODE: z.enum(["inline", "bullmq"]).default("inline"),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  SESSION_COOKIE_NAME: z.string().min(1).default("approvaltrack_session"),
  COOKIE_SECRET: z.string().min(32).default("development-only-change-this-cookie-secret-000000"),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
  RESEND_API_KEY: z.string().default(""),
  RESEND_WEBHOOK_SECRET: z.string().default(""),
  MAIL_FROM: z.string().default("ApprovalTrack Demo <onboarding@resend.dev>"),
  TEXTBEE_API_KEY: z.string().default(""),
  TEXTBEE_DEVICE_ID: z.string().default(""),
  UPLOAD_DIR: z.string().default("./uploads"),
  CLAMAV_HOST: z.string().trim().default(""),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  AI_SERVICE_URL: z.union([z.string().url(), z.literal("")]).default(""),
  AI_SERVICE_TOKEN: z.string().default(""),
  PYTHON_BIN: z.string().default("python"),
  OCR_SCRIPT_PATH: z.string().default("../mlmodels/Model1/ocr/ocr_extract.py"),
  M1_SCRIPT_PATH: z.string().default("../mlmodels/Model1/m1_training/predict_m1.py"),
  M2_SCRIPT_PATH: z.string().default("../mlmodels/Model2/ocr/m2_extract.py"),
  M3_SCRIPT_PATH: z.string().default("../mlmodels/Model3/ocr/m3_extract.py"),
  TZ: z.string().default("Asia/Kolkata"),
  NOTIFY_MODE: z.enum(["log", "send"]).default("log"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = Object.freeze(parsed.data);

if (env.NODE_ENV === "production" && !process.env.COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET must be explicitly configured in production");
}
if (env.NODE_ENV === "production" && !env.CLAMAV_HOST) {
  throw new Error("CLAMAV_HOST must be configured in production so uploads are malware-scanned");
}
if (env.NODE_ENV === "production" && env.AI_SERVICE_URL && !env.AI_SERVICE_TOKEN) {
  throw new Error("AI_SERVICE_TOKEN must be configured when using a remote AI service in production");
}
