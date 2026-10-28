import { Alert, Application, AuditLog, CaseObligation, CaseRecord, Document, Faculty, LeaseDetail, PendingItem, Policy, Session, StageConfig, StageHistory, Undertaking, User, YearlyReport } from "../../models/index.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { NotificationService } from "../notifications/service.js";
import { DEFAULT_RULES } from "../rules/engine.js";
import { writeAudit } from "../../middleware/audit.js";
import { processDocument } from "../ai/pipeline.js";
import { createAlertKey, obligationReminderLevel } from "../../engine/timeRules.js";

const DAY = 86_400_000;

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
  for (const application of applications) {
    const config = await StageConfig.findOne({ application_type: application.type, stage: application.current_stage, enabled: true }).lean();
    const maxDays = config?.max_days ?? DEFAULT_RULES.W6.params.maxDaysByStage[application.current_stage];
    if (!maxDays || now.getTime() - application.stage_entered_at.getTime() < maxDays * DAY) continue;
    scanned += 1;
    const delayDays = Math.floor((now.getTime() - application.stage_entered_at.getTime()) / DAY);
    const baseKey = `stage-delay:${application._id}:${application.current_stage}:${application.stage_entered_at.toISOString()}`;
    const recipient = application.assigned_officer_id || (await User.findOne({ role: config?.role_responsible || "SCRUTINY_OFFICER", status: "ACTIVE" }).select("_id"))?._id;
    if (!recipient) continue;
    const caseId = application.application_number || application._id.toString();
    if (delayDays < maxDays + 3) {
      const created = await alertOnce({ key: `${baseKey}:first-reminder`, userId: recipient, appId: application._id, type: "STAGE_DELAY_FIRST_REMINDER", title: "Application stage is delayed", body: `${caseId} has remained in ${application.current_stage} beyond its configured ${maxDays}-day target.` });
      if (created) {
        await StageHistory.create({ application_id: application._id, from_stage: application.current_stage, to_stage: application.current_stage, actor_id: null, reason: "System sent the first configured stage-delay reminder." });
        await writeAudit({ actor_id: null, action: "STAGE_DELAY_FIRST_REMINDER", entity: "Application", entity_id: application._id, after_json: { stage: application.current_stage, delayDays } });
        await notifyUser(recipient, "STAGE_DELAY_FIRST_REMINDER", "Application stage is delayed", `${caseId} has remained in ${application.current_stage} beyond its configured ${maxDays}-day target.`, `${baseKey}:first`, false, { application_id: application._id, caseId });
      }
      continue;
    }
    if (delayDays < maxDays + 6) {
      const created = await alertOnce({ key: `${baseKey}:reason-required`, userId: recipient, appId: application._id, type: "STAGE_DELAY_REASON_REQUIRED", title: "Reason required for delayed stage", body: `Please record a reason for the ${application.current_stage} delay on ${caseId}.`, dueAt: new Date(application.stage_entered_at.getTime() + (maxDays + 6) * DAY) });
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
    if (daysLeft > 7) continue;
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
    if (daysLeft < -3) {
      const escalations = await User.find({ role: { $in: ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] }, status: "ACTIVE" }).select("_id");
      for (const escalation of escalations) {
        await notifyUser(escalation._id, "UNDERTAKING_ESCALATION", "Undertaking remains overdue", `Case ${caseId}: ${item.title} remains overdue.`, `undertaking:${item._id}:escalation:${escalation._id}`, true, { application_id: application._id, caseId });
      }
    }
  }
  const reports = await YearlyReport.find({ status: { $in: ["DRAFT", "RETURNED", "OVERDUE"] } }).lean();
  for (const report of reports) {
    const daysLeft = istDaysBetween(report.due_date, now);
    if (daysLeft > 7) continue;
    scanned += 1;
    let user;
    if (report.faculty_id) {
      const faculty = await Faculty.findById(report.faculty_id).lean();
      user = faculty && await User.findOne({ email: faculty.email, role: "FACULTY", status: "ACTIVE" }).select("_id");
    } else {
      user = await User.findOne({ institution_id: report.institution_id, role: "INSTITUTION", status: "ACTIVE" }).select("_id");
    }
    if (!user) continue;
    const key = `yearly-report:${report._id}:${daysLeft < 0 ? "overdue" : `T${daysLeft}`}`;
    if (daysLeft < 0) await YearlyReport.updateOne({ _id: report._id }, { $set: { status: "OVERDUE" } });
    await notifyUser(user._id, daysLeft < 0 ? "YEARLY_REPORT_OVERDUE" : "YEARLY_REPORT_REMINDER",
      daysLeft < 0 ? "Yearly report is overdue" : "Yearly report deadline approaching",
      `Your ${report.academic_year} yearly report is ${daysLeft < 0 ? "overdue" : `due in ${daysLeft} day(s)`}.`,
      key, daysLeft <= 3, {});
    if (daysLeft < -3) {
      const escalations = await User.find({ role: { $in: ["BUREAU_OFFICER", "SENIOR_AUTHORITY"] }, status: "ACTIVE" }).select("_id");
      for (const escalation of escalations) {
        await notifyUser(escalation._id, "YEARLY_REPORT_ESCALATION", "Yearly report remains overdue", `Academic year ${report.academic_year} report remains overdue.`, `yearly-report:${report._id}:escalation:${escalation._id}`, true, {});
      }
    }
  }
  return { scanned };
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
  const pending = await Document.find({ status: "UPLOADED" }).select("_id").limit(20).lean();
  for (const document of pending) await processDocument(document._id);
  return { staleRecovered: stale.modifiedCount, processed: pending.length };
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
  leaseExpiryScanner,
  pendingInstitutionScanner,
  undertakingReportScanner,
  visitReminderScanner,
  notificationWorker: (now) => NotificationService.processDue({ now }),
  documentProcessingScanner,
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
