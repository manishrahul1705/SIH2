import { describe, expect, it } from "vitest";
import { hasManualCompletionValue } from "../src/modules/documents/confirmation.js";

describe("manual document completion", () => {
  it("does not allow completion when all OCR-failed fields are blank", () => {
    expect(hasManualCompletionValue([
      { confirmed_value: "" },
      { confirmed_value: "   " },
    ])).toBe(false);
  });

  it("allows completion when at least one OCR-failed field has a value", () => {
    expect(hasManualCompletionValue([
      { confirmed_value: "" },
      { confirmed_value: "Certificate 123" },
    ])).toBe(true);
  });
});
