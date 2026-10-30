#!/usr/bin/env python3
"""
ApprovalTrack - M2 field extraction (issue date, valid-to date, certificate/application number, issuer).

This file is NEW. It imports ocr_extract.py (the M1 OCR script) and only CALLS it. ocr_extract.py, m1_text.py and
the M1 model are not modified, so M1 behaves exactly as before.

Usage (Node.js can spawn this the same way as ocr_extract.py):
    python m2_extract.py file.pdf --doc-type fire          # doc type from M1's result
    python m2_extract.py file.pdf --m1-json m1_result.json  # or pass M1's JSON output file
    python m2_extract.py file.pdf --doc-type fire --debug-candidates
    python m2_extract.py file.pdf --doc-type fire --out result.json

Pipeline: ocr_extract.extract_document() -> m2_common.find_candidates() -> m2_predict.predict_fields() (after M2 is trained).
Until m2_predict.py and m2_model.joblib exist, every field comes back blank (red) with the candidates attached, so the
frontend falls back to manual entry. Nothing here starts a clock: every value is "AI-suggested" and a person confirms it.
The response also includes encumbrance_fields with the exact five-key JSON contract for Encumbrance Certificates.
Exit code: 0 = processed or quarantined, 2 = unsupported or failed (show manual entry).
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import m2_common as C
from m2_label_extract import extract_encumbrance_fields, extract_labeled_fields
import ocr_extract                                   # existing M1 OCR module, imported read-only

SCHEMA_VERSION = "m2-output-1"
FIELDS = ("issue_date", "valid_from", "valid_to", "cert_no", "issuer")
LABEL_KINDS = {
    "issue_date": "date",
    "valid_from": "date",
    "valid_to": "date",
    "cert_no": "number",
    "issuer": "issuer",
}


def blank_field(reason):
    return {"value": "", "display": "", "confidence": 0.0, "zone": "red", "page": 0, "bbox": [0.0, 0.0, 0.0, 0.0], "ambiguous": False,
            "needs_confirmation": True, "ai_suggested": False, "candidate_id": -1, "model_version": "", "blank_reason": reason}


def blank_fields(reason):
    return {f: blank_field(reason) for f in FIELDS}


def _load_predictor():
    """Return predict_fields(candidates, doc_type) once the trained model exists, else None."""
    try:
        import m2_predict
    except ImportError:
        return None, "m2_predict.py not found: M2 not trained yet, fields left blank for manual entry"
    try:
        return m2_predict.predict_fields, ""
    except AttributeError:
        return None, "m2_predict.py has no predict_fields(): fields left blank"


def _apply_labeled_fields(fields, labeled_fields, candidates):
    for name, labeled in labeled_fields.items():
        matching = next((
            candidate for candidate in candidates
            if candidate.get("kind") == LABEL_KINDS[name]
            and candidate.get("value") == labeled["value"]
            and (
                name not in {"valid_from", "valid_to"}
                or "search" in str(candidate.get("line_text", "")).lower()
            )
        ), None)
        confidence = (
            float(matching["ocr_conf"])
            if matching and matching.get("ocr_conf") is not None
            else 0.6
        )
        fields[name] = {
            **blank_field(""),
            **fields.get(name, {}),
            "value": labeled["value"],
            "display": labeled["display"],
            "confidence": confidence,
            "zone": C.zone_for(confidence),
            "page": int(matching.get("page", 0)) if matching else 0,
            "bbox": matching.get("bbox", [0.0, 0.0, 0.0, 0.0]) if matching else [0.0, 0.0, 0.0, 0.0],
            "ambiguous": False,
            "needs_confirmation": True,
            "ai_suggested": True,
            "candidate_id": int(matching.get("cand_id", -1)) if matching else -1,
            "blank_reason": "",
        }
    return fields


def run(path, doc_type="other", debug_candidates=False, ocr_data=None):
    doc_type = doc_type if doc_type in C.DOC_TYPES else "other"
    ocr = ocr_data if ocr_data is not None else ocr_extract.extract_document(path)
    out = {"schema": SCHEMA_VERSION, "file": ocr["file"], "supported": ocr["supported"], "quarantined": ocr["quarantined"],
           "quarantine_reason": ocr["quarantine_reason"] or "", "doc_type": doc_type, "used_ocr": ocr["used_ocr"],
           "mean_ocr_conf": ocr["mean_ocr_conf"] if ocr["mean_ocr_conf"] is not None else 0.0,
           "pages": [{"page": p["page"], "width": p["width"], "height": p["height"], "source": p["source"]} for p in ocr["pages"]],
           "model_available": False, "fields": blank_fields("no text could be read"), "n_candidates": 0, "warnings": list(ocr["warnings"]),
           "manual_entry_required": True, "disclaimer": "AI-suggested values are not verified. A person must confirm every value before any clock starts.",
           "encumbrance_fields": extract_encumbrance_fields("")}
    if ocr["quarantined"]:
        out["fields"] = blank_fields("file quarantined: " + (ocr["quarantine_reason"] or "unsafe file"))
        return out
    if not ocr["supported"]:
        out["fields"] = blank_fields("file could not be read: enter values manually")
        return out
    cands = C.find_candidates(ocr["pages"], doc_type)
    out["n_candidates"] = len(cands)
    full_text = ocr.get("full_text") or "\n".join(page.get("text", "") for page in ocr["pages"])
    labeled_fields = extract_labeled_fields(full_text)
    out["encumbrance_fields"] = extract_encumbrance_fields(full_text)
    predict, why = _load_predictor()
    if predict is None:
        out["warnings"].append(why)
        out["fields"] = _apply_labeled_fields(
            blank_fields("M2 model not available"),
            labeled_fields,
            cands,
        )
        out["candidates"] = cands
        return out
    try:
        fields = predict(cands, doc_type)
        fields = _apply_labeled_fields(fields, labeled_fields, cands)
        for f in FIELDS:                              # enforce the fixed schema, never let a missing key reach the frontend
            fb = blank_field("model returned no value")
            fb.update(fields.get(f, {}))
            fields[f] = fb
        out["fields"] = {f: fields[f] for f in FIELDS}
        out["model_available"] = True
        out["manual_entry_required"] = False
    except Exception as e:                            # AI failure must never block the case
        out["warnings"].append(f"M2 prediction failed ({e}): enter values manually")
        out["fields"] = _apply_labeled_fields(
            blank_fields("M2 prediction failed"),
            labeled_fields,
            cands,
        )
    if debug_candidates or not out["model_available"]:
        out["candidates"] = cands
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file"); ap.add_argument("--doc-type", default=None); ap.add_argument("--m1-json", default=None)
    ap.add_argument("--out"); ap.add_argument("--debug-candidates", action="store_true")
    ap.add_argument("--ocr-json-stdin", action="store_true")
    a = ap.parse_args()
    dtype = a.doc_type
    if not dtype and a.m1_json:
        m1 = json.load(open(a.m1_json, encoding="utf-8"))
        dtype = m1.get("predicted_class") or m1.get("doc_type") or m1.get("label") or "other"
    ocr_data = json.load(sys.stdin) if a.ocr_json_stdin else None
    res = run(a.file, dtype or "other", a.debug_candidates, ocr_data)
    s = json.dumps(res, ensure_ascii=False, indent=2)
    (open(a.out, "w", encoding="utf-8").write(s) if a.out else print(s))
    sys.exit(0 if res["supported"] or res["quarantined"] else 2)
