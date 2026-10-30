import mongoose from "mongoose";
import { baseOptions, mixed, registerModel } from "./common.js";

const documentTextSchema = new mongoose.Schema({
  fileHash: { type: String, required: true, index: true },
  ocrVersion: { type: String, required: true, trim: true },
  fullText: { type: String, default: "" },
  pages: { type: [mixed], default: [] },
  ocrData: { type: mixed, required: true, select: false },
  usedOcr: { type: Boolean, default: false },
  meanOcrConfidence: { type: Number, min: 0, max: 1, default: null },
  warnings: { type: [String], default: [] },
}, baseOptions);

documentTextSchema.index({ fileHash: 1, ocrVersion: 1 }, { unique: true, name: "document_text_ocr_cache" });
export const DocumentText = registerModel("DocumentText", documentTextSchema);
