import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Resend } from "resend";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { Alert, NotificationJob, NotificationLog, User } from "../../models/index.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const MAX_ATTEMPTS = 5;
const IST = "Asia/Kolkata";

function adjustedSmsTime(runAt, type, now = new Date()) {
  const urgent = /OTP|LEASE_T1|LEASE_EXPIRED/i.test(type);
  if (urgent) return runAt;
  const date = runAt > now ? new Date(runAt) : new Date(now);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (hour >= 8 && hour < 21) return date;
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => Number(dateParts.find((part) => part.type === type)?.value);
  const nextMorning = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 2, 30));
  if (hour >= 21) nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
  return nextMorning;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function emailHtml(subject, body) {
  const templatePath = path.resolve(process.cwd(), "templates", "email", "notification.html");
  const template = await readFile(templatePath, "utf8");
  return template
    .replaceAll("{{subject}}", escapeHtml(subject))
    .replaceAll("{{body}}", escapeHtml(body).replaceAll("\n", "<br>"));
}

function e164(phone) {
  const trimmed = String(phone || "").trim();
  if (!trimmed) return null;
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  const normalized = digits.startsWith("0") ? digits.slice(1) : digits;
  const withCountry = normalized.startsWith("91") ? `+${normalized}` : `+91${normalized}`;
  return /^\+[1-9]\d{7,14}$/.test(withCountry) ? withCountry : null;
}

export class NotificationService {
  static async enqueue({ type, channel, userId, payload = {}, runAt = new Date(), dedupeKey }) {
    if (!type || !["EMAIL", "SMS", "IN_APP"].includes(channel) || !userId || !dedupeKey) {
      throw new TypeError("Notification requires type, supported channel, userId, and dedupeKey");
    }
    const scheduledAt = channel === "SMS" ? adjustedSmsTime(new Date(runAt), type) : new Date(runAt);
    await NotificationJob.updateOne(
      { dedupe_key: dedupeKey },
      { $setOnInsert: { type, channel, to_user_id: userId, payload_json: payload, dedupe_key: dedupeKey, run_at: scheduledAt, status: "PENDING" } },
      { upsert: true, runValidators: true },
    );
    return NotificationJob.findOne({ dedupe_key: dedupeKey }).lean();
  }

  static async claim(now = new Date()) {
    const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
    await NotificationJob.updateMany(
      { status: "PROCESSING", locked_at: { $lt: staleBefore } },
      { $set: { status: "PENDING", locked_at: null, run_at: now, last_error: "Recovered stale worker claim" } },
    );
    return NotificationJob.findOneAndUpdate(
      { status: "PENDING", run_at: { $lte: now } },
      { $set: { status: "PROCESSING", locked_at: now }, $inc: { attempts: 1 } },
      { sort: { run_at: 1, createdAt: 1 }, new: true },
    );
  }

  static async processDue({ limit = 100, now = new Date() } = {}) {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const job = await NotificationService.claim(now);
      if (!job) break;
      await NotificationService.deliver(job, now);
    }
    logger.info({ processed }, "Notification worker batch completed");
    return { processed };
  }

  static async deliver(job, now = new Date()) {
    const user = await User.findById(job.to_user_id);
    if (!user || user.status !== "ACTIVE") return NotificationService.skip(job, "Recipient unavailable");
    if (job.channel === "EMAIL" && user.email_bounced) return NotificationService.skip(job, "Recipient email previously bounced");
    if (job.channel === "EMAIL" && user.notify_email === false && !job.payload_json.security) return NotificationService.skip(job, "Email notifications disabled");
    if (job.channel === "SMS" && user.notify_sms === false && !job.payload_json.security) return NotificationService.skip(job, "SMS notifications disabled");

    try {
      if (job.channel === "IN_APP") {
        await Alert.updateOne(
          { dedupe_key: job.dedupe_key },
          { $setOnInsert: {
            application_id: job.payload_json.application_id || null,
            case_id: job.payload_json.case_id || null,
            type: job.type,
            severity: job.payload_json.severity || "INFO",
            target_user_id: user._id,
            title: job.payload_json.title || job.type.replaceAll("_", " "),
            body: job.payload_json.body || "",
            due_at: job.payload_json.due_at || null,
            dedupe_key: job.dedupe_key,
          } },
          { upsert: true, runValidators: true },
        );
        return NotificationService.complete(job, "");
      }
      if (env.NOTIFY_MODE === "log") {
        logger.info({ notificationType: job.type, channel: job.channel, jobId: job._id.toString() }, "Notification delivered in log mode");
        return NotificationService.complete(job, `log-${createHash("sha256").update(job.dedupe_key).digest("hex").slice(0, 16)}`);
      }
      if (job.channel === "EMAIL") {
        if (!resend) throw Object.assign(new Error("Resend API key is not configured"), { code: "EMAIL_NOT_CONFIGURED", retryable: false });
        const subject = String(job.payload_json.subject || "ApprovalTrack notification");
        const body = String(job.payload_json.body || "");
        const message = await resend.emails.send({
          from: env.MAIL_FROM,
          to: user.email,
          subject,
          html: await emailHtml(subject, body),
          text: `${subject}\n\n${body}\n\nApprovalTrack demo notification. Official action requires human review.`,
        });
        if (message.error) throw Object.assign(new Error(message.error.message), { code: message.error.name || "RESEND_ERROR" });
        return NotificationService.complete(job, message.data?.id || "");
      }
      const recipient = e164(user.phone);
      if (!recipient) return NotificationService.skip(job, "No valid phone number");
      if (!env.TEXTBEE_API_KEY || !env.TEXTBEE_DEVICE_ID) throw Object.assign(new Error("TextBee is not configured"), { code: "SMS_NOT_CONFIGURED", retryable: false });
      const message = String(job.payload_json.message || job.payload_json.body || job.type).slice(0, 160);
      const response = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(env.TEXTBEE_DEVICE_ID)}/send-sms`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.TEXTBEE_API_KEY },
        body: JSON.stringify({ recipients: [recipient], message }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const responseText = await response.text();
        throw Object.assign(new Error(`TextBee returned HTTP ${response.status}: ${responseText.slice(0, 200)}`), { code: response.status >= 500 ? "TEXTBEE_UNAVAILABLE" : "TEXTBEE_REJECTED" });
      }
      const result = await response.json();
      return NotificationService.complete(job, String(result.data?.id || result.messageId || ""));
    } catch (error) {
      return NotificationService.fail(job, error, now);
    }
  }

  static async complete(job, providerMessageId) {
    await NotificationJob.updateOne({ _id: job._id, status: "PROCESSING" }, { $set: { status: "SENT", provider_message_id: providerMessageId, last_error: "", locked_at: null } });
    await NotificationLog.create({ job_id: job._id, to_user_id: job.to_user_id, channel: job.channel, outcome: "SENT", provider_message_id: providerMessageId });
    return { status: "SENT" };
  }

  static async skip(job, reason) {
    await NotificationJob.updateOne({ _id: job._id, status: "PROCESSING" }, { $set: { status: "CANCELLED", last_error: reason, locked_at: null } });
    await NotificationLog.create({ job_id: job._id, to_user_id: job.to_user_id, channel: job.channel, outcome: "SKIPPED", error_code: reason });
    return { status: "CANCELLED" };
  }

  static async fail(job, error, now = new Date()) {
    const retryable = error.retryable !== false;
    const terminal = job.attempts >= 5 || !retryable;
    const delayMs = Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, job.attempts - 1)));
    await NotificationJob.updateOne({ _id: job._id, status: "PROCESSING" }, {
      $set: {
        status: terminal ? "FAILED" : "PENDING",
        run_at: terminal ? job.run_at : new Date(now.getTime() + delayMs),
        last_error: String(error.code || error.message || "DELIVERY_FAILED").slice(0, 500),
        locked_at: null,
      },
    });
    await NotificationLog.create({
      job_id: job._id,
      to_user_id: job.to_user_id,
      channel: job.channel,
      outcome: "FAILED",
      error_code: String(error.code || "DELIVERY_FAILED").slice(0, 100),
    });
    if (terminal) {
      const admin = await User.findOne({ role: "ADMIN", status: "ACTIVE" }).select("_id");
      if (admin) await Alert.create({
        type: "NOTIFICATION_DELIVERY_FAILED",
        severity: "HIGH",
        target_user_id: admin._id,
        title: "Notification delivery failed",
        body: `Notification job ${job._id} exhausted retries (${error.code || "delivery error"}).`,
      });
      logger.error({ jobId: job._id.toString(), channel: job.channel, errorCode: error.code || "DELIVERY_FAILED" }, "Notification exhausted retries");
    } else {
      logger.warn({ jobId: job._id.toString(), attempt: job.attempts, errorCode: error.code || "DELIVERY_FAILED" }, "Notification will retry");
    }
    return { status: terminal ? "FAILED" : "PENDING" };
  }
}

export { adjustedSmsTime, e164 };
