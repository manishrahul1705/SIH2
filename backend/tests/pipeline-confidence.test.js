import { describe, expect, it } from "vitest";
import { normalizeSuggestion } from "../src/modules/ai/confidence.js";
import { processingErrorCode } from "../src/modules/ai/manualFallback.js";
import { m2DocumentType, shouldRunM2, summarizeM1 } from "../src/modules/ai/pipeline.js";

describe("AI suggestion confidence normalization", () => {
  it("lowers confidence on poor OCR and leaves the field blank for prefill", () => {
    expect(normalizeSuggestion("valid_to", {
      value: "2027-05-04",
      confidence: 0.9,
      zone: "green",
    }, { meanOcrConfidence: 0.3, wordCount: 80 })).toMatchObject({
      ai_confidence: 0.45,
      zone: "RED",
      prefill: false,
    });

  });

  it("forces short documents to red even when a model is highly confident", () => {
    expect(normalizeSuggestion("issue_date", {
      value: "2027-05-04",
      confidence: 0.99,
    }, { wordCount: 14 })).toMatchObject({ zone: "RED", prefill: false });
  });

  it("keeps ambiguous values out of the prefill while retaining their evidence", () => {
    expect(normalizeSuggestion("valid_to", {
      value: "2027-05-04",
      confidence: 0.95,
      ambiguous: true,
      display: "04/05/2027",
      bbox: [0.1, 0.2, 0.3, 0.25],
    }, { wordCount: 20 })).toMatchObject({
      zone: "GREEN",
      ambiguous: true,
      prefill: false,
      source_text: "04/05/2027",
      source_bbox: [0.1, 0.2, 0.3, 0.25],
    });
  });

  it("does not feed a low-confidence M1 class guess into field extraction", () => {
    expect(summarizeM1({
      value: "occupancy_or_building",
      display_name: "Occupancy or Building Certificate",
      confidence: 0.45,
      zone: "red",
      prefill: false,
    })).toEqual({
      type: "other",
      confidence: 0.45,
      display: "Other Document",
    });
  });

  it.each([
    ["Occupancy or Building Certificate", "occupancy_building"],
    ["NBA Accreditation Letter", "nba_letter"],
    ["Audited Accounts", "audited_accounts"],
    ["AICTE Approval Letter", "aicte_approval_letter"],
  ])("maps %s to the corresponding M2 model type", (sourceType, expectedType) => {
    expect(m2DocumentType(sourceType)).toBe(expectedType);
  });

  it("runs M2 for other document slots so explicit fields are extracted", () => {
    expect(m2DocumentType("Encumbrance Certificate")).toBe("other");
    expect(shouldRunM2("other", "other")).toBe(true);
  });

  describe("AI service manual fallback status", () => {
    it.each(["AI_SERVICE_UNAVAILABLE", "AI_SERVICE_TIMEOUT"])(
      "marks remote service error %s as manual-entry mode",
      (code) => {
        expect(processingErrorCode({ code })).toBe("AI_UNAVAILABLE_MANUAL_MODE");
      },
    );

    it("preserves unrelated pipeline errors", () => {
      expect(processingErrorCode({ code: "PYTHON_INVALID_JSON" })).toBe("PYTHON_INVALID_JSON");
    });
  });
});
