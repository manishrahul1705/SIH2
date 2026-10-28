#!/usr/bin/env python3
"""Offline M3 predictor. All values remain proposals until a person confirms them."""
from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
MODEL_PATH = Path(os.environ.get("M3_MODEL_PATH", HERE / "m3_model.joblib"))
ROLE_KINDS = {
    "lease_start": "date",
    "lease_end": "date",
    "term_value": "term",
}
ROLE_LABELS = (*ROLE_KINDS, "other")
MIN_CONFIDENCE = 0.60
RUNNER_UP_MARGIN = 0.15


@lru_cache(maxsize=1)
def _load_model(path: str = str(MODEL_PATH)) -> dict[str, Any]:
    model_path = Path(path)
    if not model_path.is_file():
        raise FileNotFoundError(f"M3 model file not found: {model_path}")
    bundle = joblib.load(model_path)
    required = {"model_version", "feature_builder", "model", "calibrators", "labels"}
    missing = required.difference(bundle)
    if missing:
        raise ValueError(f"M3 model bundle is incomplete: {sorted(missing)}")
    return bundle


def _predict_probabilities(bundle: dict[str, Any], frame: pd.DataFrame) -> np.ndarray:
    matrix = bundle["feature_builder"].transform(frame)
    if bundle.get("svd") is not None:
        matrix = bundle["svd"].transform(matrix).astype(np.float32)
    raw = bundle["model"].predict_proba(matrix)
    calibrated = np.empty_like(raw, dtype=np.float64)
    for column, calibrator in enumerate(bundle["calibrators"]):
        clipped = np.clip(raw[:, column], 1e-6, 1 - 1e-6)
        logits = np.log(clipped / (1 - clipped)).reshape(-1, 1)
        calibrated[:, column] = calibrator.predict_proba(logits)[:, 1]
    return calibrated / np.maximum(calibrated.sum(axis=1, keepdims=True), 1e-12)


def _blank(reason: str) -> dict[str, Any]:
    return {"candidate_id": "", "confidence": 0.0, "blank_reason": reason}


def _pick_role(
    candidates: list[dict[str, Any]],
    probabilities: np.ndarray,
    role: str,
    label_column: int,
    apply_checks: bool = True,
) -> dict[str, Any]:
    kind = ROLE_KINDS[role]
    ranked: dict[str, tuple[float, dict[str, Any]]] = {}
    for candidate, probability in zip(candidates, probabilities[:, label_column]):
        if str(candidate.get("kind", "")) != kind:
            continue
        value = str(candidate.get("value", "")).strip()
        if not value:
            continue
        key = value
        previous = ranked.get(key)
        confidence = float(probability)
        tie_key = (
            int(candidate.get("page", 0) or 0),
            int(candidate.get("line_no", 0) or 0),
            str(candidate.get("cand_id", "")),
        )
        if previous is None:
            ranked[key] = (confidence, candidate)
        else:
            prev_confidence, prev_candidate = previous
            prev_tie = (
                int(prev_candidate.get("page", 0) or 0),
                int(prev_candidate.get("line_no", 0) or 0),
                str(prev_candidate.get("cand_id", "")),
            )
            if confidence > prev_confidence or (confidence == prev_confidence and tie_key < prev_tie):
                ranked[key] = (confidence, candidate)

    if not ranked:
        return _blank("not_found")
    ordered = sorted(
        ranked.values(),
        key=lambda item: (-item[0], int(item[1].get("page", 0) or 0),
                          int(item[1].get("line_no", 0) or 0), str(item[1].get("cand_id", ""))),
    )
    confidence, winner = ordered[0]
    if apply_checks and confidence < MIN_CONFIDENCE:
        return _blank("low_confidence")
    if apply_checks and int(winner.get("ambiguous", 0) or 0):
        return {
            "candidate_id": winner.get("cand_id", ""),
            "confidence": 0.0,
            "blank_reason": "ambiguous_date" if kind == "date" else "ambiguous_candidate",
        }
    if (apply_checks and len(ordered) > 1
            and confidence - ordered[1][0] <= RUNNER_UP_MARGIN):
        confidence = min(confidence, 0.89)
    return {
        "candidate_id": winner.get("cand_id", ""),
        "confidence": round(float(confidence), 4),
        "blank_reason": "",
    }


def _rank_candidates(
    candidates: list[dict[str, Any]],
    bundle: dict[str, Any],
    probabilities: np.ndarray,
    apply_checks: bool,
) -> dict[str, Any]:
    model_version = str(bundle["model_version"])
    label_columns = {str(label): idx for idx, label in enumerate(bundle["model"].classes_)}
    roles = {
        role: _pick_role(candidates, probabilities, role, label_columns[role], apply_checks)
        for role in ROLE_KINDS
    }
    return {"model_version": model_version, "roles": roles}


def _candidate_probabilities(
    candidates: list[dict[str, Any]], bundle: dict[str, Any]
) -> np.ndarray:
    frame = pd.DataFrame(candidates)
    expected = set(bundle["feature_builder"].encoder.feature_names_in_)
    if not expected.issubset(frame.columns):
        missing = sorted(expected.difference(frame.columns))
        raise ValueError(f"M3 candidates are missing required model features: {missing}")
    return _predict_probabilities(bundle, frame)


def predict_lease(
    candidates: list[dict[str, Any]], *, apply_checks: bool = True
) -> dict[str, Any]:
    """Rank candidates by lease role, coalescing repeats by role and parsed value."""
    bundle = _load_model()
    if not candidates:
        return {
            "model_version": str(bundle["model_version"]),
            "roles": {role: _blank("not_found") for role in ROLE_KINDS},
        }
    probabilities = _candidate_probabilities(candidates, bundle)
    return _rank_candidates(candidates, bundle, probabilities, apply_checks)


def predict_lease_variants(
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return checked and unchecked rankings from one feature/model pass for evaluation."""
    bundle = _load_model()
    if not candidates:
        blank = {
            "model_version": str(bundle["model_version"]),
            "roles": {role: _blank("not_found") for role in ROLE_KINDS},
        }
        return blank, blank
    probabilities = _candidate_probabilities(candidates, bundle)
    return (
        _rank_candidates(candidates, bundle, probabilities, True),
        _rank_candidates(candidates, bundle, probabilities, False),
    )
