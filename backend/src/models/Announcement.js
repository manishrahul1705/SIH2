import mongoose from "mongoose";
import { baseOptions, objectId, registerModel } from "./common.js";

const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, minlength: 5, maxlength: 180 },
  body: { type: String, required: true, trim: true, minlength: 10, maxlength: 10000 },
  source_url: { type: String, trim: true, default: "", maxlength: 2048 },
  category: { type: String, enum: ["CIRCULAR", "NOTICE", "UPDATE"], default: "NOTICE" },
  audience: { type: String, enum: ["ALL", "STUDENT", "FACULTY"], default: "ALL" },
  published: { type: Boolean, default: false, index: true },
  publish_at: { type: Date, default: Date.now, index: true },
  expires_at: { type: Date, default: null, index: true },
  created_by: { type: objectId, ref: "User", required: true },
}, baseOptions);

announcementSchema.index({ published: 1, publish_at: -1, expires_at: 1 });
export const Announcement = registerModel("Announcement", announcementSchema);
