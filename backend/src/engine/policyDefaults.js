export const DEFAULT_CASE_ROUTES = Object.freeze({
  new_institution: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"],
  new_course: ["submitted", "self_disclosure", "scrutiny", "decision"],
  increase_in_intake: ["submitted", "self_disclosure", "scrutiny", "decision"],
  extension_of_approval: ["submitted", "self_disclosure", "scrutiny", "decision"],
  conversion_diploma_to_degree: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"],
  collaboration_twinning: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"],
  restoration_of_intake: ["submitted", "self_disclosure", "scrutiny", "evc", "decision"],
});

export const DEFAULT_STAGE_COMPLETION = Object.freeze({
  scrutiny: ["review_submitted_documents", "record_findings"],
  re_scrutiny: ["review_returned_items"],
  evc: ["report_uploaded"],
  shc: ["recommendation_recorded"],
  sac: ["recommendation_recorded"],
});

export const DEFAULT_ALERT_RULES = Object.freeze({
  reminderDays: [30, 7, 1],
  escalationAfterDays: [3, 7],
  ruleVersion: "v1",
});

export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  undertakings: 30,
  documents: 25,
  lease: 15,
  evcReadiness: 10,
  history: 20,
});
