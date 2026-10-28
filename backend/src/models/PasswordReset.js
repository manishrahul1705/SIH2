import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const passwordResetSchema = new mongoose.Schema({
  user_id: { type: objectId, ref: "User", required: true, index: true },
  token_hash: { type: String, required: true, unique: true, select: false },
  expires_at: { type: Date, required: true },
  used_at: { type: Date, default: null },
}, baseOptions);

passwordResetSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: "password_reset_expiry_ttl" });
export const PasswordReset = registerModel("PasswordReset", passwordResetSchema);
