import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const caseObligationSchema = new mongoose.Schema({
  caseId: { type: objectId, ref: "CaseRecord", required: true, index: true },
  institutionId: { type: objectId, ref: "Institution", required: true, index: true },
  sourceDocumentId: { type: objectId, ref: "Document", default: null, index: true },
  type: { type: String, enum: ["undertaking", "validity", "evc", "deficiency"], required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  dueAt: { type: Date, default: null, index: true },
  dueKind: { type: String, enum: ["timestamp", "date"], default: "date" },
  deadlineRevision: { type: Number, default: 1, min: 1 },
  ownerType: { type: String, enum: ["institution", "officer", "committee"], required: true },
  ownerId: { type: objectId, ref: "User", default: null },
  submission: { type: String, enum: ["none", "submitted"], default: "none" },
  evidenceNote: { type: String, default: "", maxlength: 3000 },
  submittedAt: { type: Date, default: null },
  verification: { type: String, enum: ["pending", "verified", "not_verified"], default: "pending" },
  verifiedBy: { type: objectId, ref: "User", default: null },
  verifiedAt: { type: Date, default: null },
  verificationReason: { type: String, default: "", maxlength: 3000 },
  closure: { type: String, enum: ["open", "closed"], default: "open" },
}, { ...baseOptions, optimisticConcurrency: true });

caseObligationSchema.index({ dueAt: 1, closure: 1 }, { name: "obligation_due_open" });
caseObligationSchema.index({ ownerId: 1, closure: 1 }, { name: "obligation_owner_open" });
caseObligationSchema.index({ sourceDocumentId: 1, type: 1 }, {
  unique: true,
  name: "validity_obligation_document_unique",
  partialFilterExpression: { sourceDocumentId: { $type: "objectId" }, type: "validity" },
});
export const CaseObligation = registerModel("CaseObligation", caseObligationSchema);
