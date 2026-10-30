// Loads only confirmed application facts for intake pipeline specification sections 9-10.
import { AiExtraction, CaseFinding, CaseTask, Document } from "../../models/index.js";
import { buildChecklist } from "../../engine/checklist.js";

function termMonths(value) {
  if (typeof value !== "string") return undefined;
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?$/i.exec(value.trim());
  if (match) return Number(match[1] || 0) * 12 + Number(match[2] || 0);
  const years = /^(\d+(?:\.\d+)?)\s*years?$/i.exec(value.trim());
  if (years) return Math.round(Number(years[1]) * 12);
  const months = /^(\d+(?:\.\d+)?)\s*months?$/i.exec(value.trim());
  if (months) return Math.round(Number(months[1]));
  return undefined;
}

export async function buildCaseFacts(record, policy, intent = "CHANGE") {
  const documentIds = record.slotRecords.map((slot) => slot.documentId).filter(Boolean);
  const [documents, confirmedExtractions, findings, tasks] = await Promise.all([
    Document.find({ case_id: record._id, _id: { $in: documentIds } })
      .select("_id doc_type_slot doc_type_final status verification verified_by verified_at confirmed_at superseded_by_document_id quarantine_reason file_hash mean_ocr_conf createdAt")
      .lean(),
    AiExtraction.find({ document_id: { $in: documentIds } })
      .select("document_id fields.field_name fields.confirmed_value")
      .sort({ createdAt: -1 })
      .lean(),
    CaseFinding.find({ caseId: record._id, status: "open" }).select("code documentId slotId").lean(),
    CaseTask.find({ caseId: record._id, state: { $in: ["open", "queued"] } })
      .select("type documentId slotId")
      .lean(),
  ]);
  const extractionByDocument = new Map();
  for (const extraction of confirmedExtractions) {
    const key = String(extraction.document_id);
    if (!extractionByDocument.has(key)) extractionByDocument.set(key, extraction.fields || []);
  }
  const currentDocs = documents.filter((document) => document.status !== "SUPERSEDED");
  const confirmedDocuments = currentDocs
    .filter((document) => document.status === "QUARANTINED" || (document.status === "CONFIRMED" && !document.quarantine_reason))
    .map((document) => {
      if (document.status === "QUARANTINED" || document.quarantine_reason) {
        return {
          documentId: String(document._id),
          slotKind: document.doc_type_slot,
          docType: document.doc_type_final,
          verification: document.verification || "pending",
          quarantined: true,
        };
      }
      const fields = new Map((extractionByDocument.get(String(document._id)) || [])
        .filter((field) => field.confirmed_value != null)
        .map((field) => [field.field_name, field.confirmed_value]));
      const leaseTerm = termMonths(fields.get("lease_term"));
      return {
        documentId: String(document._id),
        slotKind: document.doc_type_slot,
        docType: document.doc_type_final,
        fileHash: document.file_hash,
        meanOcrConfidence: document.mean_ocr_conf,
        ...(fields.has("issue_date") ? { issueDate: fields.get("issue_date") } : {}),
        ...(fields.has("valid_from") ? { validFrom: fields.get("valid_from") } : {}),
        ...(fields.has("valid_to") ? { validTo: fields.get("valid_to") } : {}),
        ...(fields.has("cert_no") ? { certificateNumber: fields.get("cert_no") } : {}),
        ...(fields.has("lease_start") || fields.has("lease_end") || leaseTerm !== undefined
          ? { lease: {
            ...(fields.has("lease_start") ? { start: fields.get("lease_start") } : {}),
            ...(fields.has("lease_end") ? { end: fields.get("lease_end") } : {}),
            ...(leaseTerm !== undefined ? { termMonths: leaseTerm } : {}),
          } }
          : {}),
        verification: document.verification || "pending",
        ...(document.superseded_by_document_id ? { supersededBy: String(document.superseded_by_document_id) } : {}),
        quarantined: false,
        confirmedAt: document.confirmed_at?.toISOString?.() || "",
      };
    });
  const checklist = buildChecklist(record.applicationType, record.applicability, record.slotRecords, policy.checklist);
  const currentDocumentById = new Map(currentDocs.map((document) => [String(document._id), document]));
  const slots = checklist.map((slot) => {
    const doc = slot.documentId ? currentDocumentById.get(String(slot.documentId)) : null;
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      requirement: slot.requirement,
      required: slot.required,
      applies: slot.reviewRequired ? "unknown" : slot.required,
      ...(slot.documentId ? { currentDocumentId: String(slot.documentId) } : {}),
      status: doc?.status === "QUARANTINED" ? "quarantined" : slot.status,
      label: slot.label,
    };
  });
  const openVerifyTaskDocumentIds = tasks.filter((task) => task.type === "VERIFY_DOCUMENT").map((task) => String(task.documentId));
  const openReviewTaskSlotIds = tasks.filter((task) => task.type === "REVIEW").map((task) => task.slotId);
  return {
    caseId: String(record._id),
    version: record.version,
    applicationType: record.applicationType,
    answers: record.applicability || {},
    policyVersion: record.policyVersion,
    route: [...record.route],
    stage: record.currentStage,
    status: record.status,
    holderType: record.holderType,
    ...(record.holderId ? { holderId: String(record.holderId) } : {}),
    region: record.region,
    slots,
    documents: confirmedDocuments,
    openFindingCodes: findings.map((finding) => finding.code),
    openFindings: findings.map((finding) => ({
      code: finding.code,
      ...(finding.documentId ? { documentId: String(finding.documentId) } : {}),
      ...(finding.slotId ? { slotId: finding.slotId } : {}),
    })),
    evcTaskExists: tasks.some((task) => task.type === "EVC"),
    openEvcTaskId: String(tasks.find((task) => task.type === "EVC")?._id || ""),
    openVerifyTaskDocumentIds,
    openReviewTaskSlotIds,
    openDeficiencyTaskDocumentIds: tasks
      .filter((task) => task.type === "DEFICIENCY_RESPONSE")
      .map((task) => String(task.documentId)),
    intent,
    ...(intent === "STAGE_COMPLETE" ? { completedStage: record.currentStage } : {}),
  };
}
