import { randomUUID } from "node:crypto";
import express from "express";
import { Webhook } from "svix";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { NotificationJob, OutboxEvent, User } from "../../models/index.js";

export function resendWebhookRouter() {
  const router = express.Router();
  router.post("/", async (req, res) => {
    if (!env.RESEND_WEBHOOK_SECRET) return res.status(503).json({ data: null, error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook verification is not configured" }, meta: { requestId: req.id } });
    let event;
    try {
      const webhook = new Webhook(env.RESEND_WEBHOOK_SECRET);
      event = webhook.verify(req.rawBody, {
        "svix-id": req.get("svix-id"),
        "svix-timestamp": req.get("svix-timestamp"),
        "svix-signature": req.get("svix-signature"),
      });
    } catch (error) {
      logger.warn({ requestId: req.id, code: error.code || "INVALID_SIGNATURE" }, "Rejected Resend webhook");
      return res.status(400).json({ data: null, error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature verification failed" }, meta: { requestId: req.id } });
    }

    try {
      const providerId = event.data?.email_id || event.data?.id;
      if (providerId) {
        const delivery = event.type === "email.delivered" ? "DELIVERED" : event.type === "email.bounced" ? "BOUNCED" : null;
        if (delivery) {
          await withTransaction(async (session) => {
            let jobQuery = NotificationJob.findOne({ provider_message_id: providerId });
            if (session) jobQuery = jobQuery.session(session);
            const job = await jobQuery;
            if (!job || job.provider_status === delivery) return;
            const previousStatus = job.provider_status;
            job.provider_status = delivery;
            await job.save(session ? { session } : {});
            const payload = { providerStatus: delivery, previousStatus, notificationType: job.type };
            const options = session ? { session } : {};
            await OutboxEvent.create([{
              eventId: randomUUID(),
              eventType: "notification.provider_status_changed",
              entityId: String(job._id),
              payload,
              publishedAt: null,
            }], options);
            await writeAudit({
              actor_id: null,
              action: "NOTIFICATION_PROVIDER_STATUS_CHANGED",
              entity: "NotificationJob",
              entity_id: job._id,
              before_json: { providerStatus: previousStatus },
              after_json: payload,
            }, options);
            if (delivery === "BOUNCED") {
              const bounceResult = await User.updateOne({ _id: job.to_user_id, email_bounced: { $ne: true } }, { $set: { email_bounced: true } }, options);
              if (bounceResult.modifiedCount === 1) {
                const userPayload = { emailBounced: true, notificationJobId: String(job._id) };
                await OutboxEvent.create([{
                  eventId: randomUUID(),
                  eventType: "user.email_bounced",
                  entityId: String(job.to_user_id),
                  payload: userPayload,
                  publishedAt: null,
                }], options);
                await writeAudit({
                  actor_id: null,
                  action: "USER_EMAIL_BOUNCED",
                  entity: "User",
                  entity_id: job.to_user_id,
                  after_json: userPayload,
                }, options);
              }
            }
          });
        }
      }
      return res.json({ data: { received: true }, error: null, meta: { requestId: req.id } });
    } catch (error) {
      logger.error({ requestId: req.id, code: error.code || "WEBHOOK_PROCESSING_FAILED" }, "Failed to process verified Resend webhook");
      return res.status(500).json({ data: null, error: { code: "WEBHOOK_PROCESSING_FAILED", message: "The verified webhook could not be processed" }, meta: { requestId: req.id } });
    }
  });
  return router;
}
