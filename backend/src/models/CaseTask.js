import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const caseTaskSchema = new mongoose.Schema({
  caseId: { type: objectId, ref: "CaseRecord", required: true, index: true },
  documentId: { type: objectId, ref: "Document", default: null, index: true },
  slotId: { type: String, default: "" },
  type: { type: String, enum: ["EVC", "DEFICIENCY_RESPONSE", "VERIFY_DOCUMENT", "REVIEW"], required: true },
  holderType: { type: String, enum: ["institution", "officer", "committee", "unassigned"], required: true },
  holderId: { type: objectId, ref: "User", default: null },
  state: { type: String, enum: ["queued", "open", "completed", "cancelled"], default: "open", index: true },
  dueAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  createdByRule: { type: String, required: true, trim: true, maxlength: 40 },
  payload: { type: mixed, default: {} },
}, { ...baseOptions, optimisticConcurrency: true });

caseTaskSchema.index({ caseId: 1, type: 1 }, {
  unique: true,
  name: "one_evc_task_per_case",
  partialFilterExpression: { type: "EVC" },
});
caseTaskSchema.index({ documentId: 1, type: 1 }, {
  unique: true,
  name: "one_verify_task_per_document",
  partialFilterExpression: { type: "VERIFY_DOCUMENT" },
});
caseTaskSchema.index({ caseId: 1, slotId: 1, type: 1 }, {
  unique: true,
  name: "one_review_task_per_slot",
  partialFilterExpression: { type: "REVIEW" },
});

export const CaseTask = registerModel("CaseTask", caseTaskSchema);
