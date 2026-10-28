import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const studentSchema = new mongoose.Schema({
  institution_id: { type: objectId, ref: "Institution", required: true },
  enrollment_no: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, default: "", trim: true },
  programme: { type: String, required: true, trim: true },
  branch: { type: String, required: true, trim: true },
  year: { type: Number, required: true, min: 1, max: 10 },
  status: { type: String, enum: ["ACTIVE", "PASSED_OUT", "DROPPED"], default: "ACTIVE", index: true },
  deleted_at: { type: Date, default: null },
}, baseOptions);

studentSchema.index({ institution_id: 1, enrollment_no: 1 }, { unique: true, name: "student_institution_enrollment_unique" });
studentSchema.index({ institution_id: 1, programme: 1, status: 1 }, { name: "student_institution_program_status" });
studentSchema.index({ institution_id: 1, name: 1 }, { name: "student_institution_name" });
export const Student = registerModel("Student", studentSchema);
