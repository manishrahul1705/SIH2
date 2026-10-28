import express from "express";
import { Webhook } from "svix";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { NotificationJob, User } from "../../models/index.js";

export function resendWebhookRouter() {
  const router = express.Router();
  router.post("/", async (req, res) => {
    if (!env.RESEND_WEBHOOK_SECRET) return res.status(503).json({ data: null, error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook verification is not configured" }, meta: { requestId: req.id } });
    try {
      const webhook = new Webhook(env.RESEND_WEBHOOK_SECRET);
      const event = webhook.verify(req.rawBody, {
        "svix-id": req.get("svix-id"),
        "svix-timestamp": req.get("svix-timestamp"),
        "svix-signature": req.get("svix-signature"),
      });
      const providerId = event.data?.email_id || event.data?.id;
      if (providerId) {
        const delivery = event.type === "email.delivered" ? "DELIVERED" : event.type === "email.bounced" ? "BOUNCED" : null;
        if (delivery) {
          const job = await NotificationJob.findOneAndUpdate(
            { provider_message_id: providerId },
            { $set: { provider_status: delivery } },
            { new: true },
          );
          if (job && delivery === "BOUNCED") await User.updateOne({ _id: job.to_user_id }, { $set: { email_bounced: true } });
        }
      }
      return res.json({ data: { received: true }, error: null, meta: { requestId: req.id } });
    } catch (error) {
      logger.warn({ requestId: req.id, code: error.code || "INVALID_SIGNATURE" }, "Rejected Resend webhook");
      return res.status(400).json({ data: null, error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature verification failed" }, meta: { requestId: req.id } });
    }
  });
  return router;
}
