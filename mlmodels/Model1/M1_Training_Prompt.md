# PROMPT: Train and package model M1 (document type classifier) for ApprovalTrack

You are a senior machine learning engineer. Train, evaluate and package **M1**, the document type classifier of ApprovalTrack (an AICTE approval workflow and compliance platform). Work only in Python. Do **not** build a backend or web server. A Node.js backend will call your code later, so your deliverables must be plain Python files and a command-line interface.

Read the whole prompt first. Follow it exactly. If anything is unclear, state your assumption in the README instead of guessing silently.

---

## 1. What M1 does in the product

A user (institution or officer) uploads a document on the **Document upload and AI review page (P7)**. The OCR step extracts text. **M1 reads that text and suggests the document type.** The page shows the suggestion as an "AI-suggested" field with a confidence chip. A person must confirm it. M1 never decides anything, never starts a clock and is never used for routing or scoring.

M1 predicts exactly one of these 8 class ids (the UI shows the display name):

| id | UI display name |
|---|---|
| lease | Lease Deed |
| fire | Fire Safety Certificate |
| structural | Structural Stability Certificate |
| occupancy_or_building | Occupancy or Building Certificate |
| nba_letter | NBA Accreditation Letter |
| audited_accounts | Audited Accounts |
| aicte_approval_letter | AICTE Approval Letter |
| other | Other Document |

## 2. Files you are given

- `m1_dataset/m1_train.csv` (6,368 rows), `m1_val.csv` (1,562), `m1_test.csv` (1,670), `m1_documents_full.csv`, `labels.json`, `DATASET_CARD.md`, `validate_dataset.py`
- Columns: `doc_id, text, label, layout_id, quality, split, source, n_words`. No missing values. Read `DATASET_CARD.md` first.
- `ocr/m1_text.py` with `normalize_for_m1(text)`, and `ocr/ocr_extract.py` (OCR and text extraction, already written and tested).

Rules about the data:
- `text` is already OCR-style text (some clean, some noisy). Do not re-clean the CSV files.
- Train only on `m1_train.csv`. Use `m1_val.csv` for choosing settings. Use `m1_test.csv` **once, at the end**. Never tune on the test set.
- A `layout_id` appears in only one split. For any cross-validation inside train, use `GroupKFold` with `groups=layout_id`. Never use random folds, because that leaks layouts.
- Run `python validate_dataset.py` first and stop if it fails.

## 3. Modelling requirements

1. **Preprocessing:** call `normalize_for_m1()` from `ocr/m1_text.py` on every text, in training and in prediction. Do not write a second version of it.
2. **Baseline (required):** TF-IDF word n-grams (1 to 2, `sublinear_tf=True`, `min_df=2`) combined with TF-IDF character n-grams (`char_wb`, 3 to 5, tolerant of OCR errors) feeding `LogisticRegression` (`class_weight="balanced"`, `max_iter` high enough to converge). Tune `C` and the n-gram ranges on validation only, with a small grid.
3. **Probability calibration (required):** the confidence value shown in the UI must be a trustworthy probability. Calibrate on validation data (`CalibratedClassifierCV` with `method="sigmoid"` or isotonic using a prefit model, or equivalent). Report the calibration quality (expected calibration error and a reliability table).
4. **Optional only if time remains:** a fine-tuned small transformer. Do not do this unless the baseline fails the targets in section 5.
5. Fix all random seeds. Training must be reproducible with one command.
6. Do not use any external API or internet service during training or prediction. Everything runs locally.

## 4. Confidence zones (must match the frontend)

The frontend `ConfidenceChip` and `AIFieldRow` use these zones on the **calibrated top-class probability**:

| zone | probability | UI behaviour |
|---|---|---|
| green | 0.90 and above | value pre-filled |
| amber | 0.60 to 0.89 | value shown with "Please check", one extra click |
| red | below 0.60 | value left blank |

In every zone a person must confirm. Put the two thresholds in one config constant (`GREEN = 0.90`, `AMBER = 0.60`) so they can change.

## 5. Evaluation (report everything in `reports/metrics.json` and `reports/REPORT.md`)

Primary targets (these are **targets, not guaranteed results**): macro-F1 of at least 0.90 on validation and on test.

Report on **validation** and **test** separately:
- Accuracy, macro-F1, per-class precision, recall and F1 (include support).
- Confusion matrix (save `reports/confusion_matrix.png` and a CSV).
- Macro-F1 broken down by `quality` (clean, scanned, skewed, blurred).
- Per-zone analysis: for each zone, the share of documents that land in it (coverage) and the accuracy inside it. A good result: green zone accuracy at or above 0.99, and red zone documents mostly wrong or "other".
- Calibration: expected calibration error and a reliability table with 10 bins.
- The "other" class specifically: precision and recall, and a list of the test documents that were misclassified (show `doc_id`, true label, predicted label, confidence, first 200 characters).

**Stress tests (required, because the data is synthetic and easy):**
1. **Keyword ablation:** on the test set, remove the strongest class keywords (for example "lease", "lessor", "fire", "structural", "accredit", "audit", "occupancy", "approval") and re-evaluate. Report how much macro-F1 drops.
2. **Extra OCR noise:** corrupt the test text further (random character substitutions at 3% and 6%) and re-evaluate.
3. **Truncation:** keep only the first 40% of the words of each test document and re-evaluate.
4. **Leave-one-layout-group-out** on train using `GroupKFold` (5 folds). Report mean and standard deviation of macro-F1.

**Honesty rules (mandatory):** the dataset is synthetic. State clearly in the report that a score near 1.0 on synthetic data does **not** predict accuracy on real AICTE documents, and that the claim supported is only: "works on synthetic data and on layouts unseen in training". Do not claim production accuracy. Do not hide or round up weak results.

## 6. Prediction interface (must match the frontend field)

Create `predict_m1.py` with:

```
predict(text: str) -> dict
predict_file(path: str) -> dict      # runs ocr/ocr_extract.py first, then predict()
```

and a command line: `python predict_m1.py --file path/to/doc.pdf` and `python predict_m1.py --text "some text"`. It must print **one JSON object to stdout and nothing else** (send logs to stderr), so Node.js can read it. Exit code 0 on success, 2 when the document is unsupported or quarantined.

The JSON contract (field names are fixed, the frontend reads them):

```json
{
  "model": "M1",
  "model_version": "m1-v1.0.0",
  "field": "document_type",
  "ai_suggested": true,
  "value": "fire",
  "display_name": "Fire Safety Certificate",
  "confidence": 0.94,
  "zone": "green",
  "prefill": true,
  "top3": [
    {"value": "fire", "display_name": "Fire Safety Certificate", "confidence": 0.94},
    {"value": "structural", "display_name": "Structural Stability Certificate", "confidence": 0.03},
    {"value": "other", "display_name": "Other Document", "confidence": 0.02}
  ],
  "ocr": {"used_ocr": false, "mean_ocr_conf": 1.0, "pages": 1, "warnings": []},
  "needs_manual_entry": false,
  "message": null
}
```

Rules:
- `value`, `display_name`, `confidence` and `top3` are always present, even in the red zone. `prefill` is `true` only in the green and amber zones; in the red zone the frontend leaves the field blank, so set `prefill: false`.
- `zone` is one of `green`, `amber`, `red`.
- Lower the final confidence when OCR is poor: if `mean_ocr_conf` is below 0.60, multiply the confidence by `mean_ocr_conf / 0.60` (so a blurred scan cannot reach green) and add a warning. If the text has fewer than 15 words, force the red zone.
- If the file is quarantined, unsupported, empty or the extraction fails, return `needs_manual_entry: true`, `prefill: false`, `zone: "red"`, `value: "other"`, `confidence: 0.0`, an explanatory `message` (for example "AI service unavailable. Enter values manually." or the quarantine reason), and exit with code 2. This is the **failure drill** behaviour: nothing may crash or block a case.
- Never include the full document text in the output.
- The model must not read any database, policy table or credential. Input is only the text.

## 7. Deliverables (create exactly this structure)

```
m1_training/
  train_m1.py              # one command: python train_m1.py
  predict_m1.py            # interface from section 6
  config.py                # seeds, thresholds, paths, model version
  requirements.txt         # pinned versions
  artifacts/m1_v1.joblib   # fitted vectorizers + classifier + calibrator + label list
  reports/metrics.json
  reports/REPORT.md        # tables, plots, stress tests, honest limits
  reports/confusion_matrix.png
  reports/misclassified_test.csv
  tests/test_predict.py    # pytest tests
  README.md                # setup, how to retrain, how Node.js can call it, limits
```

`tests/test_predict.py` must test: the JSON contract keys and types; zone boundaries (0.90, 0.89, 0.60, 0.59); red zone gives `prefill: false`; very short text goes red; low OCR confidence lowers confidence; a missing file and a renamed executable give `needs_manual_entry: true` and exit code 2; the same text always gives the same output; the sample documents in `samples/` (a fire certificate, a lease deed, an approval letter) are classified as `fire`, `lease`, `aicte_approval_letter` when run through `predict_file`.

## 8. Quality bar and things to avoid

- Clean, commented, readable code. Type hints on public functions. No notebooks.
- No data leakage: no fitting of any transformer on validation or test data, and calibration only on validation.
- No hidden manual steps. Everything runs from the README.
- Do not print or store private data. All documents here are fictional, but write the code as if they were real: no external calls.
- Do not change the dataset files. If you find a problem in them, report it in `REPORT.md` and continue.
- Finish by printing a short summary: final validation and test macro-F1, stress-test results, the artifact path, and any limits or assumptions.
