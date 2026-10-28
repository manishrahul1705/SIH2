# M1 document type classifier

M1 suggests one of eight document classes from OCR text. It never confirms a document, starts an obligation clock, routes an application, or changes an Action Score. A person remains responsible for confirming the suggested type.

## Setup

From `mlmodels/m1_training`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Image OCR additionally requires the Tesseract executable. On Windows, install Tesseract locally and set `TESSERACT_CMD` to its executable path if it is not on `PATH`. OCR runs locally; no input is sent to an external API.

## Train, evaluate, and package

Run the reproducible training/evaluation command:

```powershell
python train_m1.py
```

The command runs `m1_dataset/validate_dataset.py` first and stops if it fails. It selects settings using one layout-disjoint half of `m1_val.csv`, fits TF-IDF and logistic regression only on `m1_train.csv`, calibrates probabilities using the other layout-disjoint validation half, evaluates the validation split, and evaluates the test split after selection. Five-fold `GroupKFold` uses `layout_id` groups on training rows. Seeds and confidence thresholds are in `config.py`.

Outputs:

- `artifacts/m1_v1.joblib` — fitted word/character vectorizers, logistic regression, sigmoid calibrator and label list.
- `reports/metrics.json` and `reports/REPORT.md` — accuracy, macro-F1, per-class results, quality strata, confidence-zone coverage/accuracy, 10-bin reliability/ECE, grouped CV and requested stress tests.
- `reports/confusion_matrix.png` and `reports/confusion_matrix.csv` — test confusion matrix.
- `reports/misclassified_test.csv` — test errors for the broad `other` class, including a 200-character excerpt.
- `reports/sample_predictions.json` — sample PDF results from the provided `samples/` directory, plus the blurred image's extraction/manual-entry outcome.

The test set is not used to select parameters. Stress tests are run only after the clean test evaluation and are labelled separately.

## Predict

From this directory:

```powershell
python predict_m1.py --text "A fictional lease deed between a lessor and lessee..."
python predict_m1.py --file ..\samples\fire_safety_certificate.pdf
```

Both commands print exactly one JSON object to stdout. Diagnostics go to stderr. Exit code `0` indicates a prediction was produced; code `2` means manual entry is needed, for example when a file is missing, quarantined, unsupported, or OCR extraction failed.

Python callers may use:

```python
from predict_m1 import predict, predict_file

suggestion = predict("extracted document text")
file_suggestion = predict_file(r"..\samples\fire_safety_certificate.pdf")
```

Node.js can call the CLI with `child_process.spawn("python", ["predict_m1.py", "--file", filePath])`, read one JSON object from stdout, and handle code `2` as manual entry. A result always contains `value`, `display_name`, `confidence`, and `top3`; `prefill` is false in the red confidence zone. The consumer must still require a human confirmation for every zone.

## Evaluation limits

All supplied dataset text is synthetic and English-only. A score near 1.0 means only that this model works on synthetic data and on layouts unseen in training; it does not predict accuracy on real AICTE documents. The `other` class is intentionally broad but less varied than real documents. Do not claim production accuracy. For real-world evidence, add 50–100 public, hand-labelled real documents per class, processed using the same OCR pipeline, and evaluate them separately as `real_test`.
