import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import { localStorage } from "../documents/storage.js";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { Alert, Application, Decision, Document, Faculty, Institution, InstitutionAnnualReport, LeaseDetail, OutboxEvent, PendingItem, StageHistory, Undertaking, User, Visit, YearlyReport } from "../../models/index.js";
import { NotificationService } from "../notifications/service.js";
import { logger } from "../../config/logger.js";
import { indiaCalendarDateEnd } from "../../engine/timeRules.js";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const pendingCreate = z.object({
  application_id: id,
  description: z.string().trim().min(1).max(2000),
  due_date: z.coerce.date(),
}).strict();
const resolveSchema = z.object({ response: z.string().trim().max(3000).optional().default("") }).strict();
const reasonSchema = z.object({ reason_text: z.string().trim().min(10).max(3000) }).strict();
const undertakingCreate = z.object({
  application_id: id,
  title: z.string().trim().min(1).max(200),
  due_date: z.coerce.date(),
}).strict();
const undertakingSubmit = z.object({ file_id: id.optional() }).strict();
const visitCreate = z.object({
  application_id: id,
  evc_user_id: id,
  scheduled_at: z.coerce.date(),
}).strict();
const visitPatch = z.object({
  status: z.enum(["SCHEDULED", "DONE", "RESCHEDULED", "CANCELLED"]).optional(),
  scheduled_at: z.coerce.date().optional(),
  report_file_id: id.optional(),
  notes: z.string().max(5000).optional(),
}).strict();
const decisionSchema = z.object({
  application_id: id,
  outcome: z.enum(["APPROVED", "RETURNED", "CANCELLED", "REJECTED"]),
  reason: z.string().trim().min(1).max(5000),
}).strict();
const alertStatus = z.object({ status: z.enum(["ACKNOWLEDGED", "RESOLVED"]) }).strict();
const cancellationDecision = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(10).max(3000),
}).strict();
const reportCreate = z.object({
  academic_year: z.string().regex(/^\d{4}-\d{2}$/),
  due_date: z.coerce.date(),
  report_data: z.record(z.string(), z.unknown()).default({}),
}).strict();
const institutionReportCreate = z.object({
  calendar_year: z.coerce.number().int().min(2000).max(9999),
  complaints_received: z.coerce.number().int().min(0),
  ic_training_or_orientation: z.coerce.number().int().min(0),
  complaints_disposed: z.coerce.number().int().min(0),
  pending_over_90_days: z.coerce.number().int().min(0),
  awareness_programs: z.coerce.number().int().min(0),
  action_taken: z.string().trim().min(2).max(5000),
}).strict();
const reportEvidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single("file");

function evidenceMime(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return null;
}

function respond(res, req, data, meta = {}, status = 200) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id, ...meta } });
}

async function queueNotice(userId, type, subject, body, key, sms = false, extra = {}) {
  if (!userId) return;
  const jobs = [
    NotificationService.enqueue({ userId, type, channel: "IN_APP", payload: { title: subject, body, ...extra }, dedupeKey: `${key}:in-app` }),
    NotificationService.enqueue({ userId, type, channel: "EMAIL", payload: { subject, body, ...extra }, dedupeKey: `${key}:email` }),
  ];
  if (sms) jobs.push(NotificationService.enqueue({
    userId, type, channel: "SMS",
    payload: { message: `${extra.caseId ? `${extra.caseId}: ` : ""}${body}`.slice(0, 160), ...extra },
    dedupeKey: `${key}:sms`,
  }));
  try { await Promise.all(jobs); }
  catch (error) { logger.error({ userId: userId.toString(), type, code: error.code || "NOTIFICATION_ENQUEUE_FAILED" }, "Workflow notification could not be queued"); }
}

async function recordWorkflowMutation(req, { actorId, action, entity, eventType, mutate, before, payload }) {
  return withTransaction(async (session) => {
    const record = await mutate(session);
    if (!record) return null;
    const eventPayload = typeof payload === "function" ? payload(record) : payload;
    await OutboxEvent.create([{
      eventId: randomUUID(),
      eventType,
      entityId: String(record._id),
      payload: eventPayload,
      publishedAt: null,
    }], { session });
    await writeAudit({
      actor_id: actorId,
      action,
      entity,
      entity_id: record._id,
      ...(typeof before === "function" ? { before_json: before(record) } : before ? { before_json: before } : {}),
      after_json: eventPayload,
      ip: req.ip,
    }, { session });
    return record;
  });
}

function validId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid resource id" }, meta: { requestId: req.id } });
  return next();
}

async function institutionIdFor(user) {
  if (user.institution_id) return user.institution_id;
  return (await Institution.findOne({ contact_email: user.email }).select("_id"))?._id || null;
}

async function authorizedApplication(idValue, user) {
  if (!mongoose.isValidObjectId(idValue)) return null;
  const application = await Application.findOne({ _id: idValue, deleted_at: null });
  if (!application) return null;
  if (user.role === "INSTITUTION") {
    const own = await institutionIdFor(user);
    if (!own || own.toString() !== application.institution_id.toString()) return null;
  } else if (["SCRUTINY_OFFICER", "EVC"].includes(user.role) && application.assigned_officer_id?.toString() !== user._id.toString()) return null;
  return application;
}

export function workflowRouter() {
  const router = express.Router();
  for (const resource of ["alerts", "leases", "pending-items", "undertakings", "yearly-reports", "institution-annual-reports", "visits", "decisions"]) {
    router.use(`/${resource}`, authenticate);
  }

  router.get(["/alerts", "/alerts/my-alerts"], requireRole("INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN", "FACULTY"), validate(paging.extend({ status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]).optional() }), "query"), async (req, res, next) => {
    try {
      const filter = { target_user_id: req.user._id };
      if (req.user.role === "FACULTY") filter.type = { $in: ["YEARLY_REPORT_REMINDER", "YEARLY_REPORT_OVERDUE"] };
      if (req.query.status && ["OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(req.query.status)) filter.status = req.query.status;
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        Alert.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        Alert.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.patch("/alerts/:id", validId, validate(alertStatus), async (req, res, next) => {
    try {
      let before;
      const alert = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: `ALERT_${req.body.status}`,
        entity: "Alert",
        eventType: "alert.status_changed",
        mutate: async (session) => {
          const current = await Alert.findOne({ _id: req.params.id, target_user_id: req.user._id }).session(session);
          if (!current) return null;
          before = { status: current.status };
          current.status = req.body.status;
          await current.save({ session });
          return current;
        },
        before: () => before,
        payload: (record) => ({ status: record.status, type: record.type, applicationId: record.application_id ? String(record.application_id) : null }),
      });
      if (!alert) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Alert not found" }, meta: { requestId: req.id } });
      return respond(res, req, alert);
    } catch (error) { return next(error); }
  });
  router.post("/alerts/:id/reason", validId, validate(reasonSchema), async (req, res, next) => {
    try {
      let before;
      const alert = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "STAGE_DELAY_REASON_SUBMITTED",
        entity: "Alert",
        eventType: "stage_delay.reason_submitted",
        mutate: async (session) => {
          const current = await Alert.findOne({ _id: req.params.id, target_user_id: req.user._id, type: "STAGE_DELAY_REASON_REQUIRED" }).session(session);
          if (!current) return null;
          before = { status: current.status, reason_text: current.reason_text };
          current.reason_text = req.body.reason_text;
          current.status = "ACKNOWLEDGED";
          await current.save({ session });
          return current;
        },
        before: () => before,
        payload: (record) => ({ status: record.status, reason_text: "submitted" }),
      });
      if (!alert) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Reason request not found" }, meta: { requestId: req.id } });
      return respond(res, req, { id: alert._id, status: alert.status, reason_recorded: true });
    } catch (error) { return next(error); }
  });
  router.post("/alerts/:id/cancellation-decision", requireRole("BUREAU_OFFICER"), validId, validate(cancellationDecision), async (req, res, next) => {
    try {
      const alert = await Alert.findOne({ _id: req.params.id, target_user_id: req.user._id, type: "CANCELLATION_PERMISSION_REQUEST", status: "OPEN" });
      if (!alert) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Open cancellation review request not found" }, meta: { requestId: req.id } });
      const application = alert.application_id && await Application.findOne({ _id: alert.application_id, status: "IN_PROGRESS", deleted_at: null });
      if (!application) return res.status(409).json({ data: null, error: { code: "APPLICATION_NOT_ACTIVE", message: "The application is no longer active" }, meta: { requestId: req.id } });
      const before = { status: alert.status, application_status: application.status };
      await withTransaction(async (session) => {
        const decidedAt = new Date();
        const approved = req.body.decision === "APPROVE";
        const applicationBefore = application.toObject();
        const alertBefore = alert.toObject();
        alert.status = "RESOLVED";
        alert.cancellation_decision = approved ? "APPROVED" : "REJECTED";
        alert.cancellation_decided_by = req.user._id;
        alert.cancellation_decided_at = decidedAt;
        alert.reason_text = req.body.reason;
        await alert.save({ session });
        const openCancellationAlerts = await Alert.find({
          application_id: application._id,
          type: "CANCELLATION_PERMISSION_REQUEST",
          status: "OPEN",
        }).select("_id").session(session).lean();
        await Alert.updateMany(
          { application_id: application._id, type: "CANCELLATION_PERMISSION_REQUEST", status: "OPEN" },
          { $set: { status: "RESOLVED", cancellation_decision: approved ? "APPROVED" : "REJECTED", cancellation_decided_by: req.user._id, cancellation_decided_at: decidedAt, reason_text: req.body.reason } },
          { session },
        );
        const alertIds = new Set([alert._id.toString(), ...openCancellationAlerts.map((item) => item._id.toString())]);
        await OutboxEvent.create([...alertIds].map((alertId) => ({
          eventId: randomUUID(),
          eventType: "cancellation_request.decided",
          entityId: alertId,
          payload: {
            applicationId: String(application._id),
            alertId,
            decision: approved ? "APPROVED" : "REJECTED",
            decidedBy: String(req.user._id),
            decidedAt,
            reason: req.body.reason,
          },
          publishedAt: null,
        })), { session });
        await writeAudit({
          actor_id: req.user._id,
          action: "CANCELLATION_REQUEST_DECIDED",
          entity: "Alert",
          entity_id: alert._id,
          before_json: { status: alertBefore.status, decision: alertBefore.cancellation_decision || null },
          after_json: { status: alert.status, decision: alert.cancellation_decision },
          ip: req.ip,
        }, { session });
        if (approved) {
          const [decision] = await Decision.create([{
            application_id: application._id,
            decided_by: req.user._id,
            outcome: "CANCELLED",
            reason: req.body.reason,
          }], { session });
          application.status = "CANCELLED";
          application.current_stage = "COMPLETED";
          application.stage_entered_at = decidedAt;
          await application.save({ session });
          await StageHistory.create([{ application_id: application._id, from_stage: applicationBefore.current_stage, to_stage: "COMPLETED", actor_id: req.user._id, reason: req.body.reason }], { session });
          await OutboxEvent.create([{
            eventId: randomUUID(),
            eventType: "application.cancelled",
            entityId: String(application._id),
            payload: { applicationId: String(application._id), decisionId: String(decision._id), status: application.status, actorId: String(req.user._id), reason: req.body.reason },
            publishedAt: null,
          }], { session });
          await writeAudit({ actor_id: req.user._id, action: "APPLICATION_CANCELLED_BY_BUREAU", entity: "Application", entity_id: application._id, before_json: applicationBefore, after_json: { application: application.toObject(), decision: decision.toObject() }, ip: req.ip }, { session });
        } else {
          await StageHistory.create([{ application_id: application._id, from_stage: application.current_stage, to_stage: application.current_stage, actor_id: req.user._id, reason: `Cancellation declined: ${req.body.reason}` }], { session });
          await OutboxEvent.create([{
            eventId: randomUUID(),
            eventType: "application.cancellation_review_declined",
            entityId: String(application._id),
            payload: { applicationId: String(application._id), status: application.status, actorId: String(req.user._id), reason: req.body.reason },
            publishedAt: null,
          }], { session });
          await writeAudit({ actor_id: req.user._id, action: "APPLICATION_CANCELLATION_DECLINED", entity: "Application", entity_id: application._id, before_json: before, after_json: { status: "IN_PROGRESS", reason: req.body.reason }, ip: req.ip }, { session });
        }
      });
      const notice = `Cancellation request for ${application.application_number || application._id} was ${alert.cancellation_decision?.toLowerCase()}. ${req.body.reason}`;
      const institutionUser = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
      await queueNotice(institutionUser?._id, "CANCELLATION_REVIEW_DECIDED", "Cancellation review decided", notice, `application:${application._id}:cancellation-review:${alert._id}`, true, { application_id: application._id, caseId: application.application_number || application._id.toString() });
      return respond(res, req, { decision: alert.cancellation_decision, application_status: application.status });
    } catch (error) { return next(error); }
  });

  router.get("/leases", requireRole("INSTITUTION", "SCRUTINY_OFFICER", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"), validate(z.object({
    expiry: z.enum(["60", "30", "10", "1", "expired"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }).strict(), "query"), async (req, res, next) => {
    try {
      const filter = { lease_end: { $ne: null } };
      if (req.user.role === "INSTITUTION") {
        const ownId = await institutionIdFor(req.user);
        const appIds = await Application.find({ institution_id: ownId }).distinct("_id");
        const docIds = await Document.find({ application_id: { $in: appIds }, status: "CONFIRMED" }).distinct("_id");
        filter.document_id = { $in: docIds };
      } else if (["SCRUTINY_OFFICER", "BUREAU_OFFICER", "SENIOR_AUTHORITY"].includes(req.user.role)) {
        const appFilter = req.user.role === "SCRUTINY_OFFICER" ? { assigned_officer_id: req.user._id } : {};
        const apps = await Application.find(appFilter).distinct("_id");
        const docs = await Document.find({ application_id: { $in: apps }, status: "CONFIRMED" }).distinct("_id");
        filter.document_id = { $in: docs };
      }
      if (req.query.expiry === "expired") filter.lease_end.$lt = new Date();
      else if (req.query.expiry) {
        const limit = new Date(Date.now() + Number(req.query.expiry) * 86400000);
        filter.lease_end.$gte = new Date();
        filter.lease_end.$lte = limit;
      }
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        LeaseDetail.find(filter).sort({ lease_end: 1 }).skip((page - 1) * pageSize).limit(pageSize).populate("document_id").lean(),
        LeaseDetail.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.get("/pending-items", requireRole("INSTITUTION", "SCRUTINY_OFFICER", "ADMIN"), validate(paging, "query"), async (req, res, next) => {
    try {
      const filter = {};
      if (req.user.role === "INSTITUTION") {
        const institutionId = await institutionIdFor(req.user);
        filter.application_id = { $in: await Application.find({ institution_id: institutionId }).distinct("_id") };
      } else if (req.user.role === "SCRUTINY_OFFICER") filter.application_id = { $in: await Application.find({ assigned_officer_id: req.user._id }).distinct("_id") };
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        PendingItem.find(filter).sort({ due_date: 1 }).skip((page - 1) * pageSize).limit(pageSize).populate("application_id", "application_number institution_id").lean(),
        PendingItem.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/pending-items", requireRole("SCRUTINY_OFFICER", "ADMIN"), validate(z.object({
    application_id: id,
    description: z.string().trim().min(1).max(2000),
    due_date: z.coerce.date(),
  }).strict()), async (req, res, next) => {
    try {
      const application = await authorizedApplication(req.body.application_id, req.user);
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      const item = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "PENDING_ITEM_CREATED",
        entity: "PendingItem",
        eventType: "pending_item.created",
        mutate: async (session) => {
          const [created] = await PendingItem.create([{ ...req.body, raised_by: req.user._id }], { session });
          return created;
        },
        payload: (record) => ({
          pendingItemId: String(record._id),
          applicationId: String(record.application_id),
          dueDate: record.due_date,
          description: record.description,
        }),
      });
      const recipient = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
      if (recipient) await queueNotice(recipient._id, "PENDING_INSTITUTION_ITEM", "Institution submission requested", req.body.description, `pending:${item._id}:created`, true, { application_id: application._id, due_at: req.body.due_date, caseId: application.application_number || application._id.toString() });
      return respond(res, req, item, {}, 201);
    } catch (error) { return next(error); }
  });
  router.post("/pending-items/:id/resolve", requireRole("INSTITUTION", "ADMIN"), validId, validate(resolveSchema), async (req, res, next) => {
    try {
      const item = await PendingItem.findById(req.params.id);
      if (!item) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Pending item not found" }, meta: { requestId: req.id } });
      const application = await authorizedApplication(item.application_id, req.user);
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Pending item not found" }, meta: { requestId: req.id } });
      const updated = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "PENDING_ITEM_RESOLVED",
        entity: "PendingItem",
        eventType: "pending_item.resolved",
        mutate: async (session) => {
          const current = await PendingItem.findById(item._id).session(session);
          if (!current) return null;
          current.resolved_at = new Date();
          current.response = req.body.response;
          await current.save({ session });
          return current;
        },
        before: item.toObject(),
        payload: (record) => ({
          pendingItemId: String(record._id),
          applicationId: String(record.application_id),
          resolvedAt: record.resolved_at,
          response: req.body.response,
        }),
      });
      if (!updated) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Pending item not found" }, meta: { requestId: req.id } });
      return respond(res, req, updated);
    } catch (error) { return next(error); }
  });

  router.get("/undertakings", requireRole("INSTITUTION", "SCRUTINY_OFFICER", "BUREAU_OFFICER", "ADMIN"), validate(paging, "query"), async (req, res, next) => {
    try {
      const filter = {};
      if (req.user.role === "INSTITUTION") filter.application_id = { $in: await Application.find({ institution_id: await institutionIdFor(req.user) }).distinct("_id") };
      if (req.user.role === "SCRUTINY_OFFICER") filter.application_id = { $in: await Application.find({ assigned_officer_id: req.user._id }).distinct("_id") };
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        Undertaking.find(filter).sort({ due_date: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        Undertaking.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/undertakings", requireRole("SCRUTINY_OFFICER", "ADMIN"), validate(z.object({
    application_id: id, title: z.string().trim().min(1).max(200), due_date: z.coerce.date(),
  }).strict()), async (req, res, next) => {
    try {
      const application = await authorizedApplication(req.body.application_id, req.user);
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      const undertaking = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "UNDERTAKING_CREATED",
        entity: "Undertaking",
        eventType: "undertaking.created",
        mutate: async (session) => {
          const [created] = await Undertaking.create([{ ...req.body, status: "PENDING" }], { session });
          return created;
        },
        payload: (record) => ({
          undertakingId: String(record._id),
          applicationId: String(record.application_id),
          title: record.title,
          dueDate: record.due_date,
        }),
      });
      return respond(res, req, undertaking, {}, 201);
    } catch (error) { return next(error); }
  });
  router.post("/undertakings/:id/submit", requireRole("INSTITUTION", "ADMIN"), validId, validate(undertakingSubmit), async (req, res, next) => {
    try {
      const item = await Undertaking.findById(req.params.id);
      if (!item) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Undertaking not found" }, meta: { requestId: req.id } });
      const application = await authorizedApplication(item.application_id, req.user);
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Undertaking not found" }, meta: { requestId: req.id } });
      const updated = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "UNDERTAKING_SUBMITTED",
        entity: "Undertaking",
        eventType: "undertaking.submitted",
        mutate: async (session) => {
          const current = await Undertaking.findById(item._id).session(session);
          if (!current) return null;
          current.status = "SUBMITTED";
          current.submitted_at = new Date();
          current.file_id = req.body.file_id || current.file_id;
          await current.save({ session });
          return current;
        },
        before: item.toObject(),
        payload: (record) => ({
          undertakingId: String(record._id),
          applicationId: String(record.application_id),
          status: record.status,
          submittedAt: record.submitted_at,
        }),
      });
      if (!updated) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Undertaking not found" }, meta: { requestId: req.id } });
      return respond(res, req, updated);
    } catch (error) { return next(error); }
  });

  router.get("/yearly-reports", requireRole("INSTITUTION", "FACULTY", "ADMIN"), validate(paging, "query"), async (req, res, next) => {
    try {
      let filter = {};
      if (req.user.role === "INSTITUTION") filter.institution_id = await institutionIdFor(req.user);
      if (req.user.role === "FACULTY") {
        const faculty = await Faculty.findOne({ email: req.user.email, institution_id: req.user.institution_id, deleted_at: null }).select("_id");
        filter.faculty_id = faculty?._id || null;
      }
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        YearlyReport.find(filter).sort({ due_date: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        YearlyReport.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/yearly-reports", requireRole("INSTITUTION", "FACULTY", "ADMIN"), validate(reportCreate), async (req, res, next) => {
    try {
      const report = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "YEARLY_REPORT_SAVED",
        entity: "YearlyReport",
        eventType: "yearly_report.saved",
        mutate: (session) => createYearlyReport(req.user, req.body, session),
        payload: (record) => ({
          academicYear: record.academic_year,
          institutionId: record.institution_id ? String(record.institution_id) : null,
          facultyId: record.faculty_id ? String(record.faculty_id) : null,
          status: record.status,
        }),
      });
      if (!report) return res.status(403).json({ data: null, error: { code: "PROFILE_NOT_FOUND", message: "A matching institution or faculty profile is required" }, meta: { requestId: req.id } });
      return respond(res, req, report, {}, 201);
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "REPORT_ALREADY_SUBMITTED", message: "A submitted yearly report cannot be overwritten" }, meta: { requestId: req.id } });
      return next(error);
    }
  });
  router.post("/yearly-reports/:id/evidence", requireRole("FACULTY", "ADMIN"), validId, (req, res, next) => reportEvidenceUpload(req, res, next), async (req, res, next) => {
    let savedFile;
    try {
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPEG, or PNG file" }, meta: { requestId: req.id } });
      const mime = evidenceMime(req.file.buffer);
      if (!mime || mime !== req.file.mimetype && req.file.mimetype !== "application/octet-stream") {
        return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "File content must be PDF, JPEG, or PNG and match its MIME type" }, meta: { requestId: req.id } });
      }
      const report = await YearlyReport.findById(req.params.id).select("+evidence.storage_path");
      if (!report || !(await ownsYearlyReport(report, req.user))) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Yearly report not found" }, meta: { requestId: req.id } });
      if (!["DRAFT", "RETURNED"].includes(report.status)) return res.status(409).json({ data: null, error: { code: "REPORT_LOCKED", message: "Evidence can only be added to a draft or returned report" }, meta: { requestId: req.id } });
      if (report.evidence.length >= 10) return res.status(409).json({ data: null, error: { code: "EVIDENCE_LIMIT", message: "A yearly report can contain at most ten evidence files" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const updated = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "YEARLY_REPORT_EVIDENCE_UPLOADED",
        entity: "YearlyReport",
        eventType: "yearly_report.evidence_uploaded",
        mutate: async (session) => {
          const current = await YearlyReport.findById(report._id).select("+evidence.storage_path").session(session);
          if (!current || !(await ownsYearlyReport(current, req.user)) || !["DRAFT", "RETURNED"].includes(current.status)) return null;
          if (current.evidence.length >= 10) return null;
          current.evidence.push({
            file_name: req.file.originalname.replace(/[\\/\0]/g, "_").slice(0, 180) || "evidence",
            mime_type: mime,
            size: req.file.size,
            sha256: savedFile.sha256,
            storage_path: savedFile.filePath,
          });
          await current.save({ session });
          return current;
        },
        payload: (record) => ({ academicYear: record.academic_year, sha256: savedFile.sha256, size: req.file.size }),
      });
      if (!updated) {
        await localStorage.remove(savedFile.filePath);
        savedFile = null;
        return res.status(409).json({ data: null, error: { code: "REPORT_LOCKED_OR_EVIDENCE_LIMIT", message: "The report changed or can no longer accept evidence" }, meta: { requestId: req.id } });
      }
      savedFile = null;
      return respond(res, req, updated, {}, 201);
    } catch (error) {
      if (savedFile) await localStorage.remove(savedFile.filePath);
      return next(error);
    }
  });
  router.get("/yearly-reports/:id/evidence/:evidenceId", requireRole("FACULTY", "ADMIN"), validId, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.evidenceId)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid evidence id" }, meta: { requestId: req.id } });
      const report = await YearlyReport.findById(req.params.id).select("+evidence.storage_path");
      if (!report || !(await ownsYearlyReport(report, req.user))) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Yearly report not found" }, meta: { requestId: req.id } });
      const evidence = report.evidence.id(req.params.evidenceId);
      if (!evidence) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Evidence not found" }, meta: { requestId: req.id } });
      return res.type(evidence.mime_type).attachment(evidence.file_name).sendFile(localStorage.resolve(evidence.storage_path));
    } catch (error) { return next(error); }
  });
  router.patch("/yearly-reports/:id/submit", requireRole("INSTITUTION", "FACULTY", "ADMIN"), validId, async (req, res, next) => {
    try {
      const report = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "YEARLY_REPORT_SUBMITTED",
        entity: "YearlyReport",
        eventType: "yearly_report.submitted",
        mutate: async (session) => {
          const current = await YearlyReport.findById(req.params.id).session(session);
          if (!current || !(await ownsYearlyReport(current, req.user))) return null;
          current.status = "SUBMITTED";
          current.submitted_at = new Date();
          await current.save({ session });
          return current;
        },
        before: { status: "DRAFT_OR_RETURNED" },
        payload: (record) => ({
          academicYear: record.academic_year,
          institutionId: record.institution_id ? String(record.institution_id) : null,
          facultyId: record.faculty_id ? String(record.faculty_id) : null,
          status: record.status,
        }),
      });
      if (!report) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Yearly report not found" }, meta: { requestId: req.id } });
      return respond(res, req, report);
    } catch (error) { return next(error); }
  });

  router.get("/institution-annual-reports", requireRole("INSTITUTION", "ADMIN"), validate(paging, "query"), async (req, res, next) => {
    try {
      const filter = req.user.role === "ADMIN" ? {} : { institution_id: await institutionIdFor(req.user) };
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        InstitutionAnnualReport.find(filter).sort({ calendar_year: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        InstitutionAnnualReport.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/institution-annual-reports", requireRole("INSTITUTION"), validate(institutionReportCreate), async (req, res, next) => {
    try {
      const institutionId = await institutionIdFor(req.user);
      if (!institutionId) return res.status(403).json({ data: null, error: { code: "INSTITUTION_NOT_LINKED", message: "Link this account to an institution first" }, meta: { requestId: req.id } });
      const calendarYear = req.body.calendar_year;
      const dueDate = indiaCalendarDateEnd(calendarYear, 6, 30);
      const report = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "INSTITUTION_IC_REPORT_SAVED",
        entity: "InstitutionAnnualReport",
        eventType: "institution_ic_report.saved",
        mutate: (session) => InstitutionAnnualReport.findOneAndUpdate(
          { institution_id: institutionId, calendar_year: calendarYear, status: "DRAFT" },
          { $set: { ...req.body, institution_id: institutionId, due_date: dueDate } },
          { upsert: true, new: true, runValidators: true, session },
        ),
        payload: (record) => ({ calendar_year: record.calendar_year, status: record.status }),
      });
      return respond(res, req, report, {}, 201);
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ data: null, error: { code: "REPORT_ALREADY_SUBMITTED", message: "A report for this year has already been submitted and cannot be overwritten" }, meta: { requestId: req.id } });
      return next(error);
    }
  });
  router.patch("/institution-annual-reports/:id/submit", requireRole("INSTITUTION"), validId, async (req, res, next) => {
    try {
      const institutionId = await institutionIdFor(req.user);
      if (!institutionId) return res.status(403).json({ data: null, error: { code: "INSTITUTION_NOT_LINKED", message: "Link this account to an institution first" }, meta: { requestId: req.id } });
      const report = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "INSTITUTION_IC_REPORT_SUBMITTED",
        entity: "InstitutionAnnualReport",
        eventType: "institution_ic_report.submitted",
        mutate: async (session) => {
          const draft = await InstitutionAnnualReport.findOne({ _id: req.params.id, institution_id: institutionId, status: "DRAFT" }).session(session);
          if (!draft) return null;
          draft.status = "SUBMITTED";
          draft.submitted_at = new Date();
          await draft.save({ session });
          return draft;
        },
        before: { status: "DRAFT" },
        payload: (record) => ({ calendar_year: record.calendar_year, status: record.status }),
      });
      if (!report) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Draft institutional annual report not found" }, meta: { requestId: req.id } });
      return respond(res, req, report);
    } catch (error) { return next(error); }
  });
  router.post("/institution-annual-reports/:id/evidence", requireRole("INSTITUTION"), validId, (req, res, next) => reportEvidenceUpload(req, res, next), async (req, res, next) => {
    let savedFile;
    try {
      if (!req.file) return res.status(400).json({ data: null, error: { code: "FILE_REQUIRED", message: "Upload one PDF, JPEG, or PNG file" }, meta: { requestId: req.id } });
      const mime = evidenceMime(req.file.buffer);
      if (!mime || mime !== req.file.mimetype && req.file.mimetype !== "application/octet-stream") return res.status(415).json({ data: null, error: { code: "UNSUPPORTED_FILE", message: "Evidence must be a PDF, JPEG, or PNG matching its file contents" }, meta: { requestId: req.id } });
      const report = await InstitutionAnnualReport.findOne({ _id: req.params.id, institution_id: await institutionIdFor(req.user), status: "DRAFT" }).select("+evidence.storage_path");
      if (!report) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Draft institutional report not found" }, meta: { requestId: req.id } });
      if (report.evidence.length >= 10) return res.status(409).json({ data: null, error: { code: "EVIDENCE_LIMIT", message: "An institutional report can contain at most ten evidence files" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const updated = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "INSTITUTION_IC_REPORT_EVIDENCE_UPLOADED",
        entity: "InstitutionAnnualReport",
        eventType: "institution_ic_report.evidence_uploaded",
        mutate: async (session) => {
          report.evidence.push({ file_name: req.file.originalname.replace(/[\\/\0]/g, "_").slice(0, 180) || "evidence", mime_type: mime, size: req.file.size, sha256: savedFile.sha256, storage_path: savedFile.filePath });
          await report.save({ session });
          return report;
        },
        payload: (record) => ({ calendar_year: record.calendar_year, size: req.file.size }),
      });
      savedFile = null;
      return respond(res, req, updated, {}, 201);
    } catch (error) {
      if (savedFile) await localStorage.remove(savedFile.filePath);
      return next(error);
    }
  });
  router.get("/institution-annual-reports/:id/evidence/:evidenceId", requireRole("INSTITUTION", "ADMIN"), validId, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.evidenceId)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid evidence id" }, meta: { requestId: req.id } });
      const filter = { _id: req.params.id };
      if (req.user.role === "INSTITUTION") filter.institution_id = await institutionIdFor(req.user);
      const report = await InstitutionAnnualReport.findOne(filter).select("+evidence.storage_path");
      const evidence = report?.evidence.id(req.params.evidenceId);
      if (!evidence) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Evidence not found" }, meta: { requestId: req.id } });
      return res.type(evidence.mime_type).attachment(evidence.file_name).sendFile(localStorage.resolve(evidence.storage_path));
    } catch (error) { return next(error); }
  });

  router.get("/visits", requireRole("EVC", "SCRUTINY_OFFICER", "BUREAU_OFFICER", "ADMIN"), validate(paging, "query"), async (req, res, next) => {
    try {
      const filter = req.user.role === "EVC" ? { evc_user_id: req.user._id } : {};
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        Visit.find(filter).sort({ scheduled_at: 1 }).skip((page - 1) * pageSize).limit(pageSize).populate("application_id", "application_number current_stage").populate("evc_user_id", "name email").lean(),
        Visit.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/visits", requireRole("EVC", "ADMIN"), validate(visitCreate), async (req, res, next) => {
    try {
      if (req.user.role === "EVC" && req.body.evc_user_id !== req.user._id.toString()) {
        return res.status(403).json({ data: null, error: { code: "EVC_ASSIGNMENT_MISMATCH", message: "EVC users may schedule visits only for themselves" }, meta: { requestId: req.id } });
      }
      const application = await Application.findOne({ _id: req.body.application_id, current_stage: "EVC", status: "IN_PROGRESS", deleted_at: null });
      const evcUser = await User.findOne({
        _id: req.user.role === "EVC" ? req.user._id : req.body.evc_user_id,
        role: "EVC",
        status: "ACTIVE",
      });
      if (!application || !evcUser) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application or EVC user not found" }, meta: { requestId: req.id } });
      const existing = await Visit.findOne({ application_id: application._id, status: { $in: ["SCHEDULED", "RESCHEDULED"] } });
      if (existing) return respond(res, req, existing, { idempotent: true });
      const durationMs = 2 * 60 * 60 * 1000;
      const conflict = await Visit.findOne({
        evc_user_id: evcUser._id,
        status: { $in: ["SCHEDULED", "RESCHEDULED"] },
        scheduled_at: { $lt: new Date(req.body.scheduled_at.getTime() + durationMs), $gt: new Date(req.body.scheduled_at.getTime() - durationMs) },
      }).select("_id scheduled_at");
      if (conflict) return res.status(409).json({ data: null, error: { code: "EVC_SCHEDULE_CONFLICT", message: "This EVC member already has a visit within the two-hour inspection window" }, meta: { requestId: req.id } });
      let visit;
      try {
        visit = await recordWorkflowMutation(req, {
          actorId: req.user._id,
          action: "EVC_VISIT_SCHEDULED",
          entity: "Visit",
          eventType: "evc_visit.scheduled",
          mutate: async (session) => {
            const [created] = await Visit.create([{ ...req.body, evc_user_id: evcUser._id, active_case_key: application._id.toString() }], { session });
            return created;
          },
          payload: (record) => ({
            applicationId: String(record.application_id),
            evcUserId: String(record.evc_user_id),
            scheduledAt: record.scheduled_at,
            status: record.status,
          }),
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        const concurrentVisit = await Visit.findOne({ application_id: application._id, status: { $in: ["SCHEDULED", "RESCHEDULED"] } });
        if (!concurrentVisit) throw error;
        return respond(res, req, concurrentVisit, { idempotent: true });
      }
      const institutionUser = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
      const scheduledMessage = `EVC visit for ${application.application_number || application._id} is scheduled for ${visit.scheduled_at.toISOString()}.`;
      await Promise.all([
        queueNotice(institutionUser?._id, "EVC_VISIT_SCHEDULED", "EVC visit scheduled", scheduledMessage, `visit:${visit._id}:scheduled:institution`, true, { application_id: application._id, caseId: application.application_number || application._id.toString() }),
        queueNotice(evcUser._id, "EVC_VISIT_SCHEDULED", "EVC visit assigned", scheduledMessage, `visit:${visit._id}:scheduled:evc`, true, { application_id: application._id, caseId: application.application_number || application._id.toString() }),
      ]);
      return respond(res, req, visit, {}, 201);
    } catch (error) { return next(error); }
  });
  router.patch("/visits/:id", requireRole("EVC", "ADMIN"), validId, validate(visitPatch), async (req, res, next) => {
    try {
      const filter = req.user.role === "EVC" ? { _id: req.params.id, evc_user_id: req.user._id } : { _id: req.params.id };
      const visit = await Visit.findOne(filter);
      if (!visit) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Visit not found" }, meta: { requestId: req.id } });
      const before = visit.toObject();
      if (req.body.report_file_id) {
        const report = await Document.findOne({ _id: req.body.report_file_id, application_id: visit.application_id, status: { $ne: "SUPERSEDED" } });
        if (!report) return res.status(404).json({ data: null, error: { code: "REPORT_NOT_FOUND", message: "Visit report must belong to this application" }, meta: { requestId: req.id } });
      }
      if (req.body.status === "DONE" && !req.body.report_file_id && !visit.report_file_id) return res.status(409).json({ data: null, error: { code: "VISIT_REPORT_REQUIRED", message: "Upload the visit report before completing the visit" }, meta: { requestId: req.id } });
      Object.assign(visit, req.body);
      if (["DONE", "CANCELLED"].includes(visit.status)) visit.active_case_key = undefined;
      if (visit.status === "RESCHEDULED" && req.body.scheduled_at) {
        const durationMs = 2 * 60 * 60 * 1000;
        const conflict = await Visit.findOne({
          _id: { $ne: visit._id },
          evc_user_id: visit.evc_user_id,
          status: { $in: ["SCHEDULED", "RESCHEDULED"] },
          scheduled_at: { $lt: new Date(visit.scheduled_at.getTime() + durationMs), $gt: new Date(visit.scheduled_at.getTime() - durationMs) },
        }).select("_id");
        if (conflict) return res.status(409).json({ data: null, error: { code: "EVC_SCHEDULE_CONFLICT", message: "This EVC member already has a visit within the two-hour inspection window" }, meta: { requestId: req.id } });
      }
      const updatedVisit = await recordWorkflowMutation(req, {
        actorId: req.user._id,
        action: "EVC_VISIT_UPDATED",
        entity: "Visit",
        eventType: "evc_visit.updated",
        mutate: async (session) => {
          await visit.save({ session });
          return visit;
        },
        before,
        payload: (record) => ({
          applicationId: String(record.application_id),
          evcUserId: String(record.evc_user_id),
          scheduledAt: record.scheduled_at,
          status: record.status,
          reportFileId: record.report_file_id ? String(record.report_file_id) : null,
        }),
      });
      if (["RESCHEDULED", "CANCELLED"].includes(visit.status) || req.body.scheduled_at) {
        const application = await Application.findById(visit.application_id).select("application_number institution_id");
        const institutionUser = application && await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
        const type = visit.status === "CANCELLED" ? "EVC_VISIT_CANCELLED" : "EVC_VISIT_RESCHEDULED";
        const message = visit.status === "CANCELLED"
          ? `EVC visit for ${application?.application_number || application?._id} was cancelled.`
          : `EVC visit for ${application?.application_number || application?._id} is now scheduled for ${visit.scheduled_at.toISOString()}.`;
        await Promise.all([
          queueNotice(institutionUser?._id, type, "EVC visit updated", message, `visit:${visit._id}:${type}:${visit.updatedAt?.toISOString() || Date.now()}:institution`, true, { application_id: visit.application_id }),
          queueNotice(visit.evc_user_id, type, "EVC visit updated", message, `visit:${visit._id}:${type}:${visit.updatedAt?.toISOString() || Date.now()}:evc`, true, { application_id: visit.application_id }),
        ]);
      }
      return respond(res, req, updatedVisit);
    } catch (error) { return next(error); }
  });

  router.post("/decisions", requireRole("BUREAU_OFFICER"), validate(decisionSchema), async (req, res, next) => {
    try {
      const application = await Application.findOne({ _id: req.body.application_id, current_stage: "DECISION", status: "IN_PROGRESS", deleted_at: null });
      if (!application) return res.status(409).json({ data: null, error: { code: "INVALID_DECISION_STAGE", message: "Application is not awaiting a decision" }, meta: { requestId: req.id } });
      const decision = await withTransaction(async (session) => {
        const before = application.toObject();
        const [created] = await Decision.create([{ ...req.body, decided_by: req.user._id }], { session });
        application.status = req.body.outcome === "APPROVED" ? "APPROVED" : req.body.outcome === "CANCELLED" ? "CANCELLED" : req.body.outcome === "REJECTED" ? "REJECTED" : "RETURNED";
        application.current_stage = req.body.outcome === "RETURNED" ? "SCRUTINY" : "COMPLETED";
        application.stage_entered_at = new Date();
        await application.save({ session });
        await StageHistory.create([{ application_id: application._id, from_stage: before.current_stage, to_stage: application.current_stage, actor_id: req.user._id, reason: req.body.reason }], { session });
        await OutboxEvent.create([{
          eventId: randomUUID(),
          eventType: "application.decision_recorded",
          entityId: String(application._id),
          payload: {
            applicationId: String(application._id),
            decisionId: String(created._id),
            outcome: created.outcome,
            status: application.status,
            currentStage: application.current_stage,
            actorId: String(req.user._id),
            reason: req.body.reason,
          },
          publishedAt: null,
        }], { session });
        await writeAudit({ actor_id: req.user._id, action: "APPLICATION_DECIDED", entity: "Application", entity_id: application._id, before_json: before, after_json: { application: application.toObject(), decision: created.toObject() }, ip: req.ip }, { session });
        await Alert.create([{ application_id: application._id, type: "FINAL_DECISION", severity: "INFO", target_user_id: (await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id").session(session))?._id || req.user._id, title: `Application ${req.body.outcome.toLowerCase()}`, body: req.body.reason }], { session });
        return created;
      });
      const recipient = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
      if (recipient) await queueNotice(
        recipient._id,
        "FINAL_DECISION",
        `Application ${req.body.outcome.toLowerCase()}`,
        `Application ${application.application_number || application._id} was ${req.body.outcome.toLowerCase()}. ${req.body.reason}`,
        `application:${application._id}:decision:${decision._id}`,
        true,
        { application_id: application._id, caseId: application.application_number || application._id.toString() },
      );
      return respond(res, req, decision, {}, 201);
    } catch (error) {
      if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Application changed concurrently; reload and retry" }, meta: { requestId: req.id } });
      return next(error);
    }
  });
  return router;
}

async function createYearlyReport(user, body, session) {
  if (user.role === "INSTITUTION") {
    const institutionId = await institutionIdFor(user);
    if (!institutionId) return null;
    return YearlyReport.findOneAndUpdate(
      { institution_id: institutionId, academic_year: body.academic_year, status: { $in: ["DRAFT", "RETURNED", "OVERDUE"] } },
      { $set: { ...body, status: "DRAFT" }, $setOnInsert: { institution_id: institutionId } },
      { upsert: true, new: true, runValidators: true, session },
    );
  }
  if (user.role === "FACULTY") {
    const faculty = await Faculty.findOne({ email: user.email, institution_id: user.institution_id, deleted_at: null });
    if (!faculty) return null;
    return YearlyReport.findOneAndUpdate(
      { faculty_id: faculty._id, academic_year: body.academic_year, status: { $in: ["DRAFT", "RETURNED", "OVERDUE"] } },
      { $set: { ...body, status: "DRAFT" }, $setOnInsert: { faculty_id: faculty._id, institution_id: faculty.institution_id } },
      { upsert: true, new: true, runValidators: true, session },
    );
  }
  const [created] = await YearlyReport.create([{ ...body, institution_id: user.institution_id }], { session });
  return created;
}

async function ownsYearlyReport(report, user) {
  if (user.role === "ADMIN") return true;
  if (user.role === "INSTITUTION") return report.institution_id?.toString() === (await institutionIdFor(user))?.toString();
  if (user.role === "FACULTY") {
    const faculty = await Faculty.findOne({ email: user.email, institution_id: user.institution_id, deleted_at: null }).select("_id");
    return Boolean(faculty && report.faculty_id?.toString() === faculty._id.toString());
  }
  return false;
}
