import express from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { Alert, Application, Document, Faculty, Institution, LeaseDetail, PendingItem, Student, Undertaking, User, Visit, YearlyReport } from "../../models/index.js";

const roles = ["INSTITUTION", "SCRUTINY_OFFICER", "EVC", "SAC_SHC", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"];

async function baseScope(user) {
  if (user.role === "INSTITUTION") {
    let institutionId = user.institution_id;
    if (!institutionId) institutionId = (await Institution.findOne({ contact_email: user.email }).select("_id"))?._id;
    return institutionId ? { institution_id: institutionId } : { _id: null };
  }
  if (["SCRUTINY_OFFICER", "EVC"].includes(user.role)) return { assigned_officer_id: user._id };
  if (user.region && user.role !== "ADMIN") {
    const institutionIds = await Institution.find({ region: user.region }).distinct("_id");
    return { institution_id: { $in: institutionIds } };
  }
  return {};
}

function respond(res, req, data) {
  return res.json({ data, error: null, meta: { requestId: req.id } });
}

export function dashboardRouter() {
  const router = express.Router();
  router.use(authenticate, requireRole(...roles));
  router.get("/overview", async (req, res, next) => {
    try {
      const scope = await baseScope(req.user);
      const apps = { ...scope, deleted_at: null };
      const applicationIds = await Application.find(apps).distinct("_id");
      const appRef = { application_id: { $in: applicationIds } };
      const [applications, byStatus, byStage, pendingItems, overdueUndertakings, alerts, leasesExpiring, students, faculty, visits] = await Promise.all([
        Application.countDocuments(apps),
        Application.aggregate([{ $match: apps }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        Application.aggregate([{ $match: apps }, { $group: { _id: "$current_stage", count: { $sum: 1 } } }]),
        PendingItem.countDocuments({ ...appRef, resolved_at: null }),
        Undertaking.countDocuments({ ...appRef, status: "OVERDUE" }),
        Alert.countDocuments({ target_user_id: req.user._id, status: "OPEN" }),
        LeaseDetail.countDocuments({ document_id: { $in: await Document.find({ ...appRef, status: "CONFIRMED" }).distinct("_id") }, validity_status: "EXPIRING" }),
        scope.institution_id ? Student.countDocuments({ institution_id: scope.institution_id, status: "ACTIVE", deleted_at: null }) : 0,
        scope.institution_id ? Faculty.countDocuments({ institution_id: scope.institution_id, status: "ACTIVE", deleted_at: null }) : 0,
        req.user.role === "EVC" ? Visit.countDocuments({ evc_user_id: req.user._id, status: "SCHEDULED" }) : 0,
      ]);
      return respond(res, req, {
        applications,
        statusCounts: Object.fromEntries(byStatus.map((row) => [row._id, row.count])),
        stageCounts: Object.fromEntries(byStage.map((row) => [row._id, row.count])),
        pendingInstitutionItems: pendingItems,
        overdueUndertakings,
        openAlerts: alerts,
        expiringLeases: leasesExpiring,
        activeStudents: students,
        activeFaculty: faculty,
        scheduledVisits: visits,
      });
    } catch (error) { return next(error); }
  });
  router.get("/workload", requireRole("SCRUTINY_OFFICER", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"), async (req, res, next) => {
    try {
      const scope = await baseScope(req.user);
      const [stages, officers] = await Promise.all([
        Application.aggregate([{ $match: { ...scope, status: "IN_PROGRESS", deleted_at: null } }, { $group: { _id: "$current_stage", count: { $sum: 1 } } }]),
        Application.aggregate([
          { $match: { ...scope, status: "IN_PROGRESS", deleted_at: null, assigned_officer_id: { $ne: null } } },
          { $group: { _id: "$assigned_officer_id", count: { $sum: 1 } } },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "officer" } },
          { $unwind: "$officer" },
          { $project: { _id: 0, officer_id: "$_id", name: "$officer.name", role: "$officer.role", count: 1 } },
          { $sort: { count: -1 } },
        ]),
      ]);
      return respond(res, req, { stageWise: stages, officerWise: officers });
    } catch (error) { return next(error); }
  });
  router.get("/compliance", requireRole("INSTITUTION", "BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"), async (req, res, next) => {
    try {
      const scope = await baseScope(req.user);
      const applicationIds = await Application.find({ ...scope, deleted_at: null }).distinct("_id");
      const docIds = await Document.find({ application_id: { $in: applicationIds }, status: "CONFIRMED" }).distinct("_id");
      const [undertakings, leases, pending, reports] = await Promise.all([
        Undertaking.aggregate([{ $match: { application_id: { $in: applicationIds } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        LeaseDetail.aggregate([{ $match: { document_id: { $in: docIds } } }, { $group: { _id: "$validity_status", count: { $sum: 1 } } }]),
        PendingItem.countDocuments({ application_id: { $in: applicationIds }, resolved_at: null }),
        YearlyReport.countDocuments({ institution_id: scope.institution_id || { $exists: true }, status: { $in: ["OVERDUE", "RETURNED"] } }),
      ]);
      return respond(res, req, { undertakings, leases, openPendingItems: pending, overdueOrReturnedReports: reports });
    } catch (error) { return next(error); }
  });
  router.get("/analytics", requireRole("BUREAU_OFFICER", "SENIOR_AUTHORITY", "ADMIN"), validate(z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }).strict(), "query"), async (req, res, next) => {
    try {
      const filter = {};
      if (req.query.from || req.query.to) filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = req.query.from;
      if (req.query.to) filter.createdAt.$lte = req.query.to;
      const [applicationVolume, institutions, activeStudents, activeFaculty] = await Promise.all([
        Application.aggregate([{ $match: filter }, { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } }, { $sort: { "_id.year": 1, "_id.month": 1 } }]),
        Institution.countDocuments({ deleted_at: null }),
        Student.countDocuments({ status: "ACTIVE", deleted_at: null }),
        Faculty.countDocuments({ status: "ACTIVE", deleted_at: null }),
      ]);
      return respond(res, req, { applicationVolume, institutions, activeStudents, activeFaculty });
    } catch (error) { return next(error); }
  });
  return router;
}
