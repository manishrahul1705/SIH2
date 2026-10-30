import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AiExtraction, Application, CaseRecord, Document, DocumentText, LeaseDetail, OutboxEvent, Policy, ProcessingRun, User } from "../../models/index.js";
import { runPythonJson } from "./pythonBridge.js";
import { processingErrorCode } from "./manualFallback.js";
import { normalizeSuggestion } from "./confidence.js";
import { evaluate, getRuleConfig } from "../rules/engine.js";
import { localStorage } from "../documents/storage.js";
import { NotificationService } from "../notifications/service.js";
import { scheduleCaseEvaluation } from "../cases/pipeline.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { DEFAULT_PIPELINE_SETTINGS } from "../../engine/policyDefaults.js";

const m1Schema = z.object({
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
}).passthrough();
const ocrSchema = z.object({
  supported: z.boolean(),
  quarantined: z.boolean().optional(),
  pages: z.array(z.object({ text: z.string().optional() }).passthrough()),
  full_text: z.string().default(""),
  used_ocr: z.boolean().optional().default(false),
  mean_ocr_conf: z.number().min(0).max(1).nullable().optional(),
  warnings: z.array(z.string()).optional().default([]),
}).passthrough();
const m2Schema = z.object({
  fields: z.record(z.string(), z.unknown()),
  pages: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
  mean_ocr_conf: z.number().min(0).max(1).optional(),
}).passthrough();
const m3Schema = z.object({
  fields: z.record(z.string(), z.unknown()),
}).passthrough();
const OCR_PIPELINE_VERSION = "ocr-v1";
const M2_SUPPORTED_TYPES = new Set([
  "fire",
  "structural",
  "nba_letter",
  "occupancy_building",
  "aicte_approval_letter",
  "audited_accounts",
  "other",
]);

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

function expectedFields(document, extractedFields, normalization = {}) {
  const fields = new Map(extractedFields.map((field) => [field.field_name, field]));
  const expectedNames = ["issue_date", "valid_from", "valid_to", "cert_no", "issuer"];
  if (typeKey(document.doc_type_slot) === "lease") {
    expectedNames.push("lease_start", "lease_end", "lease_term", "lessor", "lessee");
  }
  for (const name of expectedNames) {
    if (!fields.has(name)) fields.set(name, normalizeSuggestion(name, {}, normalization));
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

export function summarizeM1(m1) {
  const isLowConfidence = m1?.prefill === false || safeText(m1?.zone).toLowerCase() === "red";
  const value = isLowConfidence ? "other" : safeText(m1?.value || "other");
  return {
    type: value,
    confidence: number(m1?.confidence),
    display: isLowConfidence ? "Other Document" : safeText(m1?.display_name || value),
  };
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
    occupancyorbuildingcertificate: "occupancy",
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

export function m2DocumentType(value) {
  const aliases = {
    lease: "lease",
    fire: "fire",
    structural: "structural",
    occupancy: "occupancy_building",
    nba: "nba_letter",
    auditedaccounts: "audited_accounts",
    aicte: "aicte_approval_letter",
  };
  return aliases[typeKey(value)] || "other";
}

export function shouldRunM2(slotM2Type, detectedM2Type) {
  return M2_SUPPORTED_TYPES.has(slotM2Type) || M2_SUPPORTED_TYPES.has(detectedM2Type);
}

async function markCaseDocumentPendingConfirmation(document, session, eventType, slotStatus = "pending_confirmation", eventExtras = {}) {
  if (!document.case_id) return;
  let caseQuery = CaseRecord.findOne({
    _id: document.case_id,
    slotRecords: { $elemMatch: { slotId: document.doc_type_slot, documentId: document._id } },
  });
  if (session) caseQuery = caseQuery.session(session);
  const caseRecord = await caseQuery;
  if (!caseRecord) return;
  const slot = caseRecord.slotRecords.find((item) => item.slotId === document.doc_type_slot);
  slot.status = slotStatus;
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
      ...eventExtras,
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
  let processingRun = null;
  let documentText = null;
  let modelResults = {};
  try {
    processingRun = await ProcessingRun.create({
      documentId: document._id,
      fileHash: document.file_hash,
      status: "processing",
      startedAt: new Date(),
    });
    document.latest_processing_run_id = processingRun._id;
    await document.save();

    const absoluteFile = localStorage.resolve(document.file_path);
    let cachedText = await DocumentText.findOne({ fileHash: document.file_hash, ocrVersion: OCR_PIPELINE_VERSION })
      .select("+ocrData")
      .lean();
    let ocr;
    if (cachedText) {
      documentText = cachedText;
      ocr = { ...ocrSchema.parse(cachedText.ocrData), file: document.original_name };
    } else {
      ocr = {
        ...ocrSchema.parse(await runPythonJson(scriptPath(env.OCR_SCRIPT_PATH), [absoluteFile])),
        file: document.original_name,
      };
      if (ocr.supported && !ocr.quarantined) {
        const fullText = ocr.full_text || ocr.pages.map((page) => page.text || "").join("\n");
        const cacheValue = {
          fileHash: document.file_hash,
          ocrVersion: OCR_PIPELINE_VERSION,
          fullText,
          pages: ocr.pages,
          ocrData: ocr,
          usedOcr: ocr.used_ocr,
          meanOcrConfidence: ocr.mean_ocr_conf,
          warnings: ocr.warnings,
        };
        try {
          documentText = await DocumentText.findOneAndUpdate(
            { fileHash: document.file_hash, ocrVersion: OCR_PIPELINE_VERSION },
            { $setOnInsert: cacheValue },
            { new: true, upsert: true, setDefaultsOnInsert: true },
          ).select("+ocrData");
        } catch (error) {
          if (error?.code !== 11000) throw error;
          documentText = await DocumentText.findOne({ fileHash: document.file_hash, ocrVersion: OCR_PIPELINE_VERSION })
            .select("+ocrData");
          if (!documentText) throw error;
        }
        ocr = ocrSchema.parse(documentText.ocrData);
      }
    }
    if (!ocr.supported || ocr.quarantined) {
      if (ocr.quarantined) {
        const quarantineReason = safeText(ocr.quarantine_reason || "The file did not pass the document safety checks").slice(0, 500);
        const quarantinedPath = await localStorage.quarantine(document.file_path);
        await withTransaction(async (session) => {
          document.file_path = quarantinedPath;
          document.status = "QUARANTINED";
          document.quarantine_reason = quarantineReason;
          await document.save(session ? { session } : {});
          await AiExtraction.create([{
            document_id: document._id,
            overall_zone: "RED",
            processing_error_code: "DOCUMENT_QUARANTINED",
            fields: expectedFields(document, [], { wordCount: 0 }),
          }], session ? { session } : {});
          await ProcessingRun.updateOne(
            { _id: processingRun._id, status: "processing" },
            { $set: { status: "quarantined", errorCode: "DOCUMENT_QUARANTINED", completedAt: new Date() } },
            session ? { session } : {},
          );
          await markCaseDocumentPendingConfirmation(document, session, "document.quarantined", "quarantined", { reason: quarantineReason });
          await writeAudit({
            actor_id: null,
            action: "DOCUMENT_QUARANTINED",
            entity: "Document",
            entity_id: document._id,
            after_json: { status: document.status, reason: quarantineReason },
          }, { session });
        });
        if (document.case_id) scheduleCaseEvaluation({ caseId: document.case_id, intent: "CHANGE" });
        logger.warn({ documentId: document._id.toString(), code: "DOCUMENT_QUARANTINED" }, "Document was quarantined by the local safety check");
        return;
      }
      throw Object.assign(new Error("OCR could not safely read this file"), { code: "OCR_UNAVAILABLE" });
    }
    ocrText = documentText?.fullText || ocr.full_text || ocr.pages.map((page) => page.text || "").join("\n");
    const m1Raw = m1Schema.parse(await runPythonJson(
      scriptPath(env.M1_SCRIPT_PATH),
      ["--text-stdin"],
      { input: ocrText, acceptedExitCodes: [0, 2] },
    ));
    const m1 = summarizeM1(m1Raw);
    modelResults.m1 = m1Raw;
    const [application, caseRecord] = await Promise.all([
      document.application_id ? Application.findById(document.application_id).lean() : null,
      document.case_id ? CaseRecord.findOne({ _id: document.case_id, deletedAt: null }).lean() : null,
    ]);
    if (document.application_id && !application || document.case_id && !caseRecord) {
      throw Object.assign(new Error("Document parent is unavailable"), { code: "DOCUMENT_PARENT_UNAVAILABLE" });
    }
    const policy = caseRecord ? await Policy.findOne({ version: caseRecord.policyVersion }).lean() : null;
    const settings = { ...DEFAULT_PIPELINE_SETTINGS, ...(policy?.pipelineSettings || {}) };
    const normalizedM1Type = typeKey(m1.type);
    const slotM2Type = m2DocumentType(document.doc_type_slot);
    const m1M2Type = m2DocumentType(m1.type);
    const runM2 = shouldRunM2(slotM2Type, m1M2Type);
    const m2Type = m1Raw.prefill === false || safeText(m1Raw.zone).toLowerCase() === "red"
      ? slotM2Type
      : m1M2Type;
    const m2 = runM2
      ? m2Schema.parse(await runPythonJson(
        scriptPath(env.M2_SCRIPT_PATH),
        [absoluteFile, "--doc-type", m2Type, "--ocr-json-stdin"],
        { input: JSON.stringify(ocr) },
      ))
      : { fields: {}, model_version: "not_applicable" };
    modelResults.m2 = m2;
    const meanOcrConfidence = [m2.mean_ocr_conf, m1Raw.ocr?.mean_ocr_conf, ocr.mean_ocr_conf]
      .find((value) => typeof value === "number" && Number.isFinite(value)) ?? null;
    const wordCount = ocrText.trim().split(/\s+/).filter(Boolean).length;
    const normalization = {
      meanOcrConfidence,
      wordCount,
      greenThreshold: settings.greenThreshold,
      amberThreshold: settings.amberThreshold,
      heuristicConfidenceCap: settings.heuristicConfidenceCap,
    };
    const extractedFields = Object.entries(m2.fields || {}).map(([name, value]) => normalizeSuggestion(name, value, {
      ...normalization,
      model: "M2",
    }));
    let m3 = null;
    if (typeKey(document.doc_type_slot) === "lease" || normalizedM1Type === "lease" && m1.confidence >= settings.amberThreshold) {
      m3 = m3Schema.parse(await runPythonJson(
        scriptPath(env.M3_SCRIPT_PATH),
        [absoluteFile, "--doc-type", "lease", "--ocr-json-stdin"],
        { input: JSON.stringify(ocr) },
      ));
      modelResults.m3 = m3;
      for (const name of ["lease_start", "lease_end", "lease_term"]) {
        if (m3.fields?.[name]) extractedFields.push(normalizeSuggestion(name, m3.fields[name], {
          ...normalization,
          model: "M3",
        }));
      }
    }
    const fields = expectedFields(document, extractedFields, normalization);
    const applicationDocuments = await Document.find(
      document.application_id ? { application_id: document.application_id } : { case_id: document.case_id },
    ).select("doc_type_slot status").lean();
    const slotMismatch = document.doc_type_slot && typeKey(m1.type) !== typeKey(document.doc_type_slot);
    const ruleContext = application || (caseRecord ? { type: caseRecord.applicationType } : null);
    const results = ruleContext ? evaluate(
      { doc_type_slot: document.doc_type_slot, doc_type_final: m1.display },
      fields,
      ruleContext,
      await getRuleConfig(),
      {
        meanOcrConfidence,
        applicationDocuments: applicationDocuments.map((item) => ({
          doc_type_slot_key: item.doc_type_slot.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
          status: item.status,
        })),
      },
    ) : [];
    if (slotMismatch) results.push({ ruleId: "DOC_TYPE_MISMATCH", severity: "WARNING", passed: false, message: "Detected type differs from the selected slot.", basis: "SYNTHETIC" });
    const zones = fields.map((item) => item.zone);
    const overallZone = zones.includes("RED") ? "RED" : zones.includes("AMBER") ? "AMBER" : "GREEN";
    const manualEntryRequired = fields.length === 0 || fields.every((field) => field.zone === "RED");
    const warnings = [];
    if (meanOcrConfidence !== null && meanOcrConfidence < settings.amberThreshold) warnings.push("LOW_OCR_QUALITY");
    if (manualEntryRequired) warnings.push("MANUAL_ENTRY_REQUIRED");
    const lines = extractedLines(ocrText);
    const textPath = ocrText ? (await localStorage.save(Buffer.from(ocrText, "utf8"), `${document._id}-ocr.txt`)).filePath : "";
    await withTransaction(async (session) => {
      const [created] = await AiExtraction.create([{
        document_id: document._id,
        ocr_text_path: textPath,
        extracted_lines: lines,
        m1_type: m1.display,
        m1_confidence: m1.confidence,
        m1_zone: String(m1Raw.zone || (m1.confidence >= settings.greenThreshold ? "green" : m1.confidence >= settings.amberThreshold ? "amber" : "red")).toUpperCase(),
        m1_top3: Array.isArray(m1Raw.top3) ? m1Raw.top3 : [],
        m2_json: m2,
        m3_json: m3,
        overall_zone: overallZone,
        rule_results_json: results,
        model_versions: { m1: m1Raw.model_version || "", m2: modelVersion(m2), m3: m3 ? modelVersion(m3) : "" },
        fields,
      }], { session });
      document.doc_type_final = m1.display;
      document.pages = Math.max(1, ocr.pages.length);
      document.used_ocr = ocr.used_ocr;
      document.mean_ocr_conf = meanOcrConfidence;
      document.analysis_warnings = [...new Set([...ocr.warnings, ...warnings])];
      document.status = manualEntryRequired ? "AI_FAILED" : "AWAITING_CONFIRMATION";
      await document.save({ session });
      await markCaseDocumentPendingConfirmation(document, session, "case.document_ai_ready");
      await ProcessingRun.updateOne(
        { _id: processingRun._id, status: "processing" },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            documentTextId: documentText?._id || null,
            modelVersions: { m1: m1Raw.model_version || "", m2: modelVersion(m2), m3: m3 ? modelVersion(m3) : "" },
            modelResults,
          },
        },
        session ? { session } : {},
      );
      if (document.case_id) {
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "document.analyzed",
          entityId: document.case_id.toString(),
          payload: { documentId: document._id.toString(), status: "pending_confirmation" },
        }], session ? { session } : {});
      }
      await writeAudit({ actor_id: null, action: "DOCUMENT_AI_EXTRACTION_COMPLETED", entity: "Document", entity_id: document._id, after_json: { extraction_id: created._id, overall_zone: overallZone, field_count: fields.length } }, { session });
      return created;
    });
    if (document.case_id) scheduleCaseEvaluation({ caseId: document.case_id, intent: "CHANGE" });
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
    const errorCode = processingErrorCode(error);
    await withTransaction(async (session) => {
      const update = await Document.updateOne(
        { _id: document._id, status: "PROCESSING" },
        { $set: { status: "AI_FAILED" } },
        { session },
      );
      if (!update.matchedCount) return;
      if (processingRun) {
        await ProcessingRun.updateOne(
          { _id: processingRun._id, status: "processing" },
          { $set: { status: "failed", errorCode, completedAt: new Date(), modelResults } },
          session ? { session } : {},
        );
      }
      await markCaseDocumentPendingConfirmation(document, session, "case.document_ai_failed");
      if (document.case_id) {
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "document.analyzed",
          entityId: document.case_id.toString(),
          payload: { documentId: document._id.toString(), status: "manual_entry_required" },
        }], session ? { session } : {});
      }
      const [failure] = await AiExtraction.create([{
        document_id: document._id,
        overall_zone: "RED",
        processing_error_code: errorCode,
        extracted_lines: extractedLines(ocrText),
        rule_results_json: [],
        fields: expectedFields(document, [], { wordCount: 0 }),
      }], { session });
      await writeAudit({ actor_id: null, action: "DOCUMENT_AI_EXTRACTION_FAILED", entity: "Document", entity_id: document._id, after_json: { extraction_id: failure._id, error_code: errorCode } }, { session });
    });
    if (document.case_id) scheduleCaseEvaluation({ caseId: document.case_id, intent: "CHANGE" });
    logger.warn({ documentId: document._id.toString(), code: error.code || "AI_PIPELINE_FAILED" }, "Document pipeline failed; manual entry is available");
  }
}
