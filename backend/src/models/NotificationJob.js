import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const notificationJobSchema = new mongoose.Schema({
  type: { type: String, required: true, trim: true, index: true },
  channel: { type: String, enum: ["EMAIL", "SMS", "IN_APP"], required: true },
  to_user_id: { type: objectId, ref: "User", default: null, index: true },
  payload_json: { type: mixed, default: {} },
  dedupe_key: { type: String, required: true, trim: true },
  run_at: { type: Date, required: true, default: Date.now },
  status: { type: String, enum: ["PENDING", "PROCESSING", "SENT", "FAILED", "CANCELLED"], default: "PENDING" },
  attempts: { type: Number, default: 0, min: 0 },
  last_error: { type: String, default: "" },
  provider_message_id: { type: String, default: "" },
  provider_status: { type: String, enum: ["DELIVERED", "BOUNCED", ""], default: "" },
  locked_at: { type: Date, default: null },
}, baseOptions);

notificationJobSchema.index({ status: 1, run_at: 1 }, { name: "notification_job_status_run_at" });
notificationJobSchema.index({ dedupe_key: 1 }, { unique: true, name: "notification_job_dedupe_unique" });
export const NotificationJob = registerModel("NotificationJob", notificationJobSchema);
