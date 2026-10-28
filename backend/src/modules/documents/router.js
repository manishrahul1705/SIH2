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
import { AiExtraction, Application, CaseRecord, Document, Institution, LeaseDetail, OutboxEvent, Policy, Visit } from "../../models/index.js";
import { processDocument } from "../ai/pipeline.js";
import { evaluate, getRuleConfig } from "../rules/engine.js";
import { localStorage } from "./storage.js";
import { buildChecklist } from "../../engine/checklist.js";
import { caseFilterForUser, scopedCase } from "../cases/router.js";
import { hasManualCompletionValue } from "./confirmation.js";

const accessRoles = ["INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"];
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
  complete: z.boolean().optional().default(false),
}).strict();
const unlink = promisify(fs.unlink);

function envelope(res, req, data, status = 200, pagination = {}) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id, ...pagination } });
}

function magicMime(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return "";
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
    processDocument(documentId).catch(async (error) => {
      await Document.updateOne({ _id: documentId }, { $set: { status: "AI_FAILED" } });
      logger.warn({ documentId: documentId.toString(), code: error.code || "PIPELINE_FAILED" }, "Document processing task failed");
    });
  });
}

function scheduleDocumentBatch(documents) {
  setImmediate(async () => {
    for (const document of documents) {
      try {
        await processDocument(document._id);
      } catch (error) {
        await Document.updateOne({ _id: document._id }, { $set: { status: "AI_FAILED" } });
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
      }).select("_id doc_type_slot doc_type_final original_name mime status pages version createdAt").sort({ createdAt: 1, _id: 1 }).lean();
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
      for (const document of documents) {
        if (document.status === "AI_FAILED") {
          document.status = "UPLOADED";
          await document.save();
          queued.push(document);
        } else if (document.status === "UPLOADED") {
          queued.push(document);
        }
      }
      await writeAudit({
        actor_id: req.user._id,
        action: "CASE_DOCUMENT_BATCH_ANALYSIS_STARTED",
        entity: "CaseRecord",
        entity_id: caseRecord._id,
        after_json: { document_count: documents.length, queued_count: queued.length },
        ip: req.ip,
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
          .select("_id application_id case_id doc_type_slot doc_type_final original_name mime status pages version createdAt")
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
        Application.find({ _id: { $in: applicationIds } }).select("application_number type status current_stage").lean(),
        CaseRecord.find({ _id: { $in: caseIds } }).select("caseNo applicationType status currentStage").lean(),
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
      if (req.user.role === "INSTITUTION" && !["draft", "returned"].includes(caseRecord.status)) {
        return res.status(409).json({ data: null, error: { code: "CASE_NOT_EDITABLE", message: "Documents can only be uploaded to a draft or returned case" }, meta: { requestId: req.id } });
      }
      if (req.user.role === "ADMIN" && ["approved", "rejected"].includes(caseRecord.status)) {
        return res.status(409).json({ data: null, error: { code: "CASE_CLOSED", message: "Documents cannot be added to a closed case" }, meta: { requestId: req.id } });
      }
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPG, or PNG file" }, meta: { requestId: req.id } });
      const detectedMime = magicMime(req.file.buffer);
      if (!detectedMime || !allowedMime.has(detectedMime)) return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "File content must be PDF, JPEG, or PNG" }, meta: { requestId: req.id } });
      if (req.file.mimetype !== detectedMime && req.file.mimetype !== "application/octet-stream") return res.status(415).json({ data: null, error: { code: "MIME_MISMATCH", message: "File extension or MIME does not match its content" }, meta: { requestId: req.id } });
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
      return envelope(res, req, { document_id: document._id, status: document.status, version }, 202);
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
        return { document: created, version: nextVersion };
      });
      schedulePipeline(document._id);
      return envelope(res, req, { document_id: document._id, status: document.status, version }, 202);
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
        return created;
      });
      return envelope(res, req, { visit_id: visit._id, report_document_id: document._id, status: visit.status }, 201);
    } catch (error) {
      if (savedFile) await unlink(savedFile.absolutePath).catch(() => {});
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "REPORT_VERSION_CONFLICT", message: "A visit report was uploaded concurrently; retry the upload" }, meta: { requestId: req.id } });
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ data: null, error: { code: "FILE_TOO_LARGE", message: "File must be no larger than 20 MB" }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.get("/documents/:id/extraction", authenticate, requireRole(...accessRoles), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      const extraction = await AiExtraction.findOne({ document_id: result.document._id }).sort({ createdAt: -1 }).lean();
      return envelope(res, req, { document: result.document, extraction });
    } catch (error) { return next(error); }
  });

  router.post("/documents/:id/confirm", authenticate, requireRole(...accessRoles), requireRole("INSTITUTION", "ADMIN"), validate(z.object({ id: idSchema }).strict(), "params"), validate(confirmSchema), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      if (result.document.status === "SUPERSEDED") return res.status(409).json({ data: null, error: { code: "DOCUMENT_SUPERSEDED", message: "Superseded document suggestions cannot be confirmed" }, meta: { requestId: req.id } });
      if (result.caseRecord && req.user.role === "INSTITUTION" && !["draft", "returned"].includes(result.caseRecord.status)) {
        return res.status(409).json({ data: null, error: { code: "CASE_NOT_EDITABLE", message: "Documents can only be edited while the case is a draft or returned" }, meta: { requestId: req.id } });
      }
      const extraction = await AiExtraction.findOne({ document_id: result.document._id }).sort({ createdAt: -1 });
      if (!extraction) return res.status(409).json({ data: null, error: { code: "EXTRACTION_NOT_READY", message: "No extraction is ready to confirm" }, meta: { requestId: req.id } });
      const requested = req.body.fields;
      const selected = requested.map((item) => extraction.fields.find((field) => field.field_name === item.field_name));
      if (result.document.status === "AI_FAILED") {
        const standardFields = new Set(["issue_date", "valid_from", "valid_to", "cert_no", "issuer"]);
        const leaseFields = new Set(["lease_start", "lease_end", "lease_term"]);
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
      const hasReviewZone = selected.some((field) => field.zone !== "GREEN");
      const before = extraction.toObject();
      const changedFields = new Set(requested.map(({ field_name }) => field_name));
      for (const [index, field] of selected.entries()) {
        const value = requested[index].confirmed_value;
        field.confirmed_value = value;
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
          await result.document.save({ session });
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
        await writeAudit({ actor_id: req.user._id, action: "DOCUMENT_FIELDS_CONFIRMED", entity: "Document", entity_id: result.document._id, before_json: { fields: before.fields }, after_json: { confirmed_fields: requested.map(({ field_name }) => field_name), rule_results: results }, ip: req.ip }, { session });
      });
      return envelope(res, req, { document: result.document, extraction });
    } catch (error) {
      if (error?.code === "CASE_DOCUMENT_SUPERSEDED") return res.status(409).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.post("/documents/:id/reprocess", authenticate, requireRole(...accessRoles), requireRole("INSTITUTION", "SCRUTINY_OFFICER", "ADMIN"), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      if (result.document.status === "SUPERSEDED") return res.status(409).json({ data: null, error: { code: "DOCUMENT_SUPERSEDED", message: "Superseded documents cannot be reprocessed" }, meta: { requestId: req.id } });
      result.document.status = "UPLOADED";
      await result.document.save();
      schedulePipeline(result.document._id);
      await writeAudit({ actor_id: req.user._id, action: "DOCUMENT_REPROCESS_REQUESTED", entity: "Document", entity_id: result.document._id, ip: req.ip });
      return envelope(res, req, { document_id: result.document._id, status: "UPLOADED" }, 202);
    } catch (error) { return next(error); }
  });

  router.get("/documents/:id/download", authenticate, requireRole(...accessRoles), validate(z.object({ id: idSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const result = await documentForUser(req.params.id, req.user);
      if (!result) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Document not found" }, meta: { requestId: req.id } });
      const target = localStorage.resolve(result.document.file_path);
      if (!fs.existsSync(target)) return res.status(404).json({ data: null, error: { code: "FILE_NOT_FOUND", message: "Stored document is unavailable" }, meta: { requestId: req.id } });
      res.type(result.document.mime);
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(result.document.original_name).replace(/["\\\r\n]/g, "_")}"`);
      return res.sendFile(target);
    } catch (error) { return next(error); }
  });
  return router;
}
