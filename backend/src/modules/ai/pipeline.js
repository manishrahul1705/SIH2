import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AiExtraction, Application, CaseRecord, Document, LeaseDetail, OutboxEvent, User } from "../../models/index.js";
import { runPythonJson } from "./pythonBridge.js";
import { evaluate, getRuleConfig } from "../rules/engine.js";
import { localStorage } from "../documents/storage.js";
import { NotificationService } from "../notifications/service.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";

const m1Schema = z.object({
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
}).passthrough();
const ocrSchema = z.object({
  supported: z.boolean(),
  quarantined: z.boolean().optional(),
  pages: z.array(z.object({ text: z.string().optional() }).passthrough()),
  full_text: z.string().default(""),
  mean_ocr_conf: z.number().min(0).max(1).nullable().optional(),
}).passthrough();
const m2Schema = z.object({
  fields: z.record(z.string(), z.unknown()),
  pages: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
  mean_ocr_conf: z.number().min(0).max(1).optional(),
}).passthrough();
const m3Schema = z.object({
  fields: z.record(z.string(), z.unknown()),
}).passthrough();

function scriptPath(configured) {
  return path.resolve(process.cwd(), configured);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function safeText(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizedField(name, raw) {
  const confidence = number(raw?.confidence ?? raw?.ai_confidence);
  const zone = String(raw?.zone || "red").toUpperCase();
  const bbox = Array.isArray(raw?.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : undefined;
  return {
    field_name: name,
    ai_value: safeText(raw?.value),
    ai_confidence: confidence,
    zone: ["GREEN", "AMBER", "RED"].includes(zone) ? zone : "RED",
    source_text: safeText(raw?.display || raw?.source_text),
    source_page: Number.isInteger(Number(raw?.page)) ? Math.max(0, Number(raw.page)) : 0,
    ...(bbox?.every(Number.isFinite) ? { source_bbox: bbox } : {}),
    confirmed_value: null,
    was_corrected: false,
  };
}

function expectedFields(document, extractedFields) {
  const fields = new Map(extractedFields.map((field) => [field.field_name, field]));
  const expectedNames = ["issue_date", "valid_from", "valid_to", "cert_no", "issuer"];
  if (typeKey(document.doc_type_slot) === "lease") {
    expectedNames.push("lease_start", "lease_end", "lease_term");
  }
  for (const name of expectedNames) {
    if (!fields.has(name)) fields.set(name, normalizedField(name, {}));
  }
  return [
    ...expectedNames.map((name) => fields.get(name)),
    ...extractedFields.filter((field) => !expectedNames.includes(field.field_name)),
  ];
}

function extractedLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .slice(0, 500).map((line) => line.slice(0, 1000));
}

function summarizeM1(m1) {
  const value = safeText(m1?.value || "other");
  return { type: value, confidence: number(m1?.confidence), display: safeText(m1?.display_name || value) };
}

function modelVersion(result) {
  if (typeof result?.model_version === "string" && result.model_version) return result.model_version;
  for (const field of Object.values(result?.fields || {})) {
    if (typeof field?.model_version === "string" && field.model_version) return field.model_version;
  }
  return "";
}

function typeKey(value) {
  const key = safeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = {
    lease: "lease",
    leasedeed: "lease",
    fire: "fire",
    firesafetycertificate: "fire",
    structural: "structural",
    structuralstabilitycertificate: "structural",
    occupancyorbuilding: "occupancy",
    occupancycertificate: "occupancy",
    buildingcertificate: "occupancy",
    nbaletter: "nba",
    nbaaccreditationletter: "nba",
    auditedaccounts: "auditedaccounts",
    aicteapprovalletter: "aicte",
    other: "other",
    otherdocument: "other",
  };
  return aliases[key] || key;
}

async function markCaseDocumentPendingConfirmation(document, session, eventType) {
  if (!document.case_id) return;
  let caseQuery = CaseRecord.findOne({
    _id: document.case_id,
    slotRecords: { $elemMatch: { slotId: document.doc_type_slot, documentId: document._id } },
  });
  if (session) caseQuery = caseQuery.session(session);
  const caseRecord = await caseQuery;
  if (!caseRecord) return;
  const slot = caseRecord.slotRecords.find((item) => item.slotId === document.doc_type_slot);
  slot.status = "pending_confirmation";
  caseRecord.version += 1;
  await caseRecord.save(session ? { session } : {});
  await OutboxEvent.create([{
    eventId: crypto.randomUUID(),
    eventType,
    entityId: caseRecord._id.toString(),
    payload: {
      caseNo: caseRecord.caseNo,
      currentStage: caseRecord.currentStage,
      documentId: document._id.toString(),
      slotId: document.doc_type_slot,
      status: slot.status,
    },
  }], session ? { session } : {});
}

export async function processDocument(documentId) {
  const document = await Document.findOneAndUpdate(
    { _id: documentId, status: { $in: ["UPLOADED", "AI_FAILED"] } },
    { $set: { status: "PROCESSING" } },
    { new: true },
  ).select("+file_path");
  if (!document) return;
  let ocrText = "";
  try {
    const absoluteFile = localStorage.resolve(document.file_path);
    const ocr = ocrSchema.parse(await runPythonJson(scriptPath(env.OCR_SCRIPT_PATH), [absoluteFile]));
    if (!ocr.supported || ocr.quarantined) {
      throw Object.assign(new Error("OCR could not safely read this file"), { code: "OCR_UNAVAILABLE" });
    }
    ocrText = ocr.full_text || ocr.pages.map((page) => page.text || "").join("\n");
    const m1Raw = m1Schema.parse(await runPythonJson(scriptPath(env.M1_SCRIPT_PATH), ["--file", absoluteFile]));
    const m1 = summarizeM1(m1Raw);
    const m2 = m2Schema.parse(await runPythonJson(scriptPath(env.M2_SCRIPT_PATH), [absoluteFile, "--doc-type", m1.type]));
    const extractedFields = Object.entries(m2.fields || {}).map(([name, value]) => normalizedField(name, value));
    let m3 = null;
    if (m1.type === "lease" || typeKey(document.doc_type_slot) === "lease") {
      m3 = m3Schema.parse(await runPythonJson(scriptPath(env.M3_SCRIPT_PATH), [absoluteFile, "--doc-type", "lease"]));
      for (const name of ["lease_start", "lease_end", "lease_term"]) {
        if (m3.fields?.[name]) extractedFields.push(normalizedField(name, m3.fields[name]));
      }
    }
    const fields = expectedFields(document, extractedFields);
    const [application, caseRecord] = await Promise.all([
      document.application_id ? Application.findById(document.application_id).lean() : null,
      document.case_id ? CaseRecord.findOne({ _id: document.case_id, deletedAt: null }).lean() : null,
    ]);
    if (document.application_id && !application || document.case_id && !caseRecord) {
      throw Object.assign(new Error("Document parent is unavailable"), { code: "DOCUMENT_PARENT_UNAVAILABLE" });
    }
    const applicationDocuments = await Document.find(
      document.application_id ? { application_id: document.application_id } : { case_id: document.case_id },
    ).select("doc_type_slot status").lean();
    const slotMismatch = document.doc_type_slot && typeKey(m1.type) !== typeKey(document.doc_type_slot);
    const results = application ? evaluate(
      { doc_type_slot: document.doc_type_slot, doc_type_final: m1.display },
      fields,
      application || {},
      await getRuleConfig(),
      {
        meanOcrConfidence: [m2.mean_ocr_conf, m1Raw.ocr?.mean_ocr_conf, ocr.mean_ocr_conf]
          .find((value) => typeof value === "number" && Number.isFinite(value)),
        applicationDocuments: applicationDocuments.map((item) => ({
          doc_type_slot_key: item.doc_type_slot.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
          status: item.status,
        })),
      },
    ) : [];
    if (slotMismatch) results.push({ ruleId: "DOC_TYPE_MISMATCH", severity: "WARNING", passed: false, message: "Detected type differs from the selected slot.", basis: "SYNTHETIC" });
    const zones = fields.map((item) => item.zone);
    const overallZone = zones.includes("RED") ? "RED" : zones.includes("AMBER") ? "AMBER" : "GREEN";
    const lines = extractedLines(ocrText);
    const textPath = ocrText ? (await localStorage.save(Buffer.from(ocrText, "utf8"), `${document._id}-ocr.txt`)).filePath : "";
    await withTransaction(async (session) => {
      const [created] = await AiExtraction.create([{
        document_id: document._id,
        ocr_text_path: textPath,
        extracted_lines: lines,
        m1_type: m1.display,
        m1_confidence: m1.confidence,
        m2_json: m2,
        m3_json: m3,
        overall_zone: overallZone,
        rule_results_json: results,
        model_versions: { m1: m1Raw.model_version || "", m2: modelVersion(m2), m3: m3 ? modelVersion(m3) : "" },
        fields,
      }], { session });
      document.doc_type_final = m1.display;
      document.pages = Math.max(1, ocr.pages.length);
      document.status = "AWAITING_CONFIRMATION";
      await document.save({ session });
      await markCaseDocumentPendingConfirmation(document, session, "case.document_ai_ready");
      await writeAudit({ actor_id: null, action: "DOCUMENT_AI_EXTRACTION_COMPLETED", entity: "Document", entity_id: document._id, after_json: { extraction_id: created._id, overall_zone: overallZone, field_count: fields.length } }, { session });
      return created;
    });
    try {
      const institutionId = application?.institution_id || caseRecord?.institutionId;
      const institutionUser = institutionId && await User.findOne({
        institution_id: institutionId,
        role: "INSTITUTION",
        status: "ACTIVE",
      }).select("_id");
      if (institutionUser) {
        await NotificationService.enqueue({
          type: "AI_CONFIRMATION_REQUIRED",
          channel: "IN_APP",
          userId: institutionUser._id,
          payload: {
            title: "Document suggestions are ready",
            body: "Review and confirm the AI-suggested fields before they affect the application.",
            ...(application ? { application_id: application._id } : { case_id: caseRecord._id }),
          },
          dedupeKey: `document-confirm:${document._id}:${document.version}`,
        });
      }
    } catch (error) {
      logger.error({ documentId: document._id.toString(), code: error.code || "NOTIFICATION_ENQUEUE_FAILED" }, "Document completed but confirmation notification could not be queued");
    }
    logger.info({ documentId: document._id.toString(), fieldCount: fields.length, overallZone }, "Document AI processing completed; human confirmation required");
  } catch (error) {
    const errorCode = String(error.code || "AI_PIPELINE_FAILED").slice(0, 100);
    await withTransaction(async (session) => {
      const update = await Document.updateOne(
        { _id: document._id, status: "PROCESSING" },
        { $set: { status: "AI_FAILED" } },
        { session },
      );
      if (!update.matchedCount) return;
      await markCaseDocumentPendingConfirmation(document, session, "case.document_ai_failed");
      const [failure] = await AiExtraction.create([{
        document_id: document._id,
        overall_zone: "RED",
        processing_error_code: errorCode,
        extracted_lines: extractedLines(ocrText),
        rule_results_json: [],
        fields: expectedFields(document, []),
      }], { session });
      await writeAudit({ actor_id: null, action: "DOCUMENT_AI_EXTRACTION_FAILED", entity: "Document", entity_id: document._id, after_json: { extraction_id: failure._id, error_code: errorCode } }, { session });
    });
    logger.warn({ documentId: document._id.toString(), code: error.code || "AI_PIPELINE_FAILED" }, "Document pipeline failed; manual entry is available");
  }
}
