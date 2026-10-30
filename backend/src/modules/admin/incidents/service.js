import { randomUUID } from "node:crypto";
import { ROLES } from "../../../config/constants.js";
import { withTransaction, writeAudit } from "../../../middleware/audit.js";
import {
  Application,
  ApplicationIncident,
  AuditLog,
  CaseRecord,
  CaseStageHistory,
  Institution,
  NotificationJob,
  NotificationLog,
  StageHistory,
  User,
} from "../../../models/index.js";

const severityRank = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const TERMINAL_STATUSES = new Set(["RESOLVED", "CLOSED"]);

export class IncidentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sourceKey(workflowType, id) {
  return `${workflowType}:${String(id)}`;
}

export function sourceReference(workflowType, applicationId) {
  if (workflowType === "LEGACY_APPLICATION") return { applicationId, caseRecordId: null };
  if (workflowType === "CASE_RECORD") return { applicationId: null, caseRecordId: applicationId };
  throw new IncidentError(400, "INVALID_WORKFLOW_TYPE", "Unsupported workflow type");
}

function sourceIdFor(incident) {
  return incident.workflowType === "LEGACY_APPLICATION" ? incident.applicationId : incident.caseRecordId;
}

function idString(id) {
  return id == null ? null : String(id._id || id);
}

function normalizedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function stageForCase(source) {
  const stages = source.allocatedStages || [];
  const indexed = Number.isInteger(source.currentStageIndex) && source.currentStageIndex >= 0
    ? stages[source.currentStageIndex]
    : null;
  const current = String(source.currentStage || "").toLowerCase();
  return indexed || stages.find((stage) => [stage.key, stage.name, stage.routeKey]
    .some((value) => String(value || "").toLowerCase() === current)) || null;
}

export function sourceSnapshot(workflowType, source) {
  if (!source) return null;
  if (workflowType === "LEGACY_APPLICATION") {
    return {
      workflowType,
      applicationId: String(source._id),
      applicationNumber: source.application_number || String(source._id),
      institutionId: idString(source.institution_id),
      applicationType: source.type,
      currentStage: source.current_stage,
      applicationStatus: source.status,
      stageEnteredAt: source.stage_entered_at || null,
      submittedAt: source.submitted_at || null,
      responsibleOfficerId: idString(source.assigned_officer_id),
      region: "",
    };
  }
  const stage = stageForCase(source);
  return {
    workflowType,
    applicationId: String(source._id),
    applicationNumber: source.caseNo || String(source._id),
    institutionId: idString(source.institutionId),
    applicationType: source.applicationType,
    currentStage: stage?.name || source.currentStage,
    stageKey: stage?.key || stage?.routeKey || source.currentStage,
    applicationStatus: source.overallStatus || source.status,
    stageEnteredAt: stage?.stageStartedAt || source.stageEnteredAt || null,
    submittedAt: source.submittedAt || null,
    responsibleOfficerId: idString(stage?.assignedUserId || stage?.activeClockHolder || source.holderId),
    responsibleOfficerRole: stage?.assignedRole || null,
    region: source.region || "",
  };
}

function eventAsSummary(event, actorUsers = new Map()) {
  const actor = actorUsers.get(idString(event.actorUserId));
  return {
    id: event.eventId,
    action: event.action,
    at: event.timestamp,
    actor: actor ? { id: idString(actor._id), name: actor.name, role: actor.role } : (event.actorUserId ? { id: idString(event.actorUserId), name: "", role: null } : null),
    note: event.note || "",
    reason: event.reason || "",
    resolutionSummary: event.resolutionSummary || "",
    rootCause: event.rootCause || "",
    resolutionEvidence: event.resolutionEvidence || "",
    verificationResult: event.verificationResult || "",
    remainingLimitations: event.remainingLimitations || "",
    result: event.result || "",
    recipient: event.recipientUserId
      ? { id: idString(event.recipientUserId), role: event.recipientRole || null }
      : null,
  };
}

function incidentDate(incident) {
  return normalizedDate(incident.detectedAt || incident.createdAt) || new Date(0);
}

function matchesIncident(incident, source, query) {
  if (query.severity && incident.severity !== query.severity) return false;
  if (query.type && incident.type !== query.type) return false;
  if (query.stage) {
    const stage = `${incident.stageKey || ""} ${incident.stageName || ""}`.toLowerCase();
    if (!stage.includes(query.stage.toLowerCase())) return false;
  }
  if (query.ownerId && idString(incident.responsibleOfficerId || source.responsibleOfficerId) !== query.ownerId) return false;
  const date = incidentDate(incident);
  if (query.dateFrom && date < query.dateFrom) return false;
  if (query.dateTo && date > query.dateTo) return false;
  return true;
}

function applicationListRecord(source, institution, users, matchingIncidents, allIncidents, now) {
  const officer = source.responsibleOfficerId ? users.get(idString(source.responsibleOfficerId)) : null;
  const pendingIncidents = allIncidents.filter((incident) => !TERMINAL_STATUSES.has(incident.status));
  const sortedMatching = [...matchingIncidents].sort((a, b) => incidentDate(b) - incidentDate(a));
  const sortedEvents = sortedMatching.flatMap((incident) => (incident.events || []).map((event) => ({ incident, event })))
    .sort((a, b) => normalizedDate(b.event.timestamp) - normalizedDate(a.event.timestamp));
  const firstSeen = matchingIncidents.map(incidentDate).sort((a, b) => a - b)[0];
  const lastSeen = matchingIncidents.map(incidentDate).sort((a, b) => b - a)[0];
  const earliestOpen = pendingIncidents.map(incidentDate).sort((a, b) => a - b)[0];
  const officerShape = officer
    ? { id: idString(officer._id), name: officer.name, role: officer.role }
    : source.responsibleOfficerId
      ? { id: idString(source.responsibleOfficerId), name: "", role: source.responsibleOfficerRole || null }
      : null;
  const lastEvent = sortedEvents[0];
  const highestSeverityIncidents = pendingIncidents.length ? pendingIncidents : matchingIncidents;
  const mostRecentResolutionAt = allIncidents.map((incident) => normalizedDate(incident.closedAt || incident.resolvedAt))
    .filter(Boolean).sort((a, b) => b - a)[0] || null;
  return {
    workflowType: source.workflowType,
    applicationId: source.applicationId,
    applicationNumber: source.applicationNumber,
    institutionName: institution?.name || "",
    applicationType: source.applicationType,
    currentStage: source.currentStage,
    applicationStatus: source.applicationStatus,
    incidentCount: matchingIncidents.length,
    highestSeverity: highestSeverityIncidents.reduce((highest, item) => severityRank[item.severity] > severityRank[highest] ? item.severity : highest, "INFO"),
    earliestIncidentAt: earliestOpen || firstSeen,
    latestIncidentAt: lastSeen,
    mostRecentResolutionAt,
    resolvedIncidentCount: allIncidents.filter((incident) => TERMINAL_STATUSES.has(incident.status)).length,
    overallIncidentStatus: pendingIncidents.length ? "PENDING" : "COMPLETED",
    responsibleOfficer: officerShape,
    pendingDurationMs: earliestOpen ? Math.max(0, now.getTime() - earliestOpen.getTime()) : 0,
    lastAction: lastEvent ? {
      action: lastEvent.event.action,
      at: lastEvent.event.timestamp,
      actorId: idString(lastEvent.event.actorUserId),
      incidentId: String(lastEvent.incident._id),
    } : null,
    incidents: sortedMatching.map((incident) => incidentSummary(incident, users)),
  };
}

function incidentSummary(incident, users) {
  const ownerId = idString(incident.responsibleOfficerId);
  const owner = ownerId ? users.get(ownerId) : null;
  const lastEvent = [...(incident.events || [])].sort((a, b) => normalizedDate(b.timestamp) - normalizedDate(a.timestamp))[0];
  return {
    id: String(incident._id),
    type: incident.type,
    severity: incident.severity,
    status: incident.status,
    stage: incident.stageKey || incident.stageName ? { key: incident.stageKey || "", name: incident.stageName || incident.stageKey || "" } : null,
    summary: incident.summary,
    detectedAt: incident.detectedAt || incident.createdAt,
    dueAt: incident.dueAt || null,
    resolvedAt: incident.resolvedAt || null,
    responsibleOfficer: owner ? { id: ownerId, name: owner.name, role: owner.role } : (ownerId ? { id: ownerId, name: incident.responsibleOfficerName || "", role: incident.responsibleOfficerRole || null } : null),
    lastAction: lastEvent ? { action: lastEvent.action, at: lastEvent.timestamp } : null,
  };
}

export function buildIncidentApplicationPage({ incidents, sources, institutions = new Map(), users = new Map(), query, now = new Date() }) {
  const sourceMap = sources instanceof Map ? sources : new Map(sources.map((source) => [sourceKey(source.workflowType, source.applicationId), source]));
  const grouped = new Map();
  for (const incident of incidents) {
    const workflowId = idString(sourceIdFor(incident));
    const key = sourceKey(incident.workflowType, workflowId);
    const source = sourceMap.get(key);
    if (!source) continue;
    const group = grouped.get(key) || { source, all: [], matching: [] };
    group.all.push(incident);
    if (matchesIncident(incident, source, query)) group.matching.push(incident);
    grouped.set(key, group);
  }

  const records = [];
  for (const group of grouped.values()) {
    if (!group.matching.length) continue;
    const institution = institutions.get(idString(group.source.institutionId));
    const row = applicationListRecord(group.source, institution, users, group.matching, group.all, now);
    if (query.search) {
      const search = query.search.toLowerCase();
      const applicationAndIncidents = [
        row.applicationNumber,
        row.institutionName,
        ...group.matching.flatMap((incident) => [String(incident._id), incident.type, incident.summary, incident.details]),
      ].join(" ").toLowerCase();
      if (!applicationAndIncidents.includes(search)) continue;
    }
    records.push({ row, pending: group.all.some((item) => !TERMINAL_STATUSES.has(item.status)), group });
  }

  const summary = {
    affectedApplications: records.length,
    pendingApplications: records.filter((record) => record.pending).length,
    completedApplications: records.filter((record) => !record.pending).length,
    criticalOpenIncidents: records.reduce((count, record) => count + record.group.matching
      .filter((incident) => !TERMINAL_STATUSES.has(incident.status) && incident.severity === "CRITICAL").length, 0),
  };
  const tabRecords = records.filter((record) => query.tab === "pending" ? record.pending : !record.pending);
  tabRecords.sort((a, b) => (b.row.latestIncidentAt?.getTime?.() || 0) - (a.row.latestIncidentAt?.getTime?.() || 0)
    || a.row.applicationNumber.localeCompare(b.row.applicationNumber));
  const total = tabRecords.length;
  const pages = Math.ceil(total / query.pageSize);
  return {
    applications: tabRecords.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((record) => record.row),
    summary,
    page: query.page,
    pageSize: query.pageSize,
    total,
    pages,
  };
}

function idSet(ids) {
  return [...new Set(ids.map(idString).filter(Boolean))];
}

async function loadSourceRecords(incidents) {
  const legacyIds = idSet(incidents.filter((incident) => incident.workflowType === "LEGACY_APPLICATION").map((incident) => incident.applicationId));
  const caseIds = idSet(incidents.filter((incident) => incident.workflowType === "CASE_RECORD").map((incident) => incident.caseRecordId));
  const [legacy, cases] = await Promise.all([
    legacyIds.length ? Application.find({ _id: { $in: legacyIds }, deleted_at: null }).lean() : [],
    caseIds.length ? CaseRecord.find({ _id: { $in: caseIds }, deletedAt: null }).lean() : [],
  ]);
  return [
    ...legacy.map((record) => sourceSnapshot("LEGACY_APPLICATION", record)),
    ...cases.map((record) => sourceSnapshot("CASE_RECORD", record)),
  ];
}

async function loadLookups(sources, incidents) {
  const institutionIds = idSet(sources.map((source) => source.institutionId));
  const userIds = idSet([
    ...sources.map((source) => source.responsibleOfficerId),
    ...incidents.map((incident) => incident.responsibleOfficerId),
    ...incidents.flatMap((incident) => (incident.events || []).map((event) => event.actorUserId)),
  ]);
  const [institutions, users] = await Promise.all([
    institutionIds.length ? Institution.find({ _id: { $in: institutionIds } }).select("name").lean() : [],
    userIds.length ? User.find({ _id: { $in: userIds } }).select("name role region status deleted_at").lean() : [],
  ]);
  return {
    institutions: new Map(institutions.map((item) => [idString(item._id), item])),
    users: new Map(users.map((item) => [idString(item._id), item])),
  };
}

export async function listIncidentApplications(query, now = new Date()) {
  const incidents = await ApplicationIncident.find().sort({ detectedAt: -1, createdAt: -1 }).lean();
  const sources = await loadSourceRecords(incidents);
  const lookups = await loadLookups(sources, incidents);
  return buildIncidentApplicationPage({
    incidents,
    sources,
    ...lookups,
    query: {
      ...query,
      ownerId: query.ownerId || "",
      dateFrom: normalizedDate(query.dateFrom),
      dateTo: normalizedDate(query.dateTo),
    },
    now,
  });
}

export async function loadApplicationIncidentDetail(workflowType, applicationId) {
  const sourceRecord = workflowType === "LEGACY_APPLICATION"
    ? await Application.findOne({ _id: applicationId, deleted_at: null }).lean()
    : await CaseRecord.findOne({ _id: applicationId, deletedAt: null }).lean();
  if (!sourceRecord) throw new IncidentError(404, "APPLICATION_NOT_FOUND", "Application not found");

  const source = sourceSnapshot(workflowType, sourceRecord);
  const filter = workflowType === "LEGACY_APPLICATION" ? { workflowType, applicationId } : { workflowType, caseRecordId: applicationId };
  const [incidents, stageHistory, caseHistory, auditEntries] = await Promise.all([
    ApplicationIncident.find(filter).sort({ detectedAt: 1, createdAt: 1 }).lean(),
    workflowType === "LEGACY_APPLICATION" ? StageHistory.find({ application_id: applicationId }).sort({ createdAt: 1 }).lean() : [],
    workflowType === "CASE_RECORD" ? CaseStageHistory.find({ caseId: applicationId }).sort({ enteredAt: 1 }).lean() : [],
    AuditLog.find({ entity: workflowType === "LEGACY_APPLICATION" ? "Application" : "CaseRecord", entity_id: applicationId }).sort({ createdAt: 1 }).lean(),
  ]);

  const embeddedStageHistory = workflowType === "CASE_RECORD"
    ? (sourceRecord.allocatedStages || []).flatMap((stage) => (stage.history || []).map((event) => ({
      stageName: stage.name,
      stageKey: stage.key,
      ...event,
    })))
    : [];
  const incidentIds = incidents.map((incident) => incident._id);
  const notificationJobs = await NotificationJob.find({
    $or: [
      { "payload_json.application_id": sourceRecord._id },
      { "payload_json.application_id": String(sourceRecord._id) },
      { "payload_json.case_id": String(sourceRecord._id) },
      ...(incidentIds.length ? [{ "payload_json.incident_id": { $in: incidentIds.map(String) } }] : []),
    ],
  }).sort({ createdAt: 1 }).lean();
  const notificationLogs = notificationJobs.length
    ? await NotificationLog.find({ job_id: { $in: notificationJobs.map((job) => job._id) } }).sort({ createdAt: 1 }).lean()
    : [];
  const jobsById = new Map(notificationJobs.map((job) => [idString(job._id), job]));
  const actorIds = idSet([
    ...stageHistory.map((event) => event.actor_id),
    ...caseHistory.flatMap((event) => [event.actorId, event.holderId]),
    ...embeddedStageHistory.map((event) => event.performed_by),
    ...auditEntries.map((event) => event.actor_id),
    ...incidents.flatMap((incident) => (incident.events || []).map((event) => event.actorUserId)),
    ...notificationLogs.map((log) => log.to_user_id),
  ]);
  const institutionIds = idSet([source.institutionId]);
  const [institutionRecords, users] = await Promise.all([
    institutionIds.length ? Institution.find({ _id: { $in: institutionIds } }).select("name").lean() : [],
    actorIds.length ? User.find({ _id: { $in: actorIds } }).select("name role").lean() : [],
  ]);
  const usersById = new Map(users.map((user) => [idString(user._id), user]));
  const officer = source.responsibleOfficerId ? usersById.get(source.responsibleOfficerId) : null;
  const application = {
    workflowType,
    applicationId: String(sourceRecord._id),
    applicationNumber: source.applicationNumber,
    institutionName: institutionRecords[0]?.name || "",
    institutionId: source.institutionId,
    applicationType: source.applicationType,
    currentStage: source.currentStage,
    applicationStatus: source.applicationStatus,
    stageEnteredAt: source.stageEnteredAt,
    submittedAt: source.submittedAt,
    stageDueAt: incidents.find((incident) => incident.stageName === source.currentStage && incident.dueAt)?.dueAt
      || (workflowType === "CASE_RECORD" ? stageForCase(sourceRecord)?.stageDueAt || null : null),
    responsibleOfficer: officer
      ? { id: source.responsibleOfficerId, name: officer.name, role: officer.role }
      : source.responsibleOfficerId ? { id: source.responsibleOfficerId, name: "", role: source.responsibleOfficerRole || null } : null,
  };
  const timeline = [
    ...stageHistory.map((event) => ({
      id: `stage:${String(event._id)}`,
      kind: "STAGE_HISTORY",
      at: event.createdAt,
      action: "STAGE_CHANGED",
      fromStage: event.from_stage,
      toStage: event.to_stage,
      reason: event.reason || "",
      actor: event.actor_id ? actorSummary(event.actor_id, usersById) : null,
    })),
    ...caseHistory.map((event) => ({
      id: `case-stage:${String(event._id)}`,
      kind: "CASE_STAGE_HISTORY",
      at: event.enteredAt,
      action: "STAGE_ENTERED",
      fromStage: event.fromStage,
      toStage: event.toStage,
      reason: event.reason || "",
      holder: event.holderId ? actorSummary(event.holderId, usersById) : null,
      actor: event.actorId ? actorSummary(event.actorId, usersById) : null,
    })),
    ...embeddedStageHistory.map((event, index) => ({
      id: `embedded-stage:${index}`,
      kind: "CASE_STAGE_EVENT",
      at: event.timestamp,
      action: event.action,
      stage: event.stageName,
      stageKey: event.stageKey,
      note: event.notes || "",
      actor: event.performed_by ? actorSummary(event.performed_by, usersById) : null,
    })),
    ...auditEntries.map((event) => ({
      id: `audit:${String(event._id)}`,
      kind: "AUDIT",
      at: event.createdAt,
      action: event.action,
      outcome: event.outcome,
      actor: event.actor_id ? actorSummary(event.actor_id, usersById) : null,
    })),
    ...incidents.flatMap((incident) => (incident.events || []).map((event) => ({
      id: `incident:${String(incident._id)}:${event.eventId}`,
      kind: "INCIDENT",
      incidentId: String(incident._id),
      at: event.timestamp,
      action: event.action,
      actor: event.actorUserId ? actorSummary(event.actorUserId, usersById) : null,
      note: event.note || "",
      reason: event.reason || "",
      resolutionSummary: event.resolutionSummary || "",
      rootCause: event.rootCause || "",
      resolutionEvidence: event.resolutionEvidence || "",
      verificationResult: event.verificationResult || "",
      remainingLimitations: event.remainingLimitations || "",
      result: event.result || "",
      recipient: event.recipientUserId ? actorSummary(event.recipientUserId, usersById) : null,
    }))),
    ...notificationLogs.map((log) => {
      const job = jobsById.get(idString(log.job_id));
      return {
        id: `notification:${String(log._id)}`,
        kind: "NOTIFICATION",
        at: log.createdAt,
        action: "NOTIFICATION_DELIVERY",
        description: `${job?.type || "Notification"} ${log.outcome.toLowerCase()} via ${log.channel}`,
        outcome: log.outcome,
        actor: null,
        recipient: log.to_user_id ? actorSummary(log.to_user_id, usersById) : null,
        source: "SYSTEM",
      };
    }),
    ...notificationJobs.filter((job) => !notificationLogs.some((log) => idString(log.job_id) === idString(job._id))).map((job) => ({
      id: `notification-job:${String(job._id)}`,
      kind: "NOTIFICATION",
      at: job.createdAt || job.run_at,
      action: "NOTIFICATION_QUEUED",
      description: `${job.type} queued via ${job.channel}`,
      outcome: job.status,
      actor: null,
      source: "SYSTEM",
    })),
  ].filter((event) => event.at).sort((a, b) => new Date(a.at) - new Date(b.at));

  const incidentDetails = incidents.map((incident) => ({
    ...incidentSummary(incident, usersById),
    workflowType: incident.workflowType,
    source: incident.source,
    detectionSource: incident.detectionSource,
    sourceDetails: incident.sourceDetails || "",
    evidence: incident.evidence || "",
    details: incident.details || "",
    closedAt: incident.closedAt || null,
    events: (incident.events || []).map((event) => eventAsSummary(event, usersById)),
  }));
  return {
    application,
    incidents: incidentDetails,
    timeline,
    historyComplete: workflowType === "LEGACY_APPLICATION"
      ? stageHistory.length > 0
      : caseHistory.length > 0 || embeddedStageHistory.length > 0,
  };
}

function actorSummary(id, usersById) {
  const value = idString(id);
  const user = usersById.get(value);
  return { id: value, name: user?.name || "", role: user?.role || null };
}

export async function recordApplicationIncident(input) {
  const { workflowType, applicationId, dedupeKey, type, severity = "MEDIUM", summary, details = "", stageKey = "", stageName = "", responsibleOfficerId = null, responsibleOfficerName = "", responsibleOfficerRole = null, detectedAt = new Date(), dueAt = null } = input;
  if (!applicationId || !dedupeKey || !summary) throw new TypeError("Incident source, dedupeKey, and summary are required");
  const sourceModel = workflowType === "LEGACY_APPLICATION" ? Application : workflowType === "CASE_RECORD" ? CaseRecord : null;
  if (!sourceModel) throw new IncidentError(400, "INVALID_WORKFLOW_TYPE", "Unsupported workflow type");
  if (!await sourceModel.exists({ _id: applicationId })) throw new IncidentError(404, "APPLICATION_NOT_FOUND", "Application not found");
  const normalizedKey = `${workflowType}:${applicationId}:${dedupeKey}`;
  const reference = sourceReference(workflowType, applicationId);
  try {
    return await withTransaction(async (session) => {
      let existingQuery = ApplicationIncident.findOne({ dedupeKey: normalizedKey });
      if (session) existingQuery = existingQuery.session(session);
      const existing = await existingQuery;
      if (existing) {
        if (!TERMINAL_STATUSES.has(existing.status)) {
          const before = {
            severity: existing.severity,
            stageKey: existing.stageKey,
            stageName: existing.stageName,
            responsibleOfficerId: idString(existing.responsibleOfficerId),
            responsibleOfficerName: existing.responsibleOfficerName,
            dueAt: existing.dueAt ? new Date(existing.dueAt).toISOString() : null,
          };
          existing.severity = severity;
          existing.summary = summary;
          existing.details = details;
          existing.stageKey = stageKey;
          existing.stageName = stageName;
          existing.responsibleOfficerId = responsibleOfficerId;
          existing.responsibleOfficerName = responsibleOfficerName;
          existing.responsibleOfficerRole = responsibleOfficerRole;
          existing.dueAt = dueAt;
          const after = {
            severity,
            stageKey,
            stageName,
            responsibleOfficerId: idString(responsibleOfficerId),
            responsibleOfficerName,
            dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          };
          const changed = Object.keys(after).some((key) => before[key] !== after[key]);
          if (changed) {
            const timestamp = new Date();
            const eventId = randomUUID();
            existing.events.push({
              eventId,
              action: "UPDATED",
              timestamp,
              note: "The automated overdue assessment refreshed the current stage owner, deadline, or severity.",
            });
            await writeAudit({
              actor_id: null,
              action: "INCIDENT_UPDATED",
              entity: "ApplicationIncident",
              entity_id: existing._id,
              before_json: before,
              after_json: { ...after, workflowType, applicationId: String(applicationId), eventId },
            }, session ? { session } : {});
          }
          await existing.save(session ? { session } : {});
        }
        return existing;
      }
      const [created] = await ApplicationIncident.create([{
        ...reference,
        workflowType,
        dedupeKey: normalizedKey,
        type,
        severity,
        status: "OPEN",
        stageKey,
        stageName,
        responsibleOfficerId,
        responsibleOfficerName,
        responsibleOfficerRole,
        summary,
        details,
        detectedAt,
        dueAt,
        events: [{ eventId: randomUUID(), action: "DETECTED", timestamp: detectedAt }],
      }], session ? { session } : {});
      await writeAudit({
        actor_id: null,
        action: "INCIDENT_DETECTED",
        entity: "ApplicationIncident",
        entity_id: created._id,
        after_json: { workflowType, applicationId: String(applicationId), type, severity, stageKey, stageName },
      }, session ? { session } : {});
      return created;
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const raced = await ApplicationIncident.findOne({ dedupeKey: normalizedKey });
    if (raced) return raced;
    throw error;
  }
}

export function applyIncidentAction(incident, action, body, event) {
  if (incident.status === "CLOSED" && action !== "REOPEN") {
    throw new IncidentError(409, "INCIDENT_CLOSED", "Reopen the incident before recording another action");
  }
  if (incident.status === "RESOLVED" && !["CLOSE", "REOPEN"].includes(action)) {
    throw new IncidentError(409, "INCIDENT_RESOLVED", "Reopen the incident before recording another action");
  }
  if (action === "REVIEW") {
    incident.status = "UNDER_REVIEW";
  } else if (action === "REQUEST_CLARIFICATION") {
    incident.status = "AWAITING_CLARIFICATION";
  } else if (action === "ESCALATE") {
    incident.status = "ESCALATED";
  } else if (action === "CORRECTIVE_ACTION") {
    incident.status = "CORRECTIVE_ACTION_PENDING";
  } else if (action === "RESOLVE") {
    incident.status = "RESOLVED";
    incident.resolvedAt = event.timestamp;
    incident.closedAt = null;
  } else if (action === "CLOSE") {
    if (incident.status !== "RESOLVED") throw new IncidentError(409, "RESOLUTION_REQUIRED", "An incident must be resolved before it can be closed");
    incident.status = "CLOSED";
    incident.closedAt = event.timestamp;
  } else if (action === "REOPEN") {
    if (!TERMINAL_STATUSES.has(incident.status)) throw new IncidentError(409, "INCIDENT_NOT_RESOLVED", "Only a resolved or closed incident can be reopened");
    incident.status = "OPEN";
    incident.resolvedAt = null;
    incident.closedAt = null;
  }
  incident.events.push({
    ...event,
    action,
    note: body.note || "",
    reason: body.reason || "",
    resolutionSummary: body.resolutionSummary || "",
    rootCause: body.rootCause || "",
    resolutionEvidence: body.resolutionEvidence || "",
    verificationResult: body.verificationResult || "",
    remainingLimitations: body.remainingLimitations || "",
    result: body.result || "",
  });
  return incident;
}

export async function resolveIncidentRecipient({ action, body, source, incident }) {
  let recipientId = body.targetUserId || "";
  let recipientRole = body.targetRole || "";
  const actionTargetsRecipient = ["REQUEST_CLARIFICATION", "CORRECTIVE_ACTION", "RESOLVE", "CLOSE"].includes(action);
  if (!recipientId && !recipientRole && actionTargetsRecipient) {
    recipientId = source.responsibleOfficerId || idString(incident.responsibleOfficerId) || "";
    if (!recipientId && source.institutionId) {
      const institutionUser = await User.findOne({
        institution_id: source.institutionId,
        role: "INSTITUTION",
        status: "ACTIVE",
        deleted_at: null,
      }).select("_id name role status").lean();
      if (institutionUser) return { recipient: institutionUser, recipientRole: institutionUser.role };
    }
  }
  if (!recipientId && !recipientRole && action === "ESCALATE") recipientRole = "ADMIN";
  if (!recipientId && !recipientRole && action === "REQUEST_CLARIFICATION") {
    throw new IncidentError(400, "RECIPIENT_REQUIRED", "Choose a user or role to receive this incident notification");
  }
  if (!recipientId && !recipientRole && actionTargetsRecipient) return { recipient: null, recipientRole: null };
  if (!recipientId && !recipientRole) return { recipient: null, recipientRole: null };
  const userFilter = { status: "ACTIVE", deleted_at: null };
  if (recipientId) userFilter._id = recipientId;
  else {
    if (!ROLES.includes(recipientRole)) throw new IncidentError(400, "INVALID_RECIPIENT_ROLE", "Recipient role is not supported");
    userFilter.role = recipientRole;
    if (source.region && recipientRole !== "ADMIN") userFilter.region = source.region;
    if (recipientRole === "INSTITUTION" && source.institutionId) userFilter.institution_id = source.institutionId;
  }
  const recipient = await User.findOne(userFilter).select("_id name role status").lean();
  if (!recipient && actionTargetsRecipient) return { recipient: null, recipientRole: null };
  if (!recipient) throw new IncidentError(404, "RECIPIENT_NOT_FOUND", "No active recipient was found for this action");
  return { recipient, recipientRole: recipientRole || recipient.role };
}

export async function persistIncidentAction({ incidentId, body, actor, ip, recipient = null }) {
  return withTransaction(async (session) => {
    let query = ApplicationIncident.findById(incidentId);
    if (session) query = query.session(session);
    const incident = await query;
    if (!incident) throw new IncidentError(404, "INCIDENT_NOT_FOUND", "Incident not found");
    const duplicateEvent = body.requestId && (incident.events || []).find((item) => item.eventId === body.requestId);
    if (duplicateEvent) return { incident, event: duplicateEvent, duplicate: true };
    const before = { status: incident.status, resolvedAt: incident.resolvedAt, closedAt: incident.closedAt };
    const timestamp = new Date();
    const event = {
      eventId: body.requestId || randomUUID(),
      timestamp,
      actorUserId: actor._id,
      ...(recipient ? { recipientUserId: recipient._id, recipientRole: recipient.role } : {}),
    };
    applyIncidentAction(incident, body.action, body, event);
    await incident.save(session ? { session } : {});
    await writeAudit({
      actor_id: actor._id,
      action: `INCIDENT_${body.action}`,
      entity: "ApplicationIncident",
      entity_id: incident._id,
      before_json: before,
      after_json: {
        workflowType: incident.workflowType,
        applicationId: String(sourceIdFor(incident)),
        status: incident.status,
        action: body.action,
        eventId: event.eventId,
        note: body.note || "",
        reason: body.reason || "",
        resolutionSummary: body.resolutionSummary || "",
        rootCause: body.rootCause || "",
        resolutionEvidence: body.resolutionEvidence || "",
        verificationResult: body.verificationResult || "",
        remainingLimitations: body.remainingLimitations || "",
        result: body.result || "",
        recipientUserId: recipient ? String(recipient._id) : null,
      },
      ip,
    }, session ? { session } : {});
    return { incident, event, duplicate: false };
  });
}

export function validateIncidentQuery(query) {
  const dateFrom = normalizedDate(query.dateFrom);
  const dateTo = normalizedDate(query.dateTo);
  if (query.dateFrom && !dateFrom) throw new IncidentError(400, "INVALID_DATE", "dateFrom must be a valid ISO date");
  if (query.dateTo && !dateTo) throw new IncidentError(400, "INVALID_DATE", "dateTo must be a valid ISO date");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new IncidentError(400, "INVALID_DATE_RANGE", "dateFrom must be before dateTo");
  if (dateTo) dateTo.setUTCHours(23, 59, 59, 999);
  return { ...query, dateFrom, dateTo };
}
