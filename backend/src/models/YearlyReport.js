import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const yearlyReportSchema = new mongoose.Schema({
  institution_id: { type: objectId, ref: "Institution", default: null, index: true },
  faculty_id: { type: objectId, ref: "Faculty", default: null, index: true },
  academic_year: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  due_date: { type: Date, required: true, index: true },
  status: { type: String, enum: ["DRAFT", "SUBMITTED", "RETURNED", "APPROVED", "OVERDUE"], default: "DRAFT", index: true },
  submitted_at: { type: Date, default: null },
  report_data: { type: mongoose.Schema.Types.Mixed, default: {} },
  evidence: {
    type: [{
      file_name: { type: String, required: true, maxlength: 180 },
      mime_type: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true },
      size: { type: Number, required: true, min: 1, max: 15 * 1024 * 1024 },
      sha256: { type: String, required: true, match: /^[a-f\d]{64}$/ },
      storage_path: { type: String, required: true, select: false },
      uploaded_at: { type: Date, default: Date.now },
    }],
    default: [],
  },
}, baseOptions);

yearlyReportSchema.index(
  { institution_id: 1, academic_year: 1 },
  { unique: true, partialFilterExpression: { institution_id: { $type: "objectId" } }, name: "yearly_report_institution_year" },
);
yearlyReportSchema.index(
  { faculty_id: 1, academic_year: 1 },
  { unique: true, partialFilterExpression: { faculty_id: { $type: "objectId" } }, name: "yearly_report_faculty_year" },
);
export const YearlyReport = registerModel("YearlyReport", yearlyReportSchema);
