import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const visitSchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", required: true, index: true },
  evc_user_id: { type: objectId, ref: "User", required: true, index: true },
  scheduled_at: { type: Date, required: true, index: true },
  active_case_key: { type: String, default: undefined },
  status: { type: String, enum: ["SCHEDULED", "DONE", "RESCHEDULED", "CANCELLED"], default: "SCHEDULED", index: true },
  report_file_id: { type: objectId, ref: "Document", default: null },
  notes: { type: String, default: "", maxlength: 5000 },
}, baseOptions);

visitSchema.index({ evc_user_id: 1, scheduled_at: 1, status: 1 }, { name: "visit_evc_schedule_status" });
visitSchema.index({ active_case_key: 1 }, { unique: true, sparse: true, name: "visit_one_active_assignment_per_case" });
export const Visit = registerModel("Visit", visitSchema);
