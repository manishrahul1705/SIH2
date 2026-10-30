import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const evidenceSchema = new mongoose.Schema({
  file_name: { type: String, required: true, maxlength: 180 },
  mime_type: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true },
  size: { type: Number, required: true, min: 1, max: 15 * 1024 * 1024 },
  sha256: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  storage_path: { type: String, required: true, select: false },
  uploaded_at: { type: Date, default: Date.now },
});

const institutionAnnualReportSchema = new mongoose.Schema({
  institution_id: { type: objectId, ref: "Institution", required: true, index: true },
  calendar_year: { type: Number, required: true, min: 2000, max: 9999 },
  due_date: { type: Date, required: true },
  complaints_received: { type: Number, required: true, min: 0 },
  ic_training_or_orientation: { type: Number, required: true, min: 0 },
  complaints_disposed: { type: Number, required: true, min: 0 },
  pending_over_90_days: { type: Number, required: true, min: 0 },
  awareness_programs: { type: Number, required: true, min: 0 },
  action_taken: { type: String, required: true, trim: true, minlength: 2, maxlength: 5000 },
  status: { type: String, enum: ["DRAFT", "SUBMITTED"], default: "DRAFT", index: true },
  submitted_at: { type: Date, default: null },
  evidence: { type: [evidenceSchema], default: [] },
}, baseOptions);

institutionAnnualReportSchema.index({ institution_id: 1, calendar_year: 1 }, { unique: true, name: "institution_ic_annual_report_year" });
export const InstitutionAnnualReport = registerModel("InstitutionAnnualReport", institutionAnnualReportSchema);
