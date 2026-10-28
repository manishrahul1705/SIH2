import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const emailVerificationSchema = new mongoose.Schema({
  user_id: { type: objectId, ref: "User", required: true, index: true },
  token_hash: { type: String, required: true, unique: true, select: false },
  expires_at: { type: Date, required: true },
  used_at: { type: Date, default: null },
}, baseOptions);

emailVerificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: "email_verification_expiry_ttl" });
export const EmailVerification = registerModel("EmailVerification", emailVerificationSchema);
