import express from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { Application, Faculty, Institution, Student, User } from "../../models/index.js";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const patchSchema = z.object({
  contact_email: z.string().email().max(254).optional(),
  contact_phone: z.string().max(32).optional(),
}).strict();

export function institutionsRouter() {
  const router = express.Router();
  router.use(authenticate);
  router.get("/", requireRole("ADMIN", "INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY"), async (req, res, next) => {
    try {
      const filter = { deleted_at: null };
      if (req.user.role === "INSTITUTION") {
        let institutionId = req.user.institution_id;
        if (!institutionId) institutionId = (await Institution.findOne({ contact_email: req.user.email }).select("_id"))?._id;
        if (!institutionId) return res.json({ data: [], error: null, meta: { requestId: req.id } });
        filter._id = institutionId;
      } else if (req.user.role !== "ADMIN" && req.user.region) filter.region = req.user.region;
      const items = await Institution.find(filter).sort({ name: 1 }).lean();
      return res.json({ data: items, error: null, meta: { requestId: req.id } });
    } catch (error) { return next(error); }
  });
  router.get("/:id", requireRole("ADMIN", "INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY"), validate(z.object({ id }).strict(), "params"), async (req, res, next) => {
    try {
      const filter = { _id: req.params.id, deleted_at: null };
      if (req.user.role === "INSTITUTION") {
        let own = req.user.institution_id;
        if (!own) own = (await Institution.findOne({ contact_email: req.user.email }).select("_id"))?._id;
        if (!own || own.toString() !== req.params.id) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Institution not found" }, meta: { requestId: req.id } });
      } else if (req.user.role !== "ADMIN" && req.user.region) filter.region = req.user.region;
      const institution = await Institution.findOne(filter).lean();
      if (!institution) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Institution not found" }, meta: { requestId: req.id } });
      const [applications, activeStudents, activeFaculty] = await Promise.all([
        Application.countDocuments({ institution_id: institution._id, deleted_at: null }),
        Student.countDocuments({ institution_id: institution._id, status: "ACTIVE", deleted_at: null }),
        Faculty.countDocuments({ institution_id: institution._id, status: "ACTIVE", deleted_at: null }),
      ]);
      return res.json({ data: { ...institution, counts: { applications, activeStudents, activeFaculty } }, error: null, meta: { requestId: req.id } });
    } catch (error) { return next(error); }
  });
  router.patch("/:id", requireRole("INSTITUTION", "ADMIN"), validate(z.object({ id }).strict(), "params"), validate(patchSchema), async (req, res, next) => {
    try {
      const filter = { _id: req.params.id, deleted_at: null };
      if (req.user.role === "INSTITUTION") filter._id = req.user.institution_id;
      const before = await Institution.findOne(filter).lean();
      if (!before) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Institution not found" }, meta: { requestId: req.id } });
      let institution;
      await withTransaction(async (session) => {
        institution = await Institution.findOneAndUpdate(filter, { $set: req.body }, { new: true, runValidators: true, session });
        if (req.user.role === "INSTITUTION" && req.body.contact_email) {
          await User.updateMany(
            { institution_id: institution._id, role: "INSTITUTION" },
            { $set: { email: req.body.contact_email.toLowerCase() } },
            { session },
          );
        }
        await writeAudit({ actor_id: req.user._id, action: "INSTITUTION_UPDATED", entity: "Institution", entity_id: institution._id, before_json: before, after_json: institution.toObject(), ip: req.ip }, { session });
      });
      return res.json({ data: institution, error: null, meta: { requestId: req.id } });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ data: null, error: { code: "EMAIL_ALREADY_EXISTS", message: "That contact email is already in use" }, meta: { requestId: req.id } });
      return next(error);
    }
  });
  return router;
}
