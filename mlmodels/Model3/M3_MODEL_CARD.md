# ApprovalTrack M3 model card

## Purpose and safeguard

M3 reads lease-deed OCR candidates and proposes `lease_start`, `lease_end`, and `term_value`. It does not decide a lease status or perform date arithmetic. `m3_extract.py` passes the proposals to the existing deterministic `reconcile_lease` and status functions. Repeated candidates with the same role and parsed value are treated as one answer: the candidate with the highest calibrated role probability represents that value; ties use the earliest page, line, and candidate ID. The runner-up is a different parsed value.

> DEMO DATA - NOT REAL AICTE DEADLINES. AI-suggested values are not verified. A person must confirm every value; the software never replaces the competent authority. No model output may start a clock, change routing, or write to any score or policy table. Rules decide, AI only suggests.

## Data and split

- The supplied data are fictional synthetic deeds: 5,000 train, 1,500 validation, and 1,500 test documents.
- Candidate counts are 85,504 train, 21,746 validation, and 24,760 test. The test set contains three held-out layouts; layouts are disjoint between splits (10 train, 3 validation, 3 test).
- Training and evaluation call `find_lease_candidates()` and check candidate IDs, parsed values, and contexts against the CSV annotations for all 5,000 training and 1,500 test deeds.
- Model features exclude document ID, layout ID, split, role label, candidate ID, candidate text/value, and character offsets. Digits remain in context text.
- The test CSV was not used for fitting or calibration. Evaluation outputs below are from the fixed final model; evaluation-code reruns corrected reporting/ambiguity propagation only and did not tune the model.

## Algorithm and implementation

The selected model is one multiclass `LogisticRegression` classifier for `lease_start`, `lease_end`, `term_value`, or `other`. Selection compared it with `HistGradientBoostingClassifier` using five-fold `GroupKFold` by training `layout_id`. The comparison used at most 400 candidates per layout and class (16,000 sampled candidates); all labeled training candidates are used to fit the final classifier.

Chosen hyperparameters:

- Logistic regression: `C=1.0`, `class_weight="balanced"`, `solver="saga"`, `max_iter=100`, `tol=0.001`, seed `2026`.
- Grouped-CV candidate: histogram gradient boosting, `learning_rate=0.1`, `max_iter=35`, `max_leaf_nodes=15`, `min_samples_leaf=30`, `l2_regularization=1.0`, no internal early stopping, seed `2026`.
- Context: separate left/right TF-IDF word vectorizers, 1–3 grams, `min_df=2`, up to 50,000 features each, sublinear term frequency. The shared `normalize_m3()` preserves digits.
- Other inputs: one-hot `kind`; scaled `page`, `n_pages`, `rel_pos`, `date_order`, `n_dates`, `date_chrono_rank`, `term_order`, `n_terms`, `term_months`, `ambiguous`, and `line_no`.
- Calibration: one-vs-rest sigmoid (Platt) calibration fitted on validation-layout predictions.

The calibrated probability for each role is ranked by parsed value. A role below 0.60 is blanked. A high-confidence ambiguous date is blanked and retains its candidate ID as a rejected-evidence pointer so `m3_extract.py` can pass the ambiguity flag into deterministic reconciliation. If a distinct-value runner-up is within 0.15, confidence is capped at 0.89. The wrapper maps confidence to green (>=0.90), amber (>=0.60), or red (<0.60).

## Model artifact

- Version: `m3-1.0.0`
- Training date (UTC): `2026-10-27`
- Training CSV bundle SHA-256: `d861c373be8db6802d08372e2b2032be5b14299ffb49c43405da030f7e74b80b`
- Dataset report SHA-256: `7a9f41dea2d3c0ecf32df8586ed0677cfc84cfcd35e233fa11344813a8d33131`
- Grouped-CV macro-F1: logistic regression `0.99335`; histogram gradient boosting `0.84459`.
- Validation candidate macro-F1 after calibration: `0.99878`.

## Held-out test results

All metrics are synthetic-layout results, not estimates of real deed performance.

| Metric | Result |
|---|---:|
| Candidate-class macro-F1 (24,760 candidates) | 0.99613 |
| Lease-start exact match (1,189 documents containing the field) | 1.000 |
| Lease-end exact match (1,213 documents containing the field) | 1.000 |
| Term exact match (1,423 documents containing the field) | 1.000 |
| Start/end/term span-F1 | 1.000 / 1.000 / 1.000 |
| End-to-end expected start, end, term, state, status (1,500 documents each) | 1.000 each |
| Scenario B derived end accuracy (359 deeds) | 1.000 |
| Scenario A derived term accuracy (372 deeds) | 1.000 |
| False fill: term in scenario A / stated end in scenario B | 0 / 0 of 372 / 359 |
| Ambiguous-date blank rate: start / end | 311/311 (100%) / 209/209 (100%) |

Layout-and-document hierarchical bootstrap used 500 resamples. The 95% interval was `[1.000, 1.000]` for each exact-match field and each span-F1 field. There are only three held-out layout clusters, so these intervals should not be read as broad evidence about unseen real-world layouts. Span-F1 treats repeated schedule copies of the same role/value as equivalent and requires an exact page/character-span match to one non-ambiguous role-labeled candidate.

Inconsistency detection found no false alarms. It detected 178/230 scenario-D deeds (77.4%); the other 52 scenario-D deeds are explicitly labeled `needs_review` because an ambiguous date takes precedence. Recall against the 178 documents whose expected state is actually `inconsistent` was 100%.

Calibrated expected-output ECE was 0.0170 for start, 0.0417 for end, and 0.0367 for term. Among documents containing each field, green/amber coverage was 84.8%/15.2% for start, 62.2%/37.8% for end, and 66.6%/33.4% for term. Accuracy within both populated zones was 100%; red coverage was 0% for these field-present subsets.

### Breakdown and diagnostics

Breakdowns by layout, page count, scenario, and `term_style` are in [`m3_metrics.json`](./m3_metrics.json). All three test layouts tied at 100% end-to-end accuracy; there were no baseline end-to-end wrong-candidate examples. Baseline blank reasons across the three roles were 728 `low_confidence`, 520 `ambiguous_date`, and 3 `not_found`.

The evaluation rerun with the model's deterministic selection checks disabled fell to 84.7% start, 79.7% end, 75.4% term, and 61.8% status accuracy. This is diagnostic only; those checks remain enabled for normal inference.

Test-set ablations (candidate macro-F1, with change against the full test model):

| Ablation | Macro-F1 | Difference |
|---|---:|---:|
| No context text | 0.51294 | -0.48320 |
| No numeric features | 0.99646 | +0.00033 |
| No position features | 0.99663 | +0.00050 |

Stress tests altered 99 held-out documents across layouts without retraining:

| Stress case | Start accuracy | End accuracy | Term accuracy |
|---|---:|---:|---:|
| Extra OCR noise | 100.0% | 100.0% | 100.0% |
| Shuffled clause order | 82.7% | 83.3% | 78.9% |
| Key clause moved to a late page | 100.0% | 98.8% | 97.9% |
| Older quoted lease placed beside the real clause | 100.0% | 92.9% | 60.0% |
| Repeated footer date on every page | 100.0% | 100.0% | 100.0% |

The weaker older-lease stress result was investigated: wrong term picks included the injected `five years` phrase, and some wrong end values were derived after the model abstained on the stated end. Shuffling clauses also led to low-confidence blanks and occasional wrong date/term selections. See the wrong-candidate examples and blank-reason counts in the metrics file. These are material limitations, not production failure rates.

All 9 files in `samples/` (8 PDFs and 1 scanned image) matched `expected_outputs.json` for start, end, term, and expected status.

## Limitations

- These deeds and layouts are synthetic. Strong lexical cues in generated clauses make the task unusually separable. The ablation result also shows that context wording, rather than position features, drives most of this score.
- The perfect held-out scores do not establish production accuracy, despite disjoint layouts and no exact or digit-normalized duplicate full documents between splits.
- The `other` distribution, clause wording, OCR quality, date formats, and scanned-document characteristics in real leases may differ substantially.
- A term or date split across a page break by a page header is not matched.
- Ambiguous dates are deliberately blanked. A person must review them; confidence is calibrated only on this synthetic validation set.
- The evaluation includes only English synthetic deeds and three held-out test layouts.

DEMO DATA - NOT REAL AICTE DEADLINES. AI-suggested values are not verified. A person must confirm every value; the software never replaces the competent authority. No model output may start a clock, change routing, or write to any score or policy table. Rules decide, AI only suggests.

These results are on synthetic deeds with unseen synthetic layouts only. They show the pipeline works; they are not production accuracy. Production accuracy needs 50 to 100 real public lease deeds with stated metrics.

## Reproduction

Run from the `mlmodels/Model3` directory with Python 3.10+ and scikit-learn, pandas, joblib, and the OCR/test dependencies installed:

```powershell
python ocr\m3_train.py
python ocr\m3_evaluate.py
python -m pytest tests -q
python ocr\m3_extract.py samples\01_start_end_dates.pdf --doc-type lease --as-of 2026-10-27
```

The training command creates `ocr/m3_model.joblib`; evaluation writes `m3_metrics.json`. The model is loaded once per Python process and inference does not access the internet.
