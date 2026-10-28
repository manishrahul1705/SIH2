import mongoose from "mongoose";
import { ROLES } from "../config/constants.js";
import { baseOptions, objectId, registerModel } from "./common.js";

const userSchema = new mongoose.Schema({
  role: { type: String, enum: ROLES, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true, select: false },
  phone: { type: String, trim: true, default: "" },
  status: { type: String, enum: ["ACTIVE", "PENDING_VERIFICATION", "LOCKED", "DISABLED"], default: "ACTIVE", index: true },
  institution_id: { type: objectId, ref: "Institution", default: null, index: true },
  region: { type: String, trim: true, default: "" },
  notify_email: { type: Boolean, default: true },
  notify_sms: { type: Boolean, default: true },
  email_bounced: { type: Boolean, default: false },
  email_verified_at: { type: Date, default: null },
  failed_login_attempts: { type: Number, default: 0, min: 0 },
  locked_until: { type: Date, default: null },
  deleted_at: { type: Date, default: null, index: true },
}, { ...baseOptions, optimisticConcurrency: true });

userSchema.index({ email: 1 }, { unique: true, name: "user_email_unique" });
export const User = registerModel("User", userSchema);
