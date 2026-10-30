export const APPLICATION_TYPES = Object.freeze([
  "new_institution",
  "new_course",
  "increase_in_intake",
  "extension_of_approval",
  "conversion_diploma_to_degree",
  "collaboration_twinning",
  "restoration_of_intake",
]);

export const DEFAULT_APPLICABILITY = Object.freeze({
  landIsLeased: false,
  newAreaAdded: false,
  buildingOver30: false,
  claimsAccreditation: false,
  landChanged: false,
  premisesShared: false,
  premisesUsed: false,
  affiliatingBodyRequired: false,
});

export function normalizeApplicability(answers = {}) {
  return {
    ...DEFAULT_APPLICABILITY,
    ...answers,
    buildingOver30: typeof answers.buildingOver30 === "boolean"
      ? answers.buildingOver30
      : Number.isFinite(answers.buildingAgeYears) && answers.buildingAgeYears > 30,
  };
}

const trackedKinds = new Set([
  "lease",
  "fire",
  "structural",
  "occupancy_or_building",
  "nba_letter",
  "audited_accounts",
  "aicte_approval_letter",
]);

const validKinds = new Set(["fire", "structural", "nba_letter", "lease"]);

const requirements = {
  land_ownership_documents: ["R", "C", "C", "C", "C", "-", "C"],
  lease: ["C", "C", "C", "C", "C", "-", "C"],
  land_use_certificate: ["R", "C", "C", "-", "C", "-", "C"],
  land_conversion_certificate: ["R", "C", "C", "-", "C", "-", "C"],
  khasra_plan_master_plan: ["R", "-", "-", "-", "-", "-", "-"],
  encumbrance_certificate: ["C", "C", "C", "-", "C", "-", "C"],
  approved_building_plan_with_architect_certificate: ["R", "R", "R", "-", "R", "-", "C"],
  occupancy_or_building: ["R", "C", "C", "C", "R", "C", "C"],
  structural: ["C", "C", "C", "C", "C", "-", "C"],
  fire: ["R", "R", "R", "R", "R", "C", "R"],
  society_or_trust_registration: ["R", "C", "C", "C", "C", "C", "C"],
  audited_accounts: ["R", "C", "C", "C", "C", "C", "C"],
  affidavit: ["R", "C", "C", "C", "C", "C", "C"],
  noc_affiliating_university_or_state: ["C", "C", "C", "-", "C", "C", "-"],
  collaboration_agreement: ["-", "-", "-", "-", "-", "R", "-"],
  aicte_approval_letter: ["-", "R", "R", "R", "R", "R", "R"],
  nba_letter: ["-", "-", "C", "-", "-", "C", "C"],
};

const conditions = {
  land_ownership_documents: ["", "landChanged OR newAreaAdded", "landChanged OR newAreaAdded", "landChanged OR newAreaAdded", "landChanged OR newAreaAdded", "", "landChanged OR newAreaAdded"],
  lease: ["landIsLeased", "landIsLeased", "landIsLeased", "landIsLeased", "landIsLeased", "", "landIsLeased"],
  land_use_certificate: ["", "newAreaAdded", "newAreaAdded", "", "newAreaAdded", "", "newAreaAdded"],
  land_conversion_certificate: ["", "newAreaAdded", "newAreaAdded", "", "newAreaAdded", "", "newAreaAdded"],
  khasra_plan_master_plan: ["", "", "", "", "", "", ""],
  encumbrance_certificate: ["landIsLeased", "landIsLeased", "landIsLeased", "", "landIsLeased", "", "landIsLeased"],
  approved_building_plan_with_architect_certificate: ["", "", "", "", "", "", "newAreaAdded"],
  occupancy_or_building: ["", "newAreaAdded", "newAreaAdded", "newAreaAdded", "newAreaAdded", "premisesShared", "newAreaAdded"],
  structural: ["buildingOver30", "buildingOver30", "buildingOver30", "buildingOver30", "buildingOver30", "", "buildingOver30"],
  fire: ["", "", "", "", "", "premisesUsed", ""],
  society_or_trust_registration: ["", "landChanged", "landChanged", "landChanged", "landChanged", "landChanged", "landChanged"],
  audited_accounts: ["", "review_required", "review_required", "review_required", "review_required", "review_required", "review_required"],
  affidavit: ["", "review_required", "review_required", "review_required", "review_required", "review_required", "review_required"],
  noc_affiliating_university_or_state: ["affiliatingBodyRequired", "affiliatingBodyRequired", "affiliatingBodyRequired", "", "affiliatingBodyRequired", "affiliatingBodyRequired", ""],
  collaboration_agreement: ["", "", "", "", "", "", ""],
  aicte_approval_letter: ["", "", "", "", "", "", ""],
  nba_letter: ["", "", "claimsAccreditation", "", "", "claimsAccreditation", "claimsAccreditation"],
};

export const CHECKLIST_SLOTS = Object.freeze(Object.keys(requirements).map((kind) => ({
  slotId: kind,
  kind,
  label: kind.replaceAll("_", " "),
  requirements: Object.fromEntries(APPLICATION_TYPES.map((type, index) => [type, requirements[kind][index]])),
  conditions: Object.fromEntries(APPLICATION_TYPES.map((type, index) => [type, conditions[kind][index] || null])),
  tracked: trackedKinds.has(kind),
  hasValidity: validKinds.has(kind),
  acceptedFileTypes: ["application/pdf", "image/jpeg", "image/png"],
  minLeaseTermYears: kind === "lease" ? null : undefined,
  helpText: kind === "lease" ? "Minimum lease term is not configured; verify it against the applicable handbook." : "",
})));

function booleanAnswer(answers, key) {
  return typeof answers?.[key] === "boolean" ? answers[key] : null;
}

function evaluateCondition(condition, answers) {
  if (condition === "review_required") return null;
  if (condition === "always") return true;
  if (!condition) return null;
  const clauses = condition.split(/\s+OR\s+/i);
  const values = clauses.map((clause) => {
    const ageMatch = /^buildingAgeYears\s*>\s*(\d+)$/.exec(clause);
    if (ageMatch) {
      if (typeof answers?.buildingOver30 === "boolean" && Number(ageMatch[1]) === 30) {
        return answers.buildingOver30;
      }
      return typeof answers?.buildingAgeYears === "number" && Number.isFinite(answers.buildingAgeYears)
        ? answers.buildingAgeYears > Number(ageMatch[1])
        : null;
    }
    return booleanAnswer(answers, clause);
  });
  if (values.includes(true)) return true;
  return values.every((value) => value === false) ? false : null;
}

export function buildChecklist(applicationType, answers = {}, slotRecords = [], slots = CHECKLIST_SLOTS) {
  if (!APPLICATION_TYPES.includes(applicationType)) {
    throw new TypeError(`Unsupported application type: ${applicationType}`);
  }
  const records = new Map(slotRecords.map((record) => [record.slotId, record]));
  return slots.map((slot) => {
    const requirement = slot.requirements[applicationType] ?? "-";
    let applicable = requirement === "R";
    let reviewRequired = false;
    if (requirement === "C") {
      const result = evaluateCondition(slot.conditions?.[applicationType], answers);
      applicable = result === true;
      reviewRequired = result === null;
    }
    if (requirement === "-") applicable = false;
    const record = records.get(slot.slotId);
    const status = !applicable
      ? (reviewRequired ? "review_required" : "not_applicable")
      : record?.status || "missing";
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      label: slot.label,
      requirement,
      required: applicable,
      reviewRequired,
      tracked: slot.tracked,
      hasValidity: slot.hasValidity,
      acceptedFileTypes: slot.acceptedFileTypes,
      minLeaseTermYears: slot.minLeaseTermYears ?? null,
      helpText: slot.helpText,
      status,
      documentId: record?.documentId || null,
    };
  });
}

export function missingChecklistItems(checklist) {
  return checklist.filter((slot) => slot.required && ["missing", "quarantined"].includes(slot.status));
}
