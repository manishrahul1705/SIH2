#!/usr/bin/env python3
"""
ApprovalTrack M3 - lease reader: OCR wrapper + fixed JSON output (schema m3-output-1).

    python m3_extract.py lease.pdf
    python m3_extract.py lease.pdf --doc-type lease --as-of 2026-10-27 --reminder-days 30

Pipeline
  1. read the file:  the project's ocr_extract.py (imported/called read-only, never modified);
     if it cannot be found or its output cannot be understood, a built-in reader is used
     (PyMuPDF embedded text -> Tesseract only for scans; DOCX; images).
  2. M1 has already said the document is a lease (pass --doc-type; anything else is blank).
  3. m3_common.find_lease_candidates(pages)     dates + terms, in ALL pages (never page 1 only)
  4. m3_predict.predict_lease(candidates)       the trained ranker (built later by the training AI)
  5. reconcile_lease(...)                       deterministic: derive, flag inconsistency, blank
  6. status_from_reconciled(...)                PREVIEW only; counts_toward_score is always false

If m3_predict.py does not exist yet, or fails, every field is blank (red) and the candidates are
attached, so the frontend falls back to manual entry. Nothing here starts a clock.

SAFEGUARD: AI-suggested values are not verified. A person must confirm every value, an authorised
official must confirm the lease review flag, and the software never replaces the competent authority.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import subprocess
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
for extra in (HERE, os.path.join(HERE, "ocr"), os.path.join(HERE, "..", "ocr"),
              os.environ.get("M3_OCR_DIR", "")):
    if extra and os.path.isdir(extra) and extra not in sys.path:
        sys.path.append(extra)

from m3_common import find_lease_candidates, normalise_pages          # noqa: E402
from m3_lease import (DEFAULT_REMINDER_DAYS, DEMO_AS_OF, display_date,  # noqa: E402
                      format_term, reconcile_lease, status_from_reconciled)

SCHEMA = "m3-output-1"
BANNER = ("DEMO DATA - NOT REAL AICTE DEADLINES. AI-suggested values are not verified. "
          "A person must confirm every value; the software never replaces the competent authority.")
GREEN, AMBER = 0.90, 0.60
MAX_PAGES_DEFAULT = 60


def zone(conf):
    return "green" if conf >= GREEN else ("amber" if conf >= AMBER else "red")


# --------------------------------------------------------------------------- reading
def _parse_json_text(text):
    text = text.strip()
    i = text.find("{")
    j = text.find("[")
    starts = [x for x in (i, j) if x != -1]
    if not starts:
        raise ValueError("no JSON in output")
    return json.loads(text[min(starts):])


def _read_with_project_ocr(path):
    """Use the existing ocr_extract.py read-only. Returns (raw, engine_note) or (None, reason)."""
    try:
        mod = importlib.import_module("ocr_extract")
    except Exception:
        return None, "ocr_extract_not_found"
    for name in ("extract_document", "extract", "extract_file", "run_ocr", "ocr_file",
                 "process_file", "process", "extract_text"):
        fn = getattr(mod, name, None)
        if not callable(fn):
            continue
        try:
            res = fn(path)
        except TypeError:
            continue
        except Exception as exc:
            return None, f"ocr_extract_failed:{type(exc).__name__}"
        if isinstance(res, str):
            try:
                res = _parse_json_text(res)
            except Exception:
                res = {"text": res}
        return res, f"ocr_extract.{name}"
    try:                                                  # command-line fallback: prints JSON
        out = subprocess.run([sys.executable, mod.__file__, path], capture_output=True,
                             text=True, timeout=300)
        return _parse_json_text(out.stdout), "ocr_extract.cli"
    except Exception as exc:
        return None, f"ocr_extract_cli_failed:{type(exc).__name__}"


def _ocr_image(img):
    import pytesseract
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    w, h = img.size
    words = []
    for i, t in enumerate(data["text"]):
        t = (t or "").strip()
        if t and float(data["conf"][i]) >= 0:
            x, y, bw, bh = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
            words.append({"text": t, "bbox": [x / w, y / h, (x + bw) / w, (y + bh) / h]})
    return words


def _builtin_read(path):
    """Embedded PDF text first; Tesseract only for scans; DOCX; images."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        try:
            import fitz                                   # PyMuPDF
        except ImportError:
            fitz = None
        if fitz is not None:
            from PIL import Image
            pages = []
            with fitz.open(path) as doc:
                for p in doc:
                    rect = p.rect
                    words = [{"text": w[4], "bbox": [w[0] / rect.width, w[1] / rect.height,
                                                     w[2] / rect.width, w[3] / rect.height]}
                             for w in p.get_text("words") if str(w[4]).strip()]
                    if len(words) < 15:                   # looks like a scan: OCR it
                        pix = p.get_pixmap(dpi=250)
                        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                        words = _ocr_image(img) or words
                    pages.append({"page": p.number + 1, "words": words})
            return {"pages": pages}
        from pypdf import PdfReader
        return {"pages": [{"page": i, "text": (pg.extract_text() or "")}
                          for i, pg in enumerate(PdfReader(path).pages, 1)]}
    if ext == ".docx":
        import docx
        lines = [p.text for p in docx.Document(path).paragraphs if p.text.strip()]
        return {"pages": [{"page": i // 45 + 1, "text": "\n".join(lines[i:i + 45])}
                          for i in range(0, len(lines), 45)] or [{"page": 1, "text": ""}]}
    if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"):
        from PIL import Image
        return {"pages": [{"page": 1, "words": _ocr_image(Image.open(path).convert("RGB"))}]}
    raise RuntimeError(f"unsupported_file_type:{ext}")


def read_document(path, ocr_data=None):
    """Returns (pages, engine, quarantine_flag). Never raises for an unreadable file."""
    if ocr_data is not None:
        if isinstance(ocr_data, dict) and (ocr_data.get("quarantined") or ocr_data.get("quarantine")
                                           or ocr_data.get("status") == "quarantined"):
            return [], "precomputed_ocr", True
        return normalise_pages(ocr_data), "precomputed_ocr", False
    raw, note = _read_with_project_ocr(path)
    if isinstance(raw, dict) and (raw.get("quarantined") or raw.get("quarantine")
                                  or raw.get("status") == "quarantined"):
        return [], note, True
    pages = normalise_pages(raw) if raw is not None else []
    if not any(p["text"].strip() for p in pages):
        try:
            pages = normalise_pages(_builtin_read(path))
            note = f"builtin ({note})"
        except Exception as exc:
            return [], f"unreadable:{type(exc).__name__}:{exc}", False
    return pages, note, False


# --------------------------------------------------------------------------- output
def _blank(model_version, reason, ambiguous=False, extra=None):
    f = {"value": "", "display": "", "confidence": 0.0, "zone": "red", "page": 0,
         "bbox": [0.0, 0.0, 0.0, 0.0], "ambiguous": bool(ambiguous), "needs_confirmation": True,
         "ai_suggested": False, "derived": False, "candidate_id": "",
         "model_version": model_version, "blank_reason": reason}
    if extra:
        f.update(extra)
    return f


def _filled(value, display, conf, cand, model_version, derived=False, extra=None):
    f = {"value": value, "display": display, "confidence": round(float(conf), 4),
         "zone": zone(conf), "page": int(cand["page"]),
         "bbox": [float(cand["bbox_x0"]), float(cand["bbox_y0"]),
                  float(cand["bbox_x1"]), float(cand["bbox_y1"])],
         "ambiguous": False, "needs_confirmation": True, "ai_suggested": True,
         "derived": bool(derived), "candidate_id": cand["cand_id"],
         "model_version": model_version, "blank_reason": ""}
    if extra:
        f.update(extra)
    return f


_EXPLICIT_LEASE_CONTEXT = {
    "lease_start": re.compile(
        r"\b(?:lease\s+start(?:\s+date)?|lease\s+commencement\s+date|"
        r"commencement\s+date|date\s+of\s+commencement|term\s+starts?\s+on)\s*[:=\-–—]*\s*$",
        re.IGNORECASE,
    ),
    "lease_end": re.compile(
        r"\b(?:lease\s+end(?:\s+date)?|lease\s+expiry\s+date|lease\s+expiration\s+date|"
        r"(?:lease\s+)?(?:expiry|expiration)\s+date|valid\s+(?:until|through)|"
        r"term\s+ends?\s+on)\s*[:=\-–—]*\s*$",
        re.IGNORECASE,
    ),
}


def _explicit_lease_candidate(candidates, role):
    pattern = _EXPLICIT_LEASE_CONTEXT[role]
    matches = [
        candidate for candidate in candidates
        if candidate.get("kind") == "date"
        and not int(candidate.get("ambiguous", 0) or 0)
        and pattern.search(str(candidate.get("left_ctx", "") or ""))
    ]
    values = {candidate.get("value") for candidate in matches}
    if len(values) != 1:
        return None
    return matches[0]


def _load_predictor():
    try:
        mod = importlib.import_module("m3_predict")
        return mod.predict_lease, None
    except ModuleNotFoundError as exc:
        if exc.name == "m3_predict":
            return None, "model_missing"
        return None, f"model_failed:ModuleNotFoundError:{exc.name}"
    except Exception as exc:
        return None, f"model_failed:{type(exc).__name__}"


def build_result(path, doc_type, as_of, reminder_days, max_pages=MAX_PAGES_DEFAULT,
                 with_candidates=False, predictor=None, ocr_data=None):
    result = {"schema": SCHEMA, "file": os.path.basename(path), "doc_type": doc_type,
              "banner": BANNER, "ocr_engine": "", "page_count": 0, "pages_scanned": 0,
              "model_loaded": False, "model_version": "none", "ok": True, "quarantined": False}
    blank_reason = ""

    def finish(fields, rec, cands, extra_reason=""):
        result["fields"] = fields
        result["reconciliation"] = {k: rec[k] for k in ("state", "reason", "flags")}
        st = status_from_reconciled(rec, as_of, reminder_days)
        st.update({"preview": True, "counts_toward_score": False,
                   "requires_person_confirmation": True,
                   "note": "Preview only. Nothing counts until a person confirms the values and an "
                           "authorised official confirms the lease review flag."})
        result["preview_status"] = st
        if with_candidates or not result["model_loaded"]:
            result["candidates"] = cands
        return result

    def all_blank(reason, cands, rec_reason=None):
        mv = result["model_version"]
        fields = {"lease_start": _blank(mv, reason), "lease_end": _blank(mv, reason),
                  "lease_term": _blank(mv, reason, extra={"months": 0})}
        rec = reconcile_lease(None, None, None)
        rec["reason"] = rec_reason or reason
        return finish(fields, rec, cands)

    if doc_type and doc_type.lower() != "lease":
        result["ok"] = False
        return all_blank("not_a_lease", [])

    pages, engine, quarantined = read_document(path, ocr_data)
    result["ocr_engine"] = engine
    if quarantined:
        result["ok"], result["quarantined"] = False, True
        return all_blank("quarantined", [])
    if not pages:
        result["ok"] = False
        return all_blank("unreadable_file", [])
    result["page_count"] = len(pages)
    pages = pages[:max_pages]
    result["pages_scanned"] = len(pages)
    cands = find_lease_candidates(pages)

    predict = predictor
    why = None
    if predict is None:
        predict, why = _load_predictor()
    if predict is None:
        return all_blank(why or "model_missing", cands)
    try:
        pred = predict(cands)
    except Exception as exc:
        return all_blank(f"model_failed:{type(exc).__name__}", cands)
    result["model_loaded"] = True
    mv = str(pred.get("model_version", "unknown"))
    result["model_version"] = mv
    roles = dict(pred.get("roles", {}))
    for role in ("lease_start", "lease_end"):
        candidate = _explicit_lease_candidate(cands, role)
        if candidate is not None:
            roles[role] = {
                "candidate_id": candidate["cand_id"],
                "confidence": 0.90,
                "blank_reason": "",
            }
    by_id = {c["cand_id"]: c for c in cands}

    def take(role):
        r = roles.get(role) or {}
        cid, conf = r.get("candidate_id", ""), float(r.get("confidence", 0.0) or 0.0)
        c = by_id.get(cid)
        if c is None:
            return None, 0.0, r.get("blank_reason") or "no_candidate"
        return c, conf, ""

    start_c, start_conf, start_why = take("lease_start")
    end_c, end_conf, end_why = take("lease_end")
    term_c, term_conf, term_why = take("term_value")
    start_amb = bool(start_c and start_c["ambiguous"])
    end_amb = bool(end_c and end_c["ambiguous"])
    term_amb = bool(term_c and term_c["ambiguous"])

    def usable(c, conf, amb):
        return c is not None and not amb and conf >= AMBER

    s_ok, e_ok, t_ok = usable(start_c, start_conf, start_amb), usable(end_c, end_conf, end_amb), \
        usable(term_c, term_conf, term_amb)
    rec = reconcile_lease(start_c["value"] if s_ok else None,
                          end_c["value"] if e_ok else None,
                          term_c["term_months"] if t_ok else None,
                          start_ambiguous=start_amb, end_ambiguous=end_amb)

    def why_blank(c, conf, amb, role_why):
        if amb:
            return "ambiguous_date"
        if c is not None and conf < AMBER:
            return "low_confidence"
        return role_why or "not_found"

    cap = lambda x: min(x, 0.89)
    fields = {}
    # ---- start
    if rec["start"]:
        conf = cap(start_conf) if rec["state"] == "inconsistent" else start_conf
        fields["lease_start"] = _filled(rec["start"], display_date(date.fromisoformat(rec["start"])),
                                        conf, start_c, mv)
    else:
        why = ("end_not_after_start" if rec["reason"] == "end_not_after_start"
               else why_blank(start_c, start_conf, start_amb, start_why))
        fields["lease_start"] = _blank(mv, why, start_amb)
    # ---- end
    if rec["end"]:
        if rec["end_derived"]:
            src = term_c
            conf = cap(min(start_conf, term_conf))
        else:
            src = end_c
            conf = cap(end_conf) if rec["state"] == "inconsistent" else end_conf
        fields["lease_end"] = _filled(rec["end"], display_date(date.fromisoformat(rec["end"])),
                                      conf, src, mv, derived=rec["end_derived"])
    else:
        why = ("end_not_after_start" if rec["reason"] == "end_not_after_start"
               else why_blank(end_c, end_conf, end_amb, end_why))
        fields["lease_end"] = _blank(mv, why, end_amb)
    # ---- term
    if rec["term_months"]:
        months = rec["term_months"]
        if rec["term_derived"]:
            src = end_c
            conf = cap(min(start_conf, end_conf))
        else:
            src = term_c
            conf = cap(term_conf) if rec["state"] == "inconsistent" else term_conf
        fields["lease_term"] = _filled(f"P{months // 12}Y{months % 12}M", format_term(months), conf,
                                       src, mv, derived=rec["term_derived"], extra={"months": months})
    else:
        fields["lease_term"] = _blank(mv, why_blank(term_c, term_conf, term_amb, term_why),
                                      term_amb, extra={"months": 0})
    return finish(fields, rec, cands)


def main():
    ap = argparse.ArgumentParser(description="ApprovalTrack M3 lease reader (proposes; a person confirms).")
    ap.add_argument("file")
    ap.add_argument("--doc-type", default="lease", help="from M1; anything other than 'lease' returns blanks")
    ap.add_argument("--as-of", default=DEMO_AS_OF.isoformat(), help="ISO date; no hidden clocks (demo default)")
    ap.add_argument("--reminder-days", type=int, default=DEFAULT_REMINDER_DAYS)
    ap.add_argument("--max-pages", type=int, default=MAX_PAGES_DEFAULT)
    ap.add_argument("--with-candidates", action="store_true")
    ap.add_argument("--ocr-json-stdin", action="store_true")
    a = ap.parse_args()
    ocr_data = json.load(sys.stdin) if a.ocr_json_stdin else None
    out = build_result(a.file, a.doc_type, a.as_of, a.reminder_days, a.max_pages, a.with_candidates, ocr_data=ocr_data)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
