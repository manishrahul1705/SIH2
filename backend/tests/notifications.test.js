import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: {
    withTransaction: vi.fn((callback) => callback(undefined)),
    writeAudit: vi.fn(async () => {}),
  },
  models: {
    Alert: {
      create: vi.fn(async ([record]) => [{ _id: "alert-1", ...record }]),
      findOne: vi.fn(),
      updateOne: vi.fn(async () => ({ upsertedCount: 0 })),
    },
    NotificationJob: { findOne: vi.fn(), updateOne: vi.fn(async () => ({ modifiedCount: 1, upsertedCount: 0 })) },
    NotificationLog: { create: vi.fn(async () => []) },
    OutboxEvent: { create: vi.fn(async () => []) },
    User: {
      findOne: vi.fn(() => ({ select: async () => ({ _id: "admin-1" }) })),
      findById: vi.fn(async () => ({ _id: "recipient-1", status: "ACTIVE" })),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    },
  },
  sendEmail: vi.fn(async () => ({ data: { id: "provider-message-1" } })),
}));

vi.mock("../src/middleware/audit.js", () => mocks.audit);
vi.mock("../src/models/index.js", () => mocks.models);
vi.mock("../src/config/env.js", () => ({ env: {
  RESEND_API_KEY: "test-resend-key",
  RESEND_WEBHOOK_SECRET: "test-webhook-secret",
  MAIL_FROM: "no-reply@approvaltrack.example",
  NOTIFY_MODE: "resend",
} }));
vi.mock("../src/config/logger.js", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("resend", () => ({
  Resend: class {
    constructor() {
      this.emails = { send: mocks.sendEmail };
    }
  },
}));
vi.mock("svix", () => ({
  Webhook: class {
    verify() {
      return { type: "email.bounced", data: { email_id: "provider-message-1" } };
    }
  },
}));

import { NotificationService } from "../src/modules/notifications/service.js";
import { resendWebhookRouter } from "../src/modules/notifications/webhook.js";
import express from "express";
import request from "supertest";

describe("notification outcome audit and outbox", () => {
  const job = {
    _id: "job-1",
    to_user_id: "recipient-1",
    channel: "EMAIL",
    type: "TEST_NOTICE",
    attempts: 5,
    run_at: new Date("2026-10-29T00:00:00.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.models.NotificationJob.updateOne.mockResolvedValue({ modifiedCount: 1, upsertedCount: 0 });
    mocks.models.NotificationLog.create.mockResolvedValue([]);
    mocks.models.OutboxEvent.create.mockResolvedValue([]);
    mocks.models.Alert.create.mockImplementation(async ([record]) => [{ _id: "alert-1", ...record }]);
    mocks.models.Alert.updateOne.mockResolvedValue({ upsertedCount: 0 });
    mocks.sendEmail.mockResolvedValue({ data: { id: "provider-message-1" } });
    mocks.models.User.findOne.mockReturnValue({ select: async () => ({ _id: "admin-1" }) });
    mocks.models.User.findById.mockResolvedValue({ _id: "recipient-1", status: "ACTIVE" });
  });

  it("writes the queue record, audit entry, and outbox event only for a new deduplicated job", async () => {
    const queuedJob = { _id: "queued-job-1", toObject: () => ({ _id: "queued-job-1", status: "PENDING" }) };
    mocks.models.NotificationJob.updateOne.mockResolvedValue({ upsertedCount: 1 });
    mocks.models.NotificationJob.findOne.mockReturnValue(Promise.resolve(queuedJob));

    const result = await NotificationService.enqueue({
      type: "YEARLY_REPORT_DUE",
      channel: "EMAIL",
      userId: "recipient-1",
      payload: { subject: "Reminder" },
      dedupeKey: "yearly-report:recipient-1:2026",
    });

    expect(result).toMatchObject({ _id: "queued-job-1", status: "PENDING" });
    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledWith([expect.objectContaining({
      eventType: "notification.queued",
      entityId: "queued-job-1",
    })], {});
    expect(mocks.audit.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "NOTIFICATION_QUEUED",
      entity_id: "queued-job-1",
    }), {});
  });

  it("uses a validated contact email override for queued institution mail", async () => {
    const queuedJob = { _id: "queued-job-2", toObject: () => ({ _id: "queued-job-2", status: "PENDING" }) };
    mocks.models.NotificationJob.updateOne.mockResolvedValue({ upsertedCount: 1 });
    mocks.models.NotificationJob.findOne.mockReturnValue(Promise.resolve(queuedJob));

    await NotificationService.enqueue({
      type: "APPLICATION_FINAL_APPROVED",
      channel: "EMAIL",
      userId: "recipient-1",
      recipientEmail: "contact@college.example",
      payload: { subject: "Application approved" },
      dedupeKey: "final-approved:case-1:email",
    });

    expect(mocks.models.NotificationJob.updateOne).toHaveBeenCalledWith(
      { dedupe_key: "final-approved:case-1:email" },
      { $setOnInsert: expect.objectContaining({
        payload_json: { subject: "Application approved", recipient_email: "contact@college.example" },
      }) },
      expect.objectContaining({ upsert: true, runValidators: true }),
    );
    await expect(NotificationService.enqueue({
      type: "APPLICATION_FINAL_APPROVED",
      channel: "EMAIL",
      userId: "recipient-1",
      recipientEmail: "invalid-address",
      payload: {},
      dedupeKey: "final-approved:case-2:email",
    })).rejects.toThrow("recipientEmail must be a valid email address");
  });

  it("delivers an institution notice to its contact email instead of the account email", async () => {
    const emailJob = {
      ...job,
      payload_json: {
        subject: "Application approved",
        body: "The application is approved.",
        recipient_email: "contact@college.example",
      },
    };
    mocks.models.User.findById.mockResolvedValue({ _id: "recipient-1", status: "ACTIVE", email: "account@college.example" });

    await NotificationService.deliver(emailJob);

    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "contact@college.example",
      subject: "Application approved",
    }));
  });

  it("records delivery status, log, outbox event, and hash-chain audit together", async () => {
    await NotificationService.complete(job, "provider-message-1");

    expect(mocks.audit.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.models.NotificationJob.updateOne).toHaveBeenCalledWith(
      { _id: job._id, status: "PROCESSING" },
      { $set: { status: "SENT", provider_message_id: "provider-message-1", last_error: "", locked_at: null } },
      {},
    );
    expect(mocks.models.NotificationLog.create).toHaveBeenCalledWith([expect.objectContaining({ outcome: "SENT", job_id: job._id })], {});
    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledWith([expect.objectContaining({
      eventType: "notification.sent",
      entityId: job._id,
    })], {});
    expect(mocks.audit.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "NOTIFICATION_SENT",
      entity_id: job._id,
    }), {});
  });

  it("audits the deduplicated in-app alert created by a notification", async () => {
    const alert = { _id: "in-app-alert-1", type: "YEARLY_REPORT_DUE", severity: "MEDIUM", target_user_id: "recipient-1" };
    mocks.models.Alert.updateOne.mockResolvedValue({ upsertedCount: 1 });
    mocks.models.Alert.findOne.mockReturnValue(Promise.resolve(alert));
    const inAppJob = { ...job, channel: "IN_APP", dedupe_key: "yearly-report:recipient-1:2026", payload_json: { title: "Report due" } };

    await NotificationService.deliver(inAppJob);

    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledWith([expect.objectContaining({
      eventType: "alert.created",
      entityId: alert._id,
    })], {});
    expect(mocks.audit.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ALERT_CREATED",
      entity_id: alert._id,
    }), {});
    expect(mocks.models.NotificationJob.updateOne).toHaveBeenCalledWith(
      { _id: inAppJob._id, status: "PROCESSING" },
      expect.objectContaining({ $set: expect.objectContaining({ status: "SENT" }) }),
      {},
    );
  });

  it("records terminal delivery failure and emits an audited administrator alert", async () => {
    await NotificationService.fail(job, Object.assign(new Error("provider unavailable"), { code: "PROVIDER_DOWN" }));

    expect(mocks.models.NotificationJob.updateOne).toHaveBeenCalledWith(
      { _id: job._id, status: "PROCESSING" },
      expect.objectContaining({ $set: expect.objectContaining({ status: "FAILED", locked_at: null }) }),
      {},
    );
    expect(mocks.models.NotificationLog.create).toHaveBeenCalledWith([expect.objectContaining({
      outcome: "FAILED",
      error_code: "PROVIDER_DOWN",
    })], {});
    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledTimes(2);
    expect(mocks.models.OutboxEvent.create).toHaveBeenNthCalledWith(2, [expect.objectContaining({
      eventType: "alert.created",
      entityId: "alert-1",
    })], {});
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(2);
    expect(mocks.audit.writeAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "ALERT_CREATED",
      entity_id: "alert-1",
    }), {});
  });

  it("audits provider bounce callbacks and the recipient bounce flag", async () => {
    const job = {
      _id: "job-bounce-1",
      to_user_id: "recipient-bounce-1",
      type: "TEST_NOTICE",
      provider_status: "",
      save: vi.fn(async () => {}),
    };

    mocks.models.NotificationJob.findOne.mockReturnValue(job);
    mocks.models.User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const app = express();
    app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
    app.use("/webhooks/resend", resendWebhookRouter());

    const response = await request(app)
      .post("/webhooks/resend")
      .set("svix-id", "message-id")
      .set("svix-timestamp", "timestamp")
      .set("svix-signature", "signature")
      .send({ type: "email.bounced" });

    expect(response.status).toBe(200);
    expect(job.provider_status).toBe("BOUNCED");
    expect(job.save).toHaveBeenCalledOnce();
    expect(mocks.models.User.updateOne).toHaveBeenCalledWith(
      { _id: job.to_user_id, email_bounced: { $ne: true } },
      { $set: { email_bounced: true } },
      {},
    );
    expect(mocks.models.OutboxEvent.create).toHaveBeenCalledTimes(2);
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(2);
    expect(mocks.audit.writeAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "NOTIFICATION_PROVIDER_STATUS_CHANGED",
      entity_id: job._id,
    }), {});
    expect(mocks.audit.writeAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "USER_EMAIL_BOUNCED",
      entity_id: job.to_user_id,
    }), {});
  });
});
