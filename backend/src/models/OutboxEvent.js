import mongoose from "mongoose";
import { baseOptions, mixed, registerModel } from "./common.js";

const outboxEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  eventType: { type: String, required: true, trim: true },
  entityId: { type: String, required: true, index: true },
  payload: { type: mixed, required: true },
  publishedAt: { type: Date, default: null, index: true },
}, baseOptions);

outboxEventSchema.index({ publishedAt: 1, createdAt: 1 }, { name: "outbox_pending" });
outboxEventSchema.index({ entityId: 1, createdAt: 1, eventId: 1 }, { name: "outbox_case_event_cursor" });
export const OutboxEvent = registerModel("OutboxEvent", outboxEventSchema);
