import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const undertakingSchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  due_date: { type: Date, required: true, index: true },
  status: { type: String, enum: ["PENDING", "SUBMITTED", "OVERDUE"], default: "PENDING", index: true },
  submitted_at: { type: Date, default: null },
  file_id: { type: objectId, ref: "Document", default: null },
}, baseOptions);

undertakingSchema.index({ application_id: 1, status: 1, due_date: 1 }, { name: "undertaking_application_status_due" });
export const Undertaking = registerModel("Undertaking", undertakingSchema);
