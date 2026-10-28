import { describe, expect, it } from "vitest";
import { confidenceZone, evaluate } from "../src/modules/rules/engine.js";

describe("document and lease rules", () => {
  it("flags issue dates in the future and invalid date ordering", () => {
    const result = evaluate(
      { doc_type_slot: "Fire Safety Certificate", doc_type_final: "Fire Safety Certificate" },
      [
        { field_name: "issue_date", confirmed_value: "2027-01-01" },
        { field_name: "valid_to", confirmed_value: "2026-01-01" },
      ],
      {},
      undefined,
      { today: new Date("2026-10-27T00:00:00Z") },
    );
    expect(result.find((rule) => rule.ruleId === "D3").passed).toBe(false);
    expect(result.find((rule) => rule.ruleId === "D4").passed).toBe(false);
  });

  it("marks expired fire certificates and leases as failures", () => {
    const result = evaluate(
      { doc_type_slot: "Fire Safety Certificate", doc_type_final: "Fire Safety Certificate" },
      [{ field_name: "valid_to", confirmed_value: "2026-01-01" }],
      {},
      undefined,
      { today: new Date("2026-10-27T00:00:00Z"), lease: { lease_end: "2026-01-01" } },
    );
    expect(result.find((rule) => rule.ruleId === "D5").passed).toBe(false);
    expect(result.find((rule) => rule.ruleId === "L6").message).toContain("EXPIRED");
  });

  it("labels confidence zones with the stricter issue-date threshold", () => {
    expect(confidenceZone(0.9, "valid_to")).toBe("GREEN");
    expect(confidenceZone(0.7, "valid_to")).toBe("AMBER");
    expect(confidenceZone(0.65, "issue_date")).toBe("RED");
  });

  it("normalizes document type codes and display names before comparison", () => {
    const result = evaluate(
      { doc_type_slot: "lease", doc_type_final: "Lease Deed" },
      [],
      { type: "NEW" },
      undefined,
      { applicationDocuments: [{ doc_type_slot_key: "lease_deed", status: "CONFIRMED" }] },
    );
    expect(result.find((rule) => rule.ruleId === "D1").passed).toBe(true);
    expect(result.find((rule) => rule.ruleId === "D2").passed).toBe(true);
  });
});
