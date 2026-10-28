import mongoose from "mongoose";
import { baseOptions, registerModel } from "./common.js";

const auditHeadSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  sequence: { type: Number, required: true, default: 0, min: 0 },
  lastHash: { type: String, required: true, default: "GENESIS" },
}, { ...baseOptions, optimisticConcurrency: true, versionKey: "__v" });

export const AuditHead = registerModel("AuditHead", auditHeadSchema);
