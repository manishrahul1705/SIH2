#!/usr/bin/env python3
"""M1 prediction API and JSON-only command line interface."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

import joblib

from config import AMBER, ARTIFACT_PATH, CLASSES, GREEN, MODEL_VERSION

ROOT = Path(__file__).resolve().parents[1]
OCR_DIR = ROOT / "ocr"
sys.path.insert(0, str(OCR_DIR))
from m1_text import document_text_for_m1, normalize_for_m1  # noqa: E402

sys.path.insert(0, str(OCR_DIR.parent / "ocr"))
import ocr_extract  # noqa: E402

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s: %(message)s")
LOGGER = logging.getLogger("m1")

_DISPLAY_NAMES = {
    "lease": "Lease Deed",
    "fire": "Fire Safety Certificate",
    "structural": "Structural Stability Certificate",
    "occupancy_or_building": "Occupancy or Building Certificate",
    "nba_letter": "NBA Accreditation Letter",
    "audited_accounts": "Audited Accounts",
    "aicte_approval_letter": "AICTE Approval Letter",
    "other": "Other Document",
}
_MODEL_BUNDLE: dict[str, Any] | None = None


def _bundle() -> dict[str, Any]:
    global _MODEL_BUNDLE
    if _MODEL_BUNDLE is None:
        if not ARTIFACT_PATH.is_file():
            raise FileNotFoundError(
                f"M1 artifact not found at {ARTIFACT_PATH}; run python train_m1.py first"
            )
        _MODEL_BUNDLE = joblib.load(ARTIFACT_PATH)
    return _MODEL_BUNDLE


def _zone(confidence: float, word_count: int) -> str:
    if word_count < 15 or confidence < AMBER:
        return "red"
    if confidence >= GREEN:
        return "green"
    return "amber"


def _failure(message: str, ocr: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "model": "M1",
        "model_version": MODEL_VERSION,
        "field": "document_type",
        "ai_suggested": True,
        "value": "other",
        "display_name": _DISPLAY_NAMES["other"],
        "confidence": 0.0,
        "zone": "red",
        "prefill": False,
        "top3": [
            {"value": "other", "display_name": _DISPLAY_NAMES["other"], "confidence": 0.0}
        ],
        "ocr": ocr
        or {"used_ocr": False, "mean_ocr_conf": 0.0, "pages": 0, "warnings": []},
        "needs_manual_entry": True,
        "message": message,
    }


def _prediction_from_probabilities(
    probabilities: list[float],
    labels: list[str] | tuple[str, ...],
    *,
    word_count: int,
    used_ocr: bool = False,
    mean_ocr_conf: float = 1.0,
    pages: int = 1,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    warning_list = list(warnings or [])
    safe_mean = max(0.0, min(1.0, float(mean_ocr_conf)))
    scores = [max(0.0, float(probability)) for probability in probabilities]
    if safe_mean < 0.60:
        penalty = safe_mean / 0.60
        scores = [score * penalty for score in scores]
        warning_list.append("Low OCR confidence reduced the suggestion confidence; review the document manually.")
    ranking = sorted(range(len(scores)), key=lambda index: scores[index], reverse=True)
    best_index = ranking[0]
    value = labels[best_index]
    confidence = scores[best_index]
    zone = _zone(confidence, word_count)
    if word_count < 15:
        warning_list.append("Fewer than 15 words were extracted; manual review is required.")
    message = "Confidence is below the display threshold; choose a document type manually." if zone == "red" else None
    return {
        "model": "M1",
        "model_version": MODEL_VERSION,
        "field": "document_type",
        "ai_suggested": True,
        "value": value,
        "display_name": _DISPLAY_NAMES[value],
        "confidence": round(confidence, 6),
        "zone": zone,
        "prefill": zone in {"green", "amber"},
        "top3": [
            {
                "value": labels[index],
                "display_name": _DISPLAY_NAMES[labels[index]],
                "confidence": round(scores[index], 6),
            }
            for index in ranking[:3]
        ],
        "ocr": {
            "used_ocr": bool(used_ocr),
            "mean_ocr_conf": round(safe_mean, 6),
            "pages": int(pages),
            "warnings": warning_list,
        },
        "needs_manual_entry": False,
        "message": message,
    }


def _predict(
    text: str,
    *,
    used_ocr: bool = False,
    mean_ocr_conf: float = 1.0,
    pages: int = 1,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip():
        return _failure("No text was extracted. Enter values manually.")
    normalized = normalize_for_m1(text)
    word_count = len(normalized.split())
    bundle = _bundle()
    model = bundle["model"]
    probabilities = model.predict_proba([normalized])[0].tolist()
    return _prediction_from_probabilities(
        probabilities,
        list(model.classes_),
        word_count=word_count,
        used_ocr=used_ocr,
        mean_ocr_conf=mean_ocr_conf,
        pages=pages,
        warnings=warnings,
    )


def predict(text: str) -> dict[str, Any]:
    """Suggest one of the configured document classes from supplied text."""
    try:
        return _predict(text)
    except Exception as error:
        LOGGER.exception("M1 text prediction failed")
        return _failure(f"AI service unavailable. Enter values manually. ({error})")


def predict_file(path: str | Path) -> dict[str, Any]:
    """Extract local file text with the supplied OCR module, then make an M1 suggestion."""
    try:
        extracted = ocr_extract.extract_document(str(path))
    except Exception as error:
        LOGGER.exception("Document extraction failed")
        return _failure(f"Document extraction failed. Enter values manually. ({error})")

    ocr = {
        "used_ocr": bool(extracted.get("used_ocr", False)),
        "mean_ocr_conf": extracted.get("mean_ocr_conf")
        if extracted.get("mean_ocr_conf") is not None
        else 0.0,
        "pages": len(extracted.get("pages", [])),
        "warnings": list(extracted.get("warnings") or []),
    }
    if extracted.get("quarantined"):
        reason = extracted.get("quarantine_reason") or "File quarantined. Enter values manually."
        return _failure(
            f"Quarantined: {reason}",
            ocr,
        )
    if not extracted.get("supported"):
        message = "; ".join(ocr["warnings"]) or "Unsupported file. Enter values manually."
        return _failure(message, ocr)
    text = document_text_for_m1(extracted)
    if not text.strip():
        return _failure("No text was extracted. Enter values manually.", ocr)
    return predict_with_ocr(
        text,
        used_ocr=ocr["used_ocr"],
        mean_ocr_conf=ocr["mean_ocr_conf"],
        pages=ocr["pages"],
        warnings=ocr["warnings"],
    )


def predict_with_ocr(
    text: str,
    *,
    used_ocr: bool,
    mean_ocr_conf: float,
    pages: int,
    warnings: list[str],
) -> dict[str, Any]:
    """Keep extraction metadata attached while applying the shared text predictor."""
    try:
        return _predict(
            text,
            used_ocr=used_ocr,
            mean_ocr_conf=mean_ocr_conf,
            pages=pages,
            warnings=warnings,
        )
    except Exception as error:
        LOGGER.exception("M1 file prediction failed")
        return _failure(f"AI service unavailable. Enter values manually. ({error})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", type=Path)
    source.add_argument("--text")
    source.add_argument("--text-stdin", action="store_true")
    args = parser.parse_args(argv)
    if args.file is not None:
        result = predict_file(args.file)
    elif args.text_stdin:
        result = predict(sys.stdin.read())
    else:
        result = predict(args.text)
    print(json.dumps(result, ensure_ascii=False))
    return 2 if result["needs_manual_entry"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
