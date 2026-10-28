const CATEGORIES = [
  ["Undertakings", "undertakings"],
  ["Non-lease documents", "nonLeaseDocuments"],
  ["Lease", "lease"],
  ["Institution EVC readiness", "evcReadiness"],
  ["History", "history"],
];

export function calculateScore(input) {
  if (!input || input.assessmentComplete === false || !input.deductions) {
    return { complete: false, score: null, band: "Assessment incomplete", deductions: [] };
  }
  const deductions = CATEGORIES.map(([category, key]) => ({
    category,
    points: Math.max(0, Number(input.deductions[key] ?? 0)),
    cap: Number(input.caps?.[key] ?? 100),
  }));
  const totalDeductions = deductions.reduce((sum, item) => sum + Math.min(item.points, item.cap), 0);
  const score = Math.max(0, Math.min(100, 100 - totalDeductions));
  const band = score >= 80 ? "Lower action burden" : score >= 50 ? "Attention needed" : "High action burden";
  return { complete: true, score, band, deductions, totalDeductions };
}

export const demoScoreInput = {
  assessmentComplete: true,
  deductions: { undertakings: 12, nonLeaseDocuments: 14, lease: 0, evcReadiness: 5, history: 6 },
  caps: { undertakings: 30, nonLeaseDocuments: 30, lease: 10, evcReadiness: 20, history: 20 },
};

export function scoreAfterFireRenewal(input = demoScoreInput) {
  return calculateScore({ ...input, deductions: { ...input.deductions, nonLeaseDocuments: Math.max(0, input.deductions.nonLeaseDocuments - 7) } });
}

export function scoreAfterLeaseConfirmation(input = demoScoreInput) {
  return calculateScore({ ...input, deductions: { ...input.deductions, lease: 10 } });
}
