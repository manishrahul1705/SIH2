import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const sessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, select: false },
  user_id: { type: objectId, ref: "User", required: true, index: true },
  created_at: { type: Date, required: true, default: Date.now },
  expires_at: { type: Date, required: true },
  ip: { type: String, default: "" },
  user_agent: { type: String, default: "" },
  revoked_at: { type: Date, default: null },
}, { ...baseOptions, timestamps: false });

sessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: "session_expiry_ttl" });
sessionSchema.index({ user_id: 1, revoked_at: 1 }, { name: "session_user_revocation" });
export const Session = registerModel("Session", sessionSchema);
