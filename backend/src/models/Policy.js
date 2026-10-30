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
  pipelineSettings: {
    maxFileMB: { type: Number, min: 1, max: 100, default: 20 },
    maxPages: { type: Number, min: 1, max: 1000, default: 40 },
    aiTimeoutMs: { type: Number, min: 100, max: 120000, default: 8000 },
    greenThreshold: { type: Number, min: 0, max: 1, default: 0.9 },
    amberThreshold: { type: Number, min: 0, max: 1, default: 0.6 },
    heuristicConfidenceCap: { type: Number, min: 0, max: 1, default: 0.85 },
    expiringSoonDays: { type: Number, min: 0, max: 3650, default: 30 },
    leaseExpiringSoonDays: { type: Number, min: 0, max: 3650, default: 90 },
    minOcrConfidence: { type: Number, min: 0, max: 1, default: 0.55 },
    endToleranceDays: { type: Number, min: 0, max: 365, default: 1 },
    blockSubmitOnMissing: { type: Boolean, default: false },
    blockAdvanceOnOpenHighFindings: { type: Boolean, default: false },
    prioritiseNewInstitutions: { type: Boolean, default: false },
    minLeaseTermYears: { type: Number, min: 0, max: 100, default: null },
    holderAssignment: { type: String, enum: ["least_open_cases", "unassigned"], default: "least_open_cases" },
  },
  signedOffBy: { type: objectId, ref: "User", default: null },
  signedOffAt: { type: Date, default: null },
  notes: { type: String, default: "", maxlength: 4000 },
}, baseOptions);

policySchema.index({ status: 1, signedOffAt: -1 }, { name: "policy_active_version" });
export const Policy = registerModel("Policy", policySchema);
