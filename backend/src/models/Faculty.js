import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const facultySchema = new mongoose.Schema({
  institution_id: { type: objectId, ref: "Institution", required: true },
  employee_id: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, default: "", trim: true },
  designation: { type: String, required: true, trim: true },
  qualification: { type: String, required: true, trim: true },
  department: { type: String, required: true, trim: true, index: true },
  date_of_joining: { type: Date, required: true },
  status: { type: String, enum: ["ACTIVE", "ON_LEAVE", "RESIGNED"], default: "ACTIVE", index: true },
  deleted_at: { type: Date, default: null },
}, baseOptions);

facultySchema.index({ institution_id: 1, employee_id: 1 }, { unique: true, name: "faculty_institution_employee_unique" });
facultySchema.index({ institution_id: 1, department: 1, status: 1 }, { name: "faculty_institution_department_status" });
facultySchema.index({ institution_id: 1, name: 1 }, { name: "faculty_institution_name" });
export const Faculty = registerModel("Faculty", facultySchema);
