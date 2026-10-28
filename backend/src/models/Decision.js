import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const decisionSchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", required: true, index: true },
  decided_by: { type: objectId, ref: "User", required: true },
  outcome: { type: String, enum: ["APPROVED", "RETURNED", "CANCELLED", "REJECTED"], required: true },
  reason: { type: String, required: true, trim: true, maxlength: 5000 },
  decision_at: { type: Date, default: Date.now },
}, baseOptions);

decisionSchema.index({ application_id: 1, decision_at: -1 }, { name: "decision_application_time" });
export const Decision = registerModel("Decision", decisionSchema);
