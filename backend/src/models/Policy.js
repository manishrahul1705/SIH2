import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const policySchema = new mongoose.Schema({
  version: { type: String, required: true, trim: true, maxlength: 40, unique: true },
  status: { type: String, enum: ["draft", "signed_off", "retired"], required: true, default: "draft", index: true },
  routes: { type: mixed, required: true },
  checklist: { type: [mixed], required: true },
  stageCompletion: { type: mixed, default: {} },
  alertRules: { type: mixed, default: {} },
  scoreWeights: { type: mixed, default: {} },
  blockSubmitOnMissing: { type: Boolean, default: false },
  signedOffBy: { type: objectId, ref: "User", default: null },
  signedOffAt: { type: Date, default: null },
  notes: { type: String, default: "", maxlength: 4000 },
}, baseOptions);

policySchema.index({ status: 1, signedOffAt: -1 }, { name: "policy_active_version" });
export const Policy = registerModel("Policy", policySchema);
