import mongoose from "mongoose";
import { APPLICATION_TYPES } from "../engine/checklist.js";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const slotRecordSchema = new mongoose.Schema({
  slotId: { type: String, required: true, trim: true },
  status: { type: String, enum: ["missing", "uploaded", "pending_confirmation", "confirmed", "verified", "rejected", "expired"], default: "missing" },
  documentId: { type: objectId, ref: "Document", default: null },
  historyIds: [{ type: objectId, ref: "Document" }],
}, { _id: false, strict: "throw" });

const caseRecordSchema = new mongoose.Schema({
  caseNo: { type: String, required: true, unique: true, trim: true },
  institutionId: { type: objectId, ref: "Institution", required: true, index: true },
  region: { type: String, trim: true, default: "" },
  applicationType: { type: String, enum: APPLICATION_TYPES, required: true, index: true },
  applicability: { type: mixed, default: {} },
  routeFlags: { type: mixed, default: {} },
  policyVersion: { type: String, required: true, trim: true },
  route: [{ type: String, required: true }],
  currentStage: { type: String, required: true, default: "submitted", index: true },
  holderType: { type: String, enum: ["institution", "officer", "committee"], required: true, default: "institution", index: true },
  holderId: { type: objectId, ref: "User", default: null, index: true },
  status: { type: String, enum: ["draft", "submitted", "in_progress", "returned", "approved", "rejected"], default: "draft", index: true },
  slotRecords: { type: [slotRecordSchema], default: [] },
  completedStages: { type: [String], default: [] },
  returnReason: { type: String, default: "", maxlength: 3000 },
  returnedToStage: { type: String, default: "" },
  version: { type: Number, default: 0, min: 0 },
  stageEnteredAt: { type: Date, required: true, default: Date.now },
  submittedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null, index: true },
}, { ...baseOptions, optimisticConcurrency: true });

caseRecordSchema.index({ institutionId:  1, status: 1 }, { name: "case_institution_status" });
caseRecordSchema.index({ region: 1, currentStage: 1, holderId: 1 }, { name: "case_region_stage_holder" });
export const CaseRecord = registerModel("CaseRecord", caseRecordSchema);
