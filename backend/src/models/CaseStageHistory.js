import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const caseStageHistorySchema = new mongoose.Schema({
  caseId: { type: objectId, ref: "CaseRecord", required: true },
  fromStage: { type: String, default: null },
  toStage: { type: String, required: true },
  holderType: { type: String, enum: ["institution", "officer", "committee"], required: true },
  holderId: { type: objectId, ref: "User", default: null },
  actorId: { type: objectId, ref: "User", default: null },
  enteredAt: { type: Date, required: true, default: Date.now },
  leftAt: { type: Date, default: null },
  reason: { type: String, default: "", maxlength: 3000 },
}, baseOptions);

caseStageHistorySchema.index({ caseId: 1, enteredAt: 1 }, { name: "case_stage_history_time" });
export const CaseStageHistory = registerModel("CaseStageHistory", caseStageHistorySchema);
