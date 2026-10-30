import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { AiExtraction, Application, CaseObligation, CaseRecord, CaseStageHistory, CaseTask, Document, Institution, LeaseDetail, OutboxEvent, Policy, Visit } from "../../models/index.js";
import { processDocument } from "../ai/pipeline.js";
import { evaluate, getRuleConfig } from "../rules/engine.js";
import { localStorage } from "./storage.js";
import { buildChecklist } from "../../engine/checklist.js";
import { caseFilterForUser, scopedCase } from "../cases/router.js";
import { hasManualCompletionValue, validateConfirmedDocumentFields } from "./confirmation.js";
import { scheduleCaseEvaluation } from "../cases/pipeline.js";
import { ClamAvError, scanBuffer } from "./clamav.js";

const accessRoles = ["INSTITUTION", "SCRUTINY_OFFICER", "EVC", "EVC_CHAIRMAN", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"];
const allowedMime = new Set(["application/pdf", "image/jpeg", "image/png"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const confirmSchema = z.object({
  fields: z.array(z.object({
    field_name: z.string().min(1).max(80),
    confirmed_value: z.string().max(2000),
  }).strict()).min(1).max(30).refine((fields) => new Set(fields.map((field) => field.field_name)).size === fields.length, "A field may only be confirmed once per request"),
  resolved_ambiguities: z.array(z.string().min(1).max(80)).max(30).default([]),
  complete: z.boolean().optional().default(false),
}).strict();
const verifyDocumentSchema = z.object({
  verification: z.enum(["verified", "not_verified"]),
  reason: z.string().trim().max(3000).optional().default(""),
}).strict().refine((value) => value.verification === "verified" || value.reason.length > 0, {
  path: ["reason"],
  message: "A reason is required when a document is not verified",
});
const unlink = promisify(fs.unlink);
const readFile = promisify(fs.readFile);

function envelope(res, req, data, status = 200, pagination = {}) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id, ...pagination } });
}

function magicMime(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return "";
}

async function scanUploadFile(req, res) {
  try {
    return await scanBuffer(req.file.buffer);
  } catch (error) {
    if (!(error instanceof ClamAvError)) throw error;
    res.status(error.status).json({
      data: null,
      error: { code: error.code, message: error.message },
      meta: { requestId: req.id },
    });
    return null;
  }
}

function istDayOffset(target, reference = new Date()) {
  const dateParts = (value) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
    const part = (type) => Number(parts.find((item) => item.type === type)?.value);
    return { year: part("year"), month: part("month"), day: part("day") };
  };
  const end = dateParts(target);
  const start = dateParts(reference);
  return Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86400000);
}

async function applicationForUser(id, user) {
  if (!mongoose.isValidObjectId(id)) return null;
  const application = await Application.findOne({ _id: id, deleted_at: null });
  if (!application) return null;
  if (user.role === "INSTITUTION") {
    let institutionId = user.institution_id;
    if (!institutionId) institutionId = (await Institution.findOne({ contact_email: user.email }).select("_id"))?._id;
    if (!institutionId || application.institution_id.toString() !== institutionId.toString()) return null;
  } else if (user.role === "SCRUTINY_OFFICER" && application.assigned_officer_id?.toString() !== user._id.toString()) {
    return null;
  } else if (user.role === "EVC" && !await Visit.exists({ application_id: application._id, evc_user_id: user._id })) {
    return null;
  }
  return application;
}

async function documentForUser(id, user) {
  if (!mongoose.isValidObjectId(id)) return null;
  const document = await Document.findOne({ _id: id, deleted_at: null }).select("+file_path");
  if (!document) return null;
  if (document.case_id) {
    const caseRecord = await scopedCase(document.case_id, user);
    return caseRecord ? { document, caseRecord } : null;
  }
  if (!document.application_id) return null;
  const application = await applicationForUser(document.application_id, user);
  return application ? { document, application } : null;
}

function schedulePipeline(documentId) {
  setImmediate(() => {
    processDocument(documentId).then(async () => {
      const document = await Document.findById(documentId).select("case_id");
      if (document?.case_id) scheduleCaseEvaluation({ caseId: document.case_id, intent: "CHANGE" });
    }).catch(async (error) => {
      try {
        await markDocumentAiFailed(documentId, error);
      } catch (recordError) {
        logger.error({ documentId: documentId.toString(), code: recordError.code || "AI_FAILURE_AUDIT_FAILED" }, "Failed to persist document processing failure");
      }
      logger.warn({ documentId: documentId.toString(), code: error.code || "PIPELINE_FAILED" }, "Document processing task failed");
    });
  });
}

async function markDocumentAiFailed(documentId, error) {
  await withTransaction(async (session) => {
    let query = Document.findOneAndUpdate(
      { _id: documentId, status: { $ne: "AI_FAILED" } },
      { $set: { status: "AI_FAILED" } },
      { new: true },
    );
    if (session) query = query.session(session);
    const document = await query;
    if (!document) return;
    const errorCode = error.code || "PIPELINE_FAILED";
    await OutboxEvent.create([{
      eventId: crypto.randomUUID(),
      eventType: "document.ai_processing_failed",
      entityId: String(document._id),
      payload: { caseId: document.case_id ? String(document.case_id) : null, applicationId: document.application_id ? String(document.application_id) : null, errorCode },
      publishedAt: null,
    }], session ? { session } : {});
    await writeAudit({
      actor_id: null,
      action: "DOCUMENT_AI_PROCESSING_FAILED",
      entity: "Document",
      entity_id: document._id,
      after_json: { status: document.status, errorCode },
    }, { session });
  });
}

function scheduleDocumentBatch(documents) {
  setImmediate(async () => {
    for (const document of documents) {
      try {
        await processDocument(document._id);
        if (document.case_id) scheduleCaseEvaluation({ caseId: document.case_id, intent: "CHANGE" });
      } catch (error) {
        try {
          await markDocumentAiFailed(document._id, error);
        } catch (recordError) {
          logger.error({ documentId: document._id.toString(), code: recordError.code || "AI_FAILURE_AUDIT_FAILED" }, "Failed to persist document batch processing failure");
        }
        logger.warn({ documentId: document._id.toString(), code: error.code || "PIPELINE_FAILED" }, "Document batch processing failed");
      }
    }
  });
}

export function documentsRouter() {
  const router = express.Router();

  router.get("/cases/:id/documents", authenticate, requireRole(...accessRoles), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const caseRecord = await scopedCase(req.params.id, req.user);
      if (!caseRecord) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Case not found in your scope" }, meta: { requestId: req.id } });
      const documents = await Document.find({
        case_id: caseRecord._id,
        status: { $ne: "SUPERSEDED" },
      }).select("_id doc_type_slot doc_type_final original_name mime status verification verification_reason verified_at quarantine_reason pages version createdAt").sort({ createdAt: 1, _id: 1 }).lean();
      const extractions = await AiExtraction.find({
        document_id: { $in: documents.map((document) => document._id) },
      }).sort({ createdAt: -1 }).lean();
      const latestExtraction = new Map();
      for (const extraction of extractions) {
        const documentId = extraction.document_id.toString();
        if (!latestExtraction.has(documentId)) latestExtraction.set(documentId, extraction);
      }
      return envelope(res, req, documents.map((document) => ({
        ...document,
        extraction: latestExtraction.get(document._id.toString()) || null,
      })));
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/documents/analyze", authenticate, requireRole(...accessRoles), requireRole("INSTITUTION", "ADMIN"), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const caseRecord = await scopedCase(req.params.id, req.user);
      if (!caseRecord) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Case not found in your scope" }, meta: { requestId: req.id } });
      if (req.user.role === "INSTITUTION" && !["draft", "returned"].includes(caseRecord.status)) {
        return res.status(409).json({ data: null, error: { code: "CASE_NOT_EDITABLE", message: "Documents can only be analyzed for a draft or returned case" }, meta: { requestId: req.id } });
      }
      if (req.user.role === "ADMIN" && ["approved", "rejected"].includes(caseRecord.status)) {
        return res.status(409).json({ data: null, error: { code: "CASE_CLOSED", message: "Documents cannot be analyzed for a closed case" }, meta: { requestId: req.id } });
      }
      const documents = await Document.find({
        case_id: caseRecord._id,
        status: { $ne: "SUPERSEDED" },
      }).select("_id status doc_type_slot original_name").sort({ createdAt: 1, _id: 1 });
      if (!documents.length) return res.status(409).json({ data: null, error: { code: "NO_CASE_DOCUMENTS", message: "Upload at least one document before starting detection" }, meta: { requestId: req.id } });
      const queued = [];
      await withTransaction(async (session) => {
        queued.length = 0;
        for (const document of documents) {
          if (document.status === "AI_FAILED") {
            document.status = "UPLOADED";
            await document.save(session ? { session } : {});
            queued.push(document);
          } else if (document.status === "UPLOADED") {
            queued.push(document);
          }
        }
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "case.document_analysis_requested",
          entityId: String(caseRecord._id),
          payload: { documentIds: queued.map((document) => String(document._id)), actorId: String(req.user._id) },
          publishedAt: null,
        }], session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "CASE_DOCUMENT_BATCH_ANALYSIS_STARTED",
          entity: "CaseRecord",
          entity_id: caseRecord._id,
          after_json: { document_count: documents.length, queued_count: queued.length },
          ip: req.ip,
        }, { session });
      });
      if (queued.length) scheduleDocumentBatch(queued);
      return envelope(res, req, {
        documents: documents.map((document) => ({
          document_id: document._id,
          slot_id: document.doc_type_slot,
          file_name: document.original_name,
          status: document.status,
        })),
        queued_count: queued.length,
      }, 202);
    } catch (error) { return next(error); }
  });

  router.get("/documents", authenticate, requireRole(...accessRoles), validate(z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(100),
  }).strict(), "query"), async (req, res, next) => {
    try {
      let applicationFilter = { deleted_at: null };
      const caseFilter = await caseFilterForUser(req.user) || { _id: { $in: [] } };
      if (req.user.role === "INSTITUTION") {
        const institutionId = req.user.institution_id
          || (await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id"))?._id;
        if (!institutionId) return envelope(res, req, [], 200, { total: 0, page: req.query.page, pageSize: req.query.pageSize });
        applicationFilter.institution_id = institutionId;
      } else if (req.user.role === "SCRUTINY_OFFICER") {
        applicationFilter.assigned_officer_id = req.user._id;
      } else if (req.user.role === "EVC") {
        const visitApplicationIds = await Visit.find({ evc_user_id: req.user._id }).distinct("application_id");
        applicationFilter._id = { $in: visitApplicationIds };
      } else if (req.user.role === "SAC_SHC") {
        applicationFilter._id = { $in: [] };
      } else if (req.user.role === "BUREAU_OFFICER" || req.user.role === "SENIOR_AUTHORITY") {
        if (req.user.region) {
          applicationFilter.institution_id = { $in: await Institution.find({ region: req.user.region, deleted_at: null }).distinct("_id") };
        } else {
          applicationFilter._id = { $in: [] };
        }
      }

      const [applicationIds, caseIds] = await Promise.all([
        Application.find(applicationFilter).distinct("_id"),
        CaseRecord.find(caseFilter).distinct("_id"),
      ]);
      const filter = {
        deleted_at: null,
        status: { $ne: "SUPERSEDED" },
        $or: [
          { application_id: { $in: applicationIds } },
          { case_id: { $in: caseIds } },
        ],
      };
      const { page, pageSize } = req.query;
      const [documents, total] = await Promise.all([
        Document.find(filter)
          .select("_id application_id case_id doc_type_slot doc_type_final original_name mime status verification verification_reason verified_at quarantine_reason pages version createdAt")
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .lean(),
        Document.countDocuments(filter),
      ]);
      const documentIds = documents.map((document) => document._id);
      const [extractions, leases, applications, cases] = await Promise.all([
        AiExtraction.find({ document_id: { $in: documentIds } })
          .select("document_id fields m1_type m1_confidence overall_zone processing_error_code createdAt")
          .sort({ createdAt: -1 })
          .lean(),
        LeaseDetail.find({ document_id: { $in: documentIds } })
          .select("document_id lease_start lease_end lease_term_years registered validity_status")
          .lean(),
        Application.find({ _id: { $in: applicationIds } })
          .select("application_number type status current_stage institution_id submitted_at")
          .populate("institution_id", "name")
          .lean(),
        CaseRecord.find({ _id: { $in: caseIds } })
          .select("caseNo applicationType status currentStage institutionId submittedAt")
          .populate("institutionId", "name")
          .lean(),
      ]);
      const extractionByDocument = new Map();
      for (const extraction of extractions) {
        const key = extraction.document_id.toString();
        if (!extractionByDocument.has(key)) extractionByDocument.set(key, extraction);
      }
      const leaseByDocument = new Map(leases.map((lease) => [lease.document_id.toString(), lease]));
      const applicationById = new Map(applications.map((application) => [application._id.toString(), application]));
      const caseById = new Map(cases.map((caseRecord) => [caseRecord._id.toString(), caseRecord]));
      return envelope(res, req, documents.map((document) => ({
        ...document,
        extraction: extractionByDocument.get(document._id.toString()) || null,
        lease: leaseByDocument.get(document._id.toString()) || null,
        application: document.application_id ? applicationById.get(document.application_id.toString()) || null : null,
        case: document.case_id ? caseById.get(document.case_id.toString()) || null : null,
      })), 200, { total, page, pageSize, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/documents", authenticate, requireRole(...accessRoles), requireRole("INSTITUTION", "ADMIN"), upload.single("file"), async (req, res, next) => {
    let savedFile;
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      const caseRecord = await scopedCase(req.params.id, req.user);
      if (!caseRecord) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Case not found in your scope" }, meta: { requestId: req.id } });
      const hasOpenDeficiency = req.user.role === "INSTITUTION" && await CaseTask.exists({
        caseId: caseRecord._id,
        type: "DEFICIENCY_RESPONSE",
        state: { $in: ["open", "queued"] },
      });
      if (req.user.role === "INSTITUTION" && !["draft", "returned"].includes(caseRecord.status) && !hasOpenDeficiency) {
        return res.status(409).json({ data: null, error: { code: "CASE_NOT_EDITABLE", message: "Documents can only be uploaded to a draft, returned case, or an open deficiency task" }, meta: { requestId: req.id } });
      }
      if (req.user.role === "ADMIN" && ["approved", "rejected"].includes(caseRecord.status)) {
        return res.status(409).json({ data: null, error: { code: "CASE_CLOSED", message: "Documents cannot be added to a closed case" }, meta: { requestId: req.id } });
      }
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPG, or PNG file" }, meta: { requestId: req.id } });
      const detectedMime = magicMime(req.file.buffer);
      if (!detectedMime || !allowedMime.has(detectedMime)) return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "File content must be PDF, JPEG, or PNG" }, meta: { requestId: req.id } });
      if (req.file.mimetype !== detectedMime && req.file.mimetype !== "application/octet-stream") return res.status(415).json({ data: null, error: { code: "MIME_MISMATCH", message: "File extension or MIME does not match its content" }, meta: { requestId: req.id } });
      const antivirus = await scanUploadFile(req, res);
      if (!antivirus) return;
      const slot = z.string().trim().min(1).max(100).safeParse(req.body.doc_type_slot);
      if (!slot.success) return res.status(400).json({ data: null, error: { code: "INVALID_DOCUMENT_SLOT", message: "doc_type_slot is required" }, meta: { requestId: req.id } });
      const policy = await Policy.findOne({ version: caseRecord.policyVersion }).lean();
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      const checklistSlot = buildChecklist(caseRecord.applicationType, caseRecord.applicability, caseRecord.slotRecords, policy.checklist)
        .find((item) => item.slotId === slot.data);
      if (!checklistSlot || checklistSlot.status === "not_applicable") return res.status(422).json({ data: null, error: { code: "SLOT_NOT_APPLICABLE", message: "The selected document slot is not applicable to this case" }, meta: { requestId: req.id } });
      if (!checklistSlot.acceptedFileTypes.includes(detectedMime)) return res.status(415).json({ data: null, error: { code: "FILE_TYPE_NOT_ALLOWED", message: "File type is not accepted for this document slot" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const { document, version } = await withTransaction(async (session) => {
        let currentCaseQuery = CaseRecord.findById(caseRecord._id);
        if (session) currentCaseQuery = currentCaseQuery.session(session);
        const currentCase = await currentCaseQuery;
        if (!currentCase || currentCase.version !== caseRecord.version) {
          throw Object.assign(new Error("Case changed during document upload"), { code: "CASE_VERSION_CONFLICT" });
        }
        let previousQuery = Document.findOne({
          case_id: caseRecord._id,
          doc_type_slot: slot.data,
          status: { $ne: "SUPERSEDED" },
        }).sort({ version: -1 });
        if (session) previousQuery = previousQuery.session(session);
        const previous = await previousQuery;
        const nextVersion = (previous?.version || 0) + 1;
        const [created] = await Document.create([{
          case_id: caseRecord._id,
          uploaded_by: req.user._id,
          file_path: savedFile.filePath,
          original_name: path.basename(req.file.originalname).slice(0, 255),
          file_hash: savedFile.sha256,
          mime: detectedMime,
          antivirus_status: antivirus.status,
          pages: 1,
          doc_type_slot: slot.data,
          status: "UPLOADED",
          version: nextVersion,
          supersedes_document_id: previous?._id || null,
        }], session ? { session } : {});
        if (previous) {
          previous.status = "SUPERSEDED";
          previous.superseded_by_document_id = created._id;
          await previous.save(session ? { session } : {});
        }
        const slotRecord = currentCase.slotRecords.find((item) => item.slotId === slot.data);
        if (slotRecord) {
          slotRecord.status = "uploaded";
          slotRecord.documentId = created._id;
          if (previous) slotRecord.historyIds.push(previous._id);
        } else {
          currentCase.slotRecords.push({
            slotId: slot.data,
            status: "uploaded",
            documentId: created._id,
            historyIds: previous ? [previous._id] : [],
          });
        }
        currentCase.version += 1;
        await currentCase.save(session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "CASE_DOCUMENT_UPLOADED",
          entity: "Document",
          entity_id: created._id,
          after_json: { case_id: caseRecord._id, doc_type_slot: slot.data, file_hash: savedFile.sha256, version: nextVersion },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "case.document_uploaded",
          entityId: caseRecord._id.toString(),
          payload: { caseNo: currentCase.caseNo, currentStage: currentCase.currentStage, documentId: created._id.toString(), slotId: slot.data },
        }], session ? { session } : {});
        return { document: created, version: nextVersion };
      });
      return envelope(res, req, { document_id: document._id, status: document.status, version, antivirus_status: document.antivirus_status }, 202);
    } catch (error) {
      if (savedFile) await unlink(savedFile.absolutePath).catch(() => {});
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "DOCUMENT_VERSION_CONFLICT", message: "A document version was created concurrently; retry the upload" }, meta: { requestId: req.id } });
      if (error?.code === "CASE_VERSION_CONFLICT") return res.status(409).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ data: null, error: { code: "FILE_TOO_LARGE", message: "File must be no larger than 20 MB" }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.post("/applications/:id/documents", authenticate, requireRole(...accessRoles), requireRole("INSTITUTION", "ADMIN"), upload.single("file"), async (req, res, next) => {
    let savedFile;
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid application id" }, meta: { requestId: req.id } });
      const application = await applicationForUser(id, req.user);
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPG, or PNG file" }, meta: { requestId: req.id } });
      const detectedMime = magicMime(req.file.buffer);
      if (!detectedMime || !allowedMime.has(detectedMime)) return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "File content must be PDF, JPEG, or PNG" }, meta: { requestId: req.id } });
      if (req.file.mimetype !== detectedMime && req.file.mimetype !== "application/octet-stream") return res.status(415).json({ data: null, error: { code: "MIME_MISMATCH", message: "File extension or MIME does not match its content" }, meta: { requestId: req.id } });
      const antivirus = await scanUploadFile(req, res);
      if (!antivirus) return;
      const slot = z.string().trim().min(1).max(100).safeParse(req.body.doc_type_slot);
      if (!slot.success) return res.status(400).json({ data: null, error: { code: "INVALID_DOCUMENT_SLOT", message: "doc_type_slot is required" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const { document, version } = await withTransaction(async (session) => {
        const previous = await Document.findOne({
          application_id: application._id,
          doc_type_slot: slot.data,
          status: { $ne: "SUPERSEDED" },
        }).sort({ version: -1 }).session(session);
        const nextVersion = (previous?.version || 0) + 1;
        const [created] = await Document.create([{
          application_id: application._id,
          uploaded_by: req.user._id,
          file_path: savedFile.filePath,
          original_name: path.basename(req.file.originalname).slice(0, 255),
          file_hash: savedFile.sha256,
          mime: detectedMime,
          antivirus_status: antivirus.status,
          pages: 1,
          doc_type_slot: slot.data,
          status: "UPLOADED",
          version: nextVersion,
          supersedes_document_id: previous?._id || null,
        }], { session });
        if (previous) {
          previous.status = "SUPERSEDED";
          previous.superseded_by_document_id = created._id;
          await previous.save({ session });
        }
        await writeAudit({
          actor_id: req.user._id,
          action: "DOCUMENT_UPLOADED",
          entity: "Document",
          entity_id: created._id,
          after_json: { application_id: application._id, doc_type_slot: slot.data, file_hash: savedFile.sha256, version: nextVersion },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "application.document_uploaded",
          entityId: application._id.toString(),
          payload: { applicationId: application._id.toString(), documentId: created._id.toString(), slotId: slot.data, version: nextVersion },
          publishedAt: null,
        }], { session });
        return { document: created, version: nextVersion };
      });
      schedulePipeline(document._id);
      return envelope(res, req, { document_id: document._id, status: document.status, version, antivirus_status: document.antivirus_status }, 202);
    } catch (error) {
      if (savedFile) await unlink(savedFile.absolutePath).catch(() => {});
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "DOCUMENT_VERSION_CONFLICT", message: "A document version was created concurrently; retry the upload" }, meta: { requestId: req.id } });
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ data: null, error: { code: "FILE_TOO_LARGE", message: "File must be no larger than 20 MB" }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.post("/visits/:id/report", authenticate, requireRole("EVC"), upload.single("file"), async (req, res, next) => {
    let savedFile;
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid visit id" }, meta: { requestId: req.id } });
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPG, or PNG visit report" }, meta: { requestId: req.id } });
      const detectedMime = magicMime(req.file.buffer);
      if (!detectedMime || !allowedMime.has(detectedMime)) return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "File content must be PDF, JPEG, or PNG" }, meta: { requestId: req.id } });
      if (req.file.mimetype !== detectedMime && req.file.mimetype !== "application/octet-stream") return res.status(415).json({ data: null, error: { code: "MIME_MISMATCH", message: "File extension or MIME does not match its content" }, meta: { requestId: req.id } });
      const antivirus = await scanUploadFile(req, res);
      if (!antivirus) return;
      const visit = await Visit.findOne({ _id: req.params.id, evc_user_id: req.user._id });
      if (!visit || visit.status === "CANCELLED") return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Active assigned visit not found" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const reportSlot = `EVC Visit Report ${visit._id}`;
      const document = await withTransaction(async (session) => {
        const previous = await Document.findOne({ application_id: visit.application_id, doc_type_slot: reportSlot, status: { $ne: "SUPERSEDED" } }).sort({ version: -1 }).session(session);
        const version = (previous?.version || 0) + 1;
        const [created] = await Document.create([{
          application_id: visit.application_id,
          uploaded_by: req.user._id,
          file_path: savedFile.filePath,
          original_name: path.basename(req.file.originalname).slice(0, 255),
          file_hash: savedFile.sha256,
          mime: detectedMime,
          antivirus_status: antivirus.status,
          pages: 1,
          doc_type_slot: reportSlot,
          doc_type_final: "EVC Visit Report",
          status: "CONFIRMED",
          version,
          supersedes_document_id: previous?._id || null,
        }], { session });
        if (previous) {
          previous.status = "SUPERSEDED";
          previous.superseded_by_document_id = created._id;
          await previous.save({ session });
        }
        const before = visit.toObject();
        visit.report_file_id = created._id;
        visit.status = "DONE";
        await visit.save({ session });
        await writeAudit({ actor_id: req.user._id, action: "EVC_VISIT_REPORT_UPLOADED", entity: "Visit", entity_id: visit._id, before_json: before, after_json: visit.toObject(), ip: req.ip }, { session });
        await writeAudit({ actor_id: req.user._id, action: "VISIT_REPORT_DOCUMENT_CREATED", entity: "Document", entity_id: created._id, after_json: { application_id: visit.application_id, visit_id: visit._id, file_hash: savedFile.sha256 }, ip: req.ip }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "evc_visit.report_uploaded",
          entityId: visit._id.toString(),
          payload: { visitId: visit._id.toString(), applicationId: visit.application_id.toString(), documentId: created._id.toString(), status: visit.status },
          publishedAt: null,
        }], { session });
        return created;
      });

      return envelope(res, req, { visit_id: visit._id, report_document_id: document._id, status: visit.status, antivirus_status: document.antivirus_status }, 201);
    } catch (error) {
      if (savedFile) await unlink(savedFile.absolutePath).catch(() => {});
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "REPORT_VERSION_CONFLICT", message: "A visit report was uploaded concurrently; retry the upload" }, meta: { requestId: req.id } });
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ data: null, error: { code: "FILE_TOO_LARGE", message: "File must be no larger than 20 MB" }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.post("/cases/:id/evc-report", authenticate, requireRole("EVC", "EVC_CHAIRMAN"), validate(z.object({ id: idSchema }).strict(), "params"), upload.single("file"), async (req, res, next) => {
    let savedFile;
    try {
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPG, or PNG EVC report" }, meta: { requestId: req.id } });
      const detectedMime = magicMime(req.file.buffer);
      if (!detectedMime || !allowedMime.has(detectedMime)) return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "File content must be PDF, JPEG, or PNG" }, meta: { requestId: req.id } });
      if (req.file.mimetype !== detectedMime && req.file.mimetype !== "application/octet-stream") return res.status(415).json({ data: null, error: { code: "MIME_MISMATCH", message: "File extension or MIME does not match its content" }, meta: { requestId: req.id } });
      const antivirus = await scanUploadFile(req, res);
      if (!antivirus) return;
      const caseRecord = await scopedCase(req.params.id, req.user);
      if (!caseRecord) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Case not found in your EVC scope" }, meta: { requestId: req.id } });
      if (caseRecord.workflowVersion) {
        const stage = caseRecord.allocatedStages?.[caseRecord.currentStageIndex];
        if (
          !stage
          || stage.key !== "evc_inspection" && stage.key !== "evc_verification"
          || stage.assignedRole !== "EVC"
          || !stage.assignedUserId?.equals(req.user._id) && !stage.assignedPanelUserIds?.some((id) => id.equals(req.user._id))
        ) {
          return res.status(409).json({ data: null, error: { code: "EVC_NOT_CURRENT_STAGE", message: "An EVC report is accepted only from the assigned EVC stage owner" }, meta: { requestId: req.id } });
        }
        if (stage.status !== "INSPECTION_SCHEDULED") {
          return res.status(409).json({ data: null, error: { code: "INSPECTION_NOT_SCHEDULED", message: "Schedule the inspection before uploading its report" }, meta: { requestId: req.id } });
        }
        savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
        const latestReport = await Document.findOne({ case_id: caseRecord._id, doc_type_slot: "evc_report" }).sort({ version: -1 }).select("version");
        const report = await withTransaction(async (session) => {
          const [created] = await Document.create([{
            case_id: caseRecord._id,
            uploaded_by: req.user._id,
            file_path: savedFile.filePath,
            original_name: path.basename(req.file.originalname).slice(0, 255),
            file_hash: savedFile.sha256,
            mime: detectedMime,
            antivirus_status: antivirus.status,
            pages: 1,
            doc_type_slot: "evc_report",
            doc_type_final: "EVC report",
            status: "CONFIRMED",
            confirmed_at: new Date(),
            version: (latestReport?.version || 0) + 1,
          }], session ? { session } : {});
          const now = new Date();
          stage.status = "WAITING_FOR_APPROVAL";
          stage.inspectionReportDocumentId = created._id;
          stage.history.push({ action: "INSPECTION_REPORT_UPLOADED", performed_by: req.user._id, timestamp: now, notes: created.original_name });
          caseRecord.version += 1;
          await caseRecord.save(session ? { session } : {});
          await CaseStageHistory.create([{
            caseId: caseRecord._id,
            fromStage: caseRecord.currentStage,
            toStage: caseRecord.currentStage,
            holderType: "committee",
            holderId: req.user._id,
            actorId: req.user._id,
            enteredAt: now,
            reason: "EVC inspection report uploaded for committee sign-off.",
          }], session ? { session } : {});
          await writeAudit({
            actor_id: req.user._id,
            action: "CASE_EVC_REPORT_UPLOADED",
            entity: "Document",
            entity_id: created._id,
            after_json: { caseId: caseRecord._id, file_hash: savedFile.sha256, stageStatus: stage.status, version: caseRecord.version },
            ip: req.ip,
          }, { session });
          await OutboxEvent.create([{
            eventId: crypto.randomUUID(),
            eventType: "case.evc_report_uploaded",
            entityId: caseRecord._id.toString(),
            payload: { caseNo: caseRecord.caseNo, documentId: created._id.toString(), currentStage: caseRecord.currentStage },
          }], session ? { session } : {});
          return created;
        });
        return envelope(res, req, { document: report, case: caseRecord, antivirus_status: report.antivirus_status }, 201);
      }
      if (caseRecord.currentStage !== "evc" || !caseRecord.route.includes("evc")) {
        return res.status(409).json({ data: null, error: { code: "EVC_NOT_CURRENT_STAGE", message: "An EVC report is accepted only while the case is at its EVC stage" }, meta: { requestId: req.id } });
      }
      const task = await CaseTask.findOne({
        caseId: caseRecord._id,
        type: "EVC",
        holderId: req.user._id,
        state: { $in: ["open", "queued"] },
      });
      if (!task) return res.status(409).json({ data: null, error: { code: "EVC_TASK_NOT_FOUND", message: "No open EVC task is assigned to this user" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const latestReport = await Document.findOne({ case_id: caseRecord._id, doc_type_slot: "evc_report" }).sort({ version: -1 }).select("version");
      const report = await withTransaction(async (session) => {
        const [created] = await Document.create([{
          case_id: caseRecord._id,
          uploaded_by: req.user._id,
          file_path: savedFile.filePath,
          original_name: path.basename(req.file.originalname).slice(0, 255),
          file_hash: savedFile.sha256,
          mime: detectedMime,
          antivirus_status: antivirus.status,
          pages: 1,
          doc_type_slot: "evc_report",
          doc_type_final: "EVC report",
          status: "CONFIRMED",
          confirmed_at: new Date(),
          version: (latestReport?.version || 0) + 1,
        }], session ? { session } : {});
        task.state = "completed";
        task.completedAt = new Date();
        task.payload = { ...task.payload, reportDocumentId: created._id.toString() };
        await task.save(session ? { session } : {});
        caseRecord.version += 1;
        await caseRecord.save(session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "CASE_EVC_REPORT_UPLOADED",
          entity: "Document",
          entity_id: created._id,
          after_json: { caseId: caseRecord._id, taskId: task._id, file_hash: savedFile.sha256 },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "case.evc_report_uploaded",
          entityId: caseRecord._id.toString(),
          payload: { caseNo: caseRecord.caseNo, documentId: created._id.toString(), currentStage: caseRecord.currentStage },
        }], session ? { session } : {});
        return created;
      });
      try {
        const evaluated = await evaluateCasePipeline({
          caseId: caseRecord._id,
          intent: "EVC_REPORT",
          expectedVersion: caseRecord.version,
          apply: true,
          actorId: req.user._id,
        });
        return envelope(res, req, { document: report, case: evaluated.case, antivirus_status: report.antivirus_status }, 201);
      } catch (pipelineError) {
        scheduleCaseEvaluation({ caseId: caseRecord._id, intent: "EVC_REPORT", actorId: req.user._id });
        logger.error({ caseId: caseRecord._id.toString(), code: pipelineError.code || "EVC_REPORT_ADVANCE_FAILED" }, "EVC report was saved; case stage advancement is pending retry");
        return envelope(res, req, { document: report, pipelineStatus: "pending_retry", antivirus_status: report.antivirus_status }, 202);
      }
    } catch (error) {
      if (savedFile) await unlink(savedFile.absolutePath).catch(() => {});
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "EVC_REPORT_CONFLICT", message: "An EVC report was uploaded concurrently; refresh and retry" }, meta: { requestId: req.id } });
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ data: null, error: { code: "FILE_TOO_LARGE", message: "File must be no larger than 20 MB" }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.get(["/documents/:id/extraction", "/documents/:id/analysis"], authenticate, requireRole(...accessRoles), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      const extraction = await AiExtraction.findOne({ document_id: result.document._id }).sort({ createdAt: -1 }).lean();
      return envelope(res, req, { document: result.document, extraction });
    } catch (error) { return next(error); }
  });

  const confirmDocumentFields = async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      if (result.document.status === "SUPERSEDED") return res.status(409).json({ data: null, error: { code: "DOCUMENT_SUPERSEDED", message: "Superseded document suggestions cannot be confirmed" }, meta: { requestId: req.id } });
      if (result.document.status === "QUARANTINED") return res.status(409).json({ data: null, error: { code: "DOCUMENT_QUARANTINED", message: "Quarantined documents cannot be confirmed; upload a safe replacement" }, meta: { requestId: req.id } });
      if (result.caseRecord) {
        const stage = result.caseRecord.allocatedStages?.[result.caseRecord.currentStageIndex];
        const assignedUserId = stage?.assignedUserId ? String(stage.assignedUserId) : "";
        const stageOwner = Boolean(result.caseRecord.workflowVersion
          && stage
          && stage.status !== "FROZEN_WAITING_FOR_ASSIST"
          && stage.assignedRole === req.user.role
          && (!assignedUserId || assignedUserId === String(req.user._id))
          && (!req.user.region || req.user.region === result.caseRecord.region));
        if (result.caseRecord.workflowVersion && stage?.status === "FROZEN_WAITING_FOR_ASSIST" && stage.assignedRole === req.user.role && (!assignedUserId || assignedUserId === String(req.user._id))) {
          return res.status(403).json({ data: null, error: { code: "STAGE_FROZEN", message: "The stage owner cannot confirm fields while the stage is frozen" }, meta: { requestId: req.id } });
        }
        if (req.user.role === "INSTITUTION" && !["draft", "returned"].includes(result.caseRecord.status)) {
          return res.status(409).json({ data: null, error: { code: "CASE_NOT_EDITABLE", message: "Institution fields can only be edited while the case is a draft or returned" }, meta: { requestId: req.id } });
        }
        if (!["INSTITUTION", "ADMIN"].includes(req.user.role) && !stageOwner) {
          return res.status(403).json({ data: null, error: { code: "STAGE_REVIEW_ACCESS_REQUIRED", message: "Only the assigned current-stage owner may confirm extracted fields" }, meta: { requestId: req.id } });
        }
        if (!result.caseRecord.workflowVersion && !["INSTITUTION", "ADMIN"].includes(req.user.role)) {
          return res.status(403).json({ data: null, error: { code: "STAGE_REVIEW_ACCESS_REQUIRED", message: "This case does not support reviewer field confirmation" }, meta: { requestId: req.id } });
        }
      }
      const extraction = await AiExtraction.findOne({ document_id: result.document._id }).sort({ createdAt: -1 });
      if (!extraction) return res.status(409).json({ data: null, error: { code: "EXTRACTION_NOT_READY", message: "No extraction is ready to confirm" }, meta: { requestId: req.id } });
      const requested = req.body.fields;
      const selected = requested.map((item) => extraction.fields.find((field) => field.field_name === item.field_name));
      if (result.document.status === "AI_FAILED") {
        const standardFields = new Set(["issue_date", "valid_from", "valid_to", "cert_no", "issuer"]);
        const leaseFields = new Set(["lease_start", "lease_end", "lease_term", "lessor", "lessee"]);
        for (const [index, item] of requested.entries()) {
          const allowed = standardFields.has(item.field_name)
            || typeKey(result.document.doc_type_slot) === "lease" && leaseFields.has(item.field_name);
          if (!allowed) return res.status(400).json({ data: null, error: { code: "UNKNOWN_FIELD", message: "One or more manual fields are not supported for this document type" }, meta: { requestId: req.id } });
          if (!selected[index]) {
            const field = {
              field_name: item.field_name,
              ai_value: "",
              ai_confidence: 0,
              zone: "RED",
              source_text: "",
              source_page: 0,
              confirmed_value: null,
              confirmed_by: null,
              confirmed_at: null,
              was_corrected: false,
            };
            extraction.fields.push(field);
            selected[index] = extraction.fields.at(-1);
          }
        }
      }
      if (selected.some((field) => !field)) return res.status(400).json({ data: null, error: { code: "UNKNOWN_FIELD", message: "One or more fields are not part of this extraction" }, meta: { requestId: req.id } });
      if (result.document.status === "AI_FAILED"
        && req.body.complete
        && !hasManualCompletionValue(requested)) {
        return res.status(422).json({
          data: null,
          error: { code: "MANUAL_FIELDS_REQUIRED", message: "Enter at least one document value before completing a document that could not be analyzed" },
          meta: { requestId: req.id },
        });
      }
      let requireValidTo = false;
      if (result.caseRecord) {
        const policy = await Policy.findOne({ version: result.caseRecord.policyVersion }).lean();
        if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
        requireValidTo = policy.checklist.find((item) => item.slotId === result.document.doc_type_slot)?.hasValidity === true;
      }
      const fieldValidation = validateConfirmedDocumentFields(
        extraction.fields,
        requested,
        req.body.resolved_ambiguities,
        requireValidTo,
      );
      if (fieldValidation) {
        return res.status(422).json({
          data: null,
          error: { code: fieldValidation.code, message: fieldValidation.message },
          meta: { requestId: req.id },
        });
      }
      const hasReviewZone = selected.some((field) => field.zone !== "GREEN");
      const before = extraction.toObject();
      const changedFields = new Set(requested.map(({ field_name }) => field_name));
      for (const [index, field] of selected.entries()) {
        const value = requested[index].confirmed_value;
        field.confirmed_value = value;
        field.confirmed_source = !field.ai_value ? "manual" : value === field.ai_value ? "ai_accepted" : "ai_edited";
        field.confirmed_by = req.user._id;
        field.confirmed_at = new Date();
        field.was_corrected = value !== field.ai_value;
      }
      const [applicationDocuments, storedLease] = await Promise.all([
        result.application
          ? Document.find({ application_id: result.application._id }).select("doc_type_slot status").lean()
          : Promise.resolve([]),
        result.application ? LeaseDetail.findOne({ document_id: result.document._id }).lean() : Promise.resolve(null),
      ]);
      const leaseStart = extraction.fields.find((field) => field.field_name === "lease_start")?.confirmed_value;
      const leaseEnd = extraction.fields.find((field) => field.field_name === "lease_end")?.confirmed_value;
      const termValue = extraction.fields.find((field) => field.field_name === "lease_term")?.confirmed_value;
      const termMatch = typeof termValue === "string" ? /^P(?:(\d+)Y)?(?:(\d+)M)?$/i.exec(termValue.trim()) : null;
      const termMonthsValue = termMatch ? Number(termMatch[1] || 0) * 12 + Number(termMatch[2] || 0) : null;
      const storedTermMonths = Number.isFinite(storedLease?.lease_term_years) ? Math.round(storedLease.lease_term_years * 12) : null;
      const effectiveStart = changedFields.has("lease_start") ? (leaseStart || null) : storedLease?.lease_start || null;
      const effectiveEnd = changedFields.has("lease_end") ? (leaseEnd || null) : storedLease?.lease_end || null;
      const effectiveTermMonths = changedFields.has("lease_term") ? termMonthsValue : storedTermMonths;
      const results = result.application ? evaluate(
        { doc_type_slot: result.document.doc_type_slot, doc_type_final: result.document.doc_type_final },
        extraction.fields,
        result.application,
        await getRuleConfig(),
        {
          applicationDocuments: applicationDocuments.map((item) => ({
            doc_type_slot_key: item.doc_type_slot.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
            status: item.status,
          })),
          lease: {
            ...storedLease,
            lease_start: effectiveStart,
            lease_end: effectiveEnd,
            lease_term_years: effectiveTermMonths === null ? null : effectiveTermMonths / 12,
          },
          today: new Date(),
        },
      ) : [];
      extraction.rule_results_json = results;
      await withTransaction(async (session) => {
        let currentCase;
        if (result.caseRecord) {
          let currentCaseQuery = CaseRecord.findOne({
            _id: result.caseRecord._id,
            slotRecords: { $elemMatch: { slotId: result.document.doc_type_slot, documentId: result.document._id } },
          });
          if (session) currentCaseQuery = currentCaseQuery.session(session);
          currentCase = await currentCaseQuery;
          if (!currentCase) throw Object.assign(new Error("Case document was replaced before confirmation"), { code: "CASE_DOCUMENT_SUPERSEDED" });
        }
        await extraction.save({ session });
        const allSuggestionsConfirmed = extraction.fields.filter((field) => field.ai_value).every((field) => field.confirmed_value != null);
        const manuallyCompleted = result.document.status === "AI_FAILED" && req.body.complete;
        if (allSuggestionsConfirmed && (result.document.status !== "AI_FAILED" || manuallyCompleted)) {
          if (result.document.status === "AI_FAILED" && !result.document.doc_type_final) result.document.doc_type_final = result.document.doc_type_slot;
          result.document.status = "CONFIRMED";
          result.document.confirmed_at = new Date();
          await result.document.save({ session });
        }
        if (result.caseRecord && !result.caseRecord.workflowVersion && result.document.status === "CONFIRMED") {
          const validTo = extraction.fields.find((field) => field.field_name === "valid_to")?.confirmed_value;
          if (validTo) {
            await CaseObligation.findOneAndUpdate(
              { sourceDocumentId: result.document._id, type: "validity" },
              {
                $set: {
                  dueAt: new Date(`${validTo}T00:00:00.000Z`),
                  title: `${result.document.doc_type_slot} validity`,
                  closure: "open",
                  verification: "pending",
                },
                $setOnInsert: {
                  caseId: result.caseRecord._id,
                  institutionId: result.caseRecord.institutionId,
                  sourceDocumentId: result.document._id,
                  type: "validity",
                  dueKind: "date",
                  ownerType: "institution",
                  submission: "none",
                },
              },
              { upsert: true, new: true, runValidators: true, session },
            );
          }
          if (result.document.supersedes_document_id) {
            await CaseTask.updateMany(
              { caseId: result.caseRecord._id, type: "DEFICIENCY_RESPONSE", documentId: result.document.supersedes_document_id, state: { $in: ["open", "queued"] } },
              { $set: { state: "completed", completedAt: new Date() } },
              session ? { session } : {},
            );
          }
          await OutboxEvent.create([{
            eventId: crypto.randomUUID(),
            eventType: "document.confirmed",
            entityId: result.caseRecord._id.toString(),
            payload: {
              caseNo: result.caseRecord.caseNo,
              documentId: result.document._id.toString(),
              confirmedFields: requested.map(({ field_name }) => field_name),
              confirmedBy: req.user._id.toString(),
            },
          }], session ? { session } : {});
        }
        if (result.caseRecord) {
          const slotRecord = currentCase.slotRecords.find((item) => item.slotId === result.document.doc_type_slot);
          slotRecord.status = result.document.status === "CONFIRMED" ? "confirmed" : "pending_confirmation";
          currentCase.version += 1;
          await currentCase.save(session ? { session } : {});
          await OutboxEvent.create([{
            eventId: crypto.randomUUID(),
            eventType: "case.document_confirmation_updated",
            entityId: currentCase._id.toString(),
            payload: { caseNo: currentCase.caseNo, currentStage: currentCase.currentStage, documentId: result.document._id.toString(), slotId: result.document.doc_type_slot, status: slotRecord.status },
          }], session ? { session } : {});
        }
        if (result.application && (changedFields.has("lease_start") || changedFields.has("lease_end") || changedFields.has("lease_term"))) {
          const endDate = effectiveEnd ? new Date(effectiveEnd) : null;
          const daysUntilEnd = endDate ? istDayOffset(endDate) : null;
          await LeaseDetail.findOneAndUpdate(
            { document_id: result.document._id },
            { $set: {
              lease_start: effectiveStart ? new Date(effectiveStart) : null,
              lease_end: effectiveEnd ? new Date(effectiveEnd) : null,
              lease_term_years: effectiveTermMonths === null ? null : effectiveTermMonths / 12,
              confirmed_by: req.user._id,
              confirmed_at: new Date(),
              validity_status: daysUntilEnd === null ? "UNKNOWN" : daysUntilEnd < 0 ? "EXPIRED" : daysUntilEnd <= 60 ? "EXPIRING" : "VALID",
            } },
            { upsert: true, new: true, runValidators: true, session },
          );
        }
        if (result.application) {
          await OutboxEvent.create([{
            eventId: crypto.randomUUID(),
            eventType: "application.document_fields_confirmed",
            entityId: result.application._id.toString(),
            payload: {
              applicationId: result.application._id.toString(),
              documentId: result.document._id.toString(),
              confirmedFields: requested.map(({ field_name }) => field_name),
              confirmedBy: req.user._id.toString(),
            },
            publishedAt: null,
          }], { session });
        }
        await writeAudit({ actor_id: req.user._id, action: "DOCUMENT_FIELDS_CONFIRMED", entity: "Document", entity_id: result.document._id, before_json: { fields: before.fields }, after_json: { confirmed_fields: requested.map(({ field_name }) => field_name), rule_results: results }, ip: req.ip }, { session });
      });
      if (result.caseRecord && result.document.status === "CONFIRMED") {
        scheduleCaseEvaluation({ caseId: result.caseRecord._id, intent: "CHANGE", actorId: req.user._id });
      }
      return envelope(res, req, { document: result.document, extraction });
    } catch (error) {
      if (error?.code === "CASE_DOCUMENT_SUPERSEDED") return res.status(409).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      return next(error);
    }
  };
  router.post("/documents/:id/confirm", authenticate, requireRole(...accessRoles), validate(z.object({ id: idSchema }).strict(), "params"), validate(confirmSchema), confirmDocumentFields);
  router.patch("/applications/:caseId/documents/:docId/confirm-fields", authenticate, requireRole(...accessRoles), validate(z.object({ caseId: idSchema, docId: idSchema }).strict(), "params"), validate(confirmSchema), async (req, res, next) => {
    try {
      const caseRecord = await scopedCase(req.params.caseId, req.user);
      const result = await documentForUser(req.params.docId, req.user);
      if (!caseRecord || !result?.caseRecord || !result.caseRecord._id.equals(caseRecord._id)) {
        return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Case document not found" }, meta: { requestId: req.id } });
      }
      req.params.id = req.params.docId;
      return confirmDocumentFields(req, res, next);
    } catch (error) { return next(error); }
  });

  router.post("/documents/:id/verify", authenticate, requireRole("SCRUTINY_OFFICER", "ADMIN"), validate(z.object({ id: idSchema }).strict(), "params"), validate(verifyDocumentSchema), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result?.caseRecord) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Case document not found" }, meta: { requestId: req.id } });
      const { document, caseRecord } = result;
      if (req.user.role !== "ADMIN" && !caseRecord.holderId?.equals(req.user._id)) {
        return res.status(403).json({ data: null, error: { code: "NOT_CASE_HOLDER", message: "Only the assigned case holder may verify this document" }, meta: { requestId: req.id } });
      }
      if (document.status !== "CONFIRMED") {
        return res.status(409).json({ data: null, error: { code: "DOCUMENT_NOT_CONFIRMED", message: "Only a human-confirmed document can be verified" }, meta: { requestId: req.id } });
      }
      const task = await CaseTask.findOne({
        documentId: document._id,
        type: "VERIFY_DOCUMENT",
        state: { $in: ["open", "queued"] },
      });
      if (!task) return res.status(409).json({ data: null, error: { code: "VERIFICATION_TASK_NOT_FOUND", message: "No open verification task exists for this document" }, meta: { requestId: req.id } });
      const before = { verification: document.verification, status: document.status };
      const now = new Date();
      const slot = caseRecord.slotRecords.find((item) => item.slotId === document.doc_type_slot && item.documentId?.equals(document._id));
      if (!slot) return res.status(409).json({ data: null, error: { code: "CASE_DOCUMENT_SUPERSEDED", message: "This document no longer occupies its checklist slot" }, meta: { requestId: req.id } });
      await withTransaction(async (session) => {
        document.verification = req.body.verification;
        document.verification_reason = req.body.reason;
        document.verified_by = req.user._id;
        document.verified_at = now;
        await document.save(session ? { session } : {});
        task.state = "completed";
        await task.save(session ? { session } : {});
        slot.status = req.body.verification === "verified" ? "verified" : "confirmed";
        caseRecord.version += 1;
        await caseRecord.save(session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "DOCUMENT_VERIFICATION_RECORDED",
          entity: "Document",
          entity_id: document._id,
          before_json: before,
          after_json: { verification: document.verification, reason: document.verification_reason, taskId: task._id },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "document.verified",
          entityId: caseRecord._id.toString(),
          payload: { caseNo: caseRecord.caseNo, documentId: document._id.toString(), verification: document.verification },
        }], session ? { session } : {});
      });
      scheduleCaseEvaluation({ caseId: caseRecord._id, intent: "CHANGE", actorId: req.user._id });
      return envelope(res, req, { document, task, caseVersion: caseRecord.version });
    } catch (error) { return next(error); }
  });

  router.post(["/documents/:id/reprocess", "/documents/:id/reanalyze"], authenticate, requireRole(...accessRoles), requireRole("INSTITUTION", "SCRUTINY_OFFICER", "ADMIN"), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      if (result.document.status === "SUPERSEDED") return res.status(409).json({ data: null, error: { code: "DOCUMENT_SUPERSEDED", message: "Superseded documents cannot be reprocessed" }, meta: { requestId: req.id } });
      const before = result.document.status;
      const previousAntivirusStatus = result.document.antivirus_status;
      if (previousAntivirusStatus !== "CLEAN") {
        const storedFile = await readFile(localStorage.resolve(result.document.file_path));
        const antivirus = await scanBuffer(storedFile);
        result.document.antivirus_status = antivirus.status;
      }
      await withTransaction(async (session) => {
        result.document.status = "UPLOADED";
        await result.document.save(session ? { session } : {});
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "document.reprocess_requested",
          entityId: result.document.case_id?.toString() || result.document.application_id?.toString() || result.document._id.toString(),
          payload: {
            documentId: result.document._id.toString(),
            caseId: result.document.case_id?.toString() || null,
            applicationId: result.document.application_id?.toString() || null,
            previousStatus: before,
            status: result.document.status,
            antivirusStatus: result.document.antivirus_status,
          },
          publishedAt: null,
        }], session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "DOCUMENT_REPROCESS_REQUESTED", entity: "Document", entity_id: result.document._id, before_json: { status: before, antivirus_status: previousAntivirusStatus }, after_json: { status: result.document.status, antivirus_status: result.document.antivirus_status }, ip: req.ip }, { session });
      });
      schedulePipeline(result.document._id);
      return envelope(res, req, { document_id: result.document._id, status: "UPLOADED", antivirus_status: result.document.antivirus_status }, 202);
    } catch (error) { return next(error); }
  });

  router.get("/documents/:id/download", authenticate, requireRole(...accessRoles), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      if (result.document.status === "QUARANTINED") return res.status(409).json({ data: null, error: { code: "DOCUMENT_QUARANTINED", message: "Quarantined files cannot be downloaded" }, meta: { requestId: req.id } });
      const target = localStorage.resolve(result.document.file_path);
      if (!fs.existsSync(target)) return res.status(404).json({ data: null, error: { code: "FILE_NOT_FOUND", message: "Stored document is unavailable" }, meta: { requestId: req.id } });
      res.type(result.document.mime);
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(result.document.original_name).replace(/["\\\r\n]/g, "_")}"`);
      return res.sendFile(target);
    } catch (error) { return next(error); }
  });
  return router;
}
