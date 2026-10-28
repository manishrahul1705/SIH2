# M2 Model Card

## Purpose and safety

M2 ranks document date, number, and issuer candidates for human review. It does not decide, route, approve, reject, or start a clock. Every proposed value remains AI-suggested and requires a person's confirmation before any clock starts.

## Data

Training and evaluation use fictional, synthetic English documents from the supplied dataset. Train, validation, and test layouts are disjoint, and the test layouts are unseen by training.

- Train: 7,502 documents / 125,859 candidates.
- Validation: 2,247 documents / 38,494 candidates.
- Test: 2,251 documents / 37,070 candidates.
- Test layouts: 24.

## Model and features

Three independent candidate classifiers handle dates, numbers, and issuer lines. Word 1-2 gram and character 2-4 gram TF-IDF alternatives were compared for logistic regression and HistGradientBoosting. Selection used layout-grouped validation macro-F1. Numeric candidate features are scaled; document type and date format are one-hot encoded. Preprocessing is fitted on training data only. Platt calibration is fitted on held-out validation layouts. The shared `find_candidates()` and `normalize_m2()` helpers are used; parsed values, identifiers, labels, and word indices are not model features.

| Kind | Selected model | Text | Grouped validation macro-F1 |
|---|---|---|---:|
| date | hist_gradient_boosting | word | 0.9674 |
| number | logistic | word | 0.9829 |
| issuer | logistic | char | 0.9979 |

## Final synthetic test results

| Field | Exact-match accuracy (eligible documents) | 95% hierarchical layout/document bootstrap interval | Span-F1 | 95% bootstrap interval |
|---|---:|---:|---:|---:|
| issue_date | 0.8437 (1,919) | [0.7315, 0.9295] | 0.8925 | [0.7997, 0.9590] |
| valid_to | 0.9159 (1,581) | [0.8652, 0.9491] | 0.9784 | [0.9620, 0.9869] |
| cert_no | 0.9973 (2,251) | [0.9933, 1.0000] | 0.9987 | [0.9967, 1.0000] |
| issuer | 0.9893 (2,251) | [0.9691, 1.0000] | 0.9568 | [0.9009, 1.0000] |

Valid-to false-fill rate: 0.0000% (0/425); target below 2%: True.
Ambiguity rule: recall 100.0000%, precision 63.5463%.

## Evaluation details

The metrics JSON records candidate-kind calibration/reliability, output zone coverage, subgroup breakdowns, the three lowest-performing test layouts, five-fold GroupKFold stability, feature ablations, and OCR/text stress checks. The hierarchical bootstrap samples layouts and then documents within sampled layouts; it is not candidate-row resampling.

**Protocol caveat:** The held-out test metrics were inspected during iterative debugging of inference safeguards and evaluation logic. Treat the reported scores as diagnostic, not as a blind one-shot estimate; use a fresh holdout for independent performance claims.

## Limitations

The data is synthetic and the layouts are generated from templates, so the scores will be high and prove only that M2 works on synthetic data and on unseen synthetic layouts. They are **not** production accuracy. To claim more, test on 50 to 100 real public documents per class (real approval letters, fire certificates, leases) that were never used in training, report span-F1 with intervals, and fix what breaks. Alerts and automation support the process; they never replace statutory scrutiny, verification, inspection or the decision of the competent authority.

Only English text is covered. The broad document types and the `other` class remain more varied in real use than synthetic templates. OCR errors, unusual layouts, poor scans, handwritten content, unseen date labels, and formatting changes can reduce performance. All output is a suggestion only; no automated action or clock may rely on it.

Training date (UTC): 2026-10-27T07:57:03.149262+00:00
Dataset report SHA-256: `99be0dc500f4f7ab196664a0ee075d6223af4aeeb7a318032d4571a1f99a75ce`
