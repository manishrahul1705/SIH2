import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const documentSchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", default: null, index: true },
  case_id: { type: objectId, ref: "CaseRecord", default: null, index: true },
  uploaded_by: { type: objectId, ref: "User", required: true },
  file_path: { type: String, required: true, select: false },
  original_name: { type: String, required: true, maxlength: 255 },
  file_hash: { type: String, required: true, index: true },
  mime: { type: String, required: true, enum: ["application/pdf", "image/jpeg", "image/png"] },
  pages: { type: Number, min: 1, default: 1 },
  doc_type_slot: { type: String, default: "" },
  doc_type_final: { type: String, default: "" },
  status: {
    type: String,
    enum: ["UPLOADED", "PROCESSING", "AI_DONE", "AWAITING_CONFIRMATION", "CONFIRMED", "REJECTED", "AI_FAILED", "SUPERSEDED"],
    default: "UPLOADED",
    index: true,
  },
  version: { type: Number, default: 1, min: 1 },
  supersedes_document_id: { type: objectId, ref: "Document", default: null },
  superseded_by_document_id: { type: objectId, ref: "Document", default: null },
  deleted_at: { type: Date, default: null },
}, { ...baseOptions, optimisticConcurrency: true });

documentSchema.index({ application_id: 1, createdAt: -1 }, { name: "document_application_created" });
documentSchema.index({ application_id: 1, doc_type_slot: 1, version: 1 }, {
  unique: true,
  name: "document_application_slot_version_unique_v2",
  partialFilterExpression: { application_id: { $type: "objectId" } },
});
documentSchema.index({ case_id: 1, doc_type_slot: 1, version: 1 }, {
  unique: true,
  name: "document_case_slot_version_unique",
  partialFilterExpression: { case_id: { $type: "objectId" } },
});
documentSchema.pre("validate", function validateDocumentOwner(next) {
  if (Boolean(this.application_id) === Boolean(this.case_id)) {
    this.invalidate("application_id", "A document must belong to exactly one application or case");
  }
  next();
});
export const Document = registerModel("Document", documentSchema);
