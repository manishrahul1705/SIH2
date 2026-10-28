import mongoose from "mongoose";
import { baseOptions, mixed, objectId, registerModel } from "./common.js";

const auditLogSchema = new mongoose.Schema({
  actor_id: { type: objectId, ref: "User", default: null, index: true },
  action: { type: String, required: true, trim: true, maxlength: 160 },
  entity: { type: String, required: true, trim: true, maxlength: 100 },
  entity_id: { type: String, required: true, trim: true },
  before_json: { type: mixed, default: null },
  after_json: { type: mixed, default: null },
  outcome: { type: String, enum: ["allowed", "denied"], default: "allowed", index: true },
  ip: { type: String, default: "" },
  seq: { type: Number, min: 1, default: undefined },
  prevHash: { type: String, default: undefined },
  hash: { type: String, default: undefined },
}, { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ entity: 1, entity_id: 1, createdAt: -1 }, { name: "audit_entity_time" });
auditLogSchema.index({ seq: 1 }, { unique: true, sparse: true, name: "audit_sequence_unique" });
auditLogSchema.pre("save", function rejectMutation() {
  if (!this.isNew) throw new Error("AuditLog is append-only");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne"]) {
  auditLogSchema.pre(operation, function rejectMutation() { throw new Error("AuditLog is append-only"); });
}
export const AuditLog = registerModel("AuditLog", auditLogSchema);
