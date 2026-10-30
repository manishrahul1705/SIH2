import mongoose from "mongoose";
import { ROLES } from "../config/constants.js";
import { baseOptions, objectId, registerModel } from "./common.js";

const incidentEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, trim: true, maxlength: 100 },
  action: { type: String, required: true, enum: ["DETECTED", "UPDATED", "MANUAL_REPORT", "REVIEW", "NOTE", "REQUEST_CLARIFICATION", "ESCALATE", "CORRECTIVE_ACTION", "RESOLVE", "CLOSE", "REOPEN"] },
  actorUserId: { type: objectId, ref: "User", default: null },
  timestamp: { type: Date, required: true, default: Date.now },
  note: { type: String, default: "", maxlength: 3000 },
  reason: { type: String, default: "", maxlength: 3000 },
  resolutionSummary: { type: String, default: "", maxlength: 3000 },
  rootCause: { type: String, default: "", maxlength: 3000 },
  resolutionEvidence: { type: String, default: "", maxlength: 4000 },
  verificationResult: { type: String, default: "", maxlength: 3000 },
  remainingLimitations: { type: String, default: "", maxlength: 3000 },
  result: { type: String, default: "", maxlength: 3000 },
  recipientUserId: { type: objectId, ref: "User", default: null },
  recipientRole: { type: String, enum: [...ROLES, null], default: null },
}, { _id: false, strict: "throw" });

const applicationIncidentSchema = new mongoose.Schema({
  workflowType: { type: String, enum: ["LEGACY_APPLICATION", "CASE_RECORD"], required: true, index: true },
  applicationId: { type: objectId, ref: "Application", default: null, index: true },
  caseRecordId: { type: objectId, ref: "CaseRecord", default: null, index: true },
  dedupeKey: { type: String, trim: true, maxlength: 300, default: undefined },
  source: { type: String, enum: ["AUTOMATED", "MANUAL"], default: "AUTOMATED", index: true },
  detectionSource: { type: String, enum: ["AUTOMATED", "ADMIN_REPORTED"], default: "AUTOMATED" },
  sourceDetails: { type: String, trim: true, default: "", maxlength: 1000 },
  evidence: { type: String, trim: true, default: "", maxlength: 4000 },
  type: { type: String, required: true, trim: true, uppercase: true, maxlength: 80, index: true },
  severity: { type: String, enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"], required: true, default: "MEDIUM", index: true },
  status: { type: String, enum: ["OPEN", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "ESCALATED", "CORRECTIVE_ACTION_PENDING", "RESOLUTION_PENDING_VERIFICATION", "RESOLVED", "CLOSED"], required: true, default: "OPEN", index: true },
  stageKey: { type: String, trim: true, default: "", maxlength: 100 },
  stageName: { type: String, trim: true, default: "", maxlength: 200 },
  responsibleOfficerId: { type: objectId, ref: "User", default: null, index: true },
  responsibleOfficerName: { type: String, trim: true, default: "", maxlength: 120 },
  responsibleOfficerRole: { type: String, enum: [...ROLES, null], default: null },
  summary: { type: String, required: true, trim: true, maxlength: 1000 },
  details: { type: String, default: "", maxlength: 5000 },
  detectedAt: { type: Date, required: true, default: Date.now, index: true },
  dueAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  events: { type: [incidentEventSchema], default: [] },
}, { ...baseOptions, optimisticConcurrency: true });

applicationIncidentSchema.pre("validate", function validateWorkflowReference() {
  const legacyReferenceIsValid = this.workflowType === "LEGACY_APPLICATION" && this.applicationId && !this.caseRecordId;
  const caseReferenceIsValid = this.workflowType === "CASE_RECORD" && this.caseRecordId && !this.applicationId;
  if (!legacyReferenceIsValid && !caseReferenceIsValid) {
    this.invalidate("workflowType", "An incident must reference exactly one source matching its workflowType");
  }
});

applicationIncidentSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true, name: "application_incident_dedupe_unique" });
applicationIncidentSchema.index({ workflowType: 1, applicationId: 1, status: 1, detectedAt: -1 }, { name: "legacy_incident_application_status" });
applicationIncidentSchema.index({ workflowType: 1, caseRecordId: 1, status: 1, detectedAt: -1 }, { name: "case_incident_application_status" });

export const ApplicationIncident = registerModel("ApplicationIncident", applicationIncidentSchema);
