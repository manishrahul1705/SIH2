import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { ROLES } from "../../../config/constants.js";
import { authenticate, requireRole } from "../../../middleware/auth.js";
import { validate } from "../../../middleware/validate.js";
import { ApplicationIncident } from "../../../models/index.js";
import { NotificationService } from "../../notifications/service.js";
import { logger } from "../../../config/logger.js";
import { withTransaction, writeAudit } from "../../../middleware/audit.js";
import {
  IncidentError,
  loadApplicationIncidentDetail,
  listIncidentApplications,
  persistIncidentAction,
  resolveIncidentRecipient,
  sourceSnapshot,
  validateIncidentQuery,
} from "./service.js";
import { Application, CaseRecord, Institution, User } from "../../../models/index.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const listQuerySchema = z.object({
  tab: z.enum(["pending", "completed"]).default("pending"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional().default(""),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  type: z.string().trim().min(1).max(80).optional(),
  stage: z.string().trim().min(1).max(100).optional(),
  ownerId: objectId.optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
}).strict();
const detailParamsSchema = z.object({
  workflowType: z.enum(["LEGACY_APPLICATION", "CASE_RECORD"]),
  applicationId: objectId,
}).strict();
const incidentParamsSchema = z.object({ incidentId: objectId }).strict();
export const manualReportSchema = z.object({
  workflowType: z.enum(["LEGACY_APPLICATION", "CASE_RECORD"]),
  requestId: z.string().uuid().optional(),
  applicationId: z.string().trim().min(1).max(200),
  type: z.string().trim().min(2).max(80),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  description: z.string().trim().min(10).max(3000),
  detectionSource: z.literal("ADMIN_REPORTED").default("ADMIN_REPORTED"),
  stageName: z.string().trim().max(200).optional(),
  responsibleUserId: objectId.optional(),
  sourceDetails: z.string().trim().max(1000).optional(),
  evidence: z.string().trim().max(4000).optional(),
}).strict();
export const actionSchema = z.object({
  action: z.enum(["REVIEW", "NOTE", "REQUEST_CLARIFICATION", "ESCALATE", "CORRECTIVE_ACTION", "RESOLVE", "CLOSE", "REOPEN"]),
  requestId: z.string().uuid().optional(),
  note: z.string().trim().max(3000).optional(),
  reason: z.string().trim().max(3000).optional(),
  resolutionSummary: z.string().trim().max(3000).optional(),
  rootCause: z.string().trim().max(3000).optional(),
  resolutionEvidence: z.string().trim().max(4000).optional(),
  verificationResult: z.string().trim().max(3000).optional(),
  remainingLimitations: z.string().trim().max(3000).optional(),
  targetUserId: objectId.optional(),
  targetRole: z.enum(ROLES).optional(),
  result: z.string().trim().max(3000).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "NOTE" && !value.note) context.addIssue({ code: "custom", path: ["note"], message: "A note is required" });
  if (value.action === "REQUEST_CLARIFICATION" && !value.note) context.addIssue({ code: "custom", path: ["note"], message: "A clarification request is required" });
  if (value.action === "ESCALATE" && !(value.reason || value.note)) context.addIssue({ code: "custom", path: ["reason"], message: "An escalation reason is required" });
  if (value.action === "CORRECTIVE_ACTION" && !(value.result || value.note)) context.addIssue({ code: "custom", path: ["result"], message: "Record the corrective action or its result" });
  if (value.action === "RESOLVE" && (!value.resolutionSummary || value.resolutionSummary.trim().length < 10)) {
    context.addIssue({ code: "custom", path: ["resolutionSummary"], message: "Provide a meaningful resolution summary (at least 10 characters)" });
  }
  if (value.action === "CLOSE" && (!value.note || value.note.trim().length < 10)) {
    context.addIssue({ code: "custom", path: ["note"], message: "Provide a closure summary (at least 10 characters)" });
  }
  if (value.action === "REOPEN" && (!value.reason || value.reason.trim().length < 10)) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Provide a meaningful reopen reason (at least 10 characters)" });
  }
});

function send(res, req, data, status = 200) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id } });
}

function sendError(res, req, error) {
  const status = error instanceof IncidentError ? error.status : 500;
  const code = error instanceof IncidentError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof IncidentError ? error.message : "Unable to process the incident request";
  if (status === 500) logger.error({ err: error, requestId: req.id }, "Admin incident request failed");
  return res.status(status).json({ data: null, error: { code, message }, meta: { requestId: req.id } });
}

function loadSource(workflowType, applicationId) {
  return workflowType === "LEGACY_APPLICATION"
    ? Application.findOne({ _id: applicationId, deleted_at: null }).lean()
    : CaseRecord.findOne({ _id: applicationId, deletedAt: null }).lean();
}

async function findManualSource(workflowType, applicationId) {
  const isObjectId = /^[a-f\d]{24}$/i.test(applicationId);
  if (isObjectId) return loadSource(workflowType, applicationId);
  return workflowType === "LEGACY_APPLICATION"
    ? Application.findOne({ application_number: applicationId, deleted_at: null }).lean()
    : CaseRecord.findOne({ caseNo: applicationId, deletedAt: null }).lean();
}

async function incidentSourceContext(incident) {
  const workflowType = incident.workflowType;
  const applicationId = String(workflowType === "LEGACY_APPLICATION" ? incident.applicationId : incident.caseRecordId);
  const sourceRecord = await loadSource(workflowType, applicationId);
  if (!sourceRecord) throw new IncidentError(404, "APPLICATION_NOT_FOUND", "Incident source application not found");
  const source = sourceSnapshot(workflowType, sourceRecord);
  const [institution, officer] = await Promise.all([
    source.institutionId ? Institution.findById(source.institutionId).select("name region").lean() : null,
    source.responsibleOfficerId ? User.findById(source.responsibleOfficerId).select("_id name role").lean() : null,
  ]);
  source.region = institution?.region || source.region || "";
  return { source, sourceRecord, institution, officer };
}

export function adminIncidentsRouter() {
  const router = express.Router();
  const adminOnly = [authenticate, requireRole("ADMIN")];

  router.get("/", adminOnly, validate(listQuerySchema, "query"), async (req, res) => {
    try {
      const query = validateIncidentQuery(req.query);
      return send(res, req, await listIncidentApplications(query));
    } catch (error) { return sendError(res, req, error); }
  });

  router.post("/", adminOnly, validate(manualReportSchema), async (req, res) => {
    try {
      const { workflowType, applicationId, type, severity, description } = req.body;
      const sourceRecord = await findManualSource(workflowType, applicationId);
      if (!sourceRecord) throw new IncidentError(404, "APPLICATION_NOT_FOUND", "Application not found");
      const snapshot = sourceSnapshot(workflowType, sourceRecord);
      const canonicalApplicationId = String(sourceRecord._id);
      const dedupeKey = req.body.requestId
        ? `${workflowType}:${canonicalApplicationId}:manual:${String(req.user._id)}:${req.body.requestId}`
        : undefined;
      if (dedupeKey) {
        const duplicate = await ApplicationIncident.findOne({ dedupeKey }).lean();
        if (duplicate) return send(res, req, {
          id: String(duplicate._id),
          workflowType,
          applicationId: canonicalApplicationId,
          source: duplicate.source,
          detectionSource: duplicate.detectionSource,
          type: duplicate.type,
          severity: duplicate.severity,
          status: duplicate.status,
          duplicate: true,
        });
      }
      let responsibleUser = null;
      if (req.body.responsibleUserId) {
        responsibleUser = await User.findOne({ _id: req.body.responsibleUserId, status: "ACTIVE", deleted_at: null }).select("_id name role").lean();
        if (!responsibleUser) throw new IncidentError(404, "RESPONSIBLE_USER_NOT_FOUND", "The selected responsible user is not active");
      } else if (snapshot.responsibleOfficerId) {
        responsibleUser = await User.findById(snapshot.responsibleOfficerId).select("_id name role").lean();
      }
      const institution = snapshot.institutionId
        ? await Institution.findById(snapshot.institutionId).select("name").lean()
        : null;
      const stageName = req.body.stageName || snapshot.currentStage || "";
      const incident = await withTransaction(async (session) => {
        const [created] = await ApplicationIncident.create([{
          workflowType,
          ...(workflowType === "LEGACY_APPLICATION" ? { applicationId: canonicalApplicationId } : { caseRecordId: canonicalApplicationId }),
          ...(dedupeKey ? { dedupeKey } : {}),
          source: "MANUAL",
          detectionSource: req.body.detectionSource,
          sourceDetails: req.body.sourceDetails || "",
          evidence: req.body.evidence || "",
          type,
          severity,
          status: "OPEN",
          stageKey: snapshot.stageKey || snapshot.currentStage || "",
          stageName,
          responsibleOfficerId: responsibleUser?._id || null,
          responsibleOfficerName: responsibleUser?.name || "",
          responsibleOfficerRole: responsibleUser?.role || snapshot.responsibleOfficerRole || null,
          summary: description.slice(0, 1000),
          details: description,
          detectedAt: new Date(),
          events: [{
            eventId: randomUUID(),
            action: "MANUAL_REPORT",
            actorUserId: req.user._id,
            timestamp: new Date(),
            note: description,
          }],
        }], session ? { session } : {});
        await writeAudit({
          actor_id: req.user._id,
          action: "INCIDENT_MANUALLY_REPORTED",
          entity: "ApplicationIncident",
          entity_id: created._id,
          after_json: {
            workflowType,
            applicationId: canonicalApplicationId,
            type: created.type,
            severity: created.severity,
            source: "MANUAL",
            stageName,
            responsibleUserId: responsibleUser ? String(responsibleUser._id) : null,
            evidenceProvided: Boolean(created.evidence),
          },
          ip: req.ip,
        }, session ? { session } : {});
        return created;
      });
      return send(res, req, {
        id: String(incident._id),
        workflowType,
        applicationId: canonicalApplicationId,
        source: incident.source,
        detectionSource: incident.detectionSource,
        type: incident.type,
        severity: incident.severity,
        status: incident.status,
        stageName,
        institutionName: institution?.name || "",
        responsibleOfficer: responsibleUser ? { id: String(responsibleUser._id), name: responsibleUser.name, role: responsibleUser.role } : null,
        duplicate: false,
      }, 201);
    } catch (error) { return sendError(res, req, error); }
  });

  router.get("/:workflowType/:applicationId", adminOnly, validate(detailParamsSchema, "params"), async (req, res) => {
    try {
      return send(res, req, await loadApplicationIncidentDetail(req.params.workflowType, req.params.applicationId));
    } catch (error) { return sendError(res, req, error); }
  });

  router.post("/:incidentId/actions", adminOnly, validate(incidentParamsSchema, "params"), validate(actionSchema), async (req, res) => {
    try {
      const incident = await ApplicationIncident.findById(req.params.incidentId).lean();
      if (!incident) throw new IncidentError(404, "INCIDENT_NOT_FOUND", "Incident not found");
      let recipient = null;
      let context = null;
      if (["REQUEST_CLARIFICATION", "ESCALATE", "CORRECTIVE_ACTION", "RESOLVE", "CLOSE"].includes(req.body.action)) {
        context = await incidentSourceContext(incident);
        const resolved = await resolveIncidentRecipient({ action: req.body.action, body: req.body, source: context.source, incident });
        recipient = resolved.recipient || null;
      }
      const saved = await persistIncidentAction({
        incidentId: req.params.incidentId,
        body: req.body,
        actor: req.user,
        ip: req.ip,
        recipient,
      });
      let notification = null;
      if (recipient) {
        const workflowType = saved.incident.workflowType;
        const applicationId = String(workflowType === "LEGACY_APPLICATION" ? saved.incident.applicationId : saved.incident.caseRecordId);
        const notificationTitle = {
          ESCALATE: "Application incident escalated",
          REQUEST_CLARIFICATION: "Clarification requested for an application incident",
          CORRECTIVE_ACTION: "Corrective action recorded for an application incident",
          RESOLVE: "Application incident resolved",
          CLOSE: "Application incident closed",
        };
        const title = notificationTitle[req.body.action];
        const message = req.body.note || req.body.reason || req.body.resolutionSummary || req.body.result || saved.incident.summary;
        try {
          await NotificationService.enqueue({
            userId: recipient._id,
            type: `APPLICATION_INCIDENT_${req.body.action}`,
            channel: "IN_APP",
            payload: {
              title,
              body: `${context.institution?.name || "Application"} — ${context.source.applicationNumber} — ${saved.incident.stageName || context.source.currentStage}: ${message}`,
              application_id: workflowType === "LEGACY_APPLICATION" ? applicationId : null,
              case_id: workflowType === "CASE_RECORD" ? applicationId : null,
              incident_id: String(saved.incident._id),
              workflow_type: workflowType,
              stage: saved.incident.stageName || context.source.currentStage,
            },
            dedupeKey: `admin-incident:${String(saved.incident._id)}:${saved.event.eventId}`,
          });
          notification = { status: "QUEUED", recipient: { id: String(recipient._id), name: recipient.name, role: recipient.role } };
        } catch (error) {
          logger.error({ err: error, incidentId: String(saved.incident._id) }, "Unable to queue incident notification");
          notification = { status: "FAILED", recipient: { id: String(recipient._id), name: recipient.name, role: recipient.role } };
        }
      }
      return send(res, req, {
        incident: {
          id: String(saved.incident._id),
          workflowType: saved.incident.workflowType,
          applicationId: String(saved.incident.workflowType === "LEGACY_APPLICATION" ? saved.incident.applicationId : saved.incident.caseRecordId),
          status: saved.incident.status,
          events: saved.incident.events,
        },
        notification,
        duplicate: saved.duplicate,
      });
    } catch (error) { return sendError(res, req, error); }
  });
  return router;
}
