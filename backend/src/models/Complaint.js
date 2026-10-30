import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import { baseOptions, objectId, registerModel } from "./common.js";

const evidenceSchema = new mongoose.Schema({
  file_name: { type: String, required: true, maxlength: 180 },
  mime_type: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true },
  size: { type: Number, required: true, min: 1, max: 10 * 1024 * 1024 },
  sha256: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  storage_path: { type: String, required: true, select: false },
  uploaded_by: { type: objectId, ref: "User", required: true },
  uploaded_at: { type: Date, default: Date.now },
});

const eventSchema = new mongoose.Schema({
  status: { type: String, required: true },
  note: { type: String, default: "", maxlength: 2000 },
  actor_id: { type: objectId, ref: "User", default: null },
  created_at: { type: Date, default: Date.now },
}, { _id: false });

const adminActionSchema = new mongoose.Schema({
  acknowledged_by: { type: objectId, ref: "User", default: null },
  acknowledged_at: { type: Date, default: null },
  evidence_reviewed_by: { type: objectId, ref: "User", default: null },
  evidence_reviewed_at: { type: Date, default: null },
  admin_remarks: { type: String, default: "", maxlength: 3000 },
  response_deadline: { type: Date, default: null },
}, { _id: false });

const collegeResponseSchema = new mongoose.Schema({
  action_taken_report: { type: String, default: "", maxlength: 5000 },
  proof_document: { type: evidenceSchema, default: null },
  responded_at: { type: Date, default: null },
  responded_by: { type: objectId, ref: "User", default: null },
}, { _id: false });

const complaintSchema = new mongoose.Schema({
  complaint_id: { type: String, trim: true, unique: true, sparse: true, default: () => `GRV-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}` },
  anonymous_alias: { type: String, trim: true, maxlength: 80, default: "" },
  institution_name: { type: String, trim: true, maxlength: 200, default: "" },
  complainant_id: { type: objectId, ref: "User", required: true, index: true },
  complainant_role: { type: String, enum: ["STUDENT", "FACULTY"], required: true },
  institution_id: { type: objectId, ref: "Institution", required: true, index: true },
  committee_type: { type: String, enum: ["STUDENT_SGRC", "FACULTY_STAFF_GRC"], required: true },
  assigned_to: { type: objectId, ref: "User", default: null, index: true },
  region: { type: String, trim: true, default: "" },
  category: { type: String, enum: ["FEES", "DOCUMENTS", "ACADEMIC", "FACILITIES", "SALARY_SERVICE", "SAFETY", "OTHER", "WITHHOLDING_DOCUMENTS", "EXCESS_FEE", "RAGGING_HARASSMENT", "FACULTY_SALARY_SERVICE", "INFRASTRUCTURE_LAB_DEFICIT"], required: true },
  subject: { type: String, required: true, trim: true, minlength: 5, maxlength: 160 },
  description: { type: String, required: true, trim: true, minlength: 20, maxlength: 5000 },
  status: { type: String, enum: ["SUBMITTED", "ACKNOWLEDGED", "IN_REVIEW", "RESOLVED", "REJECTED", "PENDING_ADMIN_VALIDATION", "ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"], default: "PENDING_ADMIN_VALIDATION", index: true },
  resolution_note: { type: String, default: "", maxlength: 2000 },
  admin_action: { type: adminActionSchema, default: () => ({}) },
  college_response: { type: collegeResponseSchema, default: () => ({}) },
  response_due_at: { type: Date, required: true, index: true },
  resolved_at: { type: Date, default: null },
  appeal_status: { type: String, enum: ["NONE", "SUBMITTED", "IN_REVIEW", "RESOLVED", "REJECTED"], default: "NONE", index: true },
  appeal_route: { type: String, enum: ["OMBUDSPERSON", "UNIVERSITY_DTE"], default: null },
  appeal_assigned_to: { type: objectId, ref: "User", default: null, index: true },
  appeal_submitted_at: { type: Date, default: null },
  appeal_due_at: { type: Date, default: null },
  appeal_reason: { type: String, default: "", maxlength: 3000 },
  appeal_resolution_note: { type: String, default: "", maxlength: 2000 },
  evidence: { type: [evidenceSchema], default: [] },
  history: { type: [eventSchema], default: [] },
}, baseOptions);

complaintSchema.index({ complainant_id: 1, createdAt: -1 });
complaintSchema.index({ institution_id: 1, status: 1, createdAt: -1 });
export const Complaint = registerModel("Complaint", complaintSchema);
