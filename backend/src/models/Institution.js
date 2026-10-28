import mongoose from "mongoose";
import { baseOptions, registerModel } from "./common.js";

const institutionSchema = new mongoose.Schema({
  aicte_id: { type: String, required: true, uppercase: true, trim: true, unique: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  state: { type: String, required: true, trim: true },
  region: { type: String, required: true, trim: true, index: true },
  contact_email: { type: String, required: true, lowercase: true, trim: true },
  contact_phone: { type: String, default: "", trim: true },
  status: { type: String, enum: ["ACTIVE", "PENDING_VERIFICATION", "DISABLED"], default: "ACTIVE", index: true },
  deleted_at: { type: Date, default: null, index: true },
}, baseOptions);

institutionSchema.index({ name: 1, state: 1 }, { name: "institution_name_state" });
export const Institution = registerModel("Institution", institutionSchema);
