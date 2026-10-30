export function hasManualCompletionValue(fields) {
  return fields.some(({ confirmed_value }) => confirmed_value.trim().length > 0);
}

function parseIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

export function validateConfirmedDocumentFields(fields, updates, resolvedAmbiguities = [], requireValidTo = false) {
  const values = new Map(fields.map((field) => [field.field_name, field.confirmed_value || field.ai_value || ""]));
  for (const update of updates) values.set(update.field_name, update.confirmed_value);

  for (const update of updates) {
    if (!/(?:date|valid_to|lease_start|lease_end)$/.test(update.field_name) || !update.confirmed_value) continue;
    if (!parseIsoDate(update.confirmed_value)) {
      return { code: "INVALID_DATE", message: `${update.field_name.replaceAll("_", " ")} must use a valid YYYY-MM-DD date` };
    }
  }

  for (const field of fields) {
    if (!field.ambiguous || !updates.some((update) => update.field_name === field.field_name)) continue;
    const value = values.get(field.field_name);
    if (!resolvedAmbiguities.includes(field.field_name) || !parseIsoDate(value)) {
      return {
        code: "AMBIGUOUS_DATE_UNRESOLVED",
        message: `Choose an unambiguous date for ${field.field_name.replaceAll("_", " ")} before confirming the document`,
      };
    }
  }

  const issueDateValue = values.get("issue_date") || values.get("valid_from") || "";
  const validToValue = values.get("valid_to") || "";
  if (requireValidTo && !validToValue) {
    return {
      code: "VALIDITY_DATE_REQUIRED",
      message: "Enter the confirmed validity end date before confirming this document",
    };
  }
  if (issueDateValue && validToValue) {
    const issueDate = parseIsoDate(issueDateValue);
    const validTo = parseIsoDate(validToValue);
    if (!issueDate || !validTo) {
      return { code: "INVALID_DATE", message: "Document dates must use a valid YYYY-MM-DD date" };
    }
    if (validTo <= issueDate) {
      return { code: "IMPOSSIBLE_DATE_ORDER", message: "The validity end date must be after the issue or valid-from date" };
    }
  }

  const leaseStartValue = values.get("lease_start") || "";
  const leaseEndValue = values.get("lease_end") || "";
  if (leaseStartValue && leaseEndValue) {
    const leaseStart = parseIsoDate(leaseStartValue);
    const leaseEnd = parseIsoDate(leaseEndValue);
    if (!leaseStart || !leaseEnd) {
      return { code: "INVALID_DATE", message: "Lease dates must use a valid YYYY-MM-DD date" };
    }
    if (leaseEnd <= leaseStart) {
      return { code: "IMPOSSIBLE_DATE_ORDER", message: "The lease end date must be after the lease start date" };
    }
  }
  return null;
}
