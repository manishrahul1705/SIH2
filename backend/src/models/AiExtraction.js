import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const extractedFieldSchema = new mongoose.Schema({
  field_name: { type: String, required: true, trim: true },
  ai_value: { type: String, default: "" },
  ai_confidence: { type: Number, min: 0, max: 1, default: 0 },
  zone: { type: String, enum: ["GREEN", "AMBER", "RED"], default: "RED" },
  source_text: { type: String, default: "" },
  source_page: { type: Number, min: 0, default: 0 },
  source_bbox: { type: [Number], default: undefined },
  confirmed_value: { type: String, default: null },
  confirmed_by: { type: objectId, ref: "User", default: null },
  confirmed_at: { type: Date, default: null },
  was_corrected: { type: Boolean, default: false },
}, { _id: true, strict: "throw" });

const aiExtractionSchema = new mongoose.Schema({
  document_id: { type: objectId, ref: "Document", required: true, index: true },
  ocr_text_path: { type: String, default: "", select: false },
  m1_type: { type: String, default: "" },
  m1_confidence: { type: Number, min: 0, max: 1, default: 0 },
  m2_json: { type: mixed, default: null },
  m3_json: { type: mixed, default: null },
  overall_zone: { type: String, enum: ["GREEN", "AMBER", "RED"], default: "RED" },
  rule_results_json: { type: [mixed], default: [] },
  model_versions: { type: mixed, default: {} },
  fields: { type: [extractedFieldSchema], default: [] },
  processing_error_code: { type: String, default: "" },
}, { ...baseOptions, optimisticConcurrency: true });

aiExtractionSchema.index({ document_id: 1, createdAt: -1 }, { name: "extraction_document_created" });
export const AiExtraction = registerModel("AiExtraction", aiExtractionSchema);
