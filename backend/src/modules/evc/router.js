import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { AiExtraction, CaseFinding, CaseRecord, CaseStageHistory, Document, Institution, OutboxEvent, User } from "../../models/index.js";
import { NotificationService } from "../notifications/service.js";
import { sendEvcRejectionEmailChain, sendEvcScheduledEmail } from "./emailService.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const modeSchema = z.enum(["PHYSICAL", "VIRTUAL", "HYBRID"]);
const rejectionCategories = [
  "Critical Infrastructure Deficiency",
  "Land/Lease Title Dispute",
  "Safety Violation / Expired NOC",
  "Non-Compliance with APH Norms",
  "Fraudulent Documentation",
];
const tabSchema = z.enum(["waiting_inspection", "waiting_approval", "completed_approval"]).default("waiting_inspection");
const scheduleSchema = z.object({
  expectedVersion: z.number().int().min(0),
  scheduled_inspection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inspection_mode: modeSchema,
  instructions: z.string().trim().max(3000).default(""),
}).strict();
const rejectSchema = z.object({
  expectedVersion: z.number().int().min(0),
  rejection_category: z.enum(rejectionCategories),
  rejection_reason: z.string().trim().min(30).max(3000),
  confirmed: z.literal(true),
}).strict();
const approveSchema = z.object({
  expectedVersion: z.number().int().min(0),
  remarks: z.string().trim().max(3000).default(""),
}).strict();

function respond(res, req, data, status = 200) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id } });
}

function deny(res, req, code, message, status = 403) {
  return res.status(status).json({ data: null, error: { code, message }, meta: { requestId: req.id } });
}

function tomorrowUtcStart(now = new Date()) {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow;
}

export function isEvcInspectionDateAllowed(value, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    && date >= tomorrowUtcStart(now);
}

export function isEvcScheduleEditable(stage) {
  return ["ACTIVE", "INSPECTION_SCHEDULED"].includes(stage?.status)
    && !stage?.inspectionReportDocumentId;
}

function activeStageQuery(user) {
  return {
    workflowVersion: "SIH26262-1.0",
    status: "in_progress",
    deletedAt: null,
    allocatedStages: {
      $elemMatch: {
        assignedRole: "EVC",
        $or: [{ assignedUserId: user._id }, { assignedPanelUserIds: user._id }],
        status: { $in: ["ACTIVE", "INSPECTION_SCHEDULED", "WAITING_FOR_APPROVAL"] },
      },
    },
  };
}

async function evcCase(caseId, user) {
  if (!mongoose.isValidObjectId(caseId)) return null;
  const record = await CaseRecord.findOne({
    _id: caseId,
    ...activeStageQuery(user),
  }).populate("institutionId", "name contact_email region");
  if (!record) return null;
  const stage = record.allocatedStages?.[record.currentStageIndex];
  const isAssigned = stage?.assignedUserId?.equals(user._id)
    || stage?.assignedPanelUserIds?.some((id) => id.equals(user._id));
  if (!stage || stage.assignedRole !== "EVC" || !isAssigned) return null;
  return { record, stage };
}

function notificationBody(message) {
  return { title: message.subject, subject: message.subject, body: message.body, application_id: message.caseId, security: true };
}

async function enqueueStageAssigned(stage, record) {
  if (!stage.assignedUserId) return { queued: 0, failedCount: 0 };
  const recipient = await User.findById(stage.assignedUserId).select("email").lean();
  if (!recipient?.email) return { queued: 0, failedCount: 1 };
  const results = await Promise.allSettled(["IN_APP", "EMAIL"].map((channel) => NotificationService.enqueue({
    userId: stage.assignedUserId,
    type: "APPLICATION_STAGE_ASSIGNED",
    channel,
    ...(channel === "EMAIL" ? { recipientEmail: recipient.email } : {}),
    payload: notificationBody({
      subject: "Application assigned to your stage",
      body: `${record.caseNo} is ready for ${stage.name}.`,
      caseId: record._id,
    }),
    dedupeKey: `stage-assigned:${record._id}:${stage.key}:${channel.toLowerCase()}`,
  })));
  const failedCount = results.filter(({ status }) => status === "rejected").length;
  if (failedCount) logger.error({ caseId: String(record._id), failedCount }, "EVC approval was saved but next-stage notifications could not all be queued");
  return { queued: results.length - failedCount, failedCount };
}

export function evcRouter() {
  const router = express.Router();
  router.use(authenticate, requireRole("EVC", "EVC_CHAIRMAN"));

  router.get("/cases", async (req, res, next) => {
    try {
      const parsed = z.object({ tab: tabSchema }).strict().safeParse(req.query);
      if (!parsed.success) return deny(res, req, "INVALID_TAB", "Choose a supported EVC work tab", 400);
      const completed = parsed.data.tab === "completed_approval";
      const statuses = completed
        ? ["APPROVED"]
        : parsed.data.tab === "waiting_inspection"
          ? ["ACTIVE", "INSPECTION_SCHEDULED"]
          : ["WAITING_FOR_APPROVAL"];
      const filter = {
        workflowVersion: "SIH26262-1.0",
        status: completed ? { $in: ["in_progress", "approved", "rejected", "returned"] } : "in_progress",
        deletedAt: null,
        allocatedStages: {
          $elemMatch: {
            assignedRole: "EVC",
            $or: [{ assignedUserId: req.user._id }, { assignedPanelUserIds: req.user._id }],
            status: { $in: statuses },
          },
        },
      };
      const records = await CaseRecord.find(filter).populate("institutionId", "name region")
        .sort({ updatedAt: -1 }).lean();
      const cases = records.flatMap((record) => {
        const stage = completed
          ? record.allocatedStages?.find((item) => item.assignedRole === "EVC"
            && statuses.includes(item.status)
            && (item.assignedUserId?.equals(req.user._id) || item.assignedPanelUserIds?.some((id) => id.equals(req.user._id))))
          : record.allocatedStages?.[record.currentStageIndex];
        if (!stage || stage.assignedRole !== "EVC" || !statuses.includes(stage.status)) return [];
        return [{
          _id: record._id,
          caseNo: record.caseNo,
          institution: record.institutionId?.name || "Institution",
          applicationType: record.applicationType,
          region: record.region || record.institutionId?.region || "",
          assignedAt: stage.stageStartedAt || record.stageEnteredAt,
          stageDueAt: stage.stageDueAt,
          approvedAt: stage.approvedAt,
          inspectionStatus: stage.status === "ACTIVE" ? "UNSCHEDULED"
            : stage.status === "INSPECTION_SCHEDULED" ? "SCHEDULED"
              : stage.status === "WAITING_FOR_APPROVAL" ? "REPORT_UPLOADED" : "APPROVED",
          scheduled_inspection_date: stage.scheduled_inspection_date,
          inspection_mode: stage.inspection_mode,
          version: record.version,
          stageName: stage.name,
        }];
      });
      return respond(res, req, cases);
    } catch (error) { return next(error); }
  });

  router.get("/cases/:id", async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return deny(res, req, "INVALID_ID", "Invalid case id", 400);
      const result = await evcCase(parsed.data.id, req.user);
      if (!result) return deny(res, req, "NOT_FOUND", "Case is not assigned to your current EVC stage", 404);
      const { record, stage } = result;
      const documents = await Document.find({
        case_id: record._id,
        deleted_at: null,
        status: { $ne: "SUPERSEDED" },
      }).select("_id original_name doc_type_slot doc_type_final status version verification verification_reason verified_by verified_at confirmed_at mime")
        .sort({ createdAt: 1, _id: 1 }).lean();
      const documentIds = documents.map(({ _id }) => _id);
      const [extractions, findings, previousStageHistory, assignedPanel] = await Promise.all([
        AiExtraction.find({ document_id: { $in: documentIds } })
          .select("document_id m1_type m1_confidence m1_zone m2_json m3_json fields.field_name fields.ai_value fields.ai_confidence fields.zone fields.confirmed_value fields.confirmed_source fields.confirmed_at fields.confirmed_by")
          .sort({ createdAt: -1 }).lean(),
        CaseFinding.find({ caseId: record._id }).sort({ createdAt: -1 }).lean(),
        CaseStageHistory.find({ caseId: record._id, fromStage: { $ne: record.currentStage } }).sort({ enteredAt: 1 }).lean(),
        User.find({
          _id: { $in: stage.assignedPanelUserIds?.length ? stage.assignedPanelUserIds : [stage.assignedUserId].filter(Boolean) },
          deleted_at: null,
        }).select("name email").sort({ role: 1, createdAt: 1 }).lean(),
      ]);
      const latestExtraction = new Map();
      for (const extraction of extractions) {
        if (!latestExtraction.has(String(extraction.document_id))) latestExtraction.set(String(extraction.document_id), extraction);
      }
      return respond(res, req, {
        case: record,
        stage,
        institution: record.institutionId,
        panelists: assignedPanel,
        documents: documents.map((document) => ({
          ...document,
          extraction: latestExtraction.get(String(document._id)) || null,
          downloadUrl: `/api/v1/documents/${document._id}/download`,
        })),
        complianceChecklist: (stage.requiredDocuments || []).map((name) => ({
          name,
          uploaded: documents.some((document) => document.doc_type_final === name || document.doc_type_slot === name),
        })),
        findings,
        previousStageHistory,
      });
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/schedule-inspection", async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = scheduleSchema.safeParse(req.body);
      if (!parsed.success) return deny(res, req, "INVALID_ID", "Invalid case id", 400);
      if (!body.success) return deny(res, req, "VALIDATION_ERROR", "A date, inspection mode, and expected version are required", 422);
      if (!isEvcInspectionDateAllowed(body.data.scheduled_inspection_date)) {
        return deny(res, req, "INSPECTION_DATE_TOO_SOON", "Choose an inspection date starting tomorrow or later", 422);
      }
      const result = await evcCase(parsed.data.id, req.user);
      if (!result) return deny(res, req, "NOT_FOUND", "Case is not assigned to your current EVC stage", 404);
      const { record, stage } = result;
      if (record.version !== body.data.expectedVersion) return deny(res, req, "VERSION_CONFLICT", "Case changed; reload and retry", 409);
      const isReschedule = stage.status === "INSPECTION_SCHEDULED";
      if (!isEvcScheduleEditable(stage)) {
        return deny(res, req, "INSPECTION_NOT_EDITABLE", "The inspection schedule can only be changed before the inspection report is uploaded", 409);
      }
      const institution = record.institutionId;
      const panelists = await User.find({
        _id: { $in: stage.assignedPanelUserIds?.length ? stage.assignedPanelUserIds : [stage.assignedUserId].filter(Boolean) },
        status: "ACTIVE",
        deleted_at: null,
      }).select("_id name email").sort({ role: 1, createdAt: 1 }).lean();
      const previousStage = record.currentStage;
      const scheduledDate = new Date(`${body.data.scheduled_inspection_date}T00:00:00.000Z`);
      stage.status = "INSPECTION_SCHEDULED";
      stage.scheduled_inspection_date = scheduledDate;
      stage.inspection_mode = body.data.inspection_mode;
      stage.inspection_instructions = body.data.instructions;
      stage.history.push({
        action: isReschedule ? "INSPECTION_RESCHEDULED" : "INSPECTION_SCHEDULED",
        performed_by: req.user._id,
        notes: body.data.instructions,
      });
      record.version += 1;
      await withTransaction(async (session) => {
        await record.save(session ? { session } : {});
        await CaseStageHistory.create([{
          caseId: record._id,
          fromStage: previousStage,
          toStage: previousStage,
          holderType: "committee",
          holderId: req.user._id,
          actorId: req.user._id,
          enteredAt: new Date(),
          reason: `${isReschedule ? "Inspection rescheduled" : "Inspection scheduled"} for ${body.data.scheduled_inspection_date}`,
        }], session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: isReschedule ? "EVC_INSPECTION_RESCHEDULED" : "EVC_INSPECTION_SCHEDULED",
          entity: "CaseRecord",
          entity_id: record._id,
          after_json: { scheduled_inspection_date: scheduledDate, inspection_mode: stage.inspection_mode, instructions: stage.inspection_instructions, version: record.version },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: isReschedule ? "case.evc_inspection_rescheduled" : "case.evc_inspection_scheduled",
          entityId: String(record._id),
          payload: { caseNo: record.caseNo, currentStage: record.currentStage, scheduled_inspection_date: scheduledDate },
        }], session ? { session } : {});
      });
      const notificationResult = await sendEvcScheduledEmail({
        institution,
        application: record,
        date: body.data.scheduled_inspection_date,
        mode: stage.inspection_mode,
        instructions: stage.inspection_instructions,
        panelists,
      });
      return respond(res, req, { case: record, notificationResult });
    } catch (error) {
      if (error instanceof mongoose.Error.VersionError) return deny(res, req, "VERSION_CONFLICT", "Case changed concurrently; reload and retry", 409);
      return next(error);
    }
  });

  router.post("/cases/:id/reject", async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = rejectSchema.safeParse(req.body);
      if (!parsed.success) return deny(res, req, "INVALID_ID", "Invalid case id", 400);
      if (!body.success) return deny(res, req, "REJECTION_DETAILS_REQUIRED", "Select a category, enter at least 30 characters of remarks, and confirm notification", 422);
      const result = await evcCase(parsed.data.id, req.user);
      if (!result) return deny(res, req, "NOT_FOUND", "Case is not assigned to your current EVC stage", 404);
      const { record, stage } = result;
      if (record.version !== body.data.expectedVersion) return deny(res, req, "VERSION_CONFLICT", "Case changed; reload and retry", 409);
      if (!["ACTIVE", "INSPECTION_SCHEDULED", "WAITING_FOR_APPROVAL"].includes(stage.status)) {
        return deny(res, req, "INVALID_STAGE_STATUS", "This case cannot be rejected from its current EVC state", 409);
      }
      const institution = record.institutionId;
      const previousStageOfficers = await previousHandlers(record, req.user._id);
      const now = new Date();
      stage.status = "REJECTED";
      stage.rejection_category = body.data.rejection_category;
      stage.rejection_reason = body.data.rejection_reason;
      stage.rejected_by = req.user._id;
      stage.rejected_at = now;
      stage.remarks = body.data.rejection_reason;
      stage.history.push({
        action: "REJECTED",
        performed_by: req.user._id,
        timestamp: now,
        notes: `${body.data.rejection_category}: ${body.data.rejection_reason}`,
      });
      record.status = "rejected";
      record.overallStatus = "EVC_REJECTED";
      record.returnReason = body.data.rejection_reason;
      record.version += 1;
      await withTransaction(async (session) => {
        await record.save(session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "EVC_APPLICATION_REJECTED",
          entity: "CaseRecord",
          entity_id: record._id,
          after_json: {
            rejection_category: body.data.rejection_category,
            rejection_reason: body.data.rejection_reason,
            previousStageHandlers: previousStageOfficers.map(({ _id, stageName }) => ({ userId: _id, stageName })),
            rejectedAt: now,
            version: record.version,
          },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "case.evc_rejected",
          entityId: String(record._id),
          payload: { caseNo: record.caseNo, currentStage: record.currentStage, actorId: String(req.user._id) },
        }], session ? { session } : {});
      });
      const notificationResult = await sendEvcRejectionEmailChain({
        institution,
        application: record,
        previousStageOfficers,
        rejectionCategory: body.data.rejection_category,
        reason: body.data.rejection_reason,
        rejectedBy: req.user,
      });
      return respond(res, req, {
        case: record,
        notificationResult,
        notificationsQueued: notificationResult.queued,
      });
    } catch (error) {
      if (error instanceof mongoose.Error.VersionError) return deny(res, req, "VERSION_CONFLICT", "Case changed concurrently; reload and retry", 409);
      return next(error);
    }
  });

  router.post("/cases/:id/approve", async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = approveSchema.safeParse(req.body);
      if (!parsed.success) return deny(res, req, "INVALID_ID", "Invalid case id", 400);
      if (!body.success) return deny(res, req, "VALIDATION_ERROR", "A valid expected version and remarks are required", 422);
      const result = await evcCase(parsed.data.id, req.user);
      if (!result) return deny(res, req, "NOT_FOUND", "Case is not assigned to your current EVC stage", 404);
      const { record, stage } = result;
      if (record.version !== body.data.expectedVersion) return deny(res, req, "VERSION_CONFLICT", "Case changed; reload and retry", 409);
      if (stage.status !== "WAITING_FOR_APPROVAL" || !stage.inspectionReportDocumentId) {
        return deny(res, req, "INSPECTION_REPORT_REQUIRED", "Upload the completed EVC inspection report before sign-off", 409);
      }
      const now = new Date();
      const priorStage = record.currentStage;
      stage.status = "APPROVED";
      stage.remarks = body.data.remarks;
      stage.approvedAt = now;
      stage.elapsedMs += stage.stageStartedAt ? Math.max(0, now.getTime() - new Date(stage.stageStartedAt).getTime()) : 0;
      stage.history.push({ action: "APPROVED", performed_by: req.user._id, timestamp: now, notes: body.data.remarks });
      record.completedStages = [...new Set([...(record.completedStages || []), stage.routeKey])];
      const nextIndex = record.currentStageIndex + 1;
      const next = record.allocatedStages[nextIndex];
      if (!next) return deny(res, req, "NO_NEXT_STAGE", "No next stage exists after EVC", 409);
      next.status = "ACTIVE";
      next.stageStartedAt = now;
      next.stageDueAt = new Date(now.getTime() + next.slaDays * 24 * 60 * 60 * 1000);
      next.activeClockHolder = next.assignedUserId;
      record.currentStageIndex = nextIndex;
      record.currentStage = next.routeKey;
      record.holderType = ["EVC", "SAC_SHC"].includes(next.assignedRole) ? "committee" : "officer";
      record.holderId = next.assignedUserId;
      record.stageEnteredAt = now;
      record.status = "in_progress";
      record.overallStatus = "IN_PROGRESS";
      record.version += 1;
      await withTransaction(async (session) => {
        await record.save(session ? { session } : {});
        await CaseStageHistory.create([{
          caseId: record._id,
          fromStage: priorStage,
          toStage: record.currentStage,
          holderType: record.holderType,
          holderId: record.holderId,
          actorId: req.user._id,
          enteredAt: now,
          reason: body.data.remarks || `Approved ${stage.name}.`,
        }], session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "EVC_STAGE_APPROVED",
          entity: "CaseRecord",
          entity_id: record._id,
          after_json: { stage: stage.key, nextStage: next.key, inspectionReportDocumentId: stage.inspectionReportDocumentId, remarks: body.data.remarks, version: record.version },
          ip: req.ip,
        }, { session });
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "case.stage_approved",
          entityId: String(record._id),
          payload: { caseNo: record.caseNo, currentStage: record.currentStage, actorId: String(req.user._id) },
        }], session ? { session } : {});
      });
      const notificationResult = await enqueueStageAssigned(next, record);
      return respond(res, req, { case: record, notificationResult });
    } catch (error) {
      if (error instanceof mongoose.Error.VersionError) return deny(res, req, "VERSION_CONFLICT", "Case changed concurrently; reload and retry", 409);
      return next(error);
    }
  });

  return router;
}

async function previousHandlers(record, evcUserId) {
  const handlers = new Map();
  for (const stage of (record.allocatedStages || []).slice(0, record.currentStageIndex)) {
    const userIds = new Set([
      ...(stage.assignedUserId ? [String(stage.assignedUserId)] : []),
      ...(stage.assignedPanelUserIds || []).map(String),
      ...(stage.history || []).map(({ performed_by }) => String(performed_by || "")).filter(Boolean),
    ]);
    for (const userId of userIds) {
      if (userId === String(evcUserId)) continue;
      const entry = handlers.get(userId) || { _id: userId, stageNames: new Set() };
      entry.stageNames.add(stage.name);
      handlers.set(userId, entry);
    }
  }
  const ids = [...handlers.keys()];
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids }, deleted_at: null }).select("_id name email").lean();
  return users.map((user) => ({
    ...user,
    stageName: [...(handlers.get(String(user._id))?.stageNames || [])].join(", "),
  }));
}
