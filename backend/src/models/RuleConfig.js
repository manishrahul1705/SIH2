import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const ruleConfigSchema = new mongoose.Schema({
  rule_id: { type: String, required: true, trim: true, unique: true },
  enabled: { type: Boolean, default: true },
  params_json: { type: mixed, default: {} },
  basis: { type: String, enum: ["REAL", "SYNTHETIC"], default: "SYNTHETIC" },
  updated_by: { type: objectId, ref: "User", default: null },
}, baseOptions);

export const RuleConfig = registerModel("RuleConfig", ruleConfigSchema);
