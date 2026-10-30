import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { AiExtraction, CaseDecision, CaseFinding, CaseObligation, CaseRecord, CaseStageHistory, CaseTask, Document, Institution, OutboxEvent, Policy, ProcessingRun, User } from "../../models/index.js";
import { APPLICATION_TYPES, buildChecklist, missingChecklistItems, normalizeApplicability } from "../../engine/checklist.js";
import { buildCaseRoute, returnTargetIsEarlier } from "../../engine/routes.js";
import { dueStatus } from "../../engine/timeRules.js";
import { DEFAULT_PIPELINE_SETTINGS } from "../../engine/policyDefaults.js";
import { allocateStagesForApplication, APPLICATION_TYPE_LABELS } from "../../engine/stageAllocationRules.js";
import { evaluateCasePipeline, scheduleCaseEvaluation } from "./pipeline.js";
import { logger } from "../../config/logger.js";
import { NotificationService } from "../notifications/service.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const applicabilitySchema = z.object({
  landIsLeased: z.boolean().optional(),
  newAreaAdded: z.boolean().optional(),
  buildingOver30: z.boolean().optional(),
  buildingAgeYears: z.number().min(0).max(500).optional(),
  claimsAccreditation: z.boolean().optional(),
  landChanged: z.boolean().optional(),
  premisesShared: z.boolean().optional(),
  premisesUsed: z.boolean().optional(),
  affiliatingBodyRequired: z.boolean().optional(),
}).strict().transform(normalizeApplicability);
const createCaseSchema = z.object({
  applicationType: z.enum(APPLICATION_TYPES),
  applicability: applicabilitySchema.default({}),
  routeFlags: z.object({
    evcRandomOrRequired: z.boolean().optional(),
    hearingRequired: z.boolean().optional(),
    appealRequired: z.boolean().optional(),
  }).strict().default({}),
  institutionId: objectId.optional(),
}).strict();
const updateCaseSchema = z.object({
  applicability: applicabilitySchema.optional(),
  routeFlags: createCaseSchema.shape.routeFlags.optional(),
  expectedVersion: z.number().int().min(0),
}).strict();
const submitSchema = z.object({ expectedVersion: z.number().int().min(0) }).strict();
const advanceSchema = z.object({
  expectedVersion: z.number().int().min(0),
  completedChecklist: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
}).strict();
const pipelineEvaluateSchema = z.object({
  intent: z.enum(["CHANGE", "STAGE_COMPLETE", "EVC_REPORT"]).default("CHANGE"),
  completedChecklist: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  expectedVersion: z.number().int().min(0),
  apply: z.boolean().default(false),
}).strict();
const returnSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(1).max(3000),
  targetStage: z.string().trim().min(1).max(60),
}).strict();
const decisionSchema = z.object({
  expectedVersion: z.number().int().min(0),
  outcome: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(3000),
  conditions: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    dueAt: z.coerce.date().optional(),
  }).strict()).max(50).default([]),
}).strict();
const assistRoles = ["INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER"];
const requestAssistSchema = z.object({
  expectedVersion: z.number().int().min(0),
  targetRole: z.enum(assistRoles),
  assignedToUserId: objectId.optional(),
  note: z.string().trim().min(1).max(3000),
  assistSlaDays: z.number().int().min(1).max(30).default(3),
}).strict();
const decideAssistSchema = z.object({
  expectedVersion: z.number().int().min(0),
  outcome: z.enum(["ASSIST_APPROVED", "ASSIST_REJECTED"]),
  remarks: z.string().trim().max(3000).default(""),
}).strict().refine((value) => value.outcome !== "ASSIST_REJECTED" || value.remarks.length > 0, {
  path: ["remarks"],
  message: "A rejection reason is required",
});
const approveStageSchema = z.object({
  expectedVersion: z.number().int().min(0),
  remarks: z.string().trim().max(3000).default(""),
  conditions: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    dueAt: z.coerce.date().optional(),
  }).strict()).max(50).default([]),
}).strict();
const rejectStageSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(1).max(3000),
}).strict();
const evidenceSchema = z.object({
  evidenceNote: z.string().trim().min(1).max(3000),
}).strict();
const verifyObligationSchema = z.object({
  verification: z.enum(["verified", "not_verified"]),
  reason: z.string().trim().max(3000).optional().default(""),
}).strict().refine((value) => value.verification === "verified" || value.reason.length > 0, {
  path: ["reason"],
  message: "A reason is required when evidence is not verified",
});
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["draft", "submitted", "in_progress", "returned", "approved", "rejected"]).optional(),
  applicationType: z.enum(APPLICATION_TYPES).optional(),
}).strict();
const previewSchema = z.object({
  applicationType: z.enum(APPLICATION_TYPES),
  applicability: applicabilitySchema.default({}),
  routeFlags: createCaseSchema.shape.routeFlags.default({}),
}).strict();
const policyRoutesSchema = z.record(
  z.enum(APPLICATION_TYPES),
  z.array(z.enum(["submitted", "self_disclosure", "scrutiny", "re_scrutiny", "regional_committee", "evc", "shc", "sac", "decision"])),
);
const policyChecklistSchema = z.array(z.object({
  slotId: z.string().trim().min(1).max(100),
  kind: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  requirements: z.record(z.enum(APPLICATION_TYPES), z.enum(["R", "C", "-"])),
  conditions: z.record(z.enum(APPLICATION_TYPES), z.string().nullable()).optional(),
  tracked: z.boolean(),
  hasValidity: z.boolean(),
  acceptedFileTypes: z.array(z.enum(["application/pdf", "image/jpeg", "image/png"])).min(1),
  minLeaseTermYears: z.number().positive().nullable().optional(),
  helpText: z.string().max(1000).optional(),
}).strict()).min(1).max(100);
const pipelineSettingsSchema = z.object({
  maxFileMB: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(1000),
  aiTimeoutMs: z.number().int().min(100).max(120000),
  greenThreshold: z.number().min(0).max(1),
  amberThreshold: z.number().min(0).max(1),
  heuristicConfidenceCap: z.number().min(0).max(1),
  expiringSoonDays: z.number().int().min(0).max(3650),
  leaseExpiringSoonDays: z.number().int().min(0).max(3650),
  endToleranceDays: z.number().int().min(0).max(365),
  blockSubmitOnMissing: z.boolean(),
  blockAdvanceOnOpenHighFindings: z.boolean(),
  prioritiseNewInstitutions: z.boolean(),
  minLeaseTermYears: z.number().min(0).max(100).nullable(),
  holderAssignment: z.enum(["least_open_cases", "unassigned"]),
}).strict();

function respond(res, req, data, status = 200, extra = {}) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id, ...extra } });
}

async function deny(req, res, { status = 403, code = "FORBIDDEN", message, entityId = "unknown", action = "CASE_ACCESS_DENIED" }) {
  await writeAudit({
    actor_id: req.user?._id || null,
    action,
    entity: "CaseRecord",
    entity_id: String(entityId),
    outcome: "denied",
    after_json: { outcome: "denied", role: req.user?.role || "anonymous", reason: code },
    ip: req.ip,
  });
  return res.status(status).json({ data: null, error: { code, message }, meta: { requestId: req.id } });
}

async function activePolicy() {
  return Policy.findOne({ status: "signed_off" }).sort({ signedOffAt: -1 }).lean();
}

async function institutionIdFor(user) {
  if (user.institution_id) return user.institution_id;
  return (await Institution.findOne({ contact_email: user.email, deleted_at: null }).select("_id"))?._id || null;
}

export async function caseFilterForUser(user) {
  const filter = { deletedAt: null };
  if (user.role !== "INSTITUTION") filter.$and = [{ status: { $ne: "draft" } }];
  if (user.role === "ADMIN") return filter;
  if (user.role === "INSTITUTION") {
    const institutionId = await institutionIdFor(user);
    return institutionId ? { ...filter, institutionId } : null;
  }
  if (user.role === "SCRUTINY_OFFICER") {
    return { ...filter, $or: [{ region: user.region }, { holderId: user._id }] };
  }
  if (["EVC", "EVC_CHAIRMAN"].includes(user.role)) {
    return {
      ...filter,
      $or: [
        { holderId: user._id },
        { allocatedStages: { $elemMatch: { assignedRole: "EVC", assignedPanelUserIds: user._id } } },
      ],
    };
  }
  if (user.role === "SAC_SHC") return { ...filter, holderId: user._id };
  if (["BUREAU_OFFICER", "SENIOR_AUTHORITY"].includes(user.role)) {
    return user.region ? { ...filter, region: user.region } : filter;
  }
  return null;
}

export function caseActionQueueFilter(user) {
  const activeStageStatuses = ["ACTIVE", "ACTIVE_UNFROZEN", "FROZEN_WAITING_FOR_ASSIST", "INSPECTION_SCHEDULED", "WAITING_FOR_APPROVAL"];
  const assignedRole = user.role === "EVC_CHAIRMAN" ? "EVC" : user.role;
  const assignedStage = {
    status: { $in: activeStageStatuses },
    ...(user.role === "ADMIN"
      ? {
        assignedRole: "ADMIN",
        $or: [{ assignedUserId: user._id }, { assignedUserId: null }],
      }
      : assignedRole === "EVC"
        ? { assignedRole, $or: [{ assignedUserId: user._id }, { assignedPanelUserIds: user._id }] }
        : { assignedRole, assignedUserId: user._id }),
  };
  return {
    $or: [
      {
        workflowVersion: { $ne: "SIH26262-1.0" },
        status: { $nin: ["approved", "rejected", "returned"] },
      },
      {
        workflowVersion: "SIH26262-1.0",
        status: "in_progress",
        $or: [
          { allocatedStages: { $elemMatch: assignedStage } },
          {
            allocatedStages: {
              $elemMatch: {
                assistRequests: {
                  $elemMatch: {
                    assignedToUserId: user._id,
                    status: "PENDING_ASSIST_DECISION",
                  },
                },
              },
            },
          },
        ],
      },
    ],
  };
}

export async function scopedCase(caseId, user) {
  if (!mongoose.isValidObjectId(caseId)) return null;
  const record = await CaseRecord.findOne({ _id: caseId, deletedAt: null });
  if (!record) return null;
  if (record.status === "draft" && user.role !== "INSTITUTION") return null;
  if (user.role === "ADMIN") return record;
  if ((record.allocatedStages || []).some((stage) => (stage.assistRequests || []).some((request) =>
    request.status === "PENDING_ASSIST_DECISION" && request.assignedToUserId?.equals(user._id)))) return record;
  if (user.role === "INSTITUTION") {
    const institutionId = await institutionIdFor(user);
    return institutionId && institutionId.equals(record.institutionId) ? record : null;
  }
  if (user.role === "SCRUTINY_OFFICER") {
    return record.region === user.region || record.holderId?.equals(user._id) ? record : null;
  }
  if (["EVC", "EVC_CHAIRMAN"].includes(user.role)) {
    const stage = currentAllocatedStage(record);
    return record.holderId?.equals(user._id)
      || stage?.assignedRole === "EVC" && stage.assignedPanelUserIds?.some((id) => id.equals(user._id))
      ? record : null;
  }
  if (user.role === "SAC_SHC") return record.holderId?.equals(user._id) ? record : null;
  if (["BUREAU_OFFICER", "SENIOR_AUTHORITY"].includes(user.role)) {
    return !user.region || user.region === record.region ? record : null;
  }
  return null;
}

function buildPolicyRoutes(routes = {}) {
  return Object.fromEntries(APPLICATION_TYPES.map((type) => [type, buildCaseRoute(type, routes)]));
}

function checklistFor(record, policy) {
  return buildChecklist(record.applicationType, record.applicability, record.slotRecords, policy.checklist);
}

function stageHolderType(role) {
  return ["EVC", "SAC_SHC"].includes(role) ? "committee" : "officer";
}

function isStageOwner(stage, user, record) {
  if (!stage || stage.assignedRole !== user.role && !(stage.assignedRole === "EVC" && user.role === "EVC_CHAIRMAN")) return false;
  if (stage.assignedUserId?.equals(user._id)) return true;
  if (stage.assignedRole === "EVC" && stage.assignedPanelUserIds?.some((id) => id.equals(user._id))) return true;
  if (stage.assignedUserId) return false;
  return user.role === "ADMIN" || !user.region || user.region === record.region;
}

function currentAllocatedStage(record) {
  return record.allocatedStages?.[record.currentStageIndex] || null;
}

async function assignStages(record, now) {
  const stages = allocateStagesForApplication(record.applicationType);
  for (const [index, stage] of stages.entries()) {
    const filter = { role: stage.assignedRole, status: "ACTIVE", deleted_at: null };
    if (stage.assignedRole === "INSTITUTION") filter.institution_id = record.institutionId;
    else if (stage.assignedRole !== "ADMIN") filter.region = record.region;
    let panel = [];
    if (stage.assignedRole === "EVC") {
      panel = await User.find({ ...filter, role: { $in: ["EVC", "EVC_CHAIRMAN"] } }).sort({ role: 1, createdAt: 1 }).select("_id role").lean();
    }
    let assignee = panel[0] || await User.findOne(filter).sort({ createdAt: 1 }).select("_id").lean();
    if (stage.assignedRole === "EVC") {
      assignee = panel.find(({ role }) => role === "EVC") || panel[0] || null;
      stage.assignedPanelUserIds = panel.map(({ _id }) => _id);
    }
    stage.assignedUserId = assignee?._id || null;
    if (index === 0) {
      stage.status = "ACTIVE";
      stage.stageStartedAt = now;
      stage.stageDueAt = new Date(now.getTime() + stage.slaDays * 24 * 60 * 60 * 1000);
      stage.activeClockHolder = stage.assignedUserId;
    }
  }
  return stages;
}

function holderIsUser(record, user) {
  if (record.holderType === "institution" && user.role === "INSTITUTION") {
    return institutionIdFor(user).then((institutionId) => Boolean(institutionId && institutionId.equals(record.institutionId)));
  }
  return record.holderId?.equals(user._id) || false;
}

async function createOutbox(session, eventType, record, actorId) {
  await OutboxEvent.create([{
    eventId: crypto.randomUUID(),
    eventType,
    entityId: record._id.toString(),
    payload: { caseNo: record.caseNo, currentStage: record.currentStage, actorId: actorId.toString() },
  }], session ? { session } : {});
}

async function recordStageChange(session, record, previousStage, actorId, reason = "") {
  let openStageQuery = CaseStageHistory.findOne({ caseId: record._id, leftAt: null }).sort({ enteredAt: -1 });
  if (session) openStageQuery = openStageQuery.session(session);
  const openStage = await openStageQuery;
  if (openStage) {
    openStage.leftAt = record.stageEnteredAt;
    await openStage.save(session ? { session } : {});
  }
  await CaseStageHistory.create([{
    caseId: record._id,
    fromStage: previousStage,
    toStage: record.currentStage,
    holderType: record.holderType,
    holderId: record.holderId,
    actorId,
    enteredAt: record.stageEnteredAt,
    reason,
  }], session ? { session } : {});
}

async function queueStageNotice({ userId, type, subject, body, key, applicationId, severity = "INFO", link = "", recipientEmail }) {
  if (!userId) return;
  try {
    await Promise.all(["IN_APP", "EMAIL"].map((channel) => NotificationService.enqueue({
      userId,
      type,
      channel,
      ...(channel === "EMAIL" && recipientEmail ? { recipientEmail } : {}),
      payload: { title: subject, subject, body, application_id: applicationId, severity, link },
      dedupeKey: `${key}:${channel.toLowerCase()}`,
    })));
  } catch (error) {
    logger.error({ userId: String(userId), type, code: error.code || "STAGE_NOTIFICATION_FAILED" }, "Stage workflow changed but a notification could not be queued");
  }
}

export function casesRouter() {
  const router = express.Router();

  router.get("/application-types", (_req, res) => respond(res, _req, APPLICATION_TYPES.map((id) => ({ id, label: APPLICATION_TYPE_LABELS[id] }))));
  router.post("/checklist/preview", authenticate, validate(previewSchema), async (req, res, next) => {
    try {
      const policy = await activePolicy();
      if (!policy) return res.status(503).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "No signed-off policy is configured" }, meta: { requestId: req.id } });
      return respond(res, req, {
        policyVersion: policy.version,
        route: allocateStagesForApplication(req.body.applicationType).map(({ routeKey }) => routeKey),
        allocatedStages: allocateStagesForApplication(req.body.applicationType),
        checklist: buildChecklist(req.body.applicationType, req.body.applicability, [], policy.checklist),
      });
    } catch (error) { return next(error); }
  });

  router.get("/policies", authenticate, async (req, res, next) => {
    try {
      if (req.user.role !== "ADMIN") return deny(req, res, { message: "Only administrators can view policy versions", entityId: "policy", action: "POLICY_ACCESS_DENIED" });
      return respond(res, req, await Policy.find().sort({ createdAt: -1 }).lean());
    } catch (error) { return next(error); }
  });

  router.post("/policies", authenticate, async (req, res, next) => {
    try {
      if (req.user.role !== "ADMIN") return deny(req, res, { message: "Only administrators can create policy drafts", entityId: "policy", action: "POLICY_CREATE_DENIED" });
      const schema = z.object({
        version: z.string().trim().min(1).max(40),
        routes: policyRoutesSchema.optional().default({}),
        checklist: policyChecklistSchema.optional(),
        stageCompletion: z.record(z.string(), z.array(z.string())).optional().default({}),
        alertRules: z.record(z.string(), z.unknown()).optional().default({}),
        scoreWeights: z.record(z.string(), z.unknown()).optional().default({}),
        blockSubmitOnMissing: z.boolean().optional().default(false),
        pipelineSettings: pipelineSettingsSchema.partial().optional().default({}),
        notes: z.string().max(4000).optional().default(""),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, meta: { requestId: req.id } });
      const routes = buildPolicyRoutes(parsed.data.routes);
      const pipelineSettings = { ...DEFAULT_PIPELINE_SETTINGS, ...parsed.data.pipelineSettings };
      pipelineSettings.blockSubmitOnMissing = parsed.data.pipelineSettings.blockSubmitOnMissing ?? parsed.data.blockSubmitOnMissing;
      if (pipelineSettings.amberThreshold > pipelineSettings.greenThreshold) {
        return res.status(400).json({ data: null, error: { code: "INVALID_PIPELINE_THRESHOLDS", message: "The amber threshold cannot exceed the green threshold" }, meta: { requestId: req.id } });
      }
      const active = await activePolicy();
      const policy = await withTransaction(async (session) => {
        const [created] = await Policy.create([{
          ...parsed.data,
          routes,
          pipelineSettings,
          blockSubmitOnMissing: pipelineSettings.blockSubmitOnMissing,
          checklist: parsed.data.checklist || active?.checklist || [],
          status: "draft",
        }], session ? { session } : {});
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "policy.draft_created",
          entityId: String(created._id),
          payload: { version: created.version, actorId: String(req.user._id) },
          publishedAt: null,
        }], session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "POLICY_DRAFT_CREATED", entity: "Policy", entity_id: created._id, after_json: { version: created.version }, ip: req.ip }, { session });
        return created;
      });
      return respond(res, req, policy, 201);
    } catch (error) { return next(error); }
  });

  router.post("/policies/:id/sign-off", authenticate, async (req, res, next) => {
    try {
      if (req.user.role !== "ADMIN") return deny(req, res, { message: "Only administrators can sign off policy", entityId: req.params.id, action: "POLICY_SIGN_OFF_DENIED" });
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid policy id" }, meta: { requestId: req.id } });
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().safeParse(req.body);
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "A sign-off reason is required" }, meta: { requestId: req.id } });
      const policy = await Policy.findOne({ _id: parsed.data.id, status: "draft" });
      if (!policy) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Draft policy not found" }, meta: { requestId: req.id } });
      const signedOffAt = new Date();
      const signedOffPolicy = await withTransaction(async (session) => {
        let currentPolicyQuery = Policy.findOne({ _id: parsed.data.id, status: "draft" });
        if (session) currentPolicyQuery = currentPolicyQuery.session(session);
        const currentPolicy = await currentPolicyQuery;
        if (!currentPolicy) throw Object.assign(new Error("Draft policy changed before sign-off"), { code: "POLICY_SIGNOFF_CONFLICT", status: 409 });
        let activePoliciesQuery = Policy.find({ status: "signed_off" });
        if (session) activePoliciesQuery = activePoliciesQuery.session(session);
        const activePolicies = await activePoliciesQuery;
        for (const activePolicyRecord of activePolicies) {
          const previousStatus = activePolicyRecord.status;
          activePolicyRecord.status = "retired";
          await activePolicyRecord.save(session ? { session } : {});
          await OutboxEvent.create([{
            eventId: crypto.randomUUID(),
            eventType: "policy.retired",
            entityId: String(activePolicyRecord._id),
            payload: { version: activePolicyRecord.version, previousStatus, actorId: String(req.user._id) },
            publishedAt: null,
          }], session ? { session } : {});
          await writeAudit({ actor_id: req.user._id, action: "POLICY_RETIRED", entity: "Policy", entity_id: activePolicyRecord._id, before_json: { status: previousStatus }, after_json: { status: "retired" }, ip: req.ip }, { session });
        }
        currentPolicy.status = "signed_off";
        currentPolicy.signedOffBy = req.user._id;
        currentPolicy.signedOffAt = signedOffAt;
        await currentPolicy.save(session ? { session } : {});
        await OutboxEvent.create([{
          eventId: crypto.randomUUID(),
          eventType: "policy.signed_off",
          entityId: String(currentPolicy._id),
          payload: { version: currentPolicy.version, reason: body.data.reason, actorId: String(req.user._id), signedOffAt },
          publishedAt: null,
        }], session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "POLICY_SIGNED_OFF", entity: "Policy", entity_id: currentPolicy._id, after_json: { version: currentPolicy.version, reason: body.data.reason }, ip: req.ip }, { session });
        return currentPolicy;
      });
      return respond(res, req, signedOffPolicy);
    } catch (error) {
      if (error?.code === "POLICY_SIGNOFF_CONFLICT") return res.status(409).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.get("/policies/:a/diff/:b", authenticate, async (req, res, next) => {
    try {
      if (req.user.role !== "ADMIN") return deny(req, res, { message: "Only administrators can compare policy versions", entityId: req.params.a, action: "POLICY_DIFF_DENIED" });
      const [left, right] = await Promise.all([Policy.findOne({ version: req.params.a }).lean(), Policy.findOne({ version: req.params.b }).lean()]);
      if (!left || !right) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "One or both policy versions were not found" }, meta: { requestId: req.id } });
      return respond(res, req, {
        from: left.version,
        to: right.version,
        routesChanged: JSON.stringify(left.routes) !== JSON.stringify(right.routes),
        checklistChanged: JSON.stringify(left.checklist) !== JSON.stringify(right.checklist),
        blockSubmitOnMissingChanged: left.blockSubmitOnMissing !== right.blockSubmitOnMissing,
        pipelineSettingsChanged: JSON.stringify(left.pipelineSettings || {}) !== JSON.stringify(right.pipelineSettings || {}),
      });
    } catch (error) { return next(error); }
  });

  router.get("/cases", authenticate, validate(listSchema, "query"), async (req, res, next) => {
    try {
      const filter = await caseFilterForUser(req.user);
      if (!filter) return deny(req, res, { message: "This role cannot view workflow cases", entityId: "case-list" });
      if (req.user.role === "INSTITUTION" && !filter.institutionId) {
        return respond(res, req, [], 200, { total: 0, page: req.query.page, pageSize: req.query.pageSize });
      }
      const conditions = filter.$and || [];
      delete filter.$and;
      if (req.user.role === "INSTITUTION") {
        conditions.push({ status: { $nin: ["approved", "rejected"] } });
      } else {
        conditions.push(caseActionQueueFilter(req.user));
      }
      if (req.query.status) conditions.push({ status: req.query.status });
      if (conditions.length) filter.$and = conditions;
      if (req.query.applicationType) filter.applicationType = req.query.applicationType;
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        CaseRecord.find(filter).populate("institutionId", "name").sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        CaseRecord.countDocuments(filter),
      ]);
      return respond(res, req, items, 200, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.post(["/cases", "/applications"], authenticate, async (req, res, next) => {
    try {
      if (req.path === "/applications" && !Object.hasOwn(req.body || {}, "applicationType")) return next();
      const parsed = createCaseSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, meta: { requestId: req.id } });
      if (!["INSTITUTION", "ADMIN"].includes(req.user.role)) return deny(req, res, { message: "Only an institution may create its application", entityId: "new-case", action: "CASE_CREATE_DENIED" });
      const institutionId = req.user.role === "INSTITUTION" ? await institutionIdFor(req.user) : parsed.data.institutionId;
      if (!institutionId) return res.status(422).json({ data: null, error: { code: "INSTITUTION_REQUIRED", message: "The account must be linked to an institution" }, meta: { requestId: req.id } });
      if (req.user.role === "ADMIN" && !await Institution.exists({ _id: institutionId, deleted_at: null })) return res.status(404).json({ data: null, error: { code: "INSTITUTION_NOT_FOUND", message: "Institution not found" }, meta: { requestId: req.id } });
      const [institution, policy] = await Promise.all([
        Institution.findById(institutionId).select("region").lean(),
        activePolicy(),
      ]);
      if (!policy) return res.status(503).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "No signed-off policy is configured" }, meta: { requestId: req.id } });
      const caseNo = `AT-${new Date().getUTCFullYear()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      let record;
      await withTransaction(async (session) => {
        [record] = await CaseRecord.create([{
          caseNo,
          institutionId,
          region: institution?.region || req.user.region || "",
          applicationType: parsed.data.applicationType,
          applicability: parsed.data.applicability,
          routeFlags: parsed.data.routeFlags,
          policyVersion: policy.version,
          route: allocateStagesForApplication(parsed.data.applicationType).map(({ routeKey }) => routeKey),
          allocatedStages: allocateStagesForApplication(parsed.data.applicationType),
          workflowVersion: "SIH26262-1.0",
          overallStatus: "DRAFT",
          currentStage: "submitted",
          holderType: "institution",
          status: "draft",
        }], session ? { session } : {});
        await CaseStageHistory.create([{
          caseId: record._id,
          toStage: "submitted",
          holderType: "institution",
          actorId: req.user._id,
          enteredAt: record.stageEnteredAt,
        }], session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "CASE_DRAFT_CREATED", entity: "CaseRecord", entity_id: record._id, after_json: { caseNo, applicationType: record.applicationType, policyVersion: record.policyVersion }, ip: req.ip }, { session });
        await createOutbox(session, "case.created", record, req.user._id);
      });
      return respond(res, req, record, 201);
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/submit", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = submitSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "expectedVersion is required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (req.user.role !== "INSTITUTION" || record.status !== "draft") return deny(req, res, { status: 403, message: "Only the owning institution may submit its draft", entityId: record._id, action: "CASE_SUBMIT_DENIED" });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const policy = await Policy.findOne({ version: record.policyVersion }).lean();
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      if (!await holderIsUser(record, req.user)) return deny(req, res, { message: "Only the owning institution may submit this draft", entityId: record._id, action: "CASE_SUBMIT_DENIED" });
      const checklist = checklistFor(record, policy);
      const missing = missingChecklistItems(checklist);
      if ((policy.pipelineSettings?.blockSubmitOnMissing ?? policy.blockSubmitOnMissing) && missing.length) return res.status(422).json({ data: null, error: { code: "MISSING_DOCUMENTS", message: "Required documents are missing", details: missing.map(({ slotId, label }) => ({ slotId, label })) }, meta: { requestId: req.id } });
      const evaluated = await evaluateCasePipeline({
        caseId: record._id,
        intent: "SUBMIT",
        expectedVersion: body.data.expectedVersion,
        apply: true,
        actorId: req.user._id,
      });
      const submittedCase = await CaseRecord.findById(evaluated.case._id);
      if (!submittedCase) throw Object.assign(new Error("Submitted application could not be reloaded"), { code: "CASE_NOT_FOUND" });
      const now = new Date();
      const previousStage = submittedCase.currentStage;
      const allocatedStages = await assignStages(submittedCase, now);
      submittedCase.allocatedStages = allocatedStages;
      submittedCase.workflowVersion = "SIH26262-1.0";
      submittedCase.currentStageIndex = 0;
      submittedCase.route = allocatedStages.map(({ routeKey }) => routeKey);
      submittedCase.currentStage = allocatedStages[0].routeKey;
      submittedCase.holderType = stageHolderType(allocatedStages[0].assignedRole);
      submittedCase.holderId = allocatedStages[0].assignedUserId;
      submittedCase.stageEnteredAt = now;
      submittedCase.status = "in_progress";
      submittedCase.overallStatus = "IN_PROGRESS";
      submittedCase.version += 1;
      await withTransaction(async (session) => {
        await submittedCase.save(session ? { session } : {});
        await recordStageChange(session, submittedCase, previousStage, req.user._id, "Deterministic stage allocation activated on submission.");
        await writeAudit({ actor_id: req.user._id, action: "CASE_STAGE_WORKFLOW_ACTIVATED", entity: "CaseRecord", entity_id: submittedCase._id, after_json: { workflowVersion: submittedCase.workflowVersion, stages: allocatedStages.map(({ key, slaDays }) => ({ key, slaDays })), version: submittedCase.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.stage_workflow_activated", submittedCase, req.user._id);
      });
      const firstStage = allocatedStages[0];
      await queueStageNotice({
        userId: firstStage.assignedUserId,
        type: "APPLICATION_STAGE_ASSIGNED",
        subject: "Application assigned to your stage",
        body: `${submittedCase.caseNo} is ready for ${firstStage.name}.`,
        key: `stage-assigned:${submittedCase._id}:${firstStage.key}`,
        applicationId: submittedCase._id,
        link: `/case/${submittedCase._id}`,
      });
      const submittedChecklist = checklistFor(submittedCase, policy);
      return respond(res, req, {
        case: submittedCase,
        checklist: submittedChecklist,
        missingDocuments: missing.map(({ slotId, label }) => ({ slotId, label })),
        warning: missing.length > 0 ? "Missing documents are present; submission was accepted." : null,
        pipeline: { findings: evaluated.findings, explain: evaluated.explain, planHash: evaluated.planHash },
      }, 200);
    } catch (error) {
      if (["CASE_VERSION_CONFLICT", "CASE_NOT_FOUND", "POLICY_UNAVAILABLE", "INVALID_PIPELINE_INTENT"].includes(error?.code)) {
        const status = error.code === "CASE_VERSION_CONFLICT" ? 409 : error.code === "CASE_NOT_FOUND" ? 404 : 422;
        return res.status(status).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      }
      return next(error);
    }
  });

  router.put("/cases/:id", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = updateCaseSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Draft fields and expectedVersion are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (req.user.role !== "INSTITUTION" || record.status !== "draft") return deny(req, res, { message: "Only the owning institution may edit a draft", entityId: record._id, action: "CASE_EDIT_DENIED" });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const policy = await Policy.findOne({ version: record.policyVersion }).lean();
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      if (body.data.applicability) record.applicability = body.data.applicability;
      if (body.data.routeFlags) record.routeFlags = body.data.routeFlags;
      const before = record.toObject();
      record.allocatedStages = allocateStagesForApplication(record.applicationType);
      record.workflowVersion = "SIH26262-1.0";
      record.route = record.allocatedStages.map(({ routeKey }) => routeKey);
      await withTransaction(async (session) => {
        record.version += 1;
        await record.save(session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "CASE_DRAFT_UPDATED", entity: "CaseRecord", entity_id: record._id, before_json: { applicability: before.applicability, routeFlags: before.routeFlags }, after_json: { version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.draft_updated", record, req.user._id);
      });
      scheduleCaseEvaluation({ caseId: record._id, intent: "CHANGE", actorId: req.user._id });
      return respond(res, req, record);
    } catch (error) {
      if (error?.code === "CASE_VERSION_CONFLICT") return res.status(409).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.get("/cases/:id/checklist", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      const policy = await Policy.findOne({ version: record.policyVersion }).lean();
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      const checklist = checklistFor(record, policy);
      const missing = missingChecklistItems(checklist);
      return respond(res, req, {
        policyVersion: record.policyVersion,
        blockSubmitOnMissing: policy.pipelineSettings?.blockSubmitOnMissing ?? policy.blockSubmitOnMissing,
        checklist,
        missingDocuments: missing.map(({ slotId, label }) => ({ slotId, label })),
      });
    } catch (error) { return next(error); }
  });

  router.get("/cases/:id/findings", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      const findings = await CaseFinding.find({ caseId: record._id }).sort({ createdAt: -1 }).lean();
      return respond(res, req, findings);
    } catch (error) { return next(error); }
  });

  router.get("/cases/:id/processing", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      const documents = await Document.find({ case_id: record._id, deleted_at: null, status: { $ne: "SUPERSEDED" } })
        .select("_id original_name doc_type_slot doc_type_final status version quarantine_reason verification")
        .sort({ createdAt: 1, _id: 1 })
        .lean();
      const documentIds = documents.map((document) => document._id);
      const [extractions, tasks, findings, processingRuns] = await Promise.all([
        AiExtraction.find({ document_id: { $in: documentIds } })
          .select("document_id m1_type m1_confidence m1_zone overall_zone model_versions processing_error_code rule_results_json fields.field_name fields.ai_value fields.ai_confidence fields.zone fields.model fields.model_version fields.ambiguous fields.prefill fields.source_page fields.source_bbox fields.confirmed_value fields.confirmed_source fields.confirmed_at")
          .sort({ createdAt: -1 })
          .lean(),
        CaseTask.find({ caseId: record._id }).sort({ createdAt: -1 }).lean(),
        CaseFinding.find({ caseId: record._id }).sort({ createdAt: -1 }).lean(),
        ProcessingRun.find({ documentId: { $in: documentIds } })
          .select("documentId status startedAt completedAt modelVersions errorCode")
          .sort({ createdAt: -1 })
          .lean(),
      ]);
      const latestExtraction = new Map();
      for (const extraction of extractions) {
        const key = String(extraction.document_id);
        if (!latestExtraction.has(key)) latestExtraction.set(key, extraction);
      }
      const latestProcessingRun = new Map();
      for (const run of processingRuns) {
        const key = String(run.documentId);
        if (!latestProcessingRun.has(key)) latestProcessingRun.set(key, run);
      }
      return respond(res, req, {
        caseId: record._id,
        caseVersion: record.version,
        policyVersion: record.policyVersion,
        documents: documents.map((document) => ({
          ...document,
          extraction: latestExtraction.get(String(document._id)) || null,
          processingRun: latestProcessingRun.get(String(document._id)) || null,
        })),
        tasks,
        findings,
      });
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/pipeline/evaluate", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = pipelineEvaluateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "A valid intent and expectedVersion are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (body.data.apply && record.workflowVersion) return res.status(409).json({ data: null, error: { code: "STAGE_WORKFLOW_REQUIRED", message: "Submitted applications must advance through their allocated stage actions" }, meta: { requestId: req.id } });
      if (body.data.apply && req.user.role !== "ADMIN" && !await holderIsUser(record, req.user)) {
        return deny(req, res, { message: "Only the current case holder may apply pipeline actions", entityId: record._id, action: "PIPELINE_APPLY_DENIED" });
      }
      const evaluated = await evaluateCasePipeline({
        caseId: record._id,
        intent: body.data.intent,
        completedChecklist: body.data.completedChecklist,
        expectedVersion: body.data.expectedVersion,
        apply: body.data.apply,
        actorId: req.user._id,
      });
      const hold = evaluated.actions.find((action) => action.type === "HOLD");
      return respond(res, req, {
        findings: evaluated.findings,
        actions: evaluated.actions,
        explain: evaluated.explain,
        planHash: evaluated.planHash,
        applied: evaluated.applied,
        held: Boolean(hold),
        holdReason: hold?.reason || null,
        case: evaluated.case,
      });
    } catch (error) {
      if (["CASE_VERSION_CONFLICT", "CASE_NOT_FOUND", "POLICY_UNAVAILABLE", "INVALID_PIPELINE_INTENT"].includes(error?.code)) {
        const status = error.code === "CASE_VERSION_CONFLICT" ? 409 : error.code === "CASE_NOT_FOUND" ? 404 : 422;
        return res.status(status).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      }
      return next(error);
    }
  });

  router.get("/cases/:id/history", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      return respond(res, req, await CaseStageHistory.find({ caseId: record._id }).sort({ enteredAt: 1 }).lean());
    } catch (error) { return next(error); }
  });

  router.get("/assist-requests/my", authenticate, async (req, res, next) => {
    try {
      if (!assistRoles.includes(req.user.role)) return deny(req, res, { message: "This role cannot receive stage-assist requests", entityId: "assist-requests", action: "ASSIST_QUEUE_ACCESS_DENIED" });
      const records = await CaseRecord.find({
        deletedAt: null,
        "allocatedStages.assistRequests.assignedToUserId": req.user._id,
        "allocatedStages.assistRequests.status": "PENDING_ASSIST_DECISION",
      }).select("caseNo applicationType currentStage currentStageIndex allocatedStages version institutionId region").lean();
      const requests = [];
      for (const record of records) {
        record.allocatedStages.forEach((stage, stageIndex) => {
          for (const assist of stage.assistRequests || []) {
            if (assist.status !== "PENDING_ASSIST_DECISION" || String(assist.assignedToUserId) !== String(req.user._id)) continue;
            requests.push({
              caseId: record._id,
              caseNo: record.caseNo,
              applicationType: record.applicationType,
              currentStageIndex: record.currentStageIndex,
              stageIndex,
              stageName: stage.name,
              stageStatus: stage.status,
              expectedVersion: record.version,
              assist,
            });
          }
        });
      }
      return respond(res, req, requests.sort((a, b) => new Date(a.assist.assistDueAt) - new Date(b.assist.assistDueAt)));
    } catch (error) { return next(error); }
  });

  router.get(["/cases/:id/stages/:stageIndex/assignees", "/applications/:id/stages/:stageIndex/assignees"], authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId, stageIndex: z.coerce.number().int().min(0) }).strict().safeParse(req.params);
      const target = z.object({ role: z.enum(assistRoles) }).strict().safeParse(req.query);
      if (!parsed.success || !target.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "A valid case, stage index, and target role are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      const stage = currentAllocatedStage(record);
      if (record.currentStageIndex !== parsed.data.stageIndex || !isStageOwner(stage, req.user, record)) return deny(req, res, { message: "Only the current stage owner may request assistance", entityId: record._id, action: "ASSIST_ASSIGNEES_DENIED" });
      if (stage.status === "FROZEN_WAITING_FOR_ASSIST") return res.status(403).json({ data: null, error: { code: "STAGE_FROZEN", message: "The stage owner cannot act while this stage is frozen" }, meta: { requestId: req.id } });
      const filter = { role: target.data.role, status: "ACTIVE", deleted_at: null, _id: { $ne: req.user._id } };
      if (target.data.role === "INSTITUTION") filter.institution_id = record.institutionId;
      else filter.region = record.region;
      const users = await User.find(filter).select("_id name email role").sort({ name: 1 }).limit(100).lean();
      return respond(res, req, users);
    } catch (error) { return next(error); }
  });

  router.post(["/cases/:id/stages/:stageIndex/request-assist", "/applications/:id/stages/:stageIndex/request-assist"], authenticate, async (req, res, next) => {
    try {
      const params = z.object({ id: objectId, stageIndex: z.coerce.number().int().min(0) }).strict().safeParse(req.params);
      const body = requestAssistSchema.safeParse(req.body);
      if (!params.success || !body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Valid case, stage, target role, note, and expectedVersion are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(params.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: params.data.id, action: "CASE_SCOPE_DENIED" });
      const stage = currentAllocatedStage(record);
      if (record.workflowVersion !== "SIH26262-1.0") return res.status(409).json({ data: null, error: { code: "STAGE_WORKFLOW_UNAVAILABLE", message: "This case has not been submitted to the deterministic stage workflow" }, meta: { requestId: req.id } });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      if (record.currentStageIndex !== params.data.stageIndex || !isStageOwner(stage, req.user, record)) return deny(req, res, { message: "Only the current stage owner may request assistance", entityId: record._id, action: "ASSIST_REQUEST_DENIED" });
      if (stage.status === "FROZEN_WAITING_FOR_ASSIST") return res.status(403).json({ data: null, error: { code: "STAGE_FROZEN", message: "The stage is already frozen while awaiting assistance" }, meta: { requestId: req.id } });
      if (!["ACTIVE", "ACTIVE_UNFROZEN"].includes(stage.status)) return res.status(409).json({ data: null, error: { code: "STAGE_NOT_ACTIVE", message: "Only an active stage can request assistance" }, meta: { requestId: req.id } });
      if (stage.assistRequests.some((request) => request.status === "PENDING_ASSIST_DECISION")) return res.status(409).json({ data: null, error: { code: "ASSIST_ALREADY_PENDING", message: "Resolve the current assist request before opening another" }, meta: { requestId: req.id } });
      const assigneeFilter = { role: body.data.targetRole, status: "ACTIVE", deleted_at: null };
      if (body.data.targetRole === "INSTITUTION") assigneeFilter.institution_id = record.institutionId;
      else assigneeFilter.region = record.region;
      if (body.data.assignedToUserId) assigneeFilter._id = body.data.assignedToUserId;
      const assignee = await User.findOne(assigneeFilter).select("_id name role").lean();
      if (!assignee || String(assignee._id) === String(req.user._id)) return res.status(422).json({ data: null, error: { code: "ASSIST_ASSIGNEE_UNAVAILABLE", message: "Choose an active, different user in the application's institution or region" }, meta: { requestId: req.id } });
      const now = new Date();
      const previousStage = record.currentStage;
      const remaining = Math.max(0, new Date(stage.stageDueAt || now).getTime() - now.getTime());
      stage.assignedUserId = req.user._id;
      stage.elapsedMs += stage.stageStartedAt ? Math.max(0, now.getTime() - new Date(stage.stageStartedAt).getTime()) : 0;
      stage.pausedRemainingMs = remaining;
      stage.stageStartedAt = null;
      stage.frozenAt = now;
      stage.activeClockHolder = assignee._id;
      stage.status = "FROZEN_WAITING_FOR_ASSIST";
      const assistDueAt = new Date(now.getTime() + body.data.assistSlaDays * 24 * 60 * 60 * 1000);
      stage.assistRequests.push({
        requestedByUserId: req.user._id,
        assignedToUserId: assignee._id,
        assignedToName: assignee.name,
        targetRole: assignee.role,
        note: body.data.note,
        status: "PENDING_ASSIST_DECISION",
        assistDueAt,
      });
      record.version += 1;
      try {
        await withTransaction(async (session) => {
          await record.save(session ? { session } : {});
          await writeAudit({ actor_id: req.user._id, action: "CASE_STAGE_ASSIST_REQUESTED", entity: "CaseRecord", entity_id: record._id, after_json: { stageIndex: params.data.stageIndex, targetRole: assignee.role, assigneeId: String(assignee._id), assistDueAt, version: record.version }, ip: req.ip }, { session });
          await createOutbox(session, "case.stage_assist_requested", record, req.user._id);
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      await queueStageNotice({ userId: assignee._id, type: "STAGE_ASSIST_REQUESTED", subject: "Stage assistance requested", body: `${record.caseNo}: ${req.user.name} requested your review for ${stage.name}. ${body.data.note}`, key: `assist:${stage.assistRequests.at(-1)._id}:requested`, applicationId: record._id, severity: "MEDIUM", link: `/case/${record._id}` });
      return respond(res, req, { case: record, assist: stage.assistRequests.at(-1) }, 201);
    } catch (error) { return next(error); }
  });

  router.post(["/cases/:id/assist-requests/:assistId/decide", "/applications/:id/assist-requests/:assistId/decide"], authenticate, async (req, res, next) => {
    try {
      const params = z.object({ id: objectId, assistId: objectId }).strict().safeParse(req.params);
      const body = decideAssistSchema.safeParse(req.body);
      if (!params.success || !body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "A valid assist decision and remarks are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(params.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Assist request not found in your scope", entityId: params.data.id, action: "ASSIST_DECISION_SCOPE_DENIED" });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const stage = record.allocatedStages.find((item) => item.assistRequests.some((request) => String(request._id) === params.data.assistId));
      const assist = stage?.assistRequests.id(params.data.assistId);
      if (!assist || !assist.assignedToUserId.equals(req.user._id) || assist.status !== "PENDING_ASSIST_DECISION" || stage.status !== "FROZEN_WAITING_FOR_ASSIST") {
        return deny(req, res, { message: "Only the assigned reviewer may decide this pending assist request", entityId: record._id, action: "ASSIST_DECISION_DENIED" });
      }
      const now = new Date();
      const previousStage = record.currentStage;
      assist.status = body.data.outcome;
      assist.decidedByUserId = req.user._id;
      assist.decidedByName = req.user.name;
      assist.decidedAt = now;
      assist.remarks = body.data.remarks;
      stage.status = "ACTIVE_UNFROZEN";
      stage.frozenAt = null;
      stage.stageStartedAt = now;
      stage.stageDueAt = new Date(now.getTime() + Math.max(0, stage.pausedRemainingMs || 0));
      stage.pausedRemainingMs = null;
      stage.activeClockHolder = stage.assignedUserId;
      record.version += 1;
      try {
        await withTransaction(async (session) => {
          await record.save(session ? { session } : {});
          await writeAudit({ actor_id: req.user._id, action: "CASE_STAGE_ASSIST_DECIDED", entity: "CaseRecord", entity_id: record._id, after_json: { assistId: String(assist._id), outcome: assist.status, remarks: assist.remarks, version: record.version }, ip: req.ip }, { session });
          await createOutbox(session, "case.stage_assist_decided", record, req.user._id);
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      await queueStageNotice({ userId: stage.assignedUserId, type: "STAGE_ASSIST_DECIDED", subject: `Stage assistance ${body.data.outcome === "ASSIST_APPROVED" ? "approved" : "rejected"}`, body: `${record.caseNo}: ${req.user.name} ${body.data.outcome === "ASSIST_APPROVED" ? "approved" : "rejected"} the assistance request for ${stage.name}. ${assist.remarks}`, key: `assist:${assist._id}:decided`, applicationId: record._id, severity: body.data.outcome === "ASSIST_APPROVED" ? "INFO" : "MEDIUM", link: `/case/${record._id}` });
      return respond(res, req, { case: record, assist });
    } catch (error) { return next(error); }
  });

  router.post(["/cases/:id/stages/:stageIndex/approve", "/applications/:id/stages/:stageIndex/approve"], authenticate, async (req, res, next) => {
    try {
      const params = z.object({ id: objectId, stageIndex: z.coerce.number().int().min(0) }).strict().safeParse(req.params);
      const body = approveStageSchema.safeParse(req.body);
      if (!params.success || !body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Valid stage index, expectedVersion, and approval details are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(params.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: params.data.id, action: "CASE_SCOPE_DENIED" });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const stage = currentAllocatedStage(record);
      if (record.currentStageIndex !== params.data.stageIndex) return res.status(409).json({ data: null, error: { code: "NOT_CURRENT_STAGE", message: "Only the current stage can be approved" }, meta: { requestId: req.id } });
      if (stage?.status === "FROZEN_WAITING_FOR_ASSIST" && isStageOwner(stage, req.user, record)) return res.status(403).json({ data: null, error: { code: "STAGE_FROZEN", message: "The stage is frozen until the assigned reviewer decides the assist request" }, meta: { requestId: req.id } });
      const approvableStatuses = stage?.assignedRole === "EVC" ? ["WAITING_FOR_APPROVAL"] : ["ACTIVE", "ACTIVE_UNFROZEN"];
      if (!isStageOwner(stage, req.user, record) || !approvableStatuses.includes(stage?.status)) return deny(req, res, { message: "Only the assigned owner of the active stage may approve it", entityId: record._id, action: "CASE_STAGE_APPROVAL_DENIED" });
      if (stage.assignedRole === "EVC" && !stage.inspectionReportDocumentId) return res.status(409).json({ data: null, error: { code: "INSPECTION_REPORT_REQUIRED", message: "Upload the completed EVC inspection report before sign-off" }, meta: { requestId: req.id } });
      const now = new Date();
      const previousStage = record.currentStage;
      stage.assignedUserId = req.user._id;
      stage.elapsedMs += stage.stageStartedAt ? Math.max(0, now.getTime() - new Date(stage.stageStartedAt).getTime()) : 0;
      stage.status = "APPROVED";
      stage.remarks = body.data.remarks;
      stage.approvedAt = now;
      stage.history.push({ action: "APPROVED", performed_by: req.user._id, timestamp: now, notes: body.data.remarks });
      record.completedStages = [...new Set([...(record.completedStages || []), stage.routeKey])];
      const nextIndex = params.data.stageIndex + 1;
      const isFinal = nextIndex >= record.allocatedStages.length;
      const finalDocuments = isFinal ? await Document.find({
        case_id: record._id,
        deleted_at: null,
        status: "CONFIRMED",
      }).select("_id original_name doc_type_final doc_type_slot").lean() : [];
      const finalExtractions = finalDocuments.length
        ? await AiExtraction.find({ document_id: { $in: finalDocuments.map(({ _id }) => _id) } })
          .select("document_id fields.field_name fields.confirmed_value fields.confirmed_at").lean()
        : [];
      const extractionByDocument = new Map(finalExtractions.map((item) => [String(item.document_id), item]));
      const validityObligations = finalDocuments.flatMap((document) => {
        const expiry = (extractionByDocument.get(String(document._id))?.fields || [])
          .find((field) => /^(valid_to|expiry_date|expiry|lease_end)$/i.test(field.field_name) && field.confirmed_value);
        const dueAt = expiry ? new Date(expiry.confirmed_value) : null;
        if (!dueAt || !Number.isFinite(dueAt.getTime())) return [];
        return [{
          caseId: record._id,
          institutionId: record.institutionId,
          sourceDocumentId: document._id,
          type: "validity",
          title: `${document.doc_type_final || document.doc_type_slot} validity`,
          dueAt,
          dueKind: "date",
          ownerType: "institution",
          submission: "none",
          verification: "pending",
          closure: "open",
        }];
      });
      const obligations = isFinal ? [...body.data.conditions.map((condition) => ({
        caseId: record._id,
        institutionId: record.institutionId,
        type: "undertaking",
        title: condition.title,
        dueAt: condition.dueAt || null,
        dueKind: "date",
        ownerType: "institution",
        submission: "none",
        verification: "pending",
        closure: "open",
      })), ...validityObligations] : [];
      if (isFinal) {
        record.status = "approved";
        record.overallStatus = "FINAL_APPROVED";
        record.approvedAt = now;
      } else {
        const next = record.allocatedStages[nextIndex];
        next.status = "ACTIVE";
        next.stageStartedAt = now;
        next.stageDueAt = new Date(now.getTime() + next.slaDays * 24 * 60 * 60 * 1000);
        next.activeClockHolder = next.assignedUserId;
        record.currentStageIndex = nextIndex;
        record.currentStage = next.routeKey;
        record.holderType = stageHolderType(next.assignedRole);
        record.holderId = next.assignedUserId;
        record.stageEnteredAt = now;
        record.status = "in_progress";
        record.overallStatus = "IN_PROGRESS";
      }
      record.version += 1;
      try {
        await withTransaction(async (session) => {
          await record.save(session ? { session } : {});
          if (obligations.length) await CaseObligation.insertMany(obligations, session ? { session, ordered: true } : { ordered: true });
          await recordStageChange(session, record, previousStage, req.user._id, body.data.remarks || `Approved ${stage.name}.`);
          await writeAudit({ actor_id: req.user._id, action: isFinal ? "CASE_FINAL_APPROVED" : "CASE_STAGE_APPROVED", entity: "CaseRecord", entity_id: record._id, after_json: { stageIndex: params.data.stageIndex, stage: stage.key, nextStage: isFinal ? null : record.currentStage, final: isFinal, remarks: body.data.remarks, version: record.version }, ip: req.ip }, { session });
          await createOutbox(session, isFinal ? "case.final_approved" : "case.stage_approved", record, req.user._id);
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      if (!isFinal) {
        const next = record.allocatedStages[record.currentStageIndex];
        await queueStageNotice({ userId: next.assignedUserId, type: "APPLICATION_STAGE_ASSIGNED", subject: "Application assigned to your stage", body: `${record.caseNo} is ready for ${next.name}.`, key: `stage-assigned:${record._id}:${next.key}`, applicationId: record._id, link: `/case/${record._id}` });
      } else {
        const [institution, recipient] = await Promise.all([
          Institution.findById(record.institutionId).select("name contact_email").lean(),
          User.findOne({ role: "INSTITUTION", institution_id: record.institutionId, status: "ACTIVE", deleted_at: null }).select("_id").lean(),
        ]);
        const validity = finalExtractions.flatMap((extraction) => {
          const document = finalDocuments.find((item) => String(item._id) === String(extraction.document_id));
          return (extraction.fields || [])
            .filter((field) => /^(issue_date|valid_from|valid_to|expiry_date|expiry|lease_start|lease_end)$/i.test(field.field_name) && field.confirmed_value)
            .map((field) => `${document?.doc_type_final || document?.doc_type_slot || "Document"} — ${field.field_name.replaceAll("_", " ")}: ${field.confirmed_value}`);
        });
        const stageSummary = record.allocatedStages.map((item) => `${item.name}: ${item.status}${item.remarks ? ` — ${item.remarks}` : ""}`).join("\n");
        const bodyText = [
          `Institution: ${institution?.name || "Institution"}`,
          `Application ID: ${record.caseNo}`,
          `Application Type: ${record.applicationType.replaceAll("_", " ")}`,
          `Approval Date: ${now.toISOString()}`,
          `Stage-by-stage approval summary:\n${stageSummary}`,
          `Confirmed document validity dates:\n${validity.length ? validity.join("\n") : "No confirmed expiry dates recorded."}`,
          `Institution dashboard: ${process.env.FRONTEND_ORIGIN || ""}/dashboard`,
          `Application details: ${process.env.FRONTEND_ORIGIN || ""}/case/${record._id}`,
          institution?.contact_email ? `Institution contact: ${institution.contact_email}` : "",
        ].filter(Boolean).join("\n\n");
        await queueStageNotice({ userId: recipient?._id, recipientEmail: institution?.contact_email, type: "APPLICATION_FINAL_APPROVED", subject: `[AICTE ApprovalTrack] Application Approved — ${record.caseNo} (${record.applicationType.replaceAll("_", " ")})`, body: bodyText, key: `final-approved:${record._id}`, applicationId: record._id, link: `/case/${record._id}` });
      }
      return respond(res, req, record);
    } catch (error) { return next(error); }
  });

  router.post(["/cases/:id/stages/:stageIndex/reject", "/applications/:id/stages/:stageIndex/reject"], authenticate, async (req, res, next) => {
    try {
      const params = z.object({ id: objectId, stageIndex: z.coerce.number().int().min(0) }).strict().safeParse(req.params);
      const body = rejectStageSchema.safeParse(req.body);
      if (!params.success || !body.success) return res.status(422).json({ data: null, error: { code: "RETURN_REASON_REQUIRED", message: "A valid stage, expectedVersion, and written reason are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(params.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: params.data.id, action: "CASE_SCOPE_DENIED" });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const stage = currentAllocatedStage(record);
      if (record.currentStageIndex !== params.data.stageIndex) return res.status(409).json({ data: null, error: { code: "NOT_CURRENT_STAGE", message: "Only the current stage can be returned" }, meta: { requestId: req.id } });
      if (stage?.status === "FROZEN_WAITING_FOR_ASSIST" && isStageOwner(stage, req.user, record)) return res.status(403).json({ data: null, error: { code: "STAGE_FROZEN", message: "The stage is frozen until the assigned reviewer decides the assist request" }, meta: { requestId: req.id } });
      const returnableStatuses = stage?.assignedRole === "EVC"
        ? ["ACTIVE", "ACTIVE_UNFROZEN", "WAITING_FOR_APPROVAL"]
        : ["ACTIVE", "ACTIVE_UNFROZEN"];
      if (!isStageOwner(stage, req.user, record) || !returnableStatuses.includes(stage?.status)) return deny(req, res, { message: "Only the assigned owner of the active stage may return it", entityId: record._id, action: "CASE_STAGE_REJECTION_DENIED" });
      const previousStage = record.currentStage;
      const now = new Date();
      stage.assignedUserId = req.user._id;
      stage.elapsedMs += stage.stageStartedAt ? Math.max(0, now.getTime() - new Date(stage.stageStartedAt).getTime()) : 0;
      stage.status = "REJECTED";
      stage.remarks = body.data.reason;
      stage.approvedAt = null;
      stage.history.push({ action: "DEFICIENCY_RETURNED", performed_by: req.user._id, timestamp: now, notes: body.data.reason });
      record.status = "returned";
      record.overallStatus = "RETURNED";
      record.returnReason = body.data.reason;
      record.returnedToStage = stage.routeKey;
      record.holderType = "institution";
      record.holderId = null;
      record.stageEnteredAt = now;
      record.version += 1;
      try {
        await withTransaction(async (session) => {
          await record.save(session ? { session } : {});
          await recordStageChange(session, record, previousStage, req.user._id, body.data.reason);
          await writeAudit({ actor_id: req.user._id, action: "CASE_STAGE_RETURNED", entity: "CaseRecord", entity_id: record._id, after_json: { stageIndex: params.data.stageIndex, reason: body.data.reason, version: record.version }, ip: req.ip }, { session });
          await createOutbox(session, "case.stage_returned", record, req.user._id);
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      const institutionUser = await User.findOne({ role: "INSTITUTION", institution_id: record.institutionId, status: "ACTIVE", deleted_at: null }).select("_id").lean();
      await queueStageNotice({ userId: institutionUser?._id, type: "APPLICATION_DEFICIENCY_RAISED", subject: "Application requires institution action", body: `${record.caseNo} was returned from ${stage.name}. Reason: ${body.data.reason}`, key: `stage-returned:${record._id}:${record.version}`, applicationId: record._id, severity: "HIGH", link: `/case/${record._id}` });
      return respond(res, req, record);
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/advance", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = advanceSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "expectedVersion and completedChecklist are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (record.workflowVersion) return res.status(409).json({ data: null, error: { code: "STAGE_WORKFLOW_REQUIRED", message: "Use the allocated stage approval action for this application" }, meta: { requestId: req.id } });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      if (record.status === "draft") return res.status(409).json({ data: null, error: { code: "DRAFT_NOT_SUBMITTED", message: "Submit the draft before advancing workflow stages" }, meta: { requestId: req.id } });
      if (!await holderIsUser(record, req.user)) return deny(req, res, { message: "Only the current case holder may advance the case", entityId: record._id, action: "CASE_ADVANCE_DENIED" });
      const policy = await Policy.findOne({ version: record.policyVersion }).lean();
      const requirements = policy?.stageCompletion?.[record.currentStage] || [];
      const missingChecks = requirements.filter((item) => !body.data.completedChecklist.includes(item));
      if (missingChecks.length) return res.status(422).json({ data: null, error: { code: "STAGE_CHECKLIST_INCOMPLETE", message: "Complete the current stage checklist before advancing", details: missingChecks.map((item) => ({ path: "completedChecklist", message: item })) }, meta: { requestId: req.id } });
      const currentIndex = record.route.indexOf(record.currentStage);
      const nextStage = record.route[currentIndex + 1];
      if (currentIndex < 0 || !nextStage) return res.status(409).json({ data: null, error: { code: "NO_NEXT_STAGE", message: "No next stage exists in this case route" }, meta: { requestId: req.id } });
      if (record.currentStage === "evc") return res.status(409).json({ data: null, error: { code: "EVC_REPORT_REQUIRED", message: "Upload the EVC report to advance from this stage" }, meta: { requestId: req.id } });
      const evaluated = await evaluateCasePipeline({
        caseId: record._id,
        intent: "STAGE_COMPLETE",
        completedChecklist: body.data.completedChecklist,
        expectedVersion: body.data.expectedVersion,
        apply: true,
        actorId: req.user._id,
      });
      const hold = evaluated.actions.find((action) => action.type === "HOLD");
      if (hold) return res.status(422).json({
        data: { caseVersion: evaluated.case.version, findings: evaluated.findings },
        error: { code: "PIPELINE_HOLD", message: hold.reason },
        meta: { requestId: req.id },
      });
      return respond(res, req, evaluated.case);
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/return", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = returnSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(422).json({ data: null, error: { code: "RETURN_REASON_REQUIRED", message: "A written reason, targetStage and expectedVersion are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (record.workflowVersion) return res.status(409).json({ data: null, error: { code: "STAGE_WORKFLOW_REQUIRED", message: "Use the allocated stage return action for this application" }, meta: { requestId: req.id } });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      if (!["SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER"].includes(req.user.role) || !await holderIsUser(record, req.user)) {
        return deny(req, res, { message: "Only the assigned reviewing authority may return the case", entityId: record._id, action: "CASE_RETURN_DENIED" });
      }
      if (!returnTargetIsEarlier(record.route, record.currentStage, body.data.targetStage)) {
        return deny(req, res, { status: 422, code: "INVALID_RETURN_TARGET", message: "Return target must be an earlier stage in this case route", entityId: record._id, action: "CASE_RETURN_DENIED" });
      }
      const institutionHolder = { holderType: "institution", holderId: null };
      const previousStage = record.currentStage;
      const now = new Date();
      await withTransaction(async (session) => {
        const targetIndex = record.route.indexOf(body.data.targetStage);
        if (!record.route.includes("re_scrutiny")) record.route.splice(targetIndex + 1, 0, "re_scrutiny");
        record.currentStage = "re_scrutiny";
        record.returnedToStage = body.data.targetStage;
        record.returnReason = body.data.reason;
        record.holderType = institutionHolder.holderType;
        record.holderId = institutionHolder.holderId;
        record.status = "returned";
        record.stageEnteredAt = now;
        record.version += 1;
        await record.save(session ? { session } : {});
        await recordStageChange(session, record, previousStage, req.user._id, body.data.reason);
        await writeAudit({ actor_id: req.user._id, action: "CASE_RETURNED", entity: "CaseRecord", entity_id: record._id, after_json: { targetStage: body.data.targetStage, reason: body.data.reason, version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.returned", record, req.user._id);
      });
      scheduleCaseEvaluation({ caseId: record._id, intent: "CHANGE", actorId: req.user._id });
      return respond(res, req, record);
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/resubmit", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = submitSchema.safeParse(req.body);
      if (!parsed.success || !body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Valid case id and expectedVersion are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (req.user.role !== "INSTITUTION" || record.status !== "returned") return deny(req, res, { message: "Only the owning institution may resubmit a returned case", entityId: record._id, action: "CASE_RESUBMIT_DENIED" });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const policy = await Policy.findOne({ version: record.policyVersion }).lean();
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      const missing = missingChecklistItems(checklistFor(record, policy));
      if ((policy.pipelineSettings?.blockSubmitOnMissing ?? policy.blockSubmitOnMissing) && missing.length) return res.status(422).json({ data: null, error: { code: "MISSING_DOCUMENTS", message: "Required documents are missing", details: missing.map(({ slotId, label }) => ({ slotId, label })) }, meta: { requestId: req.id } });
      const evaluated = await evaluateCasePipeline({
        caseId: record._id,
        intent: "RESUBMIT",
        expectedVersion: body.data.expectedVersion,
        apply: true,
        actorId: req.user._id,
      });
      let resubmittedCase = evaluated.case;
      if (record.workflowVersion) {
        resubmittedCase = await CaseRecord.findById(record._id);
        const stageIndex = Math.max(0, record.currentStageIndex);
        const stage = resubmittedCase?.allocatedStages?.[stageIndex];
        if (!resubmittedCase || !stage || stage.status !== "REJECTED") return res.status(409).json({ data: null, error: { code: "STAGE_RESUBMISSION_UNAVAILABLE", message: "The returned stage state changed; refresh the application" }, meta: { requestId: req.id } });
        const now = new Date();
        const previousStage = resubmittedCase.currentStage;
        stage.status = "ACTIVE";
        stage.stageStartedAt = now;
        stage.stageDueAt = new Date(now.getTime() + stage.slaDays * DAY);
        stage.activeClockHolder = stage.assignedUserId;
        stage.pausedRemainingMs = null;
        stage.frozenAt = null;
        resubmittedCase.currentStageIndex = stageIndex;
        resubmittedCase.currentStage = stage.routeKey;
        resubmittedCase.route = resubmittedCase.allocatedStages.map(({ routeKey }) => routeKey);
        resubmittedCase.holderType = stageHolderType(stage.assignedRole);
        resubmittedCase.holderId = stage.assignedUserId;
        resubmittedCase.stageEnteredAt = now;
        resubmittedCase.status = "in_progress";
        resubmittedCase.overallStatus = "IN_PROGRESS";
        resubmittedCase.version += 1;
        await withTransaction(async (session) => {
          await resubmittedCase.save(session ? { session } : {});
          await recordStageChange(session, resubmittedCase, previousStage, req.user._id, "Institution resubmitted its response for stage review.");
          await writeAudit({ actor_id: req.user._id, action: "CASE_STAGE_RESUBMITTED", entity: "CaseRecord", entity_id: resubmittedCase._id, after_json: { stageIndex, version: resubmittedCase.version }, ip: req.ip }, { session });
          await createOutbox(session, "case.stage_resubmitted", resubmittedCase, req.user._id);
        });
      } else {
        scheduleCaseEvaluation({ caseId: record._id, intent: "CHANGE", actorId: req.user._id });
      }
      return respond(res, req, {
        case: resubmittedCase,
        missingDocuments: missing.map(({ slotId, label }) => ({ slotId, label })),
        pipeline: { findings: evaluated.findings, explain: evaluated.explain, planHash: evaluated.planHash },
      });
    } catch (error) {
      if (["CASE_VERSION_CONFLICT", "CASE_NOT_FOUND", "POLICY_UNAVAILABLE", "INVALID_PIPELINE_INTENT"].includes(error?.code)) {
        const status = error.code === "CASE_VERSION_CONFLICT" ? 409 : error.code === "CASE_NOT_FOUND" ? 404 : 422;
        return res.status(status).json({ data: null, error: { code: error.code, message: error.message }, meta: { requestId: req.id } });
      }
      return next(error);
    }
  });

  router.post("/cases/:id/decision", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = decisionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: body.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, meta: { requestId: req.id } });
      if (req.user.role !== "ADMIN") return deny(req, res, { message: "Only an administrator may record the final decision", entityId: parsed.data.id, action: "CASE_DECISION_DENIED" });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      if (record.workflowVersion) return res.status(409).json({ data: null, error: { code: "STAGE_WORKFLOW_REQUIRED", message: "Final decisions must be recorded through the final allocated stage" }, meta: { requestId: req.id } });
      if (record.currentStage !== "decision" || record.completedStages.length < record.route.length - 1) return res.status(409).json({ data: null, error: { code: "ROUTE_INCOMPLETE", message: "All route stages must be complete before recording the decision" }, meta: { requestId: req.id } });
      if (record.version !== body.data.expectedVersion) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Case changed; reload and retry" }, meta: { requestId: req.id } });
      const now = new Date();
      const obligations = body.data.conditions.map((condition) => ({
        caseId: record._id,
        institutionId: record.institutionId,
        type: "undertaking",
        title: condition.title,
        dueAt: condition.dueAt || null,
        dueKind: "date",
        ownerType: "institution",
        submission: "none",
        verification: "pending",
        closure: "open",
      }));
      await withTransaction(async (session) => {
        record.status = body.data.outcome;
        record.completedStages = [...new Set([...record.completedStages, "decision"])];
        record.version += 1;
        await record.save(session ? { session } : {});
        await CaseDecision.create([{
          caseId: record._id,
          decidedBy: req.user._id,
          outcome: body.data.outcome,
          reason: body.data.reason,
          conditions: body.data.conditions,
          decidedAt: now,
        }], session ? { session } : {});
        if (obligations.length) await CaseObligation.create(obligations, session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "CASE_DECISION_RECORDED", entity: "CaseRecord", entity_id: record._id, after_json: { outcome: record.status, reason: body.data.reason, conditions: body.data.conditions, version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.decision_recorded", record, req.user._id);
      });

      return respond(res, req, { case: record, obligations: await CaseObligation.find({ caseId: record._id }).lean() });
    } catch (error) { return next(error); }
  });

  router.get("/cases/events", authenticate, async (req, res, next) => {
    const parseCursor = (value) => {
      if (!value) return null;
      try {
        const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (
          !Number.isSafeInteger(cursor?.at)
          || cursor.at < 0
          || !Number.isFinite(new Date(cursor.at).getTime())
          || typeof cursor.eventId !== "string"
          || cursor.eventId.length > 100
        ) return undefined;
        return { at: cursor.at, eventId: cursor.eventId };
      } catch {
        return undefined;
      }
    };
    const cursor = parseCursor(req.get("Last-Event-ID") || req.query.after);
    if (cursor === undefined) return res.status(400).json({ data: null, error: { code: "INVALID_EVENT_CURSOR", message: "Event cursor is invalid" }, meta: { requestId: req.id } });
    let caseFilter;
    try {
      caseFilter = await caseFilterForUser(req.user);
    } catch (error) {
      return next(error);
    }
    if (!caseFilter) return deny(req, res, { message: "This role cannot view case events", entityId: "case-events", action: "CASE_EVENT_ACCESS_DENIED" });

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let active = true;
    let polling = false;
    let last = cursor || { at: Date.now(), eventId: "" };
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const caseIds = await CaseRecord.find(caseFilter).distinct("_id");
        const events = await OutboxEvent.find({
          entityId: { $in: caseIds.map(String) },
          $or: [
            { createdAt: { $gt: new Date(last.at) } },
            { createdAt: new Date(last.at), eventId: { $gt: last.eventId } },
          ],
        }).sort({ createdAt: 1, eventId: 1 }).limit(100).lean();
        for (const event of events) {
          const at = new Date(event.createdAt).getTime();
          const id = Buffer.from(JSON.stringify({ at, eventId: event.eventId })).toString("base64url");
          res.write(`id: ${id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`);
          last = { at, eventId: event.eventId };
        }
        if (!events.length) res.write(": keep-alive\n\n");
      } catch (error) {
        active = false;
        clearInterval(timer);
        logger.error({ err: error }, "Case event stream polling failed");
        res.end();
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => { void poll(); }, 3000);
    res.on("close", () => {
      active = false;
      clearInterval(timer);
    });
    void poll();
  });

  router.get("/obligations", authenticate, async (req, res, next) => {
    try {
      const caseFilter = await caseFilterForUser(req.user);
      if (!caseFilter) {
        return deny(req, res, { message: "This role cannot view workflow obligations", entityId: "obligation-list", action: "OBLIGATION_ACCESS_DENIED" });
      }
      const caseIds = await CaseRecord.find(caseFilter).distinct("_id");
      const obligations = await CaseObligation.find({ caseId: { $in: caseIds } }).sort({ dueAt: 1 }).lean();
      const now = new Date();
      return respond(res, req, obligations.map((item) => ({
        ...item,
        dueStatus: dueStatus({ dueAt: item.dueAt, dueKind: item.dueKind, now }),
      })));
    } catch (error) { return next(error); }
  });

  router.post("/obligations/:id/submit-evidence", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = evidenceSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid obligation id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "A written evidence note is required" }, meta: { requestId: req.id } });
      if (req.user.role !== "INSTITUTION") return deny(req, res, { message: "Only the owning institution may submit obligation evidence", entityId: parsed.data.id, action: "OBLIGATION_SUBMISSION_DENIED" });
      const institutionId = await institutionIdFor(req.user);
      const obligation = await CaseObligation.findOne({ _id: parsed.data.id, institutionId });
      if (!obligation) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Obligation not found in your institution scope", entityId: parsed.data.id, action: "OBLIGATION_SCOPE_DENIED" });
      const caseRecord = await CaseRecord.findOne({ _id: obligation.caseId, institutionId, deletedAt: null });
      if (!caseRecord) return res.status(409).json({ data: null, error: { code: "CASE_UNAVAILABLE", message: "The obligation's case is unavailable" }, meta: { requestId: req.id } });
      if (obligation.closure === "closed") return res.status(409).json({ data: null, error: { code: "OBLIGATION_CLOSED", message: "Closed obligations cannot receive new evidence" }, meta: { requestId: req.id } });
      if (obligation.submission === "submitted" && obligation.verification !== "not_verified") return res.status(409).json({ data: null, error: { code: "EVIDENCE_ALREADY_SUBMITTED", message: "Evidence is already awaiting verification" }, meta: { requestId: req.id } });
      const now = new Date();
      await withTransaction(async (session) => {
        obligation.submission = "submitted";
        obligation.evidenceNote = body.data.evidenceNote;
        obligation.submittedAt = now;
        obligation.verification = "pending";
        obligation.verificationReason = "";
        obligation.verifiedAt = null;
        obligation.verifiedBy = null;
        await obligation.save(session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "OBLIGATION_EVIDENCE_SUBMITTED", entity: "CaseObligation", entity_id: obligation._id, after_json: { submission: obligation.submission, verification: obligation.verification }, ip: req.ip }, { session });
        await createOutbox(session, "obligation.evidence_submitted", caseRecord, req.user._id);
      });
      return respond(res, req, obligation);
    } catch (error) { return next(error); }
  });

  router.post("/obligations/:id/verify", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = verifyObligationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid obligation id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(422).json({ data: null, error: { code: "VALIDATION_ERROR", message: "A valid verification outcome is required", details: body.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, meta: { requestId: req.id } });
      if (!["SCRUTINY_OFFICER", "BUREAU_OFFICER", "ADMIN"].includes(req.user.role)) return deny(req, res, { message: "Only an authorised officer may verify submitted evidence", entityId: parsed.data.id, action: "OBLIGATION_VERIFICATION_DENIED" });
      const obligation = await CaseObligation.findById(parsed.data.id);
      const caseRecord = obligation && await scopedCase(obligation.caseId, req.user);
      if (!obligation || !caseRecord) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Obligation not found in your scope", entityId: parsed.data.id, action: "OBLIGATION_SCOPE_DENIED" });
      if (obligation.submission !== "submitted") return res.status(409).json({ data: null, error: { code: "EVIDENCE_NOT_SUBMITTED", message: "Evidence must be submitted before verification" }, meta: { requestId: req.id } });
      if (obligation.closure === "closed" || obligation.verification === "verified") return res.status(409).json({ data: null, error: { code: "OBLIGATION_ALREADY_VERIFIED", message: "Verified evidence cannot be changed" }, meta: { requestId: req.id } });
      const now = new Date();
      await withTransaction(async (session) => {
        obligation.verification = body.data.verification;
        obligation.verificationReason = body.data.reason;
        obligation.verifiedBy = req.user._id;
        obligation.verifiedAt = now;
        if (body.data.verification === "verified") obligation.closure = "closed";
        await obligation.save(session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "OBLIGATION_EVIDENCE_VERIFIED", entity: "CaseObligation", entity_id: obligation._id, after_json: { verification: obligation.verification, closure: obligation.closure }, ip: req.ip }, { session });
        await createOutbox(session, "obligation.evidence_verified", caseRecord, req.user._id);
      });
      return respond(res, req, obligation);
    } catch (error) { return next(error); }
  });

  router.get("/cases/:id", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
      const [policy, institution] = await Promise.all([
        Policy.findOne({ version: record.policyVersion }).lean(),
        Institution.findById(record.institutionId).select("name").lean(),
      ]);
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      const checklist = checklistFor(record, policy);
      return respond(res, req, {
        ...record.toObject(),
        institutionName: institution?.name || "",
        blockSubmitOnMissing: policy.pipelineSettings?.blockSubmitOnMissing ?? policy.blockSubmitOnMissing,
        checklist,
        stageRequirements: policy.stageCompletion?.[record.currentStage] || [],
        missingDocuments: missingChecklistItems(checklist).map(({ slotId, label }) => ({ slotId, label })),
      });
    } catch (error) { return next(error); }
  });

  return router;
}
