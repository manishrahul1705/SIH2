const stage = (key, name, routeKey, assignedRole, slaDays, requiredDocuments = []) => ({
  key,
  name,
  routeKey,
  assignedRole,
  slaDays,
  requiredDocuments,
});

const RULES = Object.freeze({
  new_institution: [
    stage("document_scrutiny", "Document Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 5, ["Land/Building Lease Deed", "Fire Safety Certificate", "Building Stability Certificate", "Affidavit"]),
    stage("land_lease_verification", "Infrastructure & Land/Lease Verification", "regional_committee", "SCRUTINY_OFFICER", 5),
    stage("evc_inspection", "EVC Physical/Virtual Inspection", "evc", "EVC", 7),
    stage("sac_review", "SAC / Final Review", "sac", "SAC_SHC", 4),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 3),
  ],
  new_course: [
    stage("document_scrutiny", "Document Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 4, ["Lab Equipment & Readiness Proof", "Faculty Roster & Yearly Report Compliance", "Building & Fire Safety Certificates"]),
    stage("academic_readiness", "Academic & Faculty Readiness Check", "regional_committee", "SCRUTINY_OFFICER", 4),
    stage("evc_inspection", "EVC Lab/Facility Inspection", "evc", "EVC", 5),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 3),
  ],
  increase_in_intake: [
    stage("document_scrutiny", "Document Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 4, ["Existing EoA Order", "Additional Classroom/Lab Area Proof", "Valid Fire & Building Safety Certificates", "Undertaking Affidavit"]),
    stage("ratio_infrastructure", "Faculty-Student Ratio & Infrastructure Check", "regional_committee", "SCRUTINY_OFFICER", 4),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 3),
  ],
  extension_of_approval: [
    stage("document_scrutiny", "Automated & Officer Document Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 3, ["Annual Compliance Affidavit", "Valid Fire & Building Safety Certificates", "Lease Validity", "Pending Undertaking Proofs"]),
    stage("compliance_verification", "Compliance & Undertaking Verification", "regional_committee", "SCRUTINY_OFFICER", 3),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 2),
  ],
  conversion_diploma_to_degree: [
    stage("document_scrutiny", "Document Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 5, ["Affiliating University & State Govt NOC", "Land/Lease Deed", "Upgraded Lab & Faculty Proof", "Fire & Building Safety Certificates"]),
    stage("university_lease_verification", "University/Board NOC & Land/Lease Verification", "regional_committee", "SCRUTINY_OFFICER", 5),
    stage("evc_inspection", "EVC Campus & Upgrading Inspection", "evc", "EVC", 7),
    stage("sac_review", "SAC / Final Review", "sac", "SAC_SHC", 4),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 3),
  ],
  collaboration_twinning: [
    stage("document_scrutiny", "Document Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 4, ["Bilateral MoU / Twinning Agreement", "Accreditation Proof", "Compliance Affidavit"]),
    stage("mou_accreditation_verification", "MoU & Partner Accreditation Verification", "regional_committee", "BUREAU_OFFICER", 5),
    stage("sac_review", "SAC / Standing Committee Review", "sac", "SAC_SHC", 4),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 3),
  ],
  restoration_of_intake: [
    stage("deficiency_rectification", "Deficiency Rectification Scrutiny", "scrutiny", "SCRUTINY_OFFICER", 4, ["Deficiency Rectification Report", "Updated Fire/Building/Lease Certificates", "Undertaking Fulfillment Evidence"]),
    stage("evc_verification", "EVC Verification of Rectified Deficiencies", "evc", "EVC", 6),
    stage("hearing_review", "SHC / SAC Hearing Review", "shc", "SAC_SHC", 4),
    stage("final_approval", "Final Approval", "decision", "BUREAU_OFFICER", 3),
  ],
});

export const APPLICATION_TYPE_LABELS = Object.freeze({
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration or twinning programme",
  restoration_of_intake: "Restoration of intake",
});

export function allocateStagesForApplication(applicationType) {
  const stages = RULES[applicationType];
  if (!stages) throw new TypeError(`Unsupported application type: ${applicationType}`);
  return stages.map((item) => ({
    ...item,
    status: "PENDING",
    assignedUserId: null,
    stageStartedAt: null,
    stageDueAt: null,
    elapsedMs: 0,
    activeClockHolder: null,
    pausedRemainingMs: null,
    frozenAt: null,
    assistRequests: [],
    remarks: "",
    approvedAt: null,
  }));
}

export const STAGE_ALLOCATION_RULES = RULES;
