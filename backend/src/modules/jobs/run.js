import { Alert, Application, AuditLog, CaseObligation, CaseRecord, Complaint, Document, Faculty, Institution, InstitutionAnnualReport, LeaseDetail, PendingItem, Policy, ProcessingRun, Session, StageConfig, StageHistory, Undertaking, User, YearlyReport } from "../../models/index.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { NotificationService } from "../notifications/service.js";
import { DEFAULT_RULES } from "../rules/engine.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { processDocument } from "../ai/pipeline.js";
import { evaluateCasePipeline } from "../cases/pipeline.js";
import { stageOverdueScanner } from "../applications/overdueStageWorker.js";
import { recordApplicationIncident } from "../admin/incidents/service.js";
import { createAlertKey, obligationReminderLevel } from "../../engine/timeRules.js";

export { stageOverdueScanner };

const DAY = 86_400_000;
const YEARLY_REPORT_REMINDER_DAYS = new Set([90, 60, 30, 15, 7, 1]);
const ADMIN_STAGE_DELAY_ESCALATION_DAYS = 3;

export function yearlyReportReminderLevel(daysLeft) {
  if (!Number.isInteger(daysLeft)) return null;
  if (daysLeft < 0) return "overdue";
  return YEARLY_REPORT_REMINDER_DAYS.has(daysLeft) ? `T${daysLeft}` : null;
}

export function deadlineReminderLevel(daysLeft) {
  if (!Number.isInteger(daysLeft)) return null;
  if (daysLeft < 0) return "overdue";
  if ([90, 60, 30, 15, 7, 1].includes(daysLeft)) return `T${daysLeft}`;
  if (daysLeft === 0) return "due";
  return null;
}

export function grievanceEscalationRoles(overdueDays) {
  if (!Number.isInteger(overdueDays) || overdueDays < 3) return [];
  return overdueDays >= 7 ? ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] : ["BUREAU_OFFICER"];
}

export function regionalEscalationFilter(region, overdueDays) {
  const roles = grievanceEscalationRoles(overdueDays);
  if (!roles.length || typeof region !== "string" || !region.trim()) return null;
  return { role: { $in: roles }, region: region.trim(), status: "ACTIVE", deleted_at: null };
}

async function regionalEscalationUsers(institutionId, overdueDays, entity) {
  const filterRoles = grievanceEscalationRoles(overdueDays);
  if (!filterRoles.length) return [];
  const institution = await Institution.findById(institutionId).select("region").lean();
  const filter = regionalEscalationFilter(institution?.region, overdueDays);
  if (!filter) {
    logger.warn({ entity, institutionId: String(institutionId || ""), overdueDays }, "Overdue reminder escalation skipped because institution region is unavailable");
    return [];
  }
  return User.find(filter).select("_id role").lean();
}

function istDateParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: env.TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

export function istDaysBetween(target, reference) {
  const end = istDateParts(target);
  const start = istDateParts(reference);
  return Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / DAY);
}

function startOfNextIstDay(value) {
  const { year, month, day } = istDateParts(value);
  return new Date(Date.UTC(year, month - 1, day + 1) - 330 * 60 * 1000);
}

async function alertOnce({ key, userId, appId, type, title, body, severity = "MEDIUM", dueAt = null }) {
  const result = await Alert.updateOne(
    { dedupe_key: key },
    { $setOnInsert: { application_id: appId || null, target_user_id: userId, type, title, body, severity, due_at: dueAt, dedupe_key: key, status: "OPEN" } },
    { upsert: true, runValidators: true },
  );
  return result.upsertedCount === 1;
}

async function notifyUser(userId, type, subject, body, key, sms = false, extra = {}) {
  const jobs = [
    NotificationService.enqueue({ userId, type, channel: "IN_APP", payload: { title: subject, body, ...extra }, dedupeKey: `${key}:in-app` }),
    NotificationService.enqueue({ userId, type, channel: "EMAIL", payload: { subject, body, ...extra }, dedupeKey: `${key}:email` }),
  ];
  if (sms) jobs.push(NotificationService.enqueue({ userId, type, channel: "SMS", payload: { message: `${extra.caseId ? `${extra.caseId}: ` : ""}${body}`.slice(0, 160), ...extra }, dedupeKey: `${key}:sms` }));
  await Promise.all(jobs);
}

async function stageDelayScanner(now) {
  let scanned = 0;
  const applications = await Application.find({ status: "IN_PROGRESS", deleted_at: null }).lean();
  const administrators = await User.find({ role: "ADMIN", status: "ACTIVE", deleted_at: null }).select("_id name").lean();
  for (const application of applications) {
    const config = await StageConfig.findOne({ application_type: application.type, stage: application.current_stage, enabled: true }).lean();
    const maxDays = config?.max_days ?? DEFAULT_RULES.W6.params.maxDaysByStage[application.current_stage];
    if (!maxDays || now.getTime() - application.stage_entered_at.getTime() < maxDays * DAY) continue;
    scanned += 1;
    const delayDays = Math.floor((now.getTime() - application.stage_entered_at.getTime()) / DAY);
    const baseKey = `stage-delay:${application._id}:${application.current_stage}:${application.stage_entered_at.toISOString()}`;
    let responsibleUser = application.assigned_officer_id
      ? await User.findOne({ _id: application.assigned_officer_id, status: "ACTIVE", deleted_at: null }).select("_id name role").lean()
      : null;
    if (!responsibleUser) {
      const institution = await Institution.findById(application.institution_id).select("region").lean();
      responsibleUser = await User.findOne({
        role: config?.role_responsible || "SCRUTINY_OFFICER",
        status: "ACTIVE",
        deleted_at: null,
        ...(institution?.region ? { region: institution.region } : {}),
      })
        .select("_id name role").lean();
    }
    const recipient = responsibleUser?._id || null;
    const caseId = application.application_number || application._id.toString();
    const responsibleName = responsibleUser?.name || "Unassigned (no active owner resolved)";
    const responsibleRole = responsibleUser?.role || config?.role_responsible || "Unknown";
    const delayDescription = [
      `Application ${caseId} is overdue at stage ${application.current_stage}.`,
      `Assigned responsible user: ${responsibleName} (${responsibleRole}).`,
      `Configured due date: ${new Date(application.stage_entered_at.getTime() + maxDays * DAY).toISOString()}.`,
      `Configured target: ${maxDays} day(s); elapsed: ${delayDays} day(s).`,
      "This identifies the assigned owner of the overdue work; it does not determine individual fault.",
    ].join(" ");
    await recordApplicationIncident({
      workflowType: "LEGACY_APPLICATION",
      applicationId: String(application._id),
      dedupeKey: `stage-delay:${application.current_stage}:${application.stage_entered_at.toISOString()}`,
      type: "STAGE_DELAY",
      severity: delayDays >= maxDays + ADMIN_STAGE_DELAY_ESCALATION_DAYS ? "HIGH" : "MEDIUM",
      summary: `${application.current_stage} is overdue for ${caseId}`,
      details: delayDescription,
      stageKey: application.current_stage,
      stageName: application.current_stage,
      responsibleOfficerId: recipient ? String(recipient) : null,
      responsibleOfficerName: responsibleName,
      responsibleOfficerRole: responsibleRole,
      detectedAt: new Date(application.stage_entered_at.getTime() + maxDays * DAY),
      dueAt: new Date(application.stage_entered_at.getTime() + maxDays * DAY),
    });
    if (!recipient && administrators.length === 0) {
      logger.warn({ applicationId: String(application._id), stage: application.current_stage }, "Overdue incident recorded but no active notification recipient could be resolved");
    }
    if (delayDays >= maxDays + ADMIN_STAGE_DELAY_ESCALATION_DAYS) for (const administrator of administrators) {
      const key = `${baseKey}:admin-review:${administrator._id}`;
      const created = await alertOnce({
        key,
        userId: administrator._id,
        appId: application._id,
        type: "STAGE_DELAY_ADMIN_REVIEW",
        title: `Stage delay requires Admin review: ${caseId}`,
        body: delayDescription,
        severity: "HIGH",
      });
      if (!created) continue;
      await writeAudit({
        actor_id: null,
        action: "STAGE_DELAY_ADMIN_REVIEW",
        entity: "Application",
        entity_id: application._id,
        after_json: {
          stage: application.current_stage,
          responsibleUserId: recipient ? String(recipient) : null,
          responsibleUserName: responsibleName,
          responsibleUserRole: responsibleRole,
          delayDays,
          notifiedAdminId: String(administrator._id),
        },
      });
      await notifyUser(
        administrator._id,
        "STAGE_DELAY_ADMIN_REVIEW",
        `Stage delay requires Admin review: ${caseId}`,
        delayDescription,
        key,
        false,
        { application_id: application._id, caseId },
      );
    }
    if (!recipient) continue;
    if (delayDays < maxDays + 3) {
      const created = await alertOnce({ key: `${baseKey}:first-reminder`, userId: recipient, appId: application._id, type: "STAGE_DELAY_FIRST_REMINDER", title: "Application stage is delayed", body: delayDescription });
      if (created) {
        await StageHistory.create({ application_id: application._id, from_stage: application.current_stage, to_stage: application.current_stage, actor_id: null, reason: "System sent the first configured stage-delay reminder." });
        await writeAudit({ actor_id: null, action: "STAGE_DELAY_FIRST_REMINDER", entity: "Application", entity_id: application._id, after_json: { stage: application.current_stage, responsibleUserId: String(recipient), responsibleUserName: responsibleName, delayDays } });
        await notifyUser(recipient, "STAGE_DELAY_FIRST_REMINDER", "Application stage is delayed", delayDescription, `${baseKey}:first`, false, { application_id: application._id, caseId });
      }
      continue;
    }
    if (delayDays < maxDays + 6) {
      const created = await alertOnce({ key: `${baseKey}:reason-required`, userId: recipient, appId: application._id, type: "STAGE_DELAY_REASON_REQUIRED", title: "Reason required for delayed stage", body: `${delayDescription} Please record the reason for the delay.`, dueAt: new Date(application.stage_entered_at.getTime() + (maxDays + 6) * DAY) });
      if (created) {
        await StageHistory.create({ application_id: application._id, from_stage: application.current_stage, to_stage: application.current_stage, actor_id: null, reason: "System requested a recorded reason for a delayed stage." });
        await writeAudit({ actor_id: null, action: "STAGE_DELAY_REASON_REQUESTED", entity: "Application", entity_id: application._id, after_json: { stage: application.current_stage, delayDays } });
        await notifyUser(recipient, "STAGE_DELAY_REASON_REQUIRED", "Please provide a delay reason", `A reason is required for delayed case ${caseId}.`, `${baseKey}:reason`, true, { application_id: application._id, caseId });
      }
      continue;
    }
    const reasonAlert = await Alert.findOne({ application_id: application._id, type: "STAGE_DELAY_REASON_REQUIRED", target_user_id: recipient });
    if (reasonAlert?.reason_text) continue;
    const bureau = await User.findOne({ role: "BUREAU_OFFICER", status: "ACTIVE" }).select("_id");
    for (const userId of [recipient, bureau?._id].filter(Boolean)) {
      const created = await alertOnce({ key: `${baseKey}:cancel-permission:${userId}`, userId, appId: application._id, type: "CANCELLATION_PERMISSION_REQUEST", title: "Cancellation permission requested", body: `Delayed case ${caseId} requires a human decision on whether cancellation may be considered. This application has not been cancelled.`, severity: "HIGH" });
      if (created) {
        await notifyUser(userId, "CANCELLATION_PERMISSION_REQUEST", "Human decision required", `Case ${caseId} is delayed. Review whether cancellation may be considered; no automatic cancellation has occurred.`, `${baseKey}:cancel:${userId}`, true, { application_id: application._id, caseId });
        await StageHistory.create({ application_id: application._id, from_stage: application.current_stage, to_stage: application.current_stage, actor_id: null, reason: "System requested a human cancellation review; no cancellation occurred." });
        await writeAudit({ actor_id: null, action: "CANCELLATION_PERMISSION_REQUESTED", entity: "Application", entity_id: application._id, after_json: { stage: application.current_stage, delayDays, autoCancelled: false } });
      }
    }
    if (delayDays >= maxDays + 9) {
      const seniorAuthorities = await User.find({ role: "SENIOR_AUTHORITY", status: "ACTIVE" }).select("_id");
      for (const senior of seniorAuthorities) {
        const key = `${baseKey}:senior-escalation:${senior._id}`;
        if (await alertOnce({ key, userId: senior._id, appId: application._id, type: "STAGE_DELAY_ESCALATED", title: "Application delay escalated", body: `Case ${caseId} remains delayed without a recorded reason. Human review is required.`, severity: "HIGH" })) {
          await writeAudit({ actor_id: null, action: "STAGE_DELAY_ESCALATED", entity: "Application", entity_id: application._id, after_json: { stage: application.current_stage, delayDays, escalatedTo: senior._id } });
          await notifyUser(senior._id, "STAGE_DELAY_ESCALATED", "Application delay escalated", `Case ${caseId} remains delayed without a recorded reason.`, key, true, { application_id: application._id, caseId });
        }
      }
    }
  }
  return { scanned };
}

async function leaseExpiryScanner(now) {
  let scanned = 0;
  const leases = await LeaseDetail.find({ lease_end: { $ne: null } }).populate("document_id").lean();
  for (const lease of leases) {
    if (!lease.document_id || lease.document_id.status !== "CONFIRMED") continue;
    scanned += 1;
    const daysLeft = istDaysBetween(lease.lease_end, now);
    const status = daysLeft < 0 ? "EXPIRED" : daysLeft <= 60 ? "EXPIRING" : "VALID";
    await LeaseDetail.updateOne({ _id: lease._id }, { $set: { validity_status: status } });
    const application = await Application.findById(lease.document_id.application_id).lean();
    if (!application) continue;
    const institutionUser = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
    const officer = application.assigned_officer_id ? await User.findById(application.assigned_officer_id).select("_id") : null;
    const recipients = [institutionUser?._id, officer?._id].filter(Boolean);
    const caseId = application.application_number || application._id.toString();
    if (daysLeft < 0) {
      await Application.updateOne({ _id: application._id }, { $set: { is_compliant: false } });
      const escalation = await User.find({ role: { $in: ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] }, status: "ACTIVE" }).select("_id");
      recipients.push(...escalation.map((item) => item._id));
      for (const userId of recipients) {
        const key = `lease:${lease._id}:expired:${lease.lease_end.toISOString()}:${userId}`;
        if (await alertOnce({ key, userId, appId: application._id, type: "LEASE_EXPIRED", title: "Confirmed lease is expired", body: `Case ${caseId} has a confirmed lease that expired. Human review and renewal are required.`, severity: "CRITICAL" })) {
          await notifyUser(userId, "LEASE_EXPIRED", "Confirmed lease expired", `Confirmed lease for case ${caseId} expired. Review and renewal are required.`, key, true, { application_id: application._id, caseId });
        }
      }
      continue;
    }
    for (const threshold of [60, 30, 10, 1]) {
      if (daysLeft > threshold) continue;
      for (const userId of recipients) {
        const key = `lease:${lease._id}:T${threshold}:${lease.lease_end.toISOString()}:${userId}`;
        const sms = threshold <= 30;
        if (await alertOnce({ key, userId, appId: application._id, type: `LEASE_T${threshold}`, title: `Lease expiry in ${daysLeft} day(s)`, body: `Case ${caseId} lease expires in ${daysLeft} day(s). AI suggestions do not renew or extend a lease.`, severity: threshold <= 10 ? "HIGH" : "MEDIUM" })) {
          await notifyUser(userId, `LEASE_T${threshold}`, `Lease expiry in ${daysLeft} day(s)`, `Case ${caseId} lease expires in ${daysLeft} day(s). Please review renewal.` , key, sms || threshold === 1, { application_id: application._id, caseId });
        }
      }
    }
  }
  return { scanned };
}

async function pendingInstitutionScanner(now) {
  let scanned = 0;
  const items = await PendingItem.find({ resolved_at: null, due_date: { $lte: now } }).lean();
  for (const item of items) {
    const application = await Application.findById(item.application_id).lean();
    if (!application) continue;
    scanned += 1;
    const recipient = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
    if (!recipient) continue;
    const count = item.reminder_count + 1;
    const key = `pending:${item._id}:reminder:${count}`;
    const caseId = application.application_number || application._id.toString();
    await notifyUser(recipient._id, "PENDING_INSTITUTION_ITEM", `Institution submission pending: ${item.description}`, `Case ${caseId}: ${item.description}. Due date was ${item.due_date.toISOString().slice(0, 10)}.`, key, count >= 2, { application_id: application._id, caseId });
    if (count === 3 && application.assigned_officer_id) {
      await notifyUser(application.assigned_officer_id, "PENDING_ITEM_ESCALATED", "Institution response is overdue", `Case ${caseId} has not responded to a pending item after three reminders.`, `pending:${item._id}:officer-escalation`, false, { application_id: application._id, caseId });
      await writeAudit({ actor_id: null, action: "PENDING_ITEM_ESCALATED", entity: "PendingItem", entity_id: item._id, after_json: { reminderCount: count, escalatedTo: application.assigned_officer_id } });
    }
    await PendingItem.updateOne({ _id: item._id, reminder_count: item.reminder_count }, { $inc: { reminder_count: 1 } });
  }
  return { scanned };
}

async function undertakingReportScanner(now) {
  let scanned = 0;
  const undertakings = await Undertaking.find({ status: { $in: ["PENDING", "OVERDUE"] } }).lean();
  for (const item of undertakings) {
    const application = await Application.findById(item.application_id).lean();
    if (!application) continue;
    const daysLeft = istDaysBetween(item.due_date, now);
    if (daysLeft >= 0 && !YEARLY_REPORT_REMINDER_DAYS.has(daysLeft)) continue;
    if (daysLeft > 90) continue;
    scanned += 1;
    const recipient = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
    if (!recipient) continue;
    const key = `undertaking:${item._id}:${daysLeft < 0 ? "overdue" : `T${daysLeft}`}`;
    const caseId = application.application_number || application._id.toString();
    if (daysLeft < 0) await Undertaking.updateOne({ _id: item._id }, { $set: { status: "OVERDUE" } });
    await notifyUser(recipient._id, daysLeft < 0 ? "UNDERTAKING_OVERDUE" : "UNDERTAKING_DUE_REMINDER",
      daysLeft < 0 ? "Undertaking is overdue" : "Undertaking deadline approaching",
      `Case ${caseId}: ${item.title} is ${daysLeft < 0 ? "overdue" : `due in ${daysLeft} day(s)`}.`, key, daysLeft <= 3,
      { application_id: application._id, caseId });
    if (daysLeft < 0) {
      const escalations = await regionalEscalationUsers(application.institution_id, Math.max(0, -daysLeft), `undertaking:${item._id}`);
      for (const escalation of escalations) {
        await notifyUser(escalation._id, "UNDERTAKING_ESCALATION", "Undertaking remains overdue", `Case ${caseId}: ${item.title} remains overdue.`, `undertaking:${item._id}:escalation:${escalation._id}`, true, { application_id: application._id, caseId });
      }
    }
  }
  const reports = await YearlyReport.find({ status: { $in: ["DRAFT", "RETURNED", "OVERDUE"] } }).lean();
  for (const report of reports) {
    const daysLeft = istDaysBetween(report.due_date, now);
    const reminderLevel = yearlyReportReminderLevel(daysLeft);
    if (!reminderLevel) continue;
    scanned += 1;
    let user;
    if (report.faculty_id) {
      const faculty = await Faculty.findById(report.faculty_id).lean();
      user = faculty && await User.findOne({ email: faculty.email, role: "FACULTY", status: "ACTIVE" }).select("_id");
    } else {
      user = await User.findOne({ institution_id: report.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
    }
    if (!user) continue;
    const key = `yearly-report:${report._id}:${reminderLevel}`;
    if (daysLeft < 0) await YearlyReport.updateOne({ _id: report._id }, { $set: { status: "OVERDUE" } });
    await notifyUser(user._id, daysLeft < 0 ? "YEARLY_REPORT_OVERDUE" : "YEARLY_REPORT_REMINDER",
      daysLeft < 0 ? "Yearly report is overdue" : "Yearly report deadline approaching",
      `Your ${report.academic_year} yearly report is ${daysLeft < 0 ? "overdue" : `due in ${daysLeft} day(s)`}.`,
      key, daysLeft <= 3, {});
    if (daysLeft < 0) {
      let institutionId = report.institution_id;
      if (!institutionId && report.faculty_id) {
        institutionId = (await Faculty.findById(report.faculty_id).select("institution_id").lean())?.institution_id;
      }
      const escalations = await regionalEscalationUsers(institutionId, Math.max(0, -daysLeft), `yearly-report:${report._id}`);
      for (const escalation of escalations) {
        await notifyUser(escalation._id, "YEARLY_REPORT_ESCALATION", "Yearly report remains overdue", `Academic year ${report.academic_year} report remains overdue.`, `yearly-report:${report._id}:escalation:${escalation._id}`, true, { institution_id: institutionId });
      }
    }
  }
  return { scanned };
}

async function grievanceAndInstitutionReportScanner(now) {
  let scanned = 0;
  let queued = 0;
  const activeComplaintFilter = { status: { $in: ["SUBMITTED", "ACKNOWLEDGED", "IN_REVIEW"] } };
  const [activeComplaints, invalidComplaintDeadlines] = await Promise.all([
    Complaint.find({ ...activeComplaintFilter, response_due_at: { $type: "date" } }).lean(),
    Complaint.countDocuments({ ...activeComplaintFilter, response_due_at: { $not: { $type: "date" } } }),
  ]);
  if (invalidComplaintDeadlines) logger.warn({ count: invalidComplaintDeadlines }, "Grievance reminders skipped records with invalid response deadlines");
  for (const complaint of activeComplaints) {
    const daysLeft = istDaysBetween(complaint.response_due_at, now);
    const level = deadlineReminderLevel(daysLeft);
    if (!level) continue;
    scanned += 1;
    const recipients = new Set([complaint.assigned_to?.toString()].filter(Boolean));
    if (level === "overdue" || level === "T1" || level === "due") {
      const institutionUser = await User.findOne({ institution_id: complaint.institution_id, role: "INSTITUTION", status: "ACTIVE", deleted_at: null }).select("_id").lean();
      if (institutionUser) recipients.add(institutionUser._id.toString());
    }
    if (level === "overdue") {
      const escalationRoles = grievanceEscalationRoles(Math.max(0, -daysLeft));
      if (escalationRoles.length) {
        const escalationUsers = await User.find({ role: { $in: escalationRoles }, region: complaint.region, status: "ACTIVE", deleted_at: null }).select("_id role").lean();
        escalationUsers.forEach((user) => recipients.add(user._id.toString()));
      }
    }
    const overdueDays = Math.max(0, -daysLeft);
    for (const recipientId of recipients) {
      const userId = recipientId;
      const isEscalation = level === "overdue" && (await User.exists({ _id: userId, role: { $in: ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] } }));
      const type = isEscalation ? "GRIEVANCE_RESPONSE_ESCALATION" : level === "overdue" ? "GRIEVANCE_RESPONSE_OVERDUE" : "GRIEVANCE_RESPONSE_REMINDER";
      const body = isEscalation
        ? `Complaint ${complaint._id} is ${overdueDays} day(s) overdue; escalation review is required.`
        : level === "overdue"
          ? `Complaint ${complaint._id} is ${overdueDays} day(s) overdue for its 15-day institutional response target.`
          : `Complaint ${complaint._id} requires a response by ${new Date(complaint.response_due_at).toLocaleDateString("en-IN")}.`;
      await notifyUser(userId, type, isEscalation ? "Overdue grievance escalated" : level === "overdue" ? "Grievance response deadline missed" : "Grievance response deadline approaching",
        body, `grievance:${complaint._id}:${level}:${userId}`, level === "overdue", { complaint_id: complaint._id });
      queued += 1;
    }
  }

  const activeAppeals = await Complaint.find({ appeal_status: { $in: ["SUBMITTED", "IN_REVIEW"] }, appeal_due_at: { $type: "date" } }).lean();
  for (const appeal of activeAppeals) {
    const daysLeft = istDaysBetween(appeal.appeal_due_at, now);
    const level = deadlineReminderLevel(daysLeft);
    if (!level) continue;
    scanned += 1;
    const recipients = new Set([appeal.appeal_assigned_to?.toString()].filter(Boolean));
    if (level === "overdue") {
      const institution = await Institution.findById(appeal.institution_id).select("region").lean();
      const escalationRoles = grievanceEscalationRoles(Math.max(0, -daysLeft));
      if (escalationRoles.length) {
        const escalationUsers = await User.find({ role: { $in: escalationRoles }, region: institution?.region, status: "ACTIVE", deleted_at: null }).select("_id").lean();
        escalationUsers.forEach((user) => recipients.add(user._id.toString()));
      }
    }
    for (const userId of recipients) {
      await notifyUser(userId, level === "overdue" ? "GRIEVANCE_APPEAL_OVERDUE" : "GRIEVANCE_APPEAL_REMINDER",
        level === "overdue" ? "Ombudsperson decision deadline missed" : "Ombudsperson decision deadline approaching",
        `Student appeal ${appeal._id} has a 30-day decision target${level === "overdue" ? " that is overdue" : ` due ${new Date(appeal.appeal_due_at).toLocaleDateString("en-IN")}`}.`,
        `grievance-appeal:${appeal._id}:${level}:${userId}`, level === "overdue", { complaint_id: appeal._id });
      queued += 1;
    }
  }

  const [institutionReports, invalidReportDeadlines] = await Promise.all([
    InstitutionAnnualReport.find({ status: "DRAFT", due_date: { $type: "date" } }).lean(),
    InstitutionAnnualReport.countDocuments({ status: "DRAFT", due_date: { $not: { $type: "date" } } }),
  ]);
  if (invalidReportDeadlines) logger.warn({ count: invalidReportDeadlines }, "Institutional report reminders skipped records with invalid deadlines");
  for (const report of institutionReports) {
    const daysLeft = istDaysBetween(report.due_date, now);
    const level = deadlineReminderLevel(daysLeft);
    if (!level) continue;
    scanned += 1;
    const institutionUser = await User.findOne({ institution_id: report.institution_id, role: "INSTITUTION", status: "ACTIVE", deleted_at: null }).select("_id").lean();
    const reportRecipients = new Set([institutionUser?._id.toString()].filter(Boolean));
    const overdueDays = Math.max(0, -daysLeft);
    if (level === "overdue") {
      const roles = grievanceEscalationRoles(overdueDays);
      if (roles.length) {
        const institution = await Institution.findById(report.institution_id).select("region").lean();
        const escalationUsers = await User.find({ role: { $in: roles }, ...(institution?.region ? { region: institution.region } : {}), status: "ACTIVE", deleted_at: null }).select("_id").lean();
        escalationUsers.forEach((user) => reportRecipients.add(user._id.toString()));
      }
    }
    for (const recipientId of reportRecipients) {
      const isEscalation = level === "overdue" && await User.exists({ _id: recipientId, role: { $in: ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] } });
      const type = isEscalation ? "INSTITUTION_IC_REPORT_ESCALATION" : level === "overdue" ? "INSTITUTION_IC_REPORT_OVERDUE" : "INSTITUTION_IC_REPORT_REMINDER";
      const message = isEscalation
        ? `The ${report.calendar_year} institutional Internal Committee annual report is ${overdueDays} day(s) overdue; escalation review is required.`
        : `The ${report.calendar_year} institutional Internal Committee annual report is ${level === "overdue" ? "overdue" : `due ${new Date(report.due_date).toLocaleDateString("en-IN")}`}.`;
      await notifyUser(recipientId, type, isEscalation ? "Overdue Internal Committee report escalated" : level === "overdue" ? "Internal Committee annual report overdue" : "Internal Committee annual report deadline approaching",
        message, `institution-ic-report:${report._id}:${level}:${recipientId}`, level === "overdue", {});
      queued += 1;
    }
  }
  return { scanned, queued };
}

async function visitReminderScanner(now) {
  const until = new Date(now.getTime() + DAY);
  const visits = await Visit.find({ status: "SCHEDULED", scheduled_at: { $gt: now, $lte: until } }).lean();
  let scanned = 0;
  for (const visit of visits) {
    const application = await Application.findById(visit.application_id).select("application_number institution_id").lean();
    if (!application) continue;
    scanned += 1;
    const institution = await User.findOne({ institution_id: application.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
    const recipients = [institution?._id, visit.evc_user_id].filter(Boolean);
    for (const userId of recipients) {
      const key = `visit:${visit._id}:reminder-24h:${visit.scheduled_at.toISOString()}:${userId}`;
      await notifyUser(
        userId,
        "EVC_VISIT_REMINDER",
        "EVC visit scheduled within 24 hours",
        `Case ${application.application_number || application._id} has an EVC visit scheduled for ${visit.scheduled_at.toISOString()}.`,
        key,
        true,
        { application_id: application._id, caseId: application.application_number || application._id.toString() },
      );
    }
  }
  return { scanned };
}

async function complianceRecompute() {
  const applications = await Application.find({ status: { $nin: ["APPROVED", "CANCELLED", "REJECTED"] }, deleted_at: null }).select("_id").lean();
  let updated = 0;
  for (const app of applications) {
    const undertakingOverdue = await Undertaking.exists({ application_id: app._id, status: "OVERDUE" });
    const pendingOverdue = await PendingItem.exists({ application_id: app._id, resolved_at: null, due_date: { $lt: startOfNextIstDay(new Date()) } });
    const confirmedDocumentIds = await Document.find({ application_id: app._id, status: "CONFIRMED" }).distinct("_id");
    const expiredLease = await LeaseDetail.exists({ document_id: { $in: confirmedDocumentIds }, validity_status: "EXPIRED" });
    const yearlyOverdue = await YearlyReport.exists({ institution_id: (await Application.findById(app._id).select("institution_id").lean())?.institution_id, status: "OVERDUE" });
    const compliant = !(undertakingOverdue || pendingOverdue || expiredLease || yearlyOverdue);
    const result = await Application.updateOne({ _id: app._id, is_compliant: { $ne: compliant } }, { $set: { is_compliant: compliant } });
    updated += result.modifiedCount;
  }
  return { scanned: applications.length, updated };
}

async function sessionCleanup(now) {
  const result = await Session.deleteMany({ $or: [{ revoked_at: { $ne: null } }, { expires_at: { $lte: now } }] });
  return { deleted: result.deletedCount };
}

async function documentProcessingScanner(now) {
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const stale = await Document.updateMany(
    { status: "PROCESSING", updatedAt: { $lt: staleBefore } },
    { $set: { status: "AI_FAILED" } },
  );
  const staleRuns = await ProcessingRun.updateMany(
    { status: "processing", startedAt: { $lt: staleBefore } },
    { $set: { status: "failed", errorCode: "PROCESSING_TIMEOUT", completedAt: now } },
  );
  const pending = await Document.find({ status: "UPLOADED" }).select("_id").limit(20).lean();
  for (const document of pending) await processDocument(document._id);
  return { staleRecovered: stale.modifiedCount, staleRunsFailed: staleRuns.modifiedCount, processed: pending.length };
}

async function casePipelineScanner(now) {
  const cursor = CaseRecord.find({
    status: { $in: ["submitted", "in_progress", "returned"] },
    deletedAt: null,
  }).select("_id").cursor({ batchSize: 100 });
  let scanned = 0;
  let failed = 0;
  for await (const record of cursor) {
    scanned += 1;
    try {
      await evaluateCasePipeline({ caseId: record._id, intent: "CHANGE", apply: true, now });
    } catch (error) {
      failed += 1;
      logger.error({
        caseId: record._id.toString(),
        code: error.code || "CASE_PIPELINE_TICK_FAILED",
      }, "Scheduled case pipeline reevaluation failed");
    }
  }
  return { scanned, failed };
}

async function obligationScanner(now) {
  const obligations = await CaseObligation.find({ closure: "open", dueAt: { $ne: null } }).lean();
  if (!obligations.length) return { scanned: 0, queued: 0 };
  const policyVersions = [...new Set((await CaseRecord.find({
    _id: { $in: obligations.map((item) => item.caseId) },
    deletedAt: null,
  }).distinct("policyVersion")))];
  const policies = await Policy.find({ version: { $in: policyVersions } }).select("version alertRules").lean();
  const policyByVersion = new Map(policies.map((policy) => [policy.version, policy]));
  const cases = await CaseRecord.find({ _id: { $in: obligations.map((item) => item.caseId) }, deletedAt: null })
    .select("caseNo region policyVersion")
    .lean();
  const caseById = new Map(cases.map((record) => [record._id.toString(), record]));
  let queued = 0;

  for (const obligation of obligations) {
    const caseRecord = caseById.get(obligation.caseId.toString());
    const policy = caseRecord && policyByVersion.get(caseRecord.policyVersion);
    if (!caseRecord || !policy) continue;
    const rules = policy.alertRules || {};
    const level = obligationReminderLevel({
      dueAt: obligation.dueAt,
      dueKind: obligation.dueKind,
      now,
      reminderDays: Array.isArray(rules.reminderDays) ? rules.reminderDays : [],
      escalationAfterDays: Array.isArray(rules.escalationAfterDays) ? rules.escalationAfterDays : [],
    });
    if (!level) continue;

    let recipients = [];
    if (level.startsWith("escalation_")) {
      recipients = await User.find({
        role: "SENIOR_AUTHORITY",
        status: "ACTIVE",
        deleted_at: null,
        ...(caseRecord.region ? { region: caseRecord.region } : {}),
      }).select("_id").lean();
    } else if (obligation.ownerId) {
      recipients = [{ _id: obligation.ownerId }];
    } else if (obligation.ownerType === "institution") {
      recipients = await User.find({
        institution_id: obligation.institutionId,
        role: "INSTITUTION",
        status: "ACTIVE",
        deleted_at: null,
      }).select("_id").lean();
    }

    for (const recipient of recipients) {
      const eventKey = createAlertKey({
        obligationId: obligation._id.toString(),
        deadlineRevision: obligation.deadlineRevision,
        ruleVersion: rules.ruleVersion || "v1",
        level,
        recipient: recipient._id.toString(),
        channel: "IN_APP",
      });
      const title = level.startsWith("escalation_") ? "Overdue obligation requires review" : "Obligation deadline reminder";
      const body = `${obligation.title} for case ${caseRecord.caseNo} is ${level.replaceAll("_", " ")}.`;
      await NotificationService.enqueue({
        userId: recipient._id,
        type: `OBLIGATION_${level.toUpperCase()}`,
        channel: "IN_APP",
        payload: {
          title,
          body,
          case_id: caseRecord._id,
          due_at: obligation.dueAt,
          severity: level.startsWith("escalation_") ? "HIGH" : "INFO",
        },
        dedupeKey: eventKey,
      });
      queued += 1;
    }
  }
  return { scanned: obligations.length, queued };
}

async function weeklyDigest() {
  const recipients = await User.find({ role: { $in: ["SENIOR_AUTHORITY", "BUREAU_OFFICER"] }, status: "ACTIVE" }).select("_id");
  const [openAlerts, overdueCases, expiringLeases] = await Promise.all([
    Alert.countDocuments({ status: "OPEN" }),
    Application.countDocuments({ is_compliant: false, status: "IN_PROGRESS" }),
    LeaseDetail.countDocuments({ validity_status: "EXPIRING" }),
  ]);
  for (const recipient of recipients) {
    await NotificationService.enqueue({
      userId: recipient._id,
      type: "WEEKLY_DIGEST",
      channel: "EMAIL",
      payload: { subject: "ApprovalTrack weekly compliance digest", body: `${openAlerts} open alerts, ${overdueCases} non-compliant cases, and ${expiringLeases} expiring leases.` },
      dedupeKey: `weekly-digest:${new Date().toISOString().slice(0, 10)}:${recipient._id}`,
    });
  }
  return { recipients: recipients.length };
}

export const jobHandlers = Object.freeze({
  stageDelayScanner,
  stageOverdueScanner,
  leaseExpiryScanner,
  pendingInstitutionScanner,
  undertakingReportScanner,
  grievanceAndInstitutionReportScanner,
  visitReminderScanner,
  notificationWorker: (now) => NotificationService.processDue({ now }),
  documentProcessingScanner,
  casePipelineScanner,
  obligationScanner,
  complianceRecompute,
  sessionCleanup,
  weeklyDigest,
});

export async function runJob(name, { now = new Date() } = {}) {
  const handler = jobHandlers[name];
  if (!handler) throw Object.assign(new Error(`Unknown job: ${name}`), { status: 404, code: "UNKNOWN_JOB" });
  const summary = await handler(now);
  logger.info({ job: name, summary }, "Scheduled job completed");
  return summary;
}
