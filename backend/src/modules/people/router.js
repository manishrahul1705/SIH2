import express from "express";
import { z } from "zod";
import { Faculty, Institution, Student, User } from "../../models/index.js";
import { writeAudit } from "../../middleware/audit.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const studentCreate = z.object({
  institution_id: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  enrollment_no: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().max(32).optional().default(""),
  programme: z.string().trim().min(1).max(120),
  branch: z.string().trim().min(1).max(120),
  year: z.coerce.number().int().min(1).max(10),
  status: z.enum(["ACTIVE", "PASSED_OUT", "DROPPED"]).optional(),
}).strict();
const facultyCreate = z.object({
  institution_id: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  employee_id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().max(32).optional().default(""),
  designation: z.string().trim().min(1).max(120),
  qualification: z.string().trim().min(1).max(120),
  department: z.string().trim().min(1).max(120),
  date_of_joining: z.coerce.date(),
  status: z.enum(["ACTIVE", "ON_LEAVE", "RESIGNED"]).optional(),
}).strict();
const studentPatch = studentCreate.partial().strict();
const facultyPatch = facultyCreate.partial().strict();

function respond(res, req, data, meta = {}) {
  return res.json({ data, error: null, meta: { requestId: req.id, ...meta } });
}

function parseListQuery(req, res, next) {
  const result = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(["name", "createdAt", "programme", "department", "year", "status"]).default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    search: z.string().max(100).optional(),
    programme: z.string().max(120).optional(),
    department: z.string().max(120).optional(),
    status: z.string().max(40).optional(),
  }).strict().safeParse(req.query);
  if (!result.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "Invalid list query" }, meta: { requestId: req.id } });
  req.listQuery = result.data;
  return next();
}

async function institutionScope(req) {
  if (req.user.role === "ADMIN") return {};
  if (req.user.institution_id) return { institution_id: req.user.institution_id };
  if (req.user.role === "INSTITUTION") {
    const institution = await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id");
    if (institution) return { institution_id: institution._id };
  }
  return null;
}

async function linkedProfile(Model, req) {
  const institutionId = req.user.institution_id;
  if (!institutionId) return null;
  const email = req.user.email;
  return Model.findOne({ institution_id: institutionId, email, deleted_at: null });
}

function createPeopleRouter(kind) {
  const isStudent = kind === "students";
  const Model = isStudent ? Student : Faculty;
  const createSchema = isStudent ? studentCreate : facultyCreate;
  const patchSchema = isStudent ? studentPatch : facultyPatch;
  const router = express.Router();
  const managerRoles = ["INSTITUTION", "ADMIN"];
  const personRole = isStudent ? "STUDENT" : "FACULTY";

  router.use(authenticate);
  router.get("/", requireRole(...managerRoles, personRole), parseListQuery, async (req, res, next) => {
    try {
      const scope = await institutionScope(req);
      if (!scope) return res.status(403).json({ data: null, error: { code: "INSTITUTION_REQUIRED", message: "User is not linked to an institution" }, meta: { requestId: req.id } });
      if (req.user.role === personRole) {
        const own = await linkedProfile(Model, req);
        return own ? respond(res, req, [own]) : res.status(404).json({ data: null, error: { code: "PROFILE_NOT_FOUND", message: "Profile not found" }, meta: { requestId: req.id } });
      }
      const { page, pageSize, sortBy, sortOrder, search, programme, department, status } = req.listQuery;
      const filter = { ...scope, deleted_at: null };
      if (programme && isStudent) filter.programme = programme;
      if (department && !isStudent) filter.department = department;
      if (status) filter.status = status;
      if (search) filter.$or = [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { email: { $regex: escapeRegex(search), $options: "i" } },
        { [isStudent ? "enrollment_no" : "employee_id"]: { $regex: escapeRegex(search), $options: "i" } },
      ];
      const [items, total] = await Promise.all([
        Model.find(filter).sort({ [sortBy]: sortOrder === "asc" ? 1 : -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        Model.countDocuments(filter),
      ]);
      return respond(res, req, items, { page, pageSize, total, pages: Math.ceil(total / pageSize) });
    } catch (error) { return next(error); }
  });

  router.post("/", requireRole(...managerRoles), validate(createSchema), async (req, res, next) => {
    try {
      const scope = await institutionScope(req);
      const institutionId = req.user.role === "ADMIN" ? req.body.institution_id : scope?.institution_id;
      if (!institutionId || (req.user.role === "ADMIN" && !objectIdSchema.safeParse(String(institutionId)).success)) {
        return res.status(400).json({ data: null, error: { code: "INSTITUTION_REQUIRED", message: "A valid institution is required" }, meta: { requestId: req.id } });
      }
      const record = await Model.create({ ...req.body, institution_id: institutionId });
      await writeAudit({ actor_id: req.user._id, action: `${kind.toUpperCase()}_CREATED`, entity: isStudent ? "Student" : "Faculty", entity_id: record._id, after_json: record.toObject(), ip: req.ip });
      return res.status(201).json({ data: record, error: null, meta: { requestId: req.id } });
    } catch (error) { return next(error); }
  });

  router.get("/:id", requireRole(...managerRoles, personRole), validate(z.object({ id: objectIdSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const filter = { _id: req.params.id, deleted_at: null };
      if (req.user.role === personRole) {
        const own = await linkedProfile(Model, req);
        if (!own || own._id.toString() !== req.params.id) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Record not found" }, meta: { requestId: req.id } });
        return respond(res, req, own);
      }
      if (req.user.role !== "ADMIN") filter.institution_id = (await institutionScope(req))?.institution_id;
      const record = await Model.findOne(filter).lean();
      if (!record) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Record not found" }, meta: { requestId: req.id } });
      return respond(res, req, record);
    } catch (error) { return next(error); }
  });

  router.patch("/:id", requireRole(...managerRoles, personRole), validate(z.object({ id: objectIdSchema }).strict(), "params"), validate(patchSchema), async (req, res, next) => {
    try {
      let filter = { _id: req.params.id, deleted_at: null };
      let update = req.body;
      if (req.user.role === personRole) {
        const own = await linkedProfile(Model, req);
        if (!own || own._id.toString() !== req.params.id) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Record not found" }, meta: { requestId: req.id } });
        const allowed = isStudent ? ["name", "phone", "email"] : ["name", "phone", "email", "qualification"];
        update = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
        filter = { _id: own._id, institution_id: own.institution_id, deleted_at: null };
      } else if (req.user.role !== "ADMIN") filter.institution_id = (await institutionScope(req))?.institution_id;
      const before = await Model.findOne(filter).lean();
      if (!before) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Record not found" }, meta: { requestId: req.id } });
      const record = await Model.findOneAndUpdate(filter, { $set: update }, { new: true, runValidators: true });
      await writeAudit({ actor_id: req.user._id, action: `${kind.toUpperCase()}_UPDATED`, entity: isStudent ? "Student" : "Faculty", entity_id: record._id, before_json: before, after_json: record.toObject(), ip: req.ip });
      return respond(res, req, record);
    } catch (error) { return next(error); }
  });

  router.delete("/:id", requireRole(...managerRoles), validate(z.object({ id: objectIdSchema }).strict(), "params"), async (req, res, next) => {
    try {
      const filter = { _id: req.params.id, deleted_at: null };
      if (req.user.role !== "ADMIN") filter.institution_id = (await institutionScope(req))?.institution_id;
      const record = await Model.findOneAndUpdate(filter, { $set: { deleted_at: new Date() } }, { new: true });
      if (!record) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Record not found" }, meta: { requestId: req.id } });
      await writeAudit({ actor_id: req.user._id, action: `${kind.toUpperCase()}_SOFT_DELETED`, entity: isStudent ? "Student" : "Faculty", entity_id: record._id, after_json: { deleted_at: record.deleted_at }, ip: req.ip });
      return respond(res, req, { deleted: true });
    } catch (error) { return next(error); }
  });
  return router;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function peopleRouter() {
  const router = express.Router();
  router.use("/students", createPeopleRouter("students"));
  router.use("/faculty", createPeopleRouter("faculty"));
  return router;
}
