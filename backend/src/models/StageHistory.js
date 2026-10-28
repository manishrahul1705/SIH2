import mongoose from "mongoose";
import { APPLICATION_STAGES } from "../config/constants.js";
import { baseOptions, objectId, registerModel } from "./common.js";

const stageHistorySchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", required: true },
  from_stage: { type: String, enum: APPLICATION_STAGES, default: null },
  to_stage: { type: String, enum: APPLICATION_STAGES, required: true },
  actor_id: { type: objectId, ref: "User", default: null },
  reason: { type: String, default: "", maxlength: 2000 },
}, baseOptions);

stageHistorySchema.index({ application_id: 1, createdAt: 1 }, { name: "stage_history_application_time" });
stageHistorySchema.pre("findOneAndUpdate", function rejectMutation() { throw new Error("StageHistory is append-only"); });
stageHistorySchema.pre("updateOne", function rejectMutation() { throw new Error("StageHistory is append-only"); });
stageHistorySchema.pre("deleteOne", function rejectMutation() { throw new Error("StageHistory is append-only"); });
stageHistorySchema.pre("deleteMany", function rejectMutation() { throw new Error("StageHistory is append-only"); });
export const StageHistory = registerModel("StageHistory", stageHistorySchema);
