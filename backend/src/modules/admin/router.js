import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { APPLICATION_STAGES, APPLICATION_TYPES, ROLES } from "../../config/constants.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { verifyAuditEntries, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { AuditHead, AuditLog, Institution, NotificationJob, NotificationLog, RuleConfig, StageConfig, User } from "../../models/index.js";
import { runJob, jobHandlers } from "../jobs/run.js";
import { DEFAULT_RULES } from "../rules/engine.js";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).passthrough();
const userCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  phone: z.string().max(32).optional().default(""),
  password: z.string().min(12).max(128),
  role: z.enum(ROLES),
  institution_id: id.optional(),
  region: z.string().max(100).optional().default(""),
}).strict();
const institutionSchema = z.object({
  aicte_id: z.string().trim().min(3).max(40),
  name: z.string().trim().min(2).max(200),
  state: z.string().trim().min(2).max(100),
  region: z.string().trim().min(2).max(100),
  contact_email: z.string().email().max(254),
  contact_phone: z.string().max(32).optional().default(""),
}).strict();
const stageConfigSchema = z.object({
  application_type: z.enum(APPLICATION_TYPES),
  stage: z.enum(APPLICATION_STAGES),
  sequence: z.coerce.number().int().min(0),
  role_responsible: z.enum(ROLES),
  max_days: z.coerce.number().int().min(1).max(365),
  requires_reason_on_delay: z.boolean().default(true),
  enabled: z.boolean().default(true),
  basis: z.enum(["REAL", "SYNTHETIC"]).default("SYNTHETIC"),
}).strict();
const ruleSchema = z.object({
  enabled: z.boolean(),
  params_json: z.record(z.string(), z.unknown()).default({}),
}).strict();

function send(res, req, data, meta = {}, status = 200) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id, ...meta } });
}

function parsePage(req, res, next) {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Invalid pagination query" }, meta: { requestId: req.id } });
  req.pageQuery = parsed.data;
  next();
}

function isDuplicate(error) {
  return error?.code === 11000;
}

export function adminRouter() {
  const router = express.Router();
  const adminOnly = [authenticate, requireRole("ADMIN")];

  router.get("/users", adminOnly, parsePage, async (req, res, next) => {
    try {
      const { page, pageSize } = req.pageQuery;
      const [users, total] = await Promise.all([
        User.find({ deleted_at: null }).select("-password_hash -failed_login_attempts -locked_until").sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        User.countDocuments({ deleted_at: null }),
      ]);
      return send(res, req, users, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/users", adminOnly, validate(userCreateSchema), async (req, res, next) => {
    try {
      if (["INSTITUTION", "STUDENT", "FACULTY"].includes(req.body.role)) {
        if (!req.body.institution_id) return res.status(400).json({ data: null, error: { code: "INSTITUTION_REQUIRED", message: "This account role must be linked to an institution" }, meta: { requestId: req.id } });
        if (!await Institution.exists({ _id: req.body.institution_id, deleted_at: null })) return res.status(404).json({ data: null, error: { code: "INSTITUTION_NOT_FOUND", message: "Institution not found" }, meta: { requestId: req.id } });
      }
      const { default: argon2 } = await import("argon2");
      const user = await User.create({
        ...req.body,
        email: req.body.email.toLowerCase(),
        password_hash: await argon2.hash(req.body.password, { type: argon2.argon2id }),
      });
      await writeAudit({ actor_id: req.user._id, action: "ADMIN_USER_CREATED", entity: "User", entity_id: user._id, after_json: { role: user.role, email: user.email }, ip: req.ip });
      return send(res, req, { id: user._id, role: user.role, email: user.email }, {}, 201);
    } catch (error) {
      if (isDuplicate(error)) return res.status(409).json({ data: null, error: { code: "EMAIL_ALREADY_EXISTS", message: "An account with this email already exists" }, meta: { requestId: req.id } });
      return next(error);
    }
  });
  router.patch("/users/:id/status", adminOnly, validate(z.object({ id }).strict(), "params"), validate(z.object({ status: z.enum(["ACTIVE", "PENDING_VERIFICATION", "LOCKED", "DISABLED"]) }).strict()), async (req, res, next) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user || user.deleted_at) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "User not found" }, meta: { requestId: req.id } });
      const before = user.status;
      user.status = req.body.status;
      await user.save();
      await writeAudit({ actor_id: req.user._id, action: "ADMIN_USER_STATUS_CHANGED", entity: "User", entity_id: user._id, before_json: { status: before }, after_json: { status: user.status }, ip: req.ip });
      return send(res, req, { id: user._id, status: user.status });
    } catch (error) { return next(error); }
  });

  router.get("/institutions", adminOnly, parsePage, async (req, res, next) => {
    try {
      const { page, pageSize } = req.pageQuery;
      const [items, total] = await Promise.all([
        Institution.find({ deleted_at: null }).sort({ name: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        Institution.countDocuments({ deleted_at: null }),
      ]);
      return send(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/institutions", adminOnly, validate(institutionSchema), async (req, res, next) => {
    try {
      const institution = await Institution.create({ ...req.body, aicte_id: req.body.aicte_id.toUpperCase() });
      await writeAudit({ actor_id: req.user._id, action: "INSTITUTION_CREATED", entity: "Institution", entity_id: institution._id, after_json: institution.toObject(), ip: req.ip });
      return send(res, req, institution, {}, 201);
    } catch (error) {
      if (isDuplicate(error)) return res.status(409).json({ data: null, error: { code: "INSTITUTION_ID_EXISTS", message: "AICTE institution ID already exists" }, meta: { requestId: req.id } });
      return next(error);
    }
  });

  router.get("/rules", adminOnly, async (req, res, next) => {
    try {
      const stored = await RuleConfig.find().sort({ rule_id: 1 }).lean();
      const overrides = new Map(stored.map((rule) => [rule.rule_id, rule]));
      return send(res, req, Object.entries(DEFAULT_RULES).map(([rule_id, defaults]) => {
        const override = overrides.get(rule_id);
        return { rule_id, basis: override?.basis || defaults.basis, enabled: override?.enabled ?? defaults.enabled, params_json: override?.params_json || defaults.params };
      }));
    } catch (error) { return next(error); }
  });
  router.patch("/rules/:ruleId", adminOnly, validate(z.object({ ruleId: z.string().min(1).max(60) }).strict(), "params"), validate(ruleSchema), async (req, res, next) => {
    try {
      if (!DEFAULT_RULES[req.params.ruleId]) return res.status(404).json({ data: null, error: { code: "UNKNOWN_RULE", message: "Rule is not registered" }, meta: { requestId: req.id } });
      const saved = await RuleConfig.findOneAndUpdate(
        { rule_id: req.params.ruleId },
        { $set: { enabled: req.body.enabled, params_json: req.body.params_json, updated_by: req.user._id, basis: DEFAULT_RULES[req.params.ruleId].basis } },
        { upsert: true, new: true, runValidators: true },
      );
      await writeAudit({ actor_id: req.user._id, action: "RULE_CONFIG_UPDATED", entity: "RuleConfig", entity_id: saved._id, after_json: saved.toObject(), ip: req.ip });
      return send(res, req, saved);
    } catch (error) { return next(error); }
  });

  router.get("/stage-config", adminOnly, async (req, res, next) => {
    try { return send(res, req, await StageConfig.find().sort({ application_type: 1, sequence: 1 }).lean()); }
    catch (error) { return next(error); }
  });
  router.put("/stage-config", adminOnly, validate(stageConfigSchema), async (req, res, next) => {
    try {
      const item = await StageConfig.findOneAndUpdate(
        { application_type: req.body.application_type, stage: req.body.stage },
        { $set: req.body },
        { upsert: true, new: true, runValidators: true },
      );
      await writeAudit({ actor_id: req.user._id, action: "STAGE_CONFIG_UPDATED", entity: "StageConfig", entity_id: item._id, after_json: item.toObject(), ip: req.ip });
      return send(res, req, item);
    } catch (error) { return next(error); }
  });

  router.get("/audit-logs", adminOnly, parsePage, async (req, res, next) => {
    try {
      const { page, pageSize } = req.pageQuery;
      const [items, total] = await Promise.all([
        AuditLog.find().sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).populate("actor_id", "name role email").lean(),
        AuditLog.countDocuments(),
      ]);
      return send(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.get("/audit/verify-chain", adminOnly, async (req, res, next) => {
    try {
      const entries = await AuditLog.find({ seq: { $exists: true } }).sort({ seq: 1 }).lean();
      const chain = verifyAuditEntries(entries);
      const head = await AuditHead.findById("global").lean();
      const headMatches = !head || (head.sequence === chain.checked && head.lastHash === chain.lastHash);
      return send(res, req, { ...chain, valid: chain.valid && headMatches, headMatches });
    } catch (error) { return next(error); }
  });
  router.post("/jobs/:name/run", adminOnly, validate(z.object({ name: z.string().min(1).max(80) }).strict(), "params"), async (req, res, next) => {
    try {
      if (!Object.hasOwn(jobHandlers, req.params.name)) return res.status(404).json({ data: null, error: { code: "UNKNOWN_JOB", message: "Scheduled job not found" }, meta: { requestId: req.id } });
      const summary = await runJob(req.params.name);
      await writeAudit({ actor_id: req.user._id, action: "ADMIN_JOB_TRIGGERED", entity: "ScheduledJob", entity_id: req.params.name, after_json: summary, ip: req.ip });
      return send(res, req, { job: req.params.name, summary });
    } catch (error) { return next(error); }
  });
  router.get("/notifications", adminOnly, parsePage, async (req, res, next) => {
    try {
      const { page, pageSize } = req.pageQuery;
      const [items, total] = await Promise.all([
        NotificationLog.find().sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        NotificationLog.countDocuments(),
      ]);
      return send(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });
  router.post("/notifications/:id/retry", adminOnly, validate(z.object({ id }).strict(), "params"), async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ data: null, error: { code: "INVALID_ID", message: "Invalid notification id" }, meta: { requestId: req.id } });
      const job = await NotificationJob.findOneAndUpdate(
        { _id: req.params.id, status: "FAILED" },
        { $set: { status: "PENDING", run_at: new Date(), attempts: 0, last_error: "", locked_at: null } },
        { new: true },
      );
      if (!job) return res.status(404).json({ data: null, error: { code: "RETRY_NOT_AVAILABLE", message: "Failed notification job not found" }, meta: { requestId: req.id } });
      await writeAudit({ actor_id: req.user._id, action: "NOTIFICATION_RETRY_REQUESTED", entity: "NotificationJob", entity_id: job._id, ip: req.ip });
      return send(res, req, { id: job._id, status: job.status });
    } catch (error) { return next(error); }
  });
  return router;
}
