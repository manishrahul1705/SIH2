import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { APPLICATION_STAGES, APPLICATION_TYPES, ROLES } from "../../config/constants.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { Alert, Application, Institution, PendingItem, StageConfig, StageHistory, Undertaking, User, Visit } from "../../models/index.js";
import { logger } from "../../config/logger.js";
import { NotificationService } from "../notifications/service.js";

const id = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const createSchema = z.object({
  type: z.enum(APPLICATION_TYPES),
  academic_year: z.string().regex(/^\d{4}-\d{2}$/),
}).strict();
const applicationPatchSchema = z.object({
  assigned_officer_id: id.optional(),
  is_compliant: z.boolean().optional(),
}).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["DRAFT", "SUBMITTED", "IN_PROGRESS", "RETURNED", "APPROVED", "CANCELLED", "REJECTED"]).optional(),
  current_stage: z.enum(APPLICATION_STAGES).optional(),
  type: z.enum(APPLICATION_TYPES).optional(),
  academic_year: z.string().regex(/^\d{4}-\d{2}$/).optional(),
}).strict();
const actorRoles = ["INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"];
const roleByStage = {
  SCRUTINY: "SCRUTINY_OFFICER",
  RE_SCRUTINY: "SCRUTINY_OFFICER",
  EVC: "EVC",
  SAC_SHC: "SAC_SHC",
  DECISION: "BUREAU_OFFICER",
};
const defaultPaths = {
  NEW: ["SCRUTINY", "RE_SCRUTINY", "EVC", "SAC_SHC", "DECISION"],
  EXTENSION_OF_APPROVAL: ["SCRUTINY", "RE_SCRUTINY", "DECISION"],
  INCREASE_INTAKE: ["SCRUTINY", "RE_SCRUTINY", "EVC", "SAC_SHC", "DECISION"],
  NEW_COURSE: ["SCRUTINY", "RE_SCRUTINY", "EVC", "SAC_SHC", "DECISION"],
  CLOSURE: ["SCRUTINY", "DECISION"],
};

function success(res, req, data, meta = {}) {
  return res.json({ data, error: null, meta: { requestId: req.id, ...meta } });
}

async function queueUserNotice(userId, type, subject, body, key, sms = false, extra = {}) {
  if (!userId) return;
  const notifications = [
    NotificationService.enqueue({ userId, type, channel: "IN_APP", payload: { title: subject, body, ...extra }, dedupeKey: `${key}:in-app` }),
    NotificationService.enqueue({ userId, type, channel: "EMAIL", payload: { subject, body, ...extra }, dedupeKey: `${key}:email` }),
  ];
  if (sms) notifications.push(NotificationService.enqueue({
    userId, type, channel: "SMS",
    payload: { message: `${extra.caseId ? `${extra.caseId}: ` : ""}${body}`.slice(0, 160), ...extra },
    dedupeKey: `${key}:sms`,
  }));
  try { await Promise.all(notifications); }
  catch (error) {
    logger.error({ userId: userId.toString(), type, code: error.code || "NOTIFICATION_ENQUEUE_FAILED" }, "Workflow changed but notifications could not all be queued");
  }
}

async function applicationScope(req) {
  const filter = { deleted_at: null };
  if (req.user.role === "INSTITUTION") {
    let institutionId = req.user.institution_id;
    if (!institutionId) institutionId = (await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id"))?._id;
    if (!institutionId) return null;
    filter.institution_id = institutionId;
  } else if (req.user.role === "SCRUTINY_OFFICER" || req.user.role === "EVC") {
    if (req.user.role === "SCRUTINY_OFFICER") filter.assigned_officer_id = req.user._id;
    else filter._id = { $in: await Visit.find({ evc_user_id: req.user._id }).distinct("application_id") };
  }
  return filter;
}

function validateIdParam(req, res, next) {
  const parsed = z.object({ id }).strict().safeParse(req.params);
  if (!parsed.success || !mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid resource id" }, meta: { requestId: req.id } });
  }
  return next();
}

export function applicationsRouter() {
  const router = express.Router();
  router.use(authenticate);
  router.use(requireRole(...actorRoles));

  router.post("/", requireRole("INSTITUTION", "ADMIN"), validate(createSchema), async (req, res, next) => {
    try {
      let institutionId = req.user.institution_id;
      if (req.user.role === "INSTITUTION" && !institutionId) {
        institutionId = (await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id"))?._id;
      }
      if (!institutionId) return res.status(400).json({ data: null, error: { code: "INSTITUTION_REQUIRED", message: "Your account is not linked to an institution" }, meta: { requestId: req.id } });
      const application = await Application.create({
        institution_id: institutionId,
        ...req.body,
        current_stage: "SUBMITTED",
        status: "DRAFT",
        stage_entered_at: new Date(),
        is_compliant: true,
      });
      await writeAudit({ actor_id: req.user._id, action: "APPLICATION_CREATED", entity: "Application", entity_id: application._id, after_json: application.toObject(), ip: req.ip });
      return res.status(201).json({ data: application, error: null, meta: { requestId: req.id } });
    } catch (error) { return next(error); }
  });

  router.get("/", validate(querySchema, "query"), async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      if (!scope) return success(res, req, [], { page: req.query.page, pageSize: req.query.pageSize, total: 0, pages: 0 });
      for (const key of ["status", "current_stage", "type", "academic_year"]) if (req.query[key]) scope[key] = req.query[key];
      const page = req.query.page;
      const pageSize = req.query.pageSize;
      const [items, total] = await Promise.all([
        Application.find(scope).sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).populate("institution_id", "aicte_id name state region").lean(),
        Application.countDocuments(scope),
      ]);
      return success(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.get("/:id/timeline", validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = scope && await Application.findOne({ _id: req.params.id, ...scope }).lean();
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      const timeline = await StageHistory.find({ application_id: application._id }).sort({ createdAt: 1 }).populate("actor_id", "name role").lean();
      return success(res, req, timeline);
    } catch (error) { return next(error); }
  });

  router.get("/:id/pending-items", validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = scope && await Application.exists({ _id: req.params.id, ...scope });
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      return success(res, req, await PendingItem.find({ application_id: req.params.id }).sort({ createdAt: -1 }).lean());
    } catch (error) { return next(error); }
  });

  router.get("/:id/undertakings", validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = scope && await Application.exists({ _id: req.params.id, ...scope });
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      return success(res, req, await Undertaking.find({ application_id: req.params.id }).sort({ due_date: 1 }).lean());
    } catch (error) { return next(error); }
  });

  router.post("/:id/submit", requireRole("INSTITUTION", "ADMIN"), validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const filter = { _id: req.params.id, status: "DRAFT", ...(scope || {}) };
      const application = await Application.findOne(filter);
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND_OR_ALREADY_SUBMITTED", message: "Draft application not found" }, meta: { requestId: req.id } });
      const path = await stagesFor(application.type);
      if (!path?.length) return res.status(409).json({ data: null, error: { code: "NO_WORKFLOW_CONFIG", message: "No stage path is configured for this application type" }, meta: { requestId: req.id } });
      const nextStage = path[0];
      const initialAssignment = await User.findOne({ role: "SCRUTINY_OFFICER", status: "ACTIVE", ...(req.user.region ? { region: req.user.region } : {}) }).select("_id");
      await withTransaction(async (session) => {
        const previous = application.toObject();
        application.status = "IN_PROGRESS";
        application.current_stage = nextStage;
        application.stage_entered_at = new Date();
        application.submitted_at = new Date();
        application.assigned_officer_id = initialAssignment?._id || application.assigned_officer_id;
        await application.save({ session });
        await StageHistory.create([{ application_id: application._id, from_stage: "SUBMITTED", to_stage: nextStage, actor_id: req.user._id, reason: "Application submitted" }], { session });
        await writeAudit({ actor_id: req.user._id, action: "APPLICATION_SUBMITTED", entity: "Application", entity_id: application._id, before_json: previous, after_json: application.toObject(), ip: req.ip }, { session });
      });
      const institutionUser = req.user.role === "INSTITUTION"
        ? req.user
        : await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
      await queueUserNotice(
        institutionUser?._id,
        "APPLICATION_SUBMITTED",
        "Application submitted",
        `Application ${application.application_number || application._id} has been submitted for review.`,
        `application:${application._id}:submitted`,
        false,
        { application_id: application._id, caseId: application.application_number || application._id.toString() },
      );
      return success(res, req, application);
    } catch (error) { return next(error); }
  });

  router.post("/:id/stage/advance", requireRole("SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER"), validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = await Application.findOne({ _id: req.params.id, ...(scope || {}) });
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      if (application.status !== "IN_PROGRESS") return res.status(409).json({ data: null, error: { code: "INVALID_APPLICATION_STATE", message: "Only an in-progress application can advance" }, meta: { requestId: req.id } });
      const currentConfig = await StageConfig.findOne({ application_type: application.type, stage: application.current_stage, enabled: true }).lean();
      const responsibleRole = currentConfig?.role_responsible || roleByStage[application.current_stage];
      if (req.user.role !== responsibleRole) return res.status(403).json({ data: null, error: { code: "WRONG_STAGE_ROLE", message: "Only the responsible stage role may advance this application" }, meta: { requestId: req.id } });
      if (req.user.role === "EVC" && !await Visit.exists({ application_id: application._id, evc_user_id: req.user._id, status: { $in: ["SCHEDULED", "DONE"] } })) return res.status(403).json({ data: null, error: { code: "VISIT_ASSIGNMENT_REQUIRED", message: "An assigned EVC visit is required for this application" }, meta: { requestId: req.id } });
      const path = await stagesFor(application.type);
      const currentIndex = path.indexOf(application.current_stage);
      if (currentIndex < 0) return res.status(409).json({ data: null, error: { code: "INVALID_STAGE_TRANSITION", message: "The current stage is not present in the enabled workflow" }, meta: { requestId: req.id } });
      if (currentIndex >= path.length - 1) return res.status(409).json({ data: null, error: { code: "DECISION_REQUIRED", message: "The Bureau Officer must record the final outcome through the decisions endpoint" }, meta: { requestId: req.id } });
      const nextStage = path[currentIndex + 1];
      const previous = application.toObject();
      application.current_stage = nextStage;
      application.stage_entered_at = new Date();
      const nextConfig = await StageConfig.findOne({ application_type: application.type, stage: nextStage, enabled: true }).lean();
      const nextRole = nextConfig?.role_responsible || roleByStage[nextStage];
      if (nextRole) {
        const nextAssignee = await User.findOne({ role: nextRole, status: "ACTIVE", ...(req.user.region ? { region: req.user.region } : {}) }).select("_id");
        application.assigned_officer_id = nextAssignee?._id || null;
      }
      try {
        await withTransaction(async (session) => {
          await application.save({ session });
          await StageHistory.create([{ application_id: application._id, from_stage: previous.current_stage, to_stage: nextStage, actor_id: req.user._id, reason: "" }], { session });
          await writeAudit({ actor_id: req.user._id, action: "APPLICATION_STAGE_ADVANCED", entity: "Application", entity_id: application._id, before_json: previous, after_json: application.toObject(), ip: req.ip }, { session });
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Application changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      if (application.assigned_officer_id) {
        await queueUserNotice(
          application.assigned_officer_id,
          "APPLICATION_STAGE_ASSIGNED",
          "Application assigned to your stage",
          `Case ${application.application_number || application._id} is now in ${application.current_stage}.`,
          `application:${application._id}:stage:${application.current_stage}:${application.stage_entered_at.toISOString()}`,
          false,
          { application_id: application._id, caseId: application.application_number || application._id.toString() },
        );
      }
      return success(res, req, application);
    } catch (error) { return next(error); }
  });

  router.post("/:id/stage/return", requireRole("SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER"), validateIdParam, validate(reasonSchema), async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = await Application.findOne({ _id: req.params.id, ...(scope || {}) });
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      if (application.status !== "IN_PROGRESS") return res.status(409).json({ data: null, error: { code: "INVALID_APPLICATION_STATE", message: "Only an in-progress application can be returned" }, meta: { requestId: req.id } });
      const config = await StageConfig.findOne({ application_type: application.type, stage: application.current_stage, enabled: true }).lean();
      const responsibleRole = config?.role_responsible || roleByStage[application.current_stage];
      if (req.user.role !== responsibleRole) return res.status(403).json({ data: null, error: { code: "WRONG_STAGE_ROLE", message: "Only the responsible stage role may return this application" }, meta: { requestId: req.id } });
      const before = application.toObject();
      const fromStage = application.current_stage;
      application.current_stage = "SCRUTINY";
      application.status = "RETURNED";
      application.stage_entered_at = new Date();
      try {
        await withTransaction(async (session) => {
          await application.save({ session });
          await StageHistory.create([{ application_id: application._id, from_stage: fromStage, to_stage: "SCRUTINY", actor_id: req.user._id, reason: req.body.reason }], { session });
          await writeAudit({ actor_id: req.user._id, action: "APPLICATION_STAGE_RETURNED", entity: "Application", entity_id: application._id, before_json: before, after_json: application.toObject(), ip: req.ip }, { session });
          const institutionUser = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id").session(session);
          await Alert.create([{ application_id: application._id, type: "APPLICATION_RETURNED", severity: "MEDIUM", target_user_id: institutionUser?._id || req.user._id, title: "Application returned for correction", body: req.body.reason }], { session });
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Application changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      const institutionUser = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
      await queueUserNotice(
        institutionUser?._id,
        "APPLICATION_RETURNED",
        "Application returned for correction",
        req.body.reason,
        `application:${application._id}:returned:${application.stage_entered_at.toISOString()}`,
        true,
        { application_id: application._id, caseId: application.application_number || application._id.toString() },
      );
      return success(res, req, application);
    } catch (error) { return next(error); }
  });

  router.post("/:id/resubmit", requireRole("INSTITUTION", "ADMIN"), validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = await Application.findOne({ _id: req.params.id, status: "RETURNED", ...(scope || {}) });
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Returned application not found" }, meta: { requestId: req.id } });
      const before = application.toObject();
      application.status = "IN_PROGRESS";
      application.current_stage = "SCRUTINY";
      application.stage_entered_at = new Date();
      try {
        await withTransaction(async (session) => {
          await application.save({ session });
          await StageHistory.create([{ application_id: application._id, from_stage: before.current_stage, to_stage: "SCRUTINY", actor_id: req.user._id, reason: "Institution resubmitted after correction" }], { session });
          await writeAudit({ actor_id: req.user._id, action: "APPLICATION_RESUBMITTED", entity: "Application", entity_id: application._id, before_json: before, after_json: application.toObject(), ip: req.ip }, { session });
        });
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) return res.status(409).json({ data: null, error: { code: "VERSION_CONFLICT", message: "Application changed concurrently; reload and retry" }, meta: { requestId: req.id } });
        throw error;
      }
      if (application.assigned_officer_id) {
        await queueUserNotice(
          application.assigned_officer_id,
          "APPLICATION_RESUBMITTED",
          "Application resubmitted",
          `Case ${application.application_number || application._id} is ready for scrutiny.`,
          `application:${application._id}:resubmitted:${application.stage_entered_at.toISOString()}`,
          false,
          { application_id: application._id, caseId: application.application_number || application._id.toString() },
        );
      }
      return success(res, req, application);
    } catch (error) { return next(error); }
  });

  router.patch("/:id", requireRole("ADMIN"), validateIdParam, validate(applicationPatchSchema), async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const filter = { _id: req.params.id, ...(scope || {}) };
      const before = await Application.findOne(filter).lean();
      if (!before) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      const application = await Application.findOneAndUpdate(filter, { $set: req.body }, { new: true, runValidators: true });
      await writeAudit({ actor_id: req.user._id, action: "APPLICATION_UPDATED", entity: "Application", entity_id: application._id, before_json: before, after_json: application.toObject(), ip: req.ip });
      return success(res, req, application);
    } catch (error) { return next(error); }
  });

  router.get("/:id", validateIdParam, async (req, res, next) => {
    try {
      const scope = await applicationScope(req);
      const application = scope && await Application.findOne({ _id: req.params.id, ...scope }).populate("institution_id", "aicte_id name state region").lean();
      if (!application) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Application not found" }, meta: { requestId: req.id } });
      return success(res, req, application);
    } catch (error) { return next(error); }
  });
  return router;
}

async function stagesFor(type) {
  const configured = await StageConfig.find({ application_type: type, enabled: true, stage: { $nin: ["SUBMITTED", "COMPLETED"] } }).sort({ sequence: 1 }).select("stage").lean();
  return configured.length ? configured.map((item) => item.stage) : defaultPaths[type] || [];
}
