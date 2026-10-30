import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const caseFindingSchema = new mongoose.Schema({
  caseId: { type: objectId, ref: "CaseRecord", required: true, index: true },
  documentId: { type: objectId, ref: "Document", default: null, index: true },
  slotId: { type: String, default: "" },
  code: { type: String, required: true, trim: true, maxlength: 80 },
  ruleId: { type: String, required: true, trim: true, maxlength: 40 },
  severity: { type: String, enum: ["info", "warning", "high"], required: true },
  scope: { type: String, enum: ["case", "document"], required: true },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  evidence: { type: mixed, default: {} },
  suggestedAction: { type: String, default: "", maxlength: 500 },
  advisory: { type: Boolean, default: false },
  status: { type: String, enum: ["open", "resolved", "dismissed"], default: "open", index: true },
  createdBy: { type: String, default: "pipeline" },
  resolvedAt: { type: Date, default: null },
}, { ...baseOptions, optimisticConcurrency: true });

caseFindingSchema.index({ caseId: 1, code: 1, documentId: 1, slotId: 1 }, {
  unique: true,
  name: "one_open_case_finding",
  partialFilterExpression: { status: "open" },
});
export const CaseFinding = registerModel("CaseFinding", caseFindingSchema);
