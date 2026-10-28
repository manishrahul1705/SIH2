import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const leaseDetailSchema = new mongoose.Schema({
  document_id: { type: objectId, ref: "Document", required: true, unique: true },
  lease_start: { type: Date, default: null },
  lease_end: { type: Date, default: null },
  lease_term_years: { type: Number, min: 0, default: null },
  registered: { type: Boolean, default: false },
  validity_status: { type: String, enum: ["VALID", "EXPIRING", "EXPIRED", "UNKNOWN"], default: "UNKNOWN" },
  next_alert_at: { type: Date, default: null },
  confirmed_by: { type: objectId, ref: "User", default: null },
  confirmed_at: { type: Date, default: null },
}, baseOptions);

leaseDetailSchema.index({ lease_end: 1, validity_status: 1 }, { name: "lease_end_validity" });
export const LeaseDetail = registerModel("LeaseDetail", leaseDetailSchema);
