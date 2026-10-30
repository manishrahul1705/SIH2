import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const pendingItemSchema = new mongoose.Schema({
  application_id: { type: objectId, ref: "Application", required: true, index: true },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  raised_by: { type: objectId, ref: "User", required: true },
  due_date: { type: Date, required: true, index: true },
  resolved_at: { type: Date, default: null },
  response: { type: String, trim: true, default: "", maxlength: 3000 },
  reminder_count: { type: Number, default: 0, min: 0 },
}, baseOptions);

pendingItemSchema.index({ application_id: 1, resolved_at: 1, due_date: 1 }, { name: "pending_item_open_due" });
export const PendingItem = registerModel("PendingItem", pendingItemSchema);
