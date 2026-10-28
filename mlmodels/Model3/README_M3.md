# ApprovalTrack M3 - lease reader (package)

Demo data only. AI-suggested values are not verified; a person confirms; the software never replaces the competent authority.

## Contents
- ocr/m3_lease.py - deterministic lease_status / reconcile_lease / lease_end_date (tested)
- ocr/m3_common.py - the shared candidate finder (dates + terms), used by training AND inference
- ocr/m3_extract.py - OCR wrapper, prints JSON schema m3-output-1 (blank fields until m3_predict.py exists)
- dataset/ - generator, validator, sample maker, and 8,000-deed CSV dataset (+ reports)
- samples/ - 8 PDFs + 1 scanned PNG + expected_outputs.json
- tests/ - 126 pytest cases; prompts/M3_TRAINING_PROMPT.md - give to the training AI

## Run
    pip install pytest pymupdf reportlab pytesseract pillow python-docx pypdf   (+ the tesseract program)
    python -m pytest tests -q
    python ocr/m3_extract.py samples/03_all_three_consistent.pdf --doc-type lease
    python dataset/generate_m3_dataset.py --out dataset --docs-per-layout 500 --seed 2026
    python dataset/validate_m3_dataset.py dataset

## Notes
- Non-target candidates are labelled `other` (not "none") so no label looks like a null. NONE means "not present / blank".
- ocr_extract.py was not available when this was built: m3_extract tries it read-only, and falls back to a built-in reader (PyMuPDF, Tesseract for scans only, DOCX). If your ocr_extract.py output shape differs, adapt m3_extract.py only.
- m3_common.py is self-contained (does not import m2_common.py); it uses the same date formats and the same ambiguity rule.
- Known limitation: a term/date split across a page break by a page header is not matched (such deeds were dropped from the dataset, not repaired).
