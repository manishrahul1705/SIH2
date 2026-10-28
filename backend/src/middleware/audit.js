import { createHash } from "node:crypto";
import { mongoose } from "../models/db.js";
import { AuditHead, AuditLog } from "../models/index.js";
import { logger } from "../config/logger.js";

let transactionSupportPromise;
let standaloneWarningLogged = false;

export function supportsMongoTransactions(hello) {
  return Boolean(hello?.setName || hello?.msg === "isdbgrid" || hello?.serviceId);
}

function canonicalValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && value._bsontype === "ObjectId") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function hashPayload(entry) {
  return {
    seq: entry.seq,
    createdAt: entry.createdAt,
    actor_id: entry.actor_id || null,
    action: entry.action,
    entity: entry.entity,
    entity_id: String(entry.entity_id),
    before_json: entry.before_json ?? null,
    after_json: entry.after_json ?? null,
    outcome: entry.outcome || "allowed",
    ip: entry.ip || "",
  };
}

export function auditEntryHash(entry) {
  return createHash("sha256")
    .update(`${entry.prevHash}${JSON.stringify(canonicalValue(hashPayload(entry)))}`)
    .digest("hex");
}

export function verifyAuditEntries(entries) {
  let previousHash = "GENESIS";
  let expectedSequence = 1;
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.seq !== expectedSequence || entry.prevHash !== previousHash || entry.hash !== auditEntryHash(entry)) {
      return { valid: false, checked: expectedSequence - 1, invalidSequence: entry.seq };
    }
    previousHash = entry.hash;
    expectedSequence += 1;
  }
  return { valid: true, checked: expectedSequence - 1, lastHash: previousHash };
}

async function writeAuditInContext(entry, session) {
  const options = session ? { session } : {};
  let headQuery = AuditHead.findById("global");
  if (session) headQuery = headQuery.session(session);
  let head = await headQuery;
  if (!head) {
    try {
      [head] = await AuditHead.create([{ _id: "global", sequence: 0, lastHash: "GENESIS" }], options);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      headQuery = AuditHead.findById("global");
      if (session) headQuery = headQuery.session(session);
      head = await headQuery;
    }
  }
  if (!head) throw new Error("Unable to initialize the audit chain head");

  const createdAt = new Date();
  const auditData = {
    seq: head.sequence + 1,
    prevHash: head.lastHash,
    createdAt,
    actor_id: entry.actor_id || null,
    action: entry.action,
    entity: entry.entity,
    entity_id: String(entry.entity_id),
    before_json: entry.before_json ?? null,
    after_json: entry.after_json ?? null,
    outcome: entry.outcome || "allowed",
    ip: entry.ip || "",
  };
  auditData.hash = auditEntryHash(auditData);
  head.sequence = auditData.seq;
  head.lastHash = auditData.hash;
  await head.save(options);
  const [record] = await AuditLog.create([auditData], options);
  return record;
}

export async function writeAudit(entry, options = {}) {
  if (options.session) return writeAuditInContext(entry, options.session);
  return withTransaction((session) => writeAuditInContext(entry, session));
}

export async function withTransaction(callback) {
  transactionSupportPromise ??= mongoose.connection.db.admin().command({ hello: 1 })
    .then((hello) => supportsMongoTransactions(hello))
    .catch((error) => {
      transactionSupportPromise = undefined;
      throw error;
    });

  if (!await transactionSupportPromise) {
    if (!standaloneWarningLogged) {
      logger.warn("Standalone MongoDB detected; multi-document workflows will use non-atomic writes");
      standaloneWarningLogged = true;
    }
    return callback(undefined);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await callback(session); });
    return result;
  } finally {
    await session.endSession();
  }
}
