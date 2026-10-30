import { describe, expect, it } from "vitest";
import { allocateStagesForApplication, APPLICATION_TYPE_LABELS, STAGE_ALLOCATION_RULES } from "../src/engine/stageAllocationRules.js";
import { APPLICATION_TYPES } from "../src/engine/checklist.js";

describe("deterministic application stage allocation", () => {
  it("defines one ordered, complete rule for each supported application type", () => {
    expect(Object.keys(STAGE_ALLOCATION_RULES).sort()).toEqual([...APPLICATION_TYPES].sort());
    for (const type of APPLICATION_TYPES) {
      const allocated = allocateStagesForApplication(type);
      expect(allocated.length).toBeGreaterThan(0);
      expect(allocated.every((item) => item.status === "PENDING" && item.slaDays > 0)).toBe(true);
      expect(new Set(allocated.map((item) => item.key)).size).toBe(allocated.length);
      expect(allocated.at(-1)).toMatchObject({ key: "final_approval", assignedRole: "BUREAU_OFFICER" });
    }
  });

  it("uses the prescribed ordered stages and SLAs for all seven application types", () => {
    const expected = {
      new_institution: [["document_scrutiny", 5], ["land_lease_verification", 5], ["evc_inspection", 7], ["sac_review", 4], ["final_approval", 3]],
      new_course: [["document_scrutiny", 4], ["academic_readiness", 4], ["evc_inspection", 5], ["final_approval", 3]],
      increase_in_intake: [["document_scrutiny", 4], ["ratio_infrastructure", 4], ["final_approval", 3]],
      extension_of_approval: [["document_scrutiny", 3], ["compliance_verification", 3], ["final_approval", 2]],
      conversion_diploma_to_degree: [["document_scrutiny", 5], ["university_lease_verification", 5], ["evc_inspection", 7], ["sac_review", 4], ["final_approval", 3]],
      collaboration_twinning: [["document_scrutiny", 4], ["mou_accreditation_verification", 5], ["sac_review", 4], ["final_approval", 3]],
      restoration_of_intake: [["deficiency_rectification", 4], ["evc_verification", 6], ["hearing_review", 4], ["final_approval", 3]],
    };
    for (const [type, stages] of Object.entries(expected)) {
      expect(allocateStagesForApplication(type).map(({ key, slaDays }) => [key, slaDays])).toEqual(stages);
    }
    expect(allocateStagesForApplication("increase_in_intake").reduce((total, item) => total + item.slaDays, 0)).toBe(11);
  });

  it("rejects unknown application types instead of creating a fallback route", () => {
    expect(() => allocateStagesForApplication("UNKNOWN")).toThrow("Unsupported application type");
  });

  it("uses the exact institution intake labels for the seven application types", () => {
    expect(APPLICATION_TYPE_LABELS).toEqual({
      new_institution: "New institution",
      new_course: "New course",
      increase_in_intake: "Increase in intake",
      extension_of_approval: "Extension of approval",
      conversion_diploma_to_degree: "Conversion of diploma to degree",
      collaboration_twinning: "Collaboration or twinning programme",
      restoration_of_intake: "Restoration of intake",
    });
  });
});
