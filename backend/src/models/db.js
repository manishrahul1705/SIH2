import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { Document } from "./index.js";

async function ensureDocumentOwnerIndexes() {
  const collection = mongoose.connection.collection(Document.collection.name);
  let indexes = [];
  try {
    indexes = await collection.listIndexes().toArray();
  } catch (error) {
    if (error.code !== 26) throw error;
  }
  const legacyIndex = indexes.find((index) => index.name === "document_application_slot_version_unique");
  if (legacyIndex) await collection.dropIndex(legacyIndex.name);
  await collection.createIndex(
    { application_id: 1, doc_type_slot: 1, version: 1 },
    {
      unique: true,
      name: "document_application_slot_version_unique_v2",
      partialFilterExpression: { application_id: { $type: "objectId" } },
    },
  );
  await collection.createIndex(
    { case_id: 1, doc_type_slot: 1, version: 1 },
    {
      unique: true,
      name: "document_case_slot_version_unique",
      partialFilterExpression: { case_id: { $type: "objectId" } },
    },
  );
}

export async function connectDatabase(uri = env.MONGODB_URI) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    autoIndex: env.NODE_ENV !== "production",
  });
  await ensureDocumentOwnerIndexes();
  logger.info({ database: mongoose.connection.name }, "MongoDB connected");
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export { mongoose };
