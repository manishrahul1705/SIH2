const remoteServiceFailureCodes = new Set(["AI_SERVICE_UNAVAILABLE", "AI_SERVICE_TIMEOUT"]);

export function processingErrorCode(error) {
  if (remoteServiceFailureCodes.has(error?.code)) return "AI_UNAVAILABLE_MANUAL_MODE";
  return String(error?.code || "AI_PIPELINE_FAILED").slice(0, 100);
}
