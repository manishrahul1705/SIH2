import express from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { Alert, AiExtraction, Application, CaseObligation, CaseRecord, Document, Faculty, Institution, LeaseDetail, PendingItem, Student, Undertaking, User, Visit, YearlyReport } from "../../models/index.js";
import { computeActionScore, projectActionScore } from "../../engine/score.js";

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
  router.get("/action-score", requireRole("INSTITUTION"), async (req, res, next) => {
    try {
      const institutionId = req.user.institution_id || (await Institution.findOne({ contact_email: req.user.email }).select("_id"))?._id;
      if (!institutionId) return res.status(409).json({ data: null, error: { code: "INSTITUTION_NOT_LINKED", message: "Link this account to an institution before viewing its score" }, meta: { requestId: req.id } });
      const cases = await CaseRecord.find({ institutionId, deletedAt: null, status: { $nin: ["approved", "rejected"] } }).select("_id slotRecords preliminary").lean();
      if (!cases.length) return respond(res, req, { assessmentComplete: false, current: computeActionScore({ assessmentComplete: false }), projected: projectActionScore({ assessmentComplete: false }, new Date(), 30), note: "No active case evidence is available for scoring." });
      const caseIds = cases.map((record) => record._id);
      const [obligations, docs] = await Promise.all([
        CaseObligation.find({ institutionId, caseId: { $in: caseIds }, closure: "open" }).lean(),
        Document.find({ case_id: { $in: caseIds }, status: "CONFIRMED" }).select("_id case_id doc_type_slot").lean(),
      ]);
      const documentIds = docs.map((document) => document._id);
      const extractions = await AiExtraction.find({ document_id: { $in: documentIds } })
        .select("document_id fields.field_name fields.confirmed_value")
        .sort({ createdAt: -1 }).lean();
      const extractionByDocument = new Map();
      for (const extraction of extractions) if (!extractionByDocument.has(String(extraction.document_id))) extractionByDocument.set(String(extraction.document_id), extraction.fields || []);
      const validityDocuments = docs.flatMap((document) => {
        const validTo = extractionByDocument.get(String(document._id))?.find((field) => field.field_name === "valid_to")?.confirmed_value;
        if (!validTo) return [];
        return [{ id: String(document._id), validTo, acceptedRenewal: false }];
      });
      const assessmentComplete = cases.every((record) => ["complete_clean", "complete_with_findings"].includes(record.preliminary));
      const facts = {
        assessmentComplete,
        obligations: obligations.filter((item) => item.type !== "evc").map((item) => ({
          id: String(item._id), ownerType: item.ownerType, dueAt: item.dueAt, dueKind: item.dueKind, submission: item.submission,
        })),
        evcObligations: obligations.filter((item) => item.type === "evc").map((item) => ({
          id: String(item._id), ownerType: item.ownerType, dueAt: item.dueAt, dueKind: item.dueKind,
        })),
        documents: validityDocuments,
      };
      return respond(res, req, {
        assessmentComplete,
        current: computeActionScore(facts),
        projected: projectActionScore(facts, new Date(), 30),
        assessedAt: new Date().toISOString(),
        note: "Calculated from open, institution-owned obligations and human-confirmed document dates in active cases. Officer-owned waits are excluded.",
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
