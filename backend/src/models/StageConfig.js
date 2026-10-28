import mongoose from "mongoose";
import { APPLICATION_STAGES, APPLICATION_TYPES, ROLES } from "../config/constants.js";
import { baseOptions, registerModel } from "./common.js";

const stageConfigSchema = new mongoose.Schema({
  application_type: { type: String, enum: APPLICATION_TYPES, required: true },
  stage: { type: String, enum: APPLICATION_STAGES, required: true },
  sequence: { type: Number, required: true, min: 0 },
  role_responsible: { type: String, enum: ROLES, required: true },
  max_days: { type: Number, required: true, min: 1 },
  requires_reason_on_delay: { type: Boolean, default: true },
  enabled: { type: Boolean, default: true },
  basis: { type: String, enum: ["REAL", "SYNTHETIC"], default: "SYNTHETIC" },
}, baseOptions);

stageConfigSchema.index({ application_type: 1, sequence: 1 }, { unique: true, name: "stage_config_type_sequence_unique" });
stageConfigSchema.index({ application_type: 1, stage: 1 }, { unique: true, name: "stage_config_type_stage_unique" });
export const StageConfig = registerModel("StageConfig", stageConfigSchema);
