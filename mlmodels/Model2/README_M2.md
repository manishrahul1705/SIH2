# ApprovalTrack M2 package

Drop-in files (nothing existing is changed):

- `ocr/m2_common.py` - NEW. Shared candidate finder (dates, numbers, issuer lines). Training and inference both use it.
- `ocr/m2_extract.py` - NEW. Calls the existing `ocr_extract.py` and prints the M2 JSON. Node.js spawns it like the M1 script.
- `m2_train.py`, `m2_modeling.py`, `ocr/m2_predict.py` - local training, shared preprocessing, calibrated inference.
- `m2_evaluate.py`, `metrics.json`, `MODEL_CARD.md` - final test metrics, stress checks, and model limitations.
- `tests/test_m2_predict.py` - predictor schema, safeguards, determinism, and extractor failure tests.
- `ocr/tests/test_m2_common.py` - NEW. `python -m pytest ocr/tests`.
- `generate_m2_dataset.py` - rebuilds or enlarges the dataset: `python generate_m2_dataset.py --out dataset --per-class 2500 --seed 2026`.
- `make_sample_pdfs.py` - renders test-split documents as PDFs and a scanned PNG for trying the pipeline.
- `dataset/` - plain CSV files (candidates, documents, words), 12,000 documents, 201,423 candidate rows, split by layout.
- `M2_training_prompt.md` - the prompt to give to an AI to train M2.

Install: the existing `requirements.txt` is enough for OCR. Dataset generation needs `pandas`; tests need `pytest`.
Run: `python m2_extract.py file.pdf --doc-type fire` (doc type from M1). Before training, fields come back blank (red) with the candidates attached.

## Train and evaluate M2

From this `Model2` directory, run:

```powershell
python m2_train.py
python -m pytest tests\test_m2_predict.py ocr\tests\test_m2_common.py -q
python m2_evaluate.py
```

Training reconstructs candidates using the shared `find_candidates()` helper. It uses train layouts to fit,
validation layouts to compare models and fit probability calibration, and only then evaluates on the held-out
test layouts. The resulting local artifact is `m2_model.joblib`; evaluation writes `metrics.json` and
`MODEL_CARD.md`.

In this workspace, the read-only M1 OCR module is in `..\Model1\ocr`, rather than beside the M2 extractor.
For a direct CLI run from this directory, add both OCR locations to `PYTHONPATH`:

```powershell
$env:PYTHONPATH = "..\Model1\ocr;.\ocr;."
python .\ocr\m2_extract.py .\samples\sample_fire.pdf --doc-type fire
```
