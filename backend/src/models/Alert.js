import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const alertSchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", default: null, index: true },
  case_id: { type: objectId, ref: "CaseRecord", default: null, index: true },
  type: { type: String, required: true, trim: true, index: true },
  severity: { type: String, enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"], default: "INFO", index: true },
  target_user_id: { type: objectId, ref: "User", required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, maxlength: 5000 },
  due_at: { type: Date, default: null, index: true },
  status: { type: String, enum: ["OPEN", "ACKNOWLEDGED", "RESOLVED"], default: "OPEN" },
  reason_text: { type: String, default: "", maxlength: 3000 },
  cancellation_decision: { type: String, enum: ["APPROVED", "REJECTED"], default: null },
  cancellation_decided_by: { type: objectId, ref: "User", default: null },
  cancellation_decided_at: { type: Date, default: null },
  dedupe_key: { type: String, default: undefined },
}, baseOptions);

alertSchema.index({ target_user_id: 1, status: 1 }, { name: "alert_user_status" });
alertSchema.index({ application_id: 1, status: 1, severity: 1 }, { name: "alert_application_status_severity" });
alertSchema.index({ dedupe_key: 1 }, { unique: true, sparse: true, name: "alert_dedupe_unique" });
export const Alert = registerModel("Alert", alertSchema);
