import { describe, expect, it } from "vitest";
import {
  hasManualCompletionValue,
  validateConfirmedDocumentFields,
} from "../src/modules/documents/confirmation.js";

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

  it("requires explicit resolution of an ambiguous date to a real ISO date", () => {
    const fields = [{ field_name: "valid_to", ai_value: "04/05/2027", ambiguous: true }];
    expect(validateConfirmedDocumentFields(fields, [
      { field_name: "valid_to", confirmed_value: "2027-05-04" },
    ])).toMatchObject({ code: "AMBIGUOUS_DATE_UNRESOLVED" });
    expect(validateConfirmedDocumentFields(fields, [
      { field_name: "valid_to", confirmed_value: "2027-05-04" },
    ], ["valid_to"])).toBeNull();
    expect(validateConfirmedDocumentFields(fields, [
      { field_name: "valid_to", confirmed_value: "2027-02-30" },
    ], ["valid_to"])).toMatchObject({ code: "INVALID_DATE" });
  });

  it("requires validity dates only for policy slots that have a validity clock", () => {
    const fields = [{ field_name: "valid_to", ai_value: "", confirmed_value: "" }];
    expect(validateConfirmedDocumentFields(fields, [], [], true)).toMatchObject({ code: "VALIDITY_DATE_REQUIRED" });
    expect(validateConfirmedDocumentFields(fields, [], [], false)).toBeNull();
  });

  it("rejects impossible certificate and lease date orders", () => {
    expect(validateConfirmedDocumentFields([], [
      { field_name: "issue_date", confirmed_value: "2027-01-02" },
      { field_name: "valid_to", confirmed_value: "2027-01-01" },
    ])).toMatchObject({ code: "IMPOSSIBLE_DATE_ORDER" });
    expect(validateConfirmedDocumentFields([], [
      { field_name: "lease_start", confirmed_value: "2027-01-02" },
      { field_name: "lease_end", confirmed_value: "2027-01-01" },
    ])).toMatchObject({ code: "IMPOSSIBLE_DATE_ORDER" });
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    expect(validateConfirmedDocumentFields([], [
      { field_name: "issue_date", confirmed_value: "2027-02-30" },
      { field_name: "valid_to", confirmed_value: "2027-03-01" },
    ])).toMatchObject({ code: "INVALID_DATE" });
  });
});
