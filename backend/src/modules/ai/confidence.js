function confidenceValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

export function normalizeSuggestion(name, raw = {}, {
  model = "",
  meanOcrConfidence = null,
  wordCount = Infinity,
  greenThreshold = 0.9,
  amberThreshold = 0.6,
  heuristicConfidenceCap = 0.85,
} = {}) {
  let confidence = confidenceValue(raw.confidence ?? raw.ai_confidence);
  const mean = confidenceValue(meanOcrConfidence);
  if (String(raw.model || model).toLowerCase().includes("heuristic")) {
    confidence = Math.min(confidence, heuristicConfidenceCap);
  }
  if (meanOcrConfidence != null && mean < amberThreshold) confidence *= mean / amberThreshold;
  const ambiguous = raw.ambiguous === true;
  const zone = wordCount < 15 || confidence < amberThreshold
    ? "RED"
    : confidence >= greenThreshold ? "GREEN" : "AMBER";
  const bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : undefined;
  return {
    field_name: name,
    ai_value: typeof raw.value === "string" || typeof raw.value === "number" ? String(raw.value) : "",
    ai_confidence: confidence,
    zone,
    model: String(raw.model || model),
    model_version: String(raw.model_version || ""),
    ambiguous,
    prefill: zone !== "RED" && !ambiguous,
    source_text: String(raw.display || raw.source_text || ""),
    source_page: Number.isInteger(Number(raw.page)) ? Math.max(0, Number(raw.page)) : 0,
    ...(bbox?.every(Number.isFinite) ? { source_bbox: bbox } : {}),
    confirmed_value: null,
    confirmed_source: null,
    confirmed_by: null,
    confirmed_at: null,
    was_corrected: false,
  };
}
