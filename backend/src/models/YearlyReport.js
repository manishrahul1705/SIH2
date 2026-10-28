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
