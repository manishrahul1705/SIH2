import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const notificationLogSchema = new mongoose.Schema({
  job_id: { type: objectId, ref: "NotificationJob", required: true, index: true },
  to_user_id: { type: objectId, ref: "User", default: null, index: true },
  channel: { type: String, enum: ["EMAIL", "SMS", "IN_APP"], required: true },
  outcome: { type: String, enum: ["SENT", "FAILED", "SKIPPED"], required: true },
  provider_message_id: { type: String, default: "" },
  error_code: { type: String, default: "" },
  metadata: { type: mixed, default: {} },
}, baseOptions);

notificationLogSchema.index({ job_id: 1, createdAt: -1 }, { name: "notification_log_job_time" });
export const NotificationLog = registerModel("NotificationLog", notificationLogSchema);
