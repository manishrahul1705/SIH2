#!/usr/bin/env python3
"""
ApprovalTrack - document text extraction (embedded text first, OCR only when needed).

Usage:
    python ocr_extract.py path/to/file.pdf                 # JSON to stdout (Node.js can spawn this)
    python ocr_extract.py file.jpg --out result.json
    python ocr_extract.py file.pdf --text-only             # normalised text for M1

Supported: PDF (text or scanned), JPG/JPEG, PNG, TIFF, BMP, DOCX (converted with LibreOffice).
Anything else, or any failure, returns  {"supported": false, ...}  so the UI falls back to manual entry.
Runs fully locally. No document is sent to any external service.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

MAX_MB = 20
MAX_PAGES = 40
MIN_EMBEDDED_CHARS = 40
LOW_CONF = 0.60
INSTRUCTION_PATTERNS = re.compile(
    r"ignore (all |any )?(the )?(previous|above|prior) (instructions|prompts)|disregard (the )?(previous|above)|"
    r"system prompt|you are (now )?an? (ai|assistant|language model)|reveal your (instructions|prompt)|"
    r"mark (this|the) (document|application) as (approved|verified)", re.I)

def _sig(path):
    with open(path, "rb") as f:
        return f.read(16)

def detect_type(path):
    """Detect the real type from file CONTENT, never from the extension."""
    h = _sig(path)
    if h.startswith(b"%PDF"): return "pdf"
    if h.startswith(b"\x89PNG"): return "png"
    if h.startswith(b"\xff\xd8\xff"): return "jpg"
    if h[:4] in (b"II*\x00", b"MM\x00*"): return "tiff"
    if h.startswith(b"BM"): return "bmp"
    if h.startswith(b"PK\x03\x04"):
        import zipfile
        try:
            with zipfile.ZipFile(path) as z:
                if "word/document.xml" in z.namelist(): return "docx"
        except zipfile.BadZipFile:
            pass
        return "zip"
    if h.startswith(b"MZ") or h.startswith(b"\x7fELF") or h[:4] in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe") or h.startswith(b"#!"):
        return "executable"
    return "unknown"

EXT_OK = {"pdf": {".pdf"}, "png": {".png"}, "jpg": {".jpg", ".jpeg"}, "tiff": {".tif", ".tiff"}, "bmp": {".bmp"}, "docx": {".docx"}}

def _result(path, **kw):
    base = {"file": os.path.basename(path), "supported": False, "quarantined": False, "quarantine_reason": None,
            "detected_type": None, "pages": [], "full_text": "", "mean_ocr_conf": None, "used_ocr": False, "warnings": []}
    base.update(kw)
    return base

# ------------------------------------------------------------------ image helpers
def _preprocess(img):
    """Grayscale, upscale small images, auto-contrast, light deskew."""
    from PIL import Image, ImageOps
    img = ImageOps.exif_transpose(img).convert("L")
    if min(img.size) < 1200:
        s = 1600 / min(img.size)
        img = img.resize((int(img.width * s), int(img.height * s)), Image.LANCZOS)
    img = ImageOps.autocontrast(img, cutoff=1)
    try:
        import cv2, numpy as np
        a = np.array(img)
        inv = cv2.threshold(a, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
        pts = cv2.findNonZero(inv)
        if pts is not None and len(pts) > 500:
            ang = cv2.minAreaRect(pts)[-1]
            ang = ang - 90 if ang > 45 else ang
            if 0.4 < abs(ang) < 15:
                h, w = a.shape
                M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
                a = cv2.warpAffine(a, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
                img = Image.fromarray(a)
    except Exception:
        pass
    return img

def _ocr_image(img, page_no):
    import pytesseract
    if os.environ.get("TESSERACT_CMD"): pytesseract.pytesseract.tesseract_cmd = os.environ["TESSERACT_CMD"]
    img = _preprocess(img)
    d = pytesseract.image_to_data(img, lang="eng", config="--oem 3 --psm 3", output_type=pytesseract.Output.DICT)
    W, H = img.size
    words, lines = [], {}
    for i, t in enumerate(d["text"]):
        t = (t or "").strip()
        try: conf = float(d["conf"][i])
        except (ValueError, TypeError): conf = -1
        if not t or conf < 0: continue
        x0, y0, w, h = d["left"][i], d["top"][i], d["width"][i], d["height"][i]
        words.append({"text": t, "bbox": [round(x0 / W, 5), round(y0 / H, 5), round((x0 + w) / W, 5), round((y0 + h) / H, 5)], "conf": round(conf / 100, 3)})
        lines.setdefault((d["block_num"][i], d["par_num"][i], d["line_num"][i]), []).append(t)
    text = "\n".join(" ".join(v) for _, v in sorted(lines.items()))
    return {"page": page_no, "source": "ocr", "width": W, "height": H, "text": text, "words": words}

# ------------------------------------------------------------------ per format
def _from_pdf(path, dpi, max_pages):
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    from PIL import Image
    doc = fitz.open(path)
    if doc.needs_pass: raise ValueError("password protected PDF")
    pages, warns, used_ocr = [], [], False
    n = min(len(doc), max_pages)
    if len(doc) > max_pages: warns.append(f"only first {max_pages} pages processed")
    for i in range(n):
        pg = doc[i]; rect = pg.rect
        ws = pg.get_text("words")                       # x0,y0,x1,y1,word,block,line,wordno
        text = pg.get_text("text").strip()
        if len(text) >= MIN_EMBEDDED_CHARS:
            words = [{"text": w[4], "bbox": [round(w[0] / rect.width, 5), round(w[1] / rect.height, 5), round(w[2] / rect.width, 5), round(w[3] / rect.height, 5)], "conf": 1.0} for w in ws]
            pages.append({"page": i + 1, "source": "embedded", "width": rect.width, "height": rect.height, "text": text, "words": words})
        else:
            used_ocr = True
            pix = pg.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            pages.append(_ocr_image(img, i + 1))
    return pages, warns, used_ocr

def _from_image(path):
    from PIL import Image, ImageSequence
    img = Image.open(path); pages = []
    for i, fr in enumerate(ImageSequence.Iterator(img)):
        if i >= MAX_PAGES: break
        pages.append(_ocr_image(fr.copy(), i + 1))
    return pages

def _from_docx(path, dpi, max_pages):
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice: raise RuntimeError("LibreOffice not installed, cannot convert DOCX")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", tmp, path], check=True, timeout=120, capture_output=True)
        out = os.path.join(tmp, os.path.splitext(os.path.basename(path))[0] + ".pdf")
        return _from_pdf(out, dpi, max_pages)

# ------------------------------------------------------------------ main API
def extract_document(path, dpi=300, max_pages=MAX_PAGES):
    if not os.path.isfile(path): return _result(path, warnings=["file not found"])
    kind = detect_type(path); ext = os.path.splitext(path)[1].lower()
    if os.path.getsize(path) > MAX_MB * 1024 * 1024:
        return _result(path, detected_type=kind, quarantined=True, quarantine_reason=f"file larger than {MAX_MB} MB")
    if kind == "executable":
        return _result(path, detected_type=kind, quarantined=True, quarantine_reason="executable content disguised as a document")
    if kind in EXT_OK and ext not in EXT_OK[kind]:
        return _result(path, detected_type=kind, quarantined=True, quarantine_reason=f"extension {ext or '(none)'} does not match real type {kind}")
    if kind not in EXT_OK:
        return _result(path, detected_type=kind, warnings=["unsupported file type: enter values manually"])
    try:
        if kind == "pdf": pages, warns, used = _from_pdf(path, dpi, max_pages)
        elif kind == "docx": pages, warns, used = _from_docx(path, dpi, max_pages)
        else: pages, warns, used = _from_image(path), [], True
    except Exception as e:
        return _result(path, detected_type=kind, warnings=[f"extraction failed: {e}. Enter values manually."])
    full = "\n".join(p["text"] for p in pages).strip()
    if INSTRUCTION_PATTERNS.search(full):
        return _result(path, detected_type=kind, quarantined=True, quarantine_reason="document contains instruction-like text; treated as data and not processed")
    confs = [w["conf"] for p in pages for w in p["words"]]
    mean = round(sum(confs) / len(confs), 3) if confs else None
    if not full: warns.append("no text found: enter values manually")
    if mean is not None and mean < LOW_CONF: warns.append("low OCR confidence: results need careful review")
    return _result(path, supported=bool(full), detected_type=kind, pages=pages, full_text=full, mean_ocr_conf=mean, used_ocr=used, warnings=warns)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file"); ap.add_argument("--out"); ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--max-pages", type=int, default=MAX_PAGES); ap.add_argument("--text-only", action="store_true")
    a = ap.parse_args()
    res = extract_document(a.file, a.dpi, a.max_pages)
    if a.text_only:
        from m1_text import normalize_for_m1, document_text_for_m1
        print(normalize_for_m1(document_text_for_m1(res)))
    else:
        s = json.dumps(res, ensure_ascii=False, indent=2)
        (open(a.out, "w", encoding="utf-8").write(s) if a.out else print(s))
    sys.exit(0 if res["supported"] or res["quarantined"] else 2)