import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { validate } from "../../middleware/validate.js";
import { Announcement, Complaint, Faculty, Institution, OutboxEvent, Student, User } from "../../models/index.js";
import { localStorage } from "../documents/storage.js";
import { NotificationService } from "../notifications/service.js";
import { logger } from "../../config/logger.js";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const paramsId = z.object({ id }).strict();
const complaintInput = z.object({
  institution_id: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  category: z.enum(["FEES", "DOCUMENTS", "ACADEMIC", "FACILITIES", "SALARY_SERVICE", "SAFETY", "OTHER", "WITHHOLDING_DOCUMENTS", "EXCESS_FEE", "RAGGING_HARASSMENT", "FACULTY_SALARY_SERVICE", "INFRASTRUCTURE_LAB_DEFICIT"]),
  subject: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(5000),
}).strict();
const acknowledgeComplaintInput = z.object({
  admin_remarks: z.string().trim().max(3000).optional().default(""),
  evidence_reviewed: z.boolean(),
}).strict();
const collegeReplyInput = z.object({
  action_taken_report: z.string().trim().min(10).max(5000),
}).strict();
const resolveComplaintInput = z.object({
  resolution_note: z.string().trim().min(10).max(2000),
}).strict();
const complaintUpdate = z.object({
  status: z.enum(["ACKNOWLEDGED", "IN_REVIEW", "RESOLVED", "REJECTED"]),
  resolution_note: z.string().trim().max(2000).optional().default(""),
}).strict();
const appealInput = z.object({ reason: z.string().trim().min(20).max(3000) }).strict();
const appealUpdate = z.object({
  status: z.enum(["IN_REVIEW", "RESOLVED", "REJECTED"]),
  resolution_note: z.string().trim().min(5).max(2000),
}).strict();
const appealTransitions = Object.freeze({
  SUBMITTED: new Set(["IN_REVIEW"]),
  IN_REVIEW: new Set(["RESOLVED", "REJECTED"]),
  RESOLVED: new Set(),
  REJECTED: new Set(),
});
const complaintTransitions = Object.freeze({
  PENDING_ADMIN_VALIDATION: new Set(["ACKNOWLEDGED_SENT_TO_COLLEGE"]),
  ACKNOWLEDGED_SENT_TO_COLLEGE: new Set(["COLLEGE_REPLIED", "RESOLVED"]),
  COLLEGE_REPLIED: new Set(["RESOLVED"]),
  SUBMITTED: new Set(["ACKNOWLEDGED", "IN_REVIEW"]),
  ACKNOWLEDGED: new Set(["IN_REVIEW", "RESOLVED", "REJECTED"]),
  IN_REVIEW: new Set(["RESOLVED", "REJECTED"]),
  RESOLVED: new Set(),
  REJECTED: new Set(),
});
const announcementInput = z.object({
  title: z.string().trim().min(5).max(180),
  body: z.string().trim().min(10).max(10000),
  source_url: z.string().trim().max(2048).url().refine((value) => /^https?:\/\//i.test(value), "Source URL must use HTTP or HTTPS").or(z.literal("")).default(""),
  category: z.enum(["CIRCULAR", "NOTICE", "UPDATE"]).default("NOTICE"),
  audience: z.enum(["ALL", "STUDENT", "FACULTY"]).default("ALL"),
  published: z.boolean().default(false),
  publish_at: z.coerce.date().optional(),
  expires_at: z.coerce.date().nullable().optional(),
}).strict();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, done) => {
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) {
      const error = new Error("Only PDF, JPEG, and PNG evidence files are accepted");
      error.status = 415;
      return done(error);
    }
    return done(null, true);
  },
});
const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

function respond(res, req, data, status = 200) {
  return res.status(status).json({ data, error: null, meta: { requestId: req.id } });
}

function matchesMagic(file) {
  const b = file.buffer;
  if (file.mimetype === "application/pdf") return b.subarray(0, 5).toString() === "%PDF-";
  if (file.mimetype === "image/png") return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return false;
}

function safeComplaint(complaint) {
  const value = complaint.toObject ? complaint.toObject() : complaint;
  const safeEvidence = (item) => {
    if (!item) return item;
    const { storage_path, ...safe } = item;
    return safe;
  };
  return {
    ...value,
    evidence: (value.evidence || []).map(safeEvidence),
    college_response: value.college_response
      ? { ...value.college_response, proof_document: safeEvidence(value.college_response.proof_document) }
      : value.college_response,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskIdentityText(value, identifiers = []) {
  if (!value) return value || "";
  let masked = String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]");
  for (const identifier of [...new Set(identifiers)].filter((item) => item.length >= 3).sort((a, b) => b.length - a.length)) {
    masked = masked.replace(new RegExp(escapeRegex(identifier), "gi"), "[REDACTED]");
  }
  return masked.replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[REDACTED]");
}

function evidenceExtension(mimeType) {
  return ({ "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" })[mimeType] || "";
}

export function safeInstitutionComplaint(complaint, identifiers = []) {
  const value = complaint.toObject ? complaint.toObject() : complaint;
  const safeEvidence = (item, fileName) => {
    if (!item) return item;
    const { storage_path, uploaded_by, ...safe } = item;
    return { ...safe, ...(fileName ? { file_name: fileName } : {}) };
  };
  const evidence = (value.evidence || []).map((item, index) => safeEvidence(item, `Evidence ${index + 1}${evidenceExtension(item.mime_type)}`));
  return {
    _id: value._id,
    complaint_id: value.complaint_id || `GRV-${String(value._id).slice(-8).toUpperCase()}`,
    anonymous_alias: value.anonymous_alias || `Anonymous ${value.complainant_role === "FACULTY" ? "Faculty" : "Student"} #${value.complainant_role === "FACULTY" ? "FAC" : "STU"}-${String(value._id).slice(-4).toUpperCase()}`,
    institution_id: value.institution_id,
    institution_name: value.institution_name || "",
    category: value.category,
    subject: maskIdentityText(value.subject, identifiers),
    description: maskIdentityText(value.description, identifiers),
    status: value.status,
    response_due_at: value.admin_action?.response_deadline || value.response_due_at,
    admin_action: value.admin_action ? {
      acknowledged_at: value.admin_action.acknowledged_at,
      admin_remarks: maskIdentityText(value.admin_action.admin_remarks || "", identifiers),
      response_deadline: value.admin_action.response_deadline,
    } : null,
    college_response: value.college_response ? {
      action_taken_report: maskIdentityText(value.college_response.action_taken_report || "", identifiers),
      proof_document: safeEvidence(value.college_response.proof_document, value.college_response.proof_document ? `Action Taken Report proof${evidenceExtension(value.college_response.proof_document.mime_type)}` : ""),
      responded_at: value.college_response.responded_at,
    } : null,
    evidence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

async function safeInstitutionComplaints(complaints) {
  if (!complaints.length) return [];
  const userIds = [...new Set(complaints.map((item) => String(item.complainant_id)).filter(Boolean))];
  const users = await User.find({ _id: { $in: userIds } }).select("name email phone").lean();
  const emails = [...new Set(users.map((item) => item.email).filter(Boolean))];
  const [students, faculty] = await Promise.all([
    emails.length ? Student.find({ email: { $in: emails } }).select("name email phone enrollment_no").lean() : [],
    emails.length ? Faculty.find({ email: { $in: emails } }).select("name email phone employee_id").lean() : [],
  ]);
  const privateValuesByUserId = new Map();
  for (const profile of [...students, ...faculty]) {
    const user = users.find((item) => item.email === profile.email);
    if (!user) continue;
    const values = privateValuesByUserId.get(String(user._id)) || [];
    values.push(profile.name, profile.email, profile.phone, profile.enrollment_no, profile.employee_id);
    privateValuesByUserId.set(String(user._id), values.filter(Boolean).map(String));
  }
  for (const user of users) {
    const values = privateValuesByUserId.get(String(user._id)) || [];
    values.push(user.name, user.email, user.phone);
    privateValuesByUserId.set(String(user._id), values.filter(Boolean).map(String));
  }
  return complaints.map((complaint) => safeInstitutionComplaint(
    complaint,
    privateValuesByUserId.get(String(complaint.complainant_id)) || [],
  ));
}

async function recordStakeholderMutation(req, { actorId, action, entity, eventType, mutate, before, payload }) {
  return withTransaction(async (session) => {
    const record = await mutate(session);
    const eventPayload = typeof payload === "function" ? payload(record) : payload;
    await OutboxEvent.create([{
      eventId: randomUUID(),
      eventType,
      entityId: String(record._id),
      payload: eventPayload,
      publishedAt: null,
    }], { session });
    await writeAudit({
      actor_id: actorId,
      action,
      entity,
      entity_id: record._id,
      ...(typeof before === "function" ? { before_json: before(record) } : before ? { before_json: before } : {}),
      after_json: eventPayload,
      ip: req.ip,
    }, { session });
    return record;
  });
}

export function complaintScopeFor(user) {
  if (user.role === "ADMIN") return {};
  if (user.role === "INSTITUTION") return {
    institution_id: user.institution_id || null,
    status: { $in: ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED", "RESOLVED"] },
  };
  if (user.role === "GRIEVANCE_OFFICER") return { assigned_to: user._id };
  if (["OMBUDSPERSON", "UNIVERSITY_DTE_OFFICER"].includes(user.role)) return { appeal_assigned_to: user._id, appeal_status: { $in: ["SUBMITTED", "IN_REVIEW"] } };
  return { complainant_id: user._id };
}

function isPendingAdminValidation(status) {
  return ["PENDING_ADMIN_VALIDATION", "SUBMITTED"].includes(status);
}

function isForwardedComplaint(status) {
  return ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED", "RESOLVED"].includes(status);
}

async function enqueueComplaintNotice({ type, complaint, recipients = [], fallbackEmail, subject, body, title, dedupeSuffix }) {
  const jobs = [];
  const seenEmails = new Set();
  for (const recipient of recipients) {
    if (!recipient?._id) continue;
    jobs.push(NotificationService.enqueue({
      userId: recipient._id,
      type,
      channel: "IN_APP",
      payload: { title, body },
      dedupeKey: `complaint:${complaint._id}:${dedupeSuffix}:in-app:${recipient._id}`,
    }));
    const email = String(recipient.email || "").toLowerCase();
    if (email && !seenEmails.has(email)) {
      seenEmails.add(email);
      jobs.push(NotificationService.enqueue({
        userId: recipient._id,
        recipientEmail: email,
        type,
        channel: "EMAIL",
        payload: { subject, body },
        dedupeKey: `complaint:${complaint._id}:${dedupeSuffix}:email:${email}`,
      }));
    }
  }
  const normalizedFallback = String(fallbackEmail || "").toLowerCase();
  if (normalizedFallback && !seenEmails.has(normalizedFallback)) {
    jobs.push(NotificationService.enqueue({
      recipientEmail: normalizedFallback,
      type,
      channel: "EMAIL",
      payload: { subject, body },
      dedupeKey: `complaint:${complaint._id}:${dedupeSuffix}:email:${normalizedFallback}`,
    }));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    logger.error({ complaintId: String(complaint._id), notificationFailures: failed.length }, "Complaint notification enqueue failed");
    const error = new Error("The complaint was updated, but one or more notifications could not be queued.");
    error.status = 503;
    error.code = "COMPLAINT_NOTIFICATION_QUEUE_FAILED";
    throw error;
  }
  return { queued: jobs.length };
}

export function announcementScopeFor(user, now = new Date()) {
  if (user.role === "ADMIN") return {};
  return {
    published: true,
    publish_at: { $lte: now },
    $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
    audience: { $in: ["ALL", user.role] },
  };
}

export function canTransitionComplaint(from, to) {
  return Boolean(complaintTransitions[from]?.has(to));
}

export function canTransitionAppeal(from, to) {
  return Boolean(appealTransitions[from]?.has(to));
}

export function stakeholdersRouter() {
  const router = express.Router();

  router.get("/announcements", authenticate, requireRole("STUDENT", "FACULTY", "ADMIN"), validate(page, "query"), async (req, res, next) => {
    try {
      const filter = announcementScopeFor(req.user);
      const { page: pageNumber, pageSize } = req.query;
      const items = await Announcement.find(filter).sort({ publish_at: -1, createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean();
      return respond(res, req, items);
    } catch (error) { return next(error); }
  });

  router.post("/announcements", authenticate, requireRole("ADMIN"), validate(announcementInput), async (req, res, next) => {
    try {
      const eventPayload = (record) => ({ title: record.title, audience: record.audience, published: record.published });
      const announcement = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: req.body.published ? "ANNOUNCEMENT_PUBLISHED" : "ANNOUNCEMENT_DRAFTED",
        entity: "Announcement",
        eventType: req.body.published ? "announcement.published" : "announcement.drafted",
        mutate: async (session) => (await Announcement.create([{ ...req.body, created_by: req.user._id }], { session }))[0],
        payload: eventPayload,
      });
      return respond(res, req, announcement, 201);
    } catch (error) { return next(error); }
  });

  router.patch("/announcements/:id", authenticate, requireRole("ADMIN"), validate(paramsId, "params"), validate(announcementInput.partial()), async (req, res, next) => {
    try {
      const announcement = await Announcement.findById(req.params.id);
      if (!announcement) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Announcement not found" }, meta: { requestId: req.id } });
      const before = announcement.toObject();
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "ANNOUNCEMENT_UPDATED",
        entity: "Announcement",
        eventType: "announcement.updated",
        before,
        mutate: async (session) => {
          announcement.set(req.body);
          await announcement.save({ session });
          return announcement;
        },
        payload: (record) => ({ title: record.title, audience: record.audience, published: record.published }),
      });
      return respond(res, req, updated);
    } catch (error) { return next(error); }
  });

  router.get("/complaints/institutions", authenticate, requireRole("STUDENT", "FACULTY"), async (req, res, next) => {
    try {
      const institutions = await Institution.find({ status: "ACTIVE", deleted_at: null })
        .select("_id name aicte_id state region")
        .sort({ name: 1 })
        .lean();
      return respond(res, req, institutions);
    } catch (error) { return next(error); }
  });

  router.get("/complaints/my-complaints", authenticate, requireRole("STUDENT", "FACULTY"), validate(page.extend({
    status: z.enum(["SUBMITTED", "ACKNOWLEDGED", "IN_REVIEW", "RESOLVED", "REJECTED", "PENDING_ADMIN_VALIDATION", "ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"]).optional(),
  }), "query"), async (req, res, next) => {
    try {
      const filter = { complainant_id: req.user._id, complainant_role: req.user.role };
      if (req.query.status) filter.status = req.query.status;
      const { page: pageNumber, pageSize } = req.query;
      const [items, total] = await Promise.all([
        Complaint.find(filter).sort({ createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean(),
        Complaint.countDocuments(filter),
      ]);
      return res.json({
        data: items.map(safeComplaint),
        error: null,
        meta: { requestId: req.id, page: pageNumber, pageSize, total, pages: Math.ceil(total / pageSize) },
      });
    } catch (error) { return next(error); }
  });

  router.get("/complaints/admin/colleges-summary", authenticate, requireRole("ADMIN"), async (req, res, next) => {
    try {
      const grouped = await Complaint.aggregate([
        { $group: {
          _id: "$institution_id",
          pendingCount: { $sum: { $cond: [{ $in: ["$status", ["PENDING_ADMIN_VALIDATION", "SUBMITTED"]] }, 1, 0] } },
          completedCount: { $sum: { $cond: [{ $in: ["$status", ["PENDING_ADMIN_VALIDATION", "SUBMITTED"]] }, 0, 1] } },
          totalCount: { $sum: 1 },
          lastActivity: { $max: "$updatedAt" },
        } },
      ]);
      const institutionIds = grouped.map((item) => item._id).filter(Boolean);
      const institutions = await Institution.find({ _id: { $in: institutionIds } })
        .select("_id name aicte_id region state")
        .sort({ name: 1 })
        .lean();
      const institutionById = new Map(institutions.map((item) => [String(item._id), item]));
      return respond(res, req, grouped
        .map((item) => ({
          institution: institutionById.get(String(item._id)) || { _id: item._id, name: "Institution unavailable", aicte_id: "", region: "" },
          pendingCount: item.pendingCount,
          completedCount: item.completedCount,
          totalCount: item.totalCount,
          lastActivity: item.lastActivity,
        }))
        .sort((left, right) => left.institution.name.localeCompare(right.institution.name)));
    } catch (error) { return next(error); }
  });

  router.get("/complaints/admin/colleges/:institutionId", authenticate, requireRole("ADMIN"), validate(z.object({ institutionId: id }).strict(), "params"), async (req, res, next) => {
    try {
      const institution = await Institution.findById(req.params.institutionId).select("_id name aicte_id region state").lean();
      if (!institution) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Institution not found" }, meta: { requestId: req.id } });
      const complaints = await Complaint.find({ institution_id: institution._id })
        .populate("complainant_id", "name email phone")
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();
      const pending = complaints.filter((item) => isPendingAdminValidation(item.status)).map(safeComplaint);
      const completed = complaints.filter((item) => !isPendingAdminValidation(item.status)).map(safeComplaint);
      return respond(res, req, { institution, pending, completed });
    } catch (error) { return next(error); }
  });

  router.post("/complaints/admin/:id/acknowledge", authenticate, requireRole("ADMIN"), validate(paramsId, "params"), validate(acknowledgeComplaintInput), async (req, res, next) => {
    try {
      const complaint = await Complaint.findById(req.params.id);
      if (!complaint || !isPendingAdminValidation(complaint.status)) {
        return res.status(404).json({ data: null, error: { code: "NOT_PENDING_VALIDATION", message: "No complaint is waiting for Admin validation" }, meta: { requestId: req.id } });
      }
      if (!req.body.evidence_reviewed) {
        return res.status(409).json({ data: null, error: { code: "EVIDENCE_PRIVACY_REVIEW_REQUIRED", message: "Review the complaint and attachments for identifying details before forwarding" }, meta: { requestId: req.id } });
      }
      const institution = await Institution.findOne({ _id: complaint.institution_id, deleted_at: null }).select("_id name contact_email").lean();
      if (!institution) return res.status(409).json({ data: null, error: { code: "INSTITUTION_UNAVAILABLE", message: "The complaint's institution is unavailable" }, meta: { requestId: req.id } });
      const institutionUsers = await User.find({ institution_id: institution._id, role: "INSTITUTION", status: "ACTIVE", deleted_at: null }).select("_id email").lean();
      const now = new Date();
      const responseDeadline = new Date(now.getTime() + 7 * 86_400_000);
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "COMPLAINT_ACKNOWLEDGED_AND_FORWARDED",
        entity: "Complaint",
        eventType: "complaint.acknowledged_and_forwarded",
        before: { status: complaint.status },
        mutate: async (session) => {
          complaint.complaint_id ||= `GRV-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
          complaint.anonymous_alias ||= `Anonymous ${complaint.complainant_role === "FACULTY" ? "Faculty" : "Student"} #${complaint.complainant_role === "FACULTY" ? "FAC" : "STU"}-${randomUUID().slice(0, 4).toUpperCase()}`;
          complaint.status = "ACKNOWLEDGED_SENT_TO_COLLEGE";
          complaint.admin_action = {
            acknowledged_by: req.user._id,
            acknowledged_at: now,
            evidence_reviewed_by: req.user._id,
            evidence_reviewed_at: now,
            admin_remarks: req.body.admin_remarks,
            response_deadline: responseDeadline,
          };
          complaint.history.push({ status: complaint.status, note: req.body.admin_remarks || "Acknowledged by AICTE and forwarded to the institution", actor_id: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ complaintId: record.complaint_id, institutionId: String(record.institution_id), status: record.status, responseDeadline }),
      });

      const institutionBody = `A grievance (${updated.complaint_id}) has been acknowledged by AICTE and requires your response by ${responseDeadline.toLocaleDateString("en-IN")}.${req.body.admin_remarks ? ` Admin directive: ${req.body.admin_remarks}` : ""}`;
      const institutionNotifications = await enqueueComplaintNotice({
        type: "COMPLAINT_FORWARDED_TO_INSTITUTION",
        complaint: updated,
        recipients: institutionUsers,
        fallbackEmail: institution.contact_email,
        subject: `AICTE grievance ${updated.complaint_id} requires your response`,
        body: institutionBody,
        title: "AICTE grievance forwarded for response",
        dedupeSuffix: "forwarded",
      });
      const complainant = await User.findById(updated.complainant_id).select("_id email").lean();
      const complainantNotifications = complainant
        ? await enqueueComplaintNotice({
          type: "COMPLAINT_ACKNOWLEDGED_BY_AICTE",
          complaint: updated,
          recipients: [complainant],
          subject: `Update on your AICTE grievance ${updated.complaint_id}`,
          body: `Your complaint has been acknowledged by AICTE and forwarded to the institution. ${req.body.admin_remarks ? `AICTE remarks: ${req.body.admin_remarks}` : ""}`,
          title: "Complaint acknowledged by AICTE",
          dedupeSuffix: "acknowledged",
        })
        : { queued: 0 };
      return respond(res, req, {
        complaint: safeComplaint(updated),
        notifications: { institution: institutionNotifications.queued, complainant: complainantNotifications.queued },
      });
    } catch (error) { return next(error); }
  });

  router.post("/complaints/admin/:id/resolve", authenticate, requireRole("ADMIN"), validate(paramsId, "params"), validate(resolveComplaintInput), async (req, res, next) => {
    try {
      const complaint = await Complaint.findOne({ _id: req.params.id, status: { $in: ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"] } });
      if (!complaint) return res.status(404).json({ data: null, error: { code: "NOT_RESOLVABLE", message: "Only a forwarded or college-replied complaint can be resolved" }, meta: { requestId: req.id } });
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "COMPLAINT_RESOLVED_BY_AICTE",
        entity: "Complaint",
        eventType: "complaint.resolved_by_aicte",
        before: { status: complaint.status },
        mutate: async (session) => {
          complaint.status = "RESOLVED";
          complaint.resolution_note = req.body.resolution_note;
          complaint.resolved_at = new Date();
          complaint.history.push({ status: complaint.status, note: req.body.resolution_note, actor_id: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ complaintId: record.complaint_id, status: record.status }),
      });
      const complainant = await User.findById(updated.complainant_id).select("_id email").lean();
      const notifications = complainant
        ? await enqueueComplaintNotice({
          type: "COMPLAINT_RESOLVED",
          complaint: updated,
          recipients: [complainant],
          subject: `Your AICTE grievance ${updated.complaint_id} has been resolved`,
          body: `AICTE has marked your complaint resolved. Update: ${req.body.resolution_note}`,
          title: "Your complaint has been resolved",
          dedupeSuffix: "resolved",
        })
        : { queued: 0 };
      return respond(res, req, { complaint: safeComplaint(updated), notifications: notifications.queued });
    } catch (error) { return next(error); }
  });

  router.get("/complaints/institution/my-college", authenticate, requireRole("INSTITUTION"), validate(page, "query"), async (req, res, next) => {
    try {
      const institutionId = req.user.institution_id
        || (await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id"))?._id;
      if (!institutionId) return respond(res, req, []);
      const filter = {
        institution_id: institutionId,
        status: { $in: ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED", "RESOLVED"] },
      };
      const { page: pageNumber, pageSize } = req.query;
      const [complaints, total] = await Promise.all([
        Complaint.find(filter).sort({ updatedAt: -1, createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean(),
        Complaint.countDocuments(filter),
      ]);
      const safeComplaints = await safeInstitutionComplaints(complaints);
      return res.json({
        data: safeComplaints,
        error: null,
        meta: { requestId: req.id, page: pageNumber, pageSize, total, pages: Math.ceil(total / pageSize) },
      });
    } catch (error) { return next(error); }
  });

  router.post("/complaints/institution/:id/reply", authenticate, requireRole("INSTITUTION"), validate(paramsId, "params"), upload.single("file"), async (req, res, next) => {
    let savedFile;
    try {
      const parsed = collegeReplyInput.safeParse({ action_taken_report: req.body?.action_taken_report });
      if (!parsed.success) return res.status(400).json({ data: null, error: { code: "VALIDATION_ERROR", message: "An Action Taken Report of at least 10 characters is required" }, meta: { requestId: req.id } });
      if (req.file && !matchesMagic(req.file)) return res.status(400).json({ data: null, error: { code: "INVALID_EVIDENCE_FILE", message: "Proof must be a valid PDF, JPEG, or PNG file" }, meta: { requestId: req.id } });
      const institutionId = req.user.institution_id
        || (await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id"))?._id;
      if (!institutionId) return res.status(403).json({ data: null, error: { code: "INSTITUTION_NOT_LINKED", message: "Your account is not linked to an institution" }, meta: { requestId: req.id } });
      const complaint = await Complaint.findOne({
        _id: req.params.id,
        institution_id: institutionId,
        status: { $in: ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"] },
      }).select("+college_response.proof_document.storage_path");
      if (!complaint) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Forwarded complaint not found" }, meta: { requestId: req.id } });
      if (req.file) savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "INSTITUTION_COMPLAINT_REPLIED",
        entity: "Complaint",
        eventType: "complaint.institution_replied",
        before: { status: complaint.status },
        mutate: async (session) => {
          complaint.status = "COLLEGE_REPLIED";
          complaint.college_response = {
            action_taken_report: parsed.data.action_taken_report,
            proof_document: req.file ? {
              file_name: req.file.originalname.replace(/[\\/\0]/g, "_").slice(0, 180),
              mime_type: req.file.mimetype,
              size: req.file.size,
              sha256: savedFile.sha256,
              storage_path: savedFile.filePath,
              uploaded_by: req.user._id,
            } : complaint.college_response?.proof_document,
            responded_at: new Date(),
            responded_by: req.user._id,
          };
          complaint.history.push({ status: complaint.status, note: "Institution submitted an Action Taken Report", actor_id: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ complaintId: record.complaint_id, status: record.status, proofAttached: Boolean(req.file) }),
      });
      savedFile = null;
      const complainant = await User.findById(updated.complainant_id).select("_id email").lean();
      const notifications = complainant
        ? await enqueueComplaintNotice({
          type: "COMPLAINT_COLLEGE_REPLIED",
          complaint: updated,
          recipients: [complainant],
          subject: `The institution responded to your grievance ${updated.complaint_id}`,
          body: "The institution has submitted an Action Taken Report. Sign in to your portal to review the response and any attached proof.",
          title: "Institution submitted an Action Taken Report",
          dedupeSuffix: `college-replied:${updated.updatedAt?.getTime() || Date.now()}`,
        })
        : { queued: 0 };
      return respond(res, req, {
        complaint: (await safeInstitutionComplaints([updated]))[0],
        notifications: notifications.queued,
      });
    } catch (error) {
      if (savedFile) await localStorage.remove(savedFile.filePath);
      return next(error);
    }
  });

  router.get("/complaints", authenticate, requireRole("STUDENT", "FACULTY", "ADMIN", "GRIEVANCE_OFFICER", "OMBUDSPERSON", "UNIVERSITY_DTE_OFFICER", "INSTITUTION"), validate(page.extend({ status: z.enum(["SUBMITTED", "ACKNOWLEDGED", "IN_REVIEW", "RESOLVED", "REJECTED", "PENDING_ADMIN_VALIDATION", "ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"]).optional() }), "query"), async (req, res, next) => {
    try {
      const filter = complaintScopeFor(req.user);
      if (req.query.status) {
        if (req.user.role === "INSTITUTION" && !isForwardedComplaint(req.query.status)) return respond(res, req, []);
        filter.status = req.query.status;
      }
      const { page: pageNumber, pageSize } = req.query;
      const [items, total] = await Promise.all([
        Complaint.find(filter).sort({ createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean(),
        Complaint.countDocuments(filter),
      ]);
      const data = req.user.role === "INSTITUTION"
        ? await safeInstitutionComplaints(items)
        : items.map(safeComplaint);
      return res.json({ data, error: null, meta: { requestId: req.id, page: pageNumber, pageSize, total, pages: Math.ceil(total / pageSize) } });
    } catch (error) { return next(error); }
  });

  router.post("/complaints", authenticate, requireRole("STUDENT", "FACULTY"), validate(complaintInput), async (req, res, next) => {
    try {
      const profileModel = req.user.role === "STUDENT" ? Student : Faculty;
      const profile = await profileModel.findOne({ email: req.user.email, institution_id: req.user.institution_id, deleted_at: null }).select("institution_id");
      if (!profile || !req.user.institution_id) return res.status(409).json({ data: null, error: { code: "PROFILE_NOT_LINKED", message: "Your account must be linked to an institution profile before submitting a complaint" }, meta: { requestId: req.id } });
      const targetInstitutionId = req.body.institution_id || profile.institution_id;
      const institution = await Institution.findOne({ _id: targetInstitutionId, status: "ACTIVE", deleted_at: null }).select("_id name region");
      if (!institution) return res.status(409).json({ data: null, error: { code: "INSTITUTION_NOT_FOUND", message: "Your institution is unavailable" }, meta: { requestId: req.id } });
      const submittedAt = new Date();
      const complaint = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "COMPLAINT_SUBMITTED",
        entity: "Complaint",
        eventType: "complaint.submitted",
        mutate: async (session) => (await Complaint.create([{
          ...req.body,
          complainant_id: req.user._id,
          complainant_role: req.user.role,
          institution_id: institution._id,
          institution_name: institution.name,
          anonymous_alias: `Anonymous ${req.user.role === "FACULTY" ? "Faculty" : "Student"} #${req.user.role === "FACULTY" ? "FAC" : "STU"}-${randomUUID().slice(0, 4).toUpperCase()}`,
          committee_type: req.user.role === "STUDENT" ? "STUDENT_SGRC" : "FACULTY_STAFF_GRC",
          assigned_to: null,
          response_due_at: new Date(submittedAt.getTime() + 15 * 86_400_000),
          region: institution.region || req.user.region,
          status: "PENDING_ADMIN_VALIDATION",
          history: [{ status: "PENDING_ADMIN_VALIDATION", note: "Complaint submitted for AICTE Admin validation", actor_id: req.user._id }],
        }], { session }))[0],
        payload: (record) => ({ category: record.category, status: record.status, institution_id: record.institution_id }),
      });
      return respond(res, req, safeComplaint(complaint), 201);
    } catch (error) { return next(error); }
  });

  router.patch("/complaints/:id", authenticate, requireRole("ADMIN", "GRIEVANCE_OFFICER"), validate(paramsId, "params"), validate(complaintUpdate), async (req, res, next) => {
    try {
      const filter = req.user.role === "ADMIN" ? { _id: req.params.id } : { _id: req.params.id, assigned_to: req.user._id };
      const complaint = await Complaint.findOne(filter);
      if (!complaint) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Complaint not found" }, meta: { requestId: req.id } });
      if (["PENDING_ADMIN_VALIDATION", "ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"].includes(complaint.status)
        || complaint.admin_action?.acknowledged_at) {
        return res.status(409).json({ data: null, error: { code: "DEDICATED_GRIEVANCE_ACTION_REQUIRED", message: "Use the AICTE acknowledgement, college reply, or resolution action for this complaint" }, meta: { requestId: req.id } });
      }
      if (!canTransitionComplaint(complaint.status, req.body.status)) return res.status(409).json({ data: null, error: { code: "INVALID_COMPLAINT_TRANSITION", message: `Cannot change complaint from ${complaint.status} to ${req.body.status}` }, meta: { requestId: req.id } });
      if (["RESOLVED", "REJECTED"].includes(req.body.status) && req.body.resolution_note.length < 10) return res.status(400).json({ data: null, error: { code: "RESOLUTION_REASON_REQUIRED", message: "Provide at least 10 characters explaining the decision" }, meta: { requestId: req.id } });
      const before = { status: complaint.status, resolution_note: complaint.resolution_note };
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "COMPLAINT_STATUS_UPDATED",
        entity: "Complaint",
        eventType: "complaint.status_updated",
        before,
        mutate: async (session) => {
          complaint.status = req.body.status;
          complaint.resolution_note = req.body.resolution_note;
          complaint.resolved_at = ["RESOLVED", "REJECTED"].includes(complaint.status) ? new Date() : null;
          complaint.history.push({ status: complaint.status, note: complaint.resolution_note || `Status updated to ${complaint.status}`, actor_id: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ status: record.status, resolution_note: record.resolution_note }),
      });
      return respond(res, req, safeComplaint(updated));
    } catch (error) { return next(error); }
  });

  router.post("/complaints/:id/appeals", authenticate, requireRole("STUDENT", "FACULTY"), validate(paramsId, "params"), validate(appealInput), async (req, res, next) => {
    try {
      const complaint = await Complaint.findOne({ _id: req.params.id, complainant_id: req.user._id, complainant_role: req.user.role, status: { $in: ["RESOLVED", "REJECTED"] } });
      if (!complaint) return res.status(404).json({ data: null, error: { code: "NOT_APPEALABLE", message: "A grievance decision is required before an appeal can be filed" }, meta: { requestId: req.id } });
      if (req.user.role === "STUDENT") {
        if (!complaint.resolved_at) return res.status(409).json({ data: null, error: { code: "DECISION_DATE_MISSING", message: "The grievance decision date is missing; contact the grievance officer" }, meta: { requestId: req.id } });
        const closesAt = new Date(complaint.resolved_at.getTime() + 15 * 86_400_000);
        if (new Date() > closesAt) return res.status(409).json({ data: null, error: { code: "APPEAL_WINDOW_CLOSED", message: "The 15-day student appeal window has closed" }, meta: { requestId: req.id } });
      }
      if (complaint.appeal_status !== "NONE") return res.status(409).json({ data: null, error: { code: "APPEAL_ALREADY_EXISTS", message: "An appeal has already been submitted for this complaint" }, meta: { requestId: req.id } });
      const institution = await Institution.findById(complaint.institution_id).select("region");
      const appealRole = req.user.role === "STUDENT" ? "OMBUDSPERSON" : "UNIVERSITY_DTE_OFFICER";
      const appealOfficer = await User.findOne({ role: appealRole, region: institution?.region, status: "ACTIVE", deleted_at: null }).select("_id");
      if (!appealOfficer) return res.status(409).json({ data: null, error: { code: "APPEAL_OFFICER_UNAVAILABLE", message: `No active ${appealRole === "OMBUDSPERSON" ? "Ombudsperson" : "University/DTE officer"} is configured for this institution's region` }, meta: { requestId: req.id } });
      const now = new Date();
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: `${req.user.role}_GRIEVANCE_APPEALED`,
        entity: "Complaint",
        eventType: "complaint.appeal_submitted",
        before: { appeal_status: complaint.appeal_status },
        mutate: async (session) => {
          complaint.appeal_status = "SUBMITTED";
          complaint.appeal_route = req.user.role === "STUDENT" ? "OMBUDSPERSON" : "UNIVERSITY_DTE";
          complaint.appeal_assigned_to = appealOfficer._id;
          complaint.appeal_submitted_at = now;
          complaint.appeal_due_at = req.user.role === "STUDENT" ? new Date(now.getTime() + 30 * 86_400_000) : null;
          complaint.appeal_reason = req.body.reason;
          complaint.history.push({ status: "APPEAL_SUBMITTED", note: `Referred to ${complaint.appeal_route}`, actor_id: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ route: record.appeal_route, appeal_status: record.appeal_status, due_at: record.appeal_due_at }),
      });
      return respond(res, req, safeComplaint(updated), 201);
    } catch (error) { return next(error); }
  });

  router.patch("/complaints/:id/appeals", authenticate, requireRole("ADMIN", "OMBUDSPERSON", "UNIVERSITY_DTE_OFFICER"), validate(paramsId, "params"), validate(appealUpdate), async (req, res, next) => {
    try {
      const filter = req.user.role === "ADMIN" ? { _id: req.params.id, appeal_status: { $in: ["SUBMITTED", "IN_REVIEW"] } } : { _id: req.params.id, appeal_assigned_to: req.user._id, appeal_status: { $in: ["SUBMITTED", "IN_REVIEW"] } };
      const complaint = await Complaint.findOne(filter);
      if (!complaint) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Appeal not found in your assigned scope" }, meta: { requestId: req.id } });
      if (!canTransitionAppeal(complaint.appeal_status, req.body.status)) return res.status(409).json({ data: null, error: { code: "INVALID_APPEAL_TRANSITION", message: `Cannot change appeal from ${complaint.appeal_status} to ${req.body.status}` }, meta: { requestId: req.id } });
      const before = { appeal_status: complaint.appeal_status };
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: `${req.user.role}_GRIEVANCE_APPEAL_UPDATED`,
        entity: "Complaint",
        eventType: "complaint.appeal_updated",
        before,
        mutate: async (session) => {
          complaint.appeal_status = req.body.status;
          complaint.appeal_resolution_note = req.body.resolution_note;
          complaint.history.push({ status: `APPEAL_${req.body.status}`, note: req.body.resolution_note, actor_id: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ appeal_status: record.appeal_status }),
      });
      return respond(res, req, safeComplaint(updated));
    } catch (error) { return next(error); }
  });

  router.post("/complaints/:id/evidence", authenticate, requireRole("STUDENT", "FACULTY"), validate(paramsId, "params"), upload.single("file"), async (req, res, next) => {
    let savedFile;
    try {
      if (!req.file || !matchesMagic(req.file)) return res.status(400).json({ data: null, error: { code: "INVALID_EVIDENCE_FILE", message: "Evidence must be a valid PDF, JPEG, or PNG file" }, meta: { requestId: req.id } });
      const complaint = await Complaint.findOne({
        _id: req.params.id,
        complainant_id: req.user._id,
        status: { $in: ["SUBMITTED", "ACKNOWLEDGED", "IN_REVIEW", "PENDING_ADMIN_VALIDATION", "ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED"] },
      }).select("+evidence.storage_path");
      if (!complaint) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Open complaint not found" }, meta: { requestId: req.id } });
      if (complaint.evidence.length >= 5) return res.status(409).json({ data: null, error: { code: "EVIDENCE_LIMIT", message: "A complaint can contain at most five evidence files" }, meta: { requestId: req.id } });
      savedFile = await localStorage.save(req.file.buffer, req.file.originalname);
      const updated = await recordStakeholderMutation(req, {
        actorId: req.user._id,
        action: "COMPLAINT_EVIDENCE_UPLOADED",
        entity: "Complaint",
        eventType: "complaint.evidence_uploaded",
        mutate: async (session) => {
          complaint.evidence.push({ file_name: req.file.originalname.replace(/[\\/\0]/g, "_").slice(0, 180), mime_type: req.file.mimetype, size: req.file.size, sha256: savedFile.sha256, storage_path: savedFile.filePath, uploaded_by: req.user._id });
          await complaint.save({ session });
          return complaint;
        },
        payload: (record) => ({ sha256: record.evidence.at(-1).sha256, size: req.file.size }),
      });
      savedFile = null;
      return respond(res, req, safeComplaint(updated), 201);
    } catch (error) {
      if (savedFile) await localStorage.remove(savedFile.filePath);
      return next(error);
    }
  });

  router.get("/complaints/:id/evidence/:evidenceId", authenticate, requireRole("STUDENT", "FACULTY", "ADMIN", "GRIEVANCE_OFFICER", "OMBUDSPERSON", "UNIVERSITY_DTE_OFFICER", "INSTITUTION"), validate(z.object({ id, evidenceId: id }).strict(), "params"), async (req, res, next) => {
    try {
      let scope = complaintScopeFor(req.user);
      if (req.user.role === "INSTITUTION" && !req.user.institution_id) {
        const institutionId = (await Institution.findOne({ contact_email: req.user.email, deleted_at: null }).select("_id"))?._id;
        scope = {
          institution_id: institutionId || null,
          status: { $in: ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED", "RESOLVED"] },
        };
      }
      const filter = { _id: req.params.id, ...scope };
      const complaint = await Complaint.findOne(filter).select("+evidence.storage_path +college_response.proof_document.storage_path");
      const evidence = complaint?.evidence.id(req.params.evidenceId)
        || (String(complaint?.college_response?.proof_document?._id) === req.params.evidenceId ? complaint.college_response.proof_document : null);
      if (!evidence) return res.status(404).json({ data: null, error: { code: "NOT_FOUND", message: "Evidence not found" }, meta: { requestId: req.id } });
      const evidenceIndex = req.user.role === "INSTITUTION" ? complaint.evidence.findIndex((item) => String(item._id) === req.params.evidenceId) : -1;
      const isProof = req.user.role === "INSTITUTION" && String(complaint.college_response?.proof_document?._id) === req.params.evidenceId;
      const downloadName = req.user.role === "INSTITUTION"
        ? isProof
          ? `Action Taken Report proof${evidenceExtension(evidence.mime_type)}`
          : `Evidence ${evidenceIndex + 1}${evidenceExtension(evidence.mime_type)}`
        : evidence.file_name;
      return res.type(evidence.mime_type).attachment(downloadName).sendFile(localStorage.resolve(evidence.storage_path));
    } catch (error) { return next(error); }
  });

  return router;
}
