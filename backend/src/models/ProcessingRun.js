import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const processingRunSchema = new mongoose.Schema({
  documentId: { type: objectId, ref: "Document", required: true, index: true },
  fileHash: { type: String, required: true, index: true },
  documentTextId: { type: objectId, ref: "DocumentText", default: null },
  status: { type: String, enum: ["processing", "completed", "failed", "quarantined"], required: true, index: true },
  startedAt: { type: Date, required: true, default: Date.now },
  completedAt: { type: Date, default: null },
  modelVersions: { type: mixed, default: {} },
  modelResults: { type: mixed, default: {} },
  errorCode: { type: String, default: "", maxlength: 100 },
}, baseOptions);

processingRunSchema.index({ documentId: 1, createdAt: -1 }, { name: "processing_run_document_created" });
export const ProcessingRun = registerModel("ProcessingRun", processingRunSchema);
