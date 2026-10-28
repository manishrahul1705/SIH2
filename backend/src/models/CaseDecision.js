import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const caseDecisionSchema = new mongoose.Schema({
  caseId: { type: objectId, ref: "CaseRecord", required: true, unique: true },
  decidedBy: { type: objectId, ref: "User", required: true },
  outcome: { type: String, enum: ["approved", "rejected"], required: true },
  reason: { type: String, required: true, trim: true, maxlength: 3000 },
  conditions: [{
    title: { type: String, required: true, trim: true, maxlength: 200 },
    dueAt: { type: Date, default: null },
  }],
  decidedAt: { type: Date, required: true, default: Date.now },
}, baseOptions);

export const CaseDecision = registerModel("CaseDecision", caseDecisionSchema);
