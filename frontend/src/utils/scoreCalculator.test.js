import test from "node:test";
import assert from "node:assert/strict";
import { calculateScore, demoScoreInput, scoreAfterFireRenewal, scoreAfterLeaseConfirmation } from "./scoreCalculator.js";

test("demo score is 63 with correct action burden band", () => {
  const result = calculateScore(demoScoreInput);
  assert.equal(result.score, 63);
  assert.equal(result.band, "Attention needed");
});

test("missing assessment data is incomplete, never defaulted to 100", () => {
  assert.equal(calculateScore({ assessmentComplete: false }).score, null);
});

test("fire renewal raises the score to 70 and lease confirmation deducts 10", () => {
  assert.equal(scoreAfterFireRenewal().score, 70);
  assert.equal(scoreAfterLeaseConfirmation().score, 53);
});
