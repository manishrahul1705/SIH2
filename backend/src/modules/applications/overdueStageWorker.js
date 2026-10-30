import { randomUUID } from "node:crypto";
import { Alert, CaseRecord, OutboxEvent, User } from "../../models/index.js";
import { logger } from "../../config/logger.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";
import { NotificationService } from "../notifications/service.js";
import { recordApplicationIncident } from "../admin/incidents/service.js";

const ADMIN_ESCALATION_AFTER_HOURS = 24;

export async function stageOverdueScanner(now = new Date()) {
  const records = await CaseRecord.find({
    workflowVersion: "SIH26262-1.0",
    overallStatus: "IN_PROGRESS",
    deletedAt: null,
    currentStageIndex: { $gte: 0 },
  }).lean();
  let created = 0;
  for (const record of records) {
    const stage = record.allocatedStages?.[record.currentStageIndex];
    if (!stage || ["PENDING", "APPROVED", "REJECTED"].includes(stage.status)) continue;
    const assist = stage.status === "FROZEN_WAITING_FOR_ASSIST"
      ? [...(stage.assistRequests || [])].reverse().find((item) => item.status === "PENDING_ASSIST_DECISION")
      : null;
    const assistId = assist ? String(assist._id) : "none";
    const dueAt = assist?.assistDueAt || stage.stageDueAt;
    if (!dueAt || new Date(dueAt) >= now) continue;
    let responsibleUser = (assist?.assignedToUserId || stage.assignedUserId)
      ? await User.findOne({
        _id: assist?.assignedToUserId || stage.assignedUserId,
        status: "ACTIVE",
        deleted_at: null,
      }).select("_id name role").lean()
      : null;
    if (!responsibleUser) {
      responsibleUser = await User.findOne({
        role: assist?.targetRole || stage.assignedRole,
        status: "ACTIVE",
        deleted_at: null,
        region: record.region,
        ...(assist?.targetRole === "INSTITUTION" ? { institution_id: record.institutionId } : {}),
      }).select("_id name role").lean();
    }
    const recipientId = responsibleUser?._id || null;
    const stageOwner = assist && stage.assignedUserId && String(stage.assignedUserId) !== String(recipientId || "")
      ? await User.findOne({ _id: stage.assignedUserId, status: "ACTIVE", deleted_at: null }).select("_id name role").lean()
      : responsibleUser;
    const administrators = await User.find({ role: "ADMIN", status: "ACTIVE", deleted_at: null }).select("_id name").lean();
    const hoursOverdue = Math.max(1, Math.floor((now.getTime() - new Date(dueAt).getTime()) / 3_600_000));
    const recipients = [
      ...(recipientId ? [{ userId: recipientId, recipientType: "stage_owner" }] : []),
      ...(hoursOverdue >= ADMIN_ESCALATION_AFTER_HOURS ? administrators : [])
        .filter((admin) => String(admin._id) !== String(recipientId || ""))
        .map((admin) => ({ userId: admin._id, recipientType: "admin" })),
    ];
    const responsibleName = responsibleUser?.name || "Unassigned (no active owner resolved)";
    const responsibleRole = responsibleUser?.role || assist?.targetRole || stage.assignedRole || "Unknown";
    const stageOwnerName = stageOwner?.name || "Unavailable";
    const body = [
      `Application ID: ${record.caseNo}`,
      `Application Type: ${record.applicationType.replaceAll("_", " ")}`,
      `Stage: ${stage.name}`,
      `Assigned responsible user: ${responsibleName} (${responsibleRole})`,
      ...(assist ? [`Stage owner: ${stageOwnerName}`, `Overdue assist assignee: ${responsibleName}`] : []),
      `Due Date: ${new Date(dueAt).toISOString()}`,
      `Overdue: ${hoursOverdue} hour(s)`,
      "This identifies the assigned owner of the overdue work; it does not determine individual fault.",
      `Open and act: ${process.env.FRONTEND_ORIGIN || ""}/case/${record._id}`,
    ].join("\n");
    await recordApplicationIncident({
      workflowType: "CASE_RECORD",
      applicationId: String(record._id),
      dedupeKey: `stage-overdue:${record.currentStageIndex}:${assistId}:${new Date(dueAt).toISOString()}`,
      type: "STAGE_DUE_DATE_EXCEEDED",
      severity: "HIGH",
      summary: `${stage.name} is overdue for ${record.caseNo}`,
      details: body,
      stageKey: stage.key || stage.routeKey || String(record.currentStageIndex),
      stageName: stage.name,
      responsibleOfficerId: recipientId ? String(recipientId) : null,
      responsibleOfficerName: responsibleName,
      responsibleOfficerRole: responsibleRole,
      detectedAt: now,
      dueAt,
    });
    if (recipients.length === 0) {
      logger.warn({ caseId: String(record._id), stageIndex: record.currentStageIndex }, "Overdue stage alert skipped because no stage owner or active administrator could be resolved");
      continue;
    }
    const baseDedupeKey = `stage-overdue:${record._id}:${record.currentStageIndex}:${assistId}:STAGE_OVERDUE`;
    const subject = `ApprovalTrack overdue: ${record.caseNo} — ${stage.name}`;
    const insertedRecipientIds = await withTransaction(async (session) => {
      const options = session ? { session } : {};
      const createdFor = [];
      for (const recipient of recipients) {
        const dedupeKey = recipient.recipientType === "stage_owner"
          ? baseDedupeKey
          : `${baseDedupeKey}:admin:${recipient.userId}`;
        const result = await Alert.updateOne(
          { dedupe_key: dedupeKey },
          { $setOnInsert: {
            case_id: record._id,
            type: "STAGE_DUE_DATE_EXCEEDED",
            severity: "HIGH",
            target_user_id: recipient.userId,
            title: subject,
            body,
            due_at: dueAt,
            status: "OPEN",
            dedupe_key: dedupeKey,
          } },
          { upsert: true, runValidators: true, ...options },
        );
        if (result.upsertedCount === 1) createdFor.push({ ...recipient, dedupeKey });
      }
      if (createdFor.length === 0) return [];
      const payload = {
        caseId: String(record._id),
        caseNo: record.caseNo,
        stageIndex: record.currentStageIndex,
        stage: stage.name,
        assistId,
        responsibleUserId: recipientId ? String(recipientId) : null,
        responsibleUserName: responsibleName,
        responsibleUserRole: responsibleRole,
        stageOwnerId: stage.assignedUserId ? String(stage.assignedUserId) : null,
        adminRecipientIds: createdFor.filter((item) => item.recipientType === "admin").map((item) => String(item.userId)),
        dueAt,
        hoursOverdue,
      };
      await OutboxEvent.create([{
        eventId: randomUUID(),
        eventType: "case.stage_overdue_alert_created",
        entityId: String(record._id),
        payload,
        publishedAt: null,
      }], options);
      await writeAudit({ actor_id: null, action: "STAGE_DUE_DATE_EXCEEDED", entity: "CaseRecord", entity_id: record._id, after_json: payload }, { session });
      return createdFor;
    });
    if (insertedRecipientIds.length === 0) continue;
    created += 1;
    for (const recipient of insertedRecipientIds) {
      await NotificationService.enqueue({
        userId: recipient.userId,
        type: "STAGE_DUE_DATE_EXCEEDED",
        channel: "EMAIL",
        payload: { subject, body, case_id: String(record._id), severity: "HIGH" },
        dedupeKey: `${recipient.dedupeKey}:email`,
      });
    }
  }
  return { scanned: records.length, alertsCreated: created };
}