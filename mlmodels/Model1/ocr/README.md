# OCR extraction (Python, local)

Install: `pip install -r requirements.txt`, plus the Tesseract OCR program (`apt install tesseract-ocr`, or on Windows set `TESSERACT_CMD` to tesseract.exe) and LibreOffice for DOCX.

Run: `python ocr_extract.py file.pdf` prints JSON. Use `--text-only` for the normalised M1 input.

Order: detect real type from content, quarantine bad files, use embedded PDF text where it exists, run OCR only for scans and images, return pages with word boxes (0 to 1 coordinates for the highlight boxes) and confidence.

Later, Node.js can call it with `child_process.spawn("python", ["ocr_extract.py", path])` and read the JSON from stdout. Exit code 0 = processed or quarantined, 2 = unsupported or failed (show manual entry).

`m1_text.py` holds `normalize_for_m1()`. Training and prediction must both use it.
