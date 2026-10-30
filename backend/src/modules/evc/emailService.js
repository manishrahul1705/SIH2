import { logger } from "../../config/logger.js";
import { NotificationService } from "../notifications/service.js";

async function enqueueEmails(recipients, { type, subjectFor, bodyFor, dedupeKey }) {
  const uniqueRecipients = [...new Map(recipients
    .filter((recipient) => recipient.email)
    .map((recipient) => [recipient.email.toLowerCase(), recipient])).values()];
  const results = await Promise.allSettled(uniqueRecipients.map((recipient, index) => NotificationService.enqueue({
    userId: recipient.userId || undefined,
    recipientEmail: recipient.email,
    type,
    channel: "EMAIL",
    payload: {
      subject: subjectFor(recipient),
      body: bodyFor(recipient),
      security: true,
    },
    dedupeKey: `${dedupeKey}:${index}:${recipient.email.toLowerCase()}`,
  })));
  const failedCount = results.filter((result) => result.status === "rejected").length;
  const queuedEmails = uniqueRecipients.filter((_, index) => results[index].status === "fulfilled").map(({ email }) => email.toLowerCase());
  if (failedCount) {
    logger.error({ type, queued: results.length - failedCount, failedCount }, "EVC email notifications could not all be queued");
  }
  return { queued: results.length - failedCount, failedCount, queuedEmails };
}

export async function sendEvcScheduledEmail({ institution, application, date, mode, instructions, panelists = [] }) {
  const panelNames = panelists.map((member) => member.name).filter(Boolean).join(", ") || "Assigned EVC panel";
  const modeLabel = { PHYSICAL: "Physical Campus Visit", VIRTUAL: "Virtual Inspection", HYBRID: "Hybrid Inspection" }[mode] || mode;
  const readyDocuments = (application.allocatedStages?.[application.currentStageIndex]?.requiredDocuments || []).join(", ") || "the application documents";
  const body = [
    `Application: ${application.caseNo} (${institution.name})`,
    `Inspection date: ${date}`,
    `Inspection mode: ${modeLabel}`,
    `Assigned panel: ${panelNames}`,
    `Documents to keep ready: ${readyDocuments}`,
    instructions ? `Special instructions: ${instructions}` : "",
  ].filter(Boolean).join("\n");
  const result = await enqueueEmails([
    { email: institution.contact_email },
    ...panelists.map((member) => ({ email: member.email, userId: member._id })),
  ], {
    type: "EVC_INSPECTION_SCHEDULED",
    subjectFor: () => `[AICTE ApprovalTrack] EVC inspection scheduled — ${application.caseNo}`,
    bodyFor: () => body,
    dedupeKey: `evc-scheduled:${application._id}:${new Date(date).toISOString().slice(0, 10)}`,
  });
  const institutionEmail = institution.contact_email.toLowerCase();
  return {
    queued: result.queued,
    failedCount: result.failedCount,
    institutionQueued: result.queuedEmails.includes(institutionEmail),
    panelistsQueued: result.queuedEmails.filter((email) => email !== institutionEmail).length,
  };
}

export async function sendEvcRejectionEmailChain({
  institution,
  application,
  previousStageOfficers,
  rejectionCategory,
  reason,
  rejectedBy,
}) {
  const institutionBody = [
    `Application ${application.caseNo} for ${institution.name} was rejected during Expert Visit Committee review.`,
    `Category: ${rejectionCategory}`,
    `Rejection remarks: ${reason}`,
    "Applicable APH references: consult the current signed-off policy recorded on this application.",
    "You may submit a deficiency response or pursue the appeal process through the Standing Appellate Committee (SAC), subject to the applicable policy and timelines.",
  ].join("\n\n");
  const result = await enqueueEmails([
    { email: institution.contact_email, body: institutionBody, subject: `[AICTE ApprovalTrack] Urgent: Application Rejected at EVC Stage — ${application.caseNo} (${institution.name})` },
    ...previousStageOfficers.map((officer) => ({
      email: officer.email,
      userId: officer._id,
      stageName: officer.stageName,
      body: `Case ${application.caseNo} (${institution.name}), previously processed at stage ${officer.stageName}, was rejected at the EVC stage by ${rejectedBy.name}. Category: ${rejectionCategory}. Rejection remarks: ${reason}`,
      subject: `[Notification] Case ${application.caseNo} Rejected at EVC Stage by ${rejectedBy.name}`,
    })),
  ], {
    type: "EVC_APPLICATION_REJECTED",
    subjectFor: (recipient) => recipient.subject || `[Notification] Case ${application.caseNo} Rejected at EVC Stage`,
    bodyFor: (recipient) => recipient.body || institutionBody,
    dedupeKey: `evc-rejected:${application._id}:${application.version}`,
  });
  const institutionEmail = institution.contact_email.toLowerCase();
  return {
    queued: result.queued,
    failedCount: result.failedCount,
    institutionQueued: result.queuedEmails.includes(institutionEmail),
    previousStageOfficersQueued: result.queuedEmails.filter((email) => email !== institutionEmail).length,
  };
}
