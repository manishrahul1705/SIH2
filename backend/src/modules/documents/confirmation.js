export function hasManualCompletionValue(fields) {
  return fields.some(({ confirmed_value }) => confirmed_value.trim().length > 0);
}
