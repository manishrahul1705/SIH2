# M1 document type classifier evaluation

## Scope and limitations

Works on synthetic data and on layouts unseen in training. A score near 1.0 on synthetic documents does not predict accuracy on real AICTE documents. Only English is covered; the broad 'other' class is less varied than real-world documents. No production accuracy is claimed.

The dataset is entirely synthetic. To support claims about real documents, add 50–100 hand-labelled public real documents per class, run the same OCR pipeline, and evaluate them separately as `real_test`. This model only proposes a document type; a person confirms it.

## Model and reproducibility

- Pipeline: normalized text → word TF-IDF and character `char_wb` TF-IDF → balanced logistic regression → sigmoid probability calibration.
- Selected parameters: `{"C": 0.5, "char_ngram_range": [3, 5], "word_ngram_range": [1, 2]}`
- Calibration data: layout-held-out half of validation (808 documents).
- Grouped 5-fold layout CV mean macro-F1: **0.9991 ± 0.0012**.
- Macro-F1 targets (0.90): validation **met**, test **met**.

### Validation (full validation split)

- Accuracy: **1.0000**
- Macro-F1: **1.0000**
- Expected calibration error (10 bins): **0.0133**

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| lease | 1.0000 | 1.0000 | 1.0000 | 200 |
| fire | 1.0000 | 1.0000 | 1.0000 | 200 |
| structural | 1.0000 | 1.0000 | 1.0000 | 200 |
| occupancy_or_building | 1.0000 | 1.0000 | 1.0000 | 200 |
| nba_letter | 1.0000 | 1.0000 | 1.0000 | 200 |
| audited_accounts | 1.0000 | 1.0000 | 1.0000 | 200 |
| aicte_approval_letter | 1.0000 | 1.0000 | 1.0000 | 200 |
| other | 1.0000 | 1.0000 | 1.0000 | 162 |

| Quality | Count | Macro-F1 |
|---|---:|---:|
| clean | 599 | 1.0000 |
| scanned | 462 | 1.0000 |
| skewed | 253 | 1.0000 |
| blurred | 248 | 1.0000 |

| Zone | Count | Coverage | Accuracy |
|---|---:|---:|---:|
| green | 1561 | 99.94% | 1.0000 |
| amber | 1 | 0.06% | 1.0000 |
| red | 0 | 0.00% | n/a |

| Confidence bin | Count | Mean confidence | Accuracy |
|---|---:|---:|---:|
| 0.0-0.1 | 0 | n/a | n/a |
| 0.1-0.2 | 0 | n/a | n/a |
| 0.2-0.3 | 0 | n/a | n/a |
| 0.3-0.4 | 0 | n/a | n/a |
| 0.4-0.5 | 0 | n/a | n/a |
| 0.5-0.6 | 0 | n/a | n/a |
| 0.6-0.7 | 1 | 0.6746 | 1.0000 |
| 0.7-0.8 | 0 | n/a | n/a |
| 0.8-0.9 | 0 | n/a | n/a |
| 0.9-1.0 | 1561 | 0.9869 | 1.0000 |

### Test (used once after model selection)

- Accuracy: **0.9988**
- Macro-F1: **0.9989**
- Expected calibration error (10 bins): **0.0183**

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| lease | 1.0000 | 1.0000 | 1.0000 | 200 |
| fire | 1.0000 | 1.0000 | 1.0000 | 200 |
| structural | 0.9950 | 1.0000 | 0.9975 | 200 |
| occupancy_or_building | 1.0000 | 1.0000 | 1.0000 | 200 |
| nba_letter | 1.0000 | 1.0000 | 1.0000 | 200 |
| audited_accounts | 1.0000 | 0.9950 | 0.9975 | 200 |
| aicte_approval_letter | 1.0000 | 1.0000 | 1.0000 | 200 |
| other | 0.9963 | 0.9963 | 0.9963 | 270 |

| Quality | Count | Macro-F1 |
|---|---:|---:|
| clean | 659 | 0.9987 |
| scanned | 521 | 1.0000 |
| skewed | 247 | 1.0000 |
| blurred | 243 | 0.9963 |

| Zone | Count | Coverage | Accuracy |
|---|---:|---:|---:|
| green | 1641 | 98.26% | 1.0000 |
| amber | 28 | 1.68% | 0.9643 |
| red | 1 | 0.06% | 0.0000 |

| Confidence bin | Count | Mean confidence | Accuracy |
|---|---:|---:|---:|
| 0.0-0.1 | 0 | n/a | n/a |
| 0.1-0.2 | 0 | n/a | n/a |
| 0.2-0.3 | 0 | n/a | n/a |
| 0.3-0.4 | 1 | 0.3467 | 0.0000 |
| 0.4-0.5 | 0 | n/a | n/a |
| 0.5-0.6 | 0 | n/a | n/a |
| 0.6-0.7 | 2 | 0.6453 | 0.5000 |
| 0.7-0.8 | 6 | 0.7615 | 1.0000 |
| 0.8-0.9 | 20 | 0.8674 | 1.0000 |
| 0.9-1.0 | 1641 | 0.9843 | 1.0000 |

## Stress tests

A negative drop means the ablation scored slightly higher than the clean test baseline on this synthetic split.

| Stress test | Macro-F1 | Drop from clean test |
|---|---:|---:|
| keyword_ablation | 0.9989 | -0.0000 |
| extra_ocr_noise_3pct | 0.9989 | -0.0000 |
| extra_ocr_noise_6pct | 0.9973 | 0.0016 |
| first_40_percent_truncation | 0.9791 | 0.0198 |

## Other class

- Test precision: **0.9963**
- Test recall: **0.9963**
- Misclassified `other` rows are in `misclassified_test.csv`, with ids, labels, confidence and a 200-character text preview.

## Artifacts

- `metrics.json`: complete machine-readable metrics and confusion matrix.
- `confusion_matrix.png` and `confusion_matrix.csv`: test set.
- `misclassified_test.csv`: test errors for the `other` class.
- Model artifact: `m1_training\artifacts\m1_v1.joblib`.

## Sample document smoke evaluation

The provided sample documents are evaluated through `predict_m1.py` and recorded in `sample_predictions.json`.
The supplied blurred JPG is also attempted through local OCR; if OCR is unavailable or extraction fails, the safe result is manual entry, not a guessed prediction.

| File | Expected | Suggested | Confidence | Zone | Result |
|---|---|---|---:|---|---|
| approval_letter_sample.pdf | aicte_approval_letter | aicte_approval_letter | 0.9867 | green | correct |
| blurred_scan_ambiguous_date.jpg | not labelled | other | 0.3893 | red | manual review |
| fire_safety_certificate.pdf | fire | fire | 0.9860 | green | correct |
| lease_deed_excerpt.pdf | lease | lease | 0.9922 | green | correct |
