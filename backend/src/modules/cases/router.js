import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { CaseDecision, CaseObligation, CaseRecord, CaseStageHistory, Institution, OutboxEvent, Policy, User } from "../../models/index.js";
import { APPLICATION_TYPES, buildChecklist, missingChecklistItems, normalizeApplicability } from "../../engine/checklist.js";
import { buildCaseRoute, returnTargetIsEarlier } from "../../engine/routes.js";
import { dueStatus } from "../../engine/timeRules.js";
import { logger } from "../../config/logger.js";

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
  if (["EVC", "SAC_SHC"].includes(user.role)) return { ...filter, holderId: user._id };
  if (["BUREAU_OFFICER", "SENIOR_AUTHORITY"].includes(user.role)) {
    return user.region ? { ...filter, region: user.region } : filter;
  }
  return null;
}

export async function scopedCase(caseId, user) {
  if (!mongoose.isValidObjectId(caseId)) return null;
  const record = await CaseRecord.findOne({ _id: caseId, deletedAt: null });
  if (!record) return null;
  if (record.status === "draft" && user.role !== "INSTITUTION") return null;
  if (user.role === "ADMIN") return record;
  if (user.role === "INSTITUTION") {
    const institutionId = await institutionIdFor(user);
    return institutionId && institutionId.equals(record.institutionId) ? record : null;
  }
  if (user.role === "SCRUTINY_OFFICER") {
    return record.region === user.region || record.holderId?.equals(user._id) ? record : null;
  }
  if (["EVC", "SAC_SHC"].includes(user.role)) return record.holderId?.equals(user._id) ? record : null;
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

function holderIsUser(record, user) {
  if (record.holderType === "institution" && user.role === "INSTITUTION") {
    return institutionIdFor(user).then((institutionId) => Boolean(institutionId && institutionId.equals(record.institutionId)));
  }
  return record.holderId?.equals(user._id) || false;
}

function stageRole(stage) {
  if (["scrutiny", "re_scrutiny", "regional_committee"].includes(stage)) return { role: "SCRUTINY_OFFICER", holderType: "officer" };
  if (stage === "evc") return { role: "EVC", holderType: "committee" };
  if (["shc", "sac"].includes(stage)) return { role: "SAC_SHC", holderType: "committee" };
  if (stage === "decision") return { role: "BUREAU_OFFICER", holderType: "officer" };
  return { role: null, holderType: "institution" };
}

async function assignedHolder(stage, region) {
  const assignment = stageRole(stage);
  if (!assignment.role) return { holderType: assignment.holderType, holderId: null };
  const user = await User.findOne({
    role: assignment.role,
    status: "ACTIVE",
    deleted_at: null,
    ...(region ? { region } : {}),
  }).select("_id").lean();
  return { holderType: assignment.holderType, holderId: user?._id || null };
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

export function casesRouter() {
  const router = express.Router();

  router.get("/application-types", (_req, res) => respond(res, _req, APPLICATION_TYPES.map((id) => ({ id, label: id.replaceAll("_", " ") }))));
  router.post("/checklist/preview", authenticate, validate(previewSchema), async (req, res, next) => {
    try {
      const policy = await activePolicy();
      if (!policy) return res.status(503).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "No signed-off policy is configured" }, meta: { requestId: req.id } });
      return respond(res, req, {
        policyVersion: policy.version,
        route: buildCaseRoute(req.body.applicationType, policy.routes, req.body.routeFlags),
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
        notes: z.string().max(4000).optional().default(""),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, meta: { requestId: req.id } });
      const routes = buildPolicyRoutes(parsed.data.routes);
      const policy = await Policy.create({
        ...parsed.data,
        routes,
        checklist: parsed.data.checklist || (await activePolicy())?.checklist || [],
        status: "draft",
      });
      await writeAudit({ actor_id: req.user._id, action: "POLICY_DRAFT_CREATED", entity: "Policy", entity_id: policy._id, after_json: { version: policy.version }, ip: req.ip });
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
      await withTransaction(async (session) => {
        await Policy.updateMany({ status: "signed_off" }, { $set: { status: "retired" } }, session ? { session } : {});
        policy.status = "signed_off";
        policy.signedOffBy = req.user._id;
        policy.signedOffAt = signedOffAt;
        await policy.save(session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "POLICY_SIGNED_OFF", entity: "Policy", entity_id: policy._id, after_json: { version: policy.version, reason: body.data.reason }, ip: req.ip }, { session });
      });
      return respond(res, req, policy);
    } catch (error) { return next(error); }
  });

  router.get("/policies/:a/diff/:b", authenticate, async (req, res, next) => {
    try {
      if (req.user.role !== "ADMIN") return deny(req, res, { message: "Only administrators can compare policy versions", entityId: req.params.a, action: "POLICY_DIFF_DENIED" });
      const [left, right] = await Promise.all([Policy.findOne({ version: req.params.a }).lean(), Policy.findOne({ version: req.params.b }).lean()]);
      if (!left || !right) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "One or both policy versions were not found" }, meta: { requestId: req.id } });
      return respond(res, req, { from: left.version, to: right.version, routesChanged: JSON.stringify(left.routes) !== JSON.stringify(right.routes), checklistChanged: JSON.stringify(left.checklist) !== JSON.stringify(right.checklist), blockSubmitOnMissingChanged: left.blockSubmitOnMissing !== right.blockSubmitOnMissing });
    } catch (error) { return next(error); }
  });

  router.get("/cases", authenticate, validate(listSchema, "query"), async (req, res, next) => {
    try {
      const filter = await caseFilterForUser(req.user);
      if (!filter) return deny(req, res, { message: "This role cannot view workflow cases", entityId: "case-list" });
      if (req.user.role === "INSTITUTION" && !filter.institutionId) {
        return respond(res, req, [], 200, { total: 0, page: req.query.page, pageSize: req.query.pageSize });
      }
      if (req.query.status) {
        if (filter.$and) filter.$and.push({ status: req.query.status });
        else filter.status = req.query.status;
      }
      if (req.query.applicationType) filter.applicationType = req.query.applicationType;
      const { page, pageSize } = req.query;
      const [items, total] = await Promise.all([
        CaseRecord.find(filter).populate("institutionId", "name").sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        CaseRecord.countDocuments(filter),
      ]);
      return respond(res, req, items, 200, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.post("/cases", authenticate, async (req, res, next) => {
    try {
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
          route: buildCaseRoute(parsed.data.applicationType, policy.routes, parsed.data.routeFlags),
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
      if (policy.blockSubmitOnMissing && missing.length) return res.status(422).json({ data: null, error: { code: "MISSING_DOCUMENTS", message: "Required documents are missing", details: missing.map(({ slotId, label }) => ({ slotId, label })) }, meta: { requestId: req.id } });
      const before = record.toObject();
      const now = new Date();
      await withTransaction(async (session) => {
        record.status = "submitted";
        record.currentStage = "self_disclosure";
        record.submittedAt = now;
        record.stageEnteredAt = now;
        record.version += 1;
        await record.save(session ? { session } : {});
        await recordStageChange(session, record, "submitted", req.user._id, "Final submission");
        await writeAudit({ actor_id: req.user._id, action: "CASE_SUBMITTED", entity: "CaseRecord", entity_id: record._id, before_json: { status: before.status, version: before.version }, after_json: { status: record.status, version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.submitted", record, req.user._id);
      });
      return respond(res, req, { case: record, checklist, missingDocuments: missing.map(({ slotId, label }) => ({ slotId, label })), warning: missing.length > 0 ? "Missing documents are present; submission was accepted." : null }, 200);
    } catch (error) { return next(error); }
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
      record.route = buildCaseRoute(record.applicationType, policy.routes, record.routeFlags);
      await withTransaction(async (session) => {
        record.version += 1;
        await record.save(session ? { session } : {});
        await writeAudit({ actor_id: req.user._id, action: "CASE_DRAFT_UPDATED", entity: "CaseRecord", entity_id: record._id, before_json: { applicability: before.applicability, routeFlags: before.routeFlags }, after_json: { version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.draft_updated", record, req.user._id);
      });
      return respond(res, req, record);
    } catch (error) { return next(error); }
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
      return respond(res, req, { policyVersion: record.policyVersion, checklist, missingDocuments: missing.map(({ slotId, label }) => ({ slotId, label })) });
    } catch (error) { return next(error); }
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

  router.post("/cases/:id/advance", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = advanceSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "expectedVersion and completedChecklist are required" }, meta: { requestId: req.id } });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
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
      const assignment = await assignedHolder(nextStage, record.region);
      const previousStage = record.currentStage;
      const now = new Date();
      await withTransaction(async (session) => {
        record.completedStages = [...new Set([...record.completedStages, previousStage])];
        record.currentStage = nextStage;
        record.holderType = assignment.holderType;
        record.holderId = assignment.holderId;
        record.status = "in_progress";
        record.stageEnteredAt = now;
        record.version += 1;
        await record.save(session ? { session } : {});
        await recordStageChange(session, record, previousStage, req.user._id);
        await writeAudit({ actor_id: req.user._id, action: "CASE_STAGE_ADVANCED", entity: "CaseRecord", entity_id: record._id, after_json: { from: previousStage, to: nextStage, holderType: record.holderType, version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.stage_advanced", record, req.user._id);
      });
      return respond(res, req, record);
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
      if (policy.blockSubmitOnMissing && missing.length) return res.status(422).json({ data: null, error: { code: "MISSING_DOCUMENTS", message: "Required documents are missing", details: missing.map(({ slotId, label }) => ({ slotId, label })) }, meta: { requestId: req.id } });
      const previousStage = record.currentStage;
      const assignment = await assignedHolder("re_scrutiny", record.region);
      const now = new Date();
      await withTransaction(async (session) => {
        record.currentStage = "re_scrutiny";
        record.holderType = assignment.holderType;
        record.holderId = assignment.holderId;
        record.status = "in_progress";
        record.stageEnteredAt = now;
        record.version += 1;
        await record.save(session ? { session } : {});
        await recordStageChange(session, record, previousStage, req.user._id, "Institution resubmitted");
        await writeAudit({ actor_id: req.user._id, action: "CASE_RESUBMITTED", entity: "CaseRecord", entity_id: record._id, after_json: { version: record.version }, ip: req.ip }, { session });
        await createOutbox(session, "case.resubmitted", record, req.user._id);
      });
      return respond(res, req, { case: record, missingDocuments: missing.map(({ slotId, label }) => ({ slotId, label })) });
    } catch (error) { return next(error); }
  });

  router.post("/cases/:id/decision", authenticate, async (req, res, next) => {
    try {
      const parsed = z.object({ id: objectId }).strict().safeParse(req.params);
      const body = decisionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid case id" }, meta: { requestId: req.id } });
      if (!body.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: body.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, meta: { requestId: req.id } });
      if (req.user.role !== "BUREAU_OFFICER") return deny(req, res, { message: "Only the competent authority may record the final decision", entityId: parsed.data.id, action: "CASE_DECISION_DENIED" });
      const record = await scopedCase(parsed.data.id, req.user);
      if (!record) return deny(req, res, { status: 404, code: "NOT_FOUND", message: "Case not found in your scope", entityId: parsed.data.id, action: "CASE_SCOPE_DENIED" });
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
      const policy = await Policy.findOne({ version: record.policyVersion }).lean();
      if (!policy) return res.status(409).json({ data: null, error: { code: "POLICY_UNAVAILABLE", message: "The case policy version is unavailable" }, meta: { requestId: req.id } });
      const checklist = checklistFor(record, policy);
      return respond(res, req, { ...record.toObject(), checklist, missingDocuments: missingChecklistItems(checklist).map(({ slotId, label }) => ({ slotId, label })) });
    } catch (error) { return next(error); }
  });

  return router;
}
