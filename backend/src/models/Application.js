import mongoose from "mongoose";
import { APPLICATION_STAGES, APPLICATION_TYPES } from "../config/constants.js";
import { baseOptions, objectId, registerModel } from "./common.js";

const applicationSchema = new mongoose.Schema({
  institution_id: { type: objectId, ref: "Institution", required: true, index: true },
  type: { type: String, enum: APPLICATION_TYPES, required: true },
  academic_year: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  current_stage: { type: String, enum: APPLICATION_STAGES, required: true, default: "SUBMITTED" },
  status: { type: String, enum: ["DRAFT", "SUBMITTED", "IN_PROGRESS", "RETURNED", "APPROVED", "CANCELLED", "REJECTED"], default: "DRAFT", index: true },
  stage_entered_at: { type: Date, required: true, default: Date.now },
  assigned_officer_id: { type: objectId, ref: "User", default: null },
  is_compliant: { type: Boolean, default: true },
  submitted_at: { type: Date, default: null },
  application_number: { type: String, trim: true },
  deleted_at: { type: Date, default: null, index: true },
  version: { type: Number, default: 0, min: 0 },
}, { ...baseOptions, optimisticConcurrency: true });

applicationSchema.index({ institution_id: 1, current_stage: 1, status: 1 }, { name: "application_institution_stage_status" });
applicationSchema.index({ assigned_officer_id: 1, current_stage: 1, status: 1 }, { name: "application_officer_stage_status" });
applicationSchema.index({ application_number: 1 }, { unique: true, sparse: true, name: "application_number_unique" });
export const Application = registerModel("Application", applicationSchema);
