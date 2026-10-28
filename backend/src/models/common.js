import mongoose from "mongoose";

export const objectId = mongoose.Schema.Types.ObjectId;
export const mixed = mongoose.Schema.Types.Mixed;

export const baseOptions = Object.freeze({
  timestamps: true,
  strict: "throw",
  minimize: false,
});

export function registerModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}
