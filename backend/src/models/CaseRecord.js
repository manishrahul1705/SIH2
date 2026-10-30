import mongoose from "mongoose";
import { APPLICATION_TYPES } from "../engine/checklist.js";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const slotRecordSchema = new mongoose.Schema({
  slotId: { type: String, required: true, trim: true },
  status: { type: String, enum: ["missing", "uploaded", "pending_confirmation", "confirmed", "verified", "rejected", "expired", "quarantined"], default: "missing" },
  documentId: { type: objectId, ref: "Document", default: null },
  historyIds: [{ type: objectId, ref: "Document" }],
}, { _id: false, strict: "throw" });

const assistRequestSchema = new mongoose.Schema({
  requestedByUserId: { type: objectId, ref: "User", required: true },
  assignedToUserId: { type: objectId, ref: "User", required: true },
  assignedToName: { type: String, default: "", trim: true, maxlength: 200 },
  targetRole: { type: String, required: true, trim: true },
  note: { type: String, required: true, trim: true, maxlength: 3000 },
  status: { type: String, enum: ["PENDING_ASSIST_DECISION", "ASSIST_APPROVED", "ASSIST_REJECTED"], default: "PENDING_ASSIST_DECISION", index: true },
  assistDueAt: { type: Date, required: true },
  decidedByUserId: { type: objectId, ref: "User", default: null },
  decidedByName: { type: String, default: "", trim: true, maxlength: 200 },
  decidedAt: { type: Date, default: null },
  remarks: { type: String, default: "", maxlength: 3000 },
}, { ...baseOptions, strict: "throw" });

const stageHistorySchema = new mongoose.Schema({
  action: { type: String, required: true, trim: true, maxlength: 100 },
  performed_by: { type: objectId, ref: "User", default: null },
  timestamp: { type: Date, default: Date.now },
  notes: { type: String, default: "", maxlength: 3000 },
}, { _id: false, strict: "throw" });

const allocatedStageSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  routeKey: { type: String, required: true, trim: true },
  assignedRole: { type: String, required: true, trim: true },
  requiredDocuments: [{ type: String, trim: true }],
  assignedUserId: { type: objectId, ref: "User", default: null },
  assignedPanelUserIds: [{ type: objectId, ref: "User" }],
  status: { type: String, enum: ["PENDING", "ACTIVE", "FROZEN_WAITING_FOR_ASSIST", "ACTIVE_UNFROZEN", "INSPECTION_SCHEDULED", "WAITING_FOR_APPROVAL", "APPROVED", "REJECTED"], default: "PENDING", index: true },
  slaDays: { type: Number, required: true, min: 1 },
  stageStartedAt: { type: Date, default: null },
  stageDueAt: { type: Date, default: null, index: true },
  elapsedMs: { type: Number, default: 0, min: 0 },
  activeClockHolder: { type: objectId, ref: "User", default: null },
  pausedRemainingMs: { type: Number, default: null, min: 0 },
  frozenAt: { type: Date, default: null },
  assistRequests: { type: [assistRequestSchema], default: [] },
  remarks: { type: String, default: "", maxlength: 3000 },
  approvedAt: { type: Date, default: null },
  scheduled_inspection_date: { type: Date, default: null },
  inspection_mode: { type: String, enum: ["PHYSICAL", "VIRTUAL", "HYBRID", null], default: null },
  inspection_instructions: { type: String, default: "", maxlength: 3000 },
  inspectionReportDocumentId: { type: objectId, ref: "Document", default: null },
  rejection_reason: { type: String, default: "", maxlength: 3000 },
  rejection_category: { type: String, default: "", maxlength: 100 },
  rejected_by: { type: objectId, ref: "User", default: null },
  rejected_at: { type: Date, default: null },
  history: { type: [stageHistorySchema], default: [] },
}, { ...baseOptions, strict: "throw" });

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
  currentStageIndex: { type: Number, default: -1, min: -1 },
  allocatedStages: { type: [allocatedStageSchema], default: [] },
  workflowVersion: { type: String, default: "" },
  overallStatus: { type: String, enum: ["DRAFT", "SUBMITTED", "IN_PROGRESS", "RETURNED", "FINAL_APPROVED", "EVC_REJECTED", "REJECTED"], default: "DRAFT", index: true },
  approvedAt: { type: Date, default: null },
  holderType: { type: String, enum: ["institution", "officer", "committee"], required: true, default: "institution", index: true },
  holderId: { type: objectId, ref: "User", default: null, index: true },
  status: { type: String, enum: ["draft", "submitted", "in_progress", "returned", "approved", "rejected"], default: "draft", index: true },
  slotRecords: { type: [slotRecordSchema], default: [] },
  completedStages: { type: [String], default: [] },
  returnReason: { type: String, default: "", maxlength: 3000 },
  returnedToStage: { type: String, default: "" },
  version: { type: Number, default: 0, min: 0 },
  preliminary: { type: String, enum: ["incomplete", "complete_with_findings", "complete_clean"], default: "incomplete" },
  lastPlanHash: { type: String, default: "" },
  lastPlanIntent: { type: String, default: "" },
  lastEvaluatedAt: { type: Date, default: null },
  stageEnteredAt: { type: Date, required: true, default: Date.now },
  submittedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null, index: true },
}, { ...baseOptions, optimisticConcurrency: true });

caseRecordSchema.index({ institutionId:  1, status: 1 }, { name: "case_institution_status" });
caseRecordSchema.index({ region: 1, currentStage: 1, holderId: 1 }, { name: "case_region_stage_holder" });
export const CaseRecord = registerModel("CaseRecord", caseRecordSchema);
