"""Cached M2 inference with calibrated probabilities and mandatory human confirmation."""

from __future__ import annotations

import os
import re
import sys
from functools import lru_cache
from typing import Any

import joblib
import numpy as np

MODEL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)

import m2_common as C

MODEL_PATH = os.path.join(MODEL_DIR, "m2_model.joblib")
FIELDS = ("issue_date", "valid_to", "cert_no", "issuer")
_VALID_TO_CONTEXT = re.compile(
    r"\b(?:valid|va[l1i][l1i]?d(?:ity)?|vo[l1i]id(?:ity)?|"
    r"exp[i1l]r[a-z]*|cxpir[a-z]*|e.?ds|end[a-z]*|termination|"
    r"until|till|through|up\s*to)\b",
    re.IGNORECASE,
)
_ISSUE_DATE_CONTEXT = re.compile(
    r"\b(?:issue(?:d)?(?:\s+date)?|dated|date\s+of\s+(?:deed|registration|issue|survey|inspection|approval)|"
    r"registration\s+date|execution\s+date|executed\s+on|registered\s+on|"
    r"approved\s+on|approval\s+date|certificate\s+date|place\s+and\s+date|"
    r"survey\s+report\s+date)\b",
    re.IGNORECASE,
)


def _blank(reason: str, model_version: str, ambiguous: bool = False) -> dict[str, Any]:
    return {
        "value": "", "display": "", "confidence": 0.0, "zone": "red",
        "page": 0, "bbox": [0.0, 0.0, 0.0, 0.0], "ambiguous": bool(ambiguous),
        "needs_confirmation": True, "ai_suggested": False, "candidate_id": -1,
        "model_version": model_version, "blank_reason": reason, "why": "",
    }


@lru_cache(maxsize=1)
def _load_model() -> dict[str, Any]:
    return joblib.load(MODEL_PATH)


def _candidate_frame(candidates: list[dict[str, Any]], doc_type: str):
    from m2_modeling import candidate_frame
    return candidate_frame(candidates, doc_type)


def _why(model: dict[str, Any], kind: str, role: str, candidate: dict[str, Any],
         doc_type: str) -> str:
    bundle = model["models"][kind]
    estimator = bundle.get("explain_estimator", bundle["estimator"])
    if not hasattr(estimator, "named_steps") or "classifier" not in estimator.named_steps:
        return ""
    if not hasattr(estimator.named_steps["classifier"], "coef_"):
        return ""
    return _why_many(model, kind, [(role, candidate, doc_type)])[0]


def _why_many(model: dict[str, Any], kind: str,
              selected: list[tuple[str, dict[str, Any], str]]) -> list[str]:
    if not selected:
        return []
    bundle = model["models"][kind]
    estimator = bundle.get("explain_estimator", bundle["estimator"])
    if not hasattr(estimator, "named_steps") or "classifier" not in estimator.named_steps:
        return [""] * len(selected)
    if not hasattr(estimator.named_steps["classifier"], "coef_"):
        return [""] * len(selected)
    frame = _candidate_frame([item[1] for item in selected], "")
    transformed = estimator.named_steps["features"].transform(frame).tocsr()
    names = estimator.named_steps["features"].get_feature_names_out()
    classes = list(estimator.classes_)
    classifier = estimator.named_steps["classifier"]
    explanations = []
    for row_index, (role, candidate, _) in enumerate(selected):
        if role not in classes:
            explanations.append("")
            continue
        class_index = classes.index(role)
        if classifier.coef_.shape[0] == 1:
            coef = classifier.coef_[0] * (1 if class_index == 1 else -1)
        else:
            coef = classifier.coef_[class_index]
        row = transformed.getrow(row_index)
        contributions = []
        for index, value in zip(row.indices, row.data):
            name = str(names[index])
            if not name.startswith("text_"):
                continue
            context = next((column for column in ("ctx_left", "ctx_above", "ctx_right", "line_text")
                            if name.startswith(f"text_{column}__")), None)
            if context is None or not str(candidate.get(context, "") or "").strip():
                continue
            feature = name.split("__", 1)[-1]
            if feature != "m2emptytoken" and any(char.isalpha() for char in feature):
                contribution = float(coef[index] * value)
                if contribution > 0:
                    contributions.append((contribution, feature))
        terms = [term.replace("_", " ") for _, term in sorted(contributions, reverse=True)[:3]]
        explanations.append("Context evidence: " + ", ".join(terms) if terms else "")
    return explanations


def _bbox(candidate: dict[str, Any]) -> list[float]:
    bbox = candidate.get("bbox")
    if bbox is None:
        bbox = [candidate.get("x0", 0), candidate.get("y0", 0),
                candidate.get("x1", 0), candidate.get("y1", 0)]
    return [float(value) for value in bbox]


def _prediction(candidate: dict[str, Any], confidence: float, model_version: str,
                why: str) -> dict[str, Any]:
    return {
        "value": str(candidate.get("value", "") or ""),
        "display": str(candidate.get("text", "") or ""),
        "confidence": float(confidence),
        "zone": C.zone_for(float(confidence)),
        "page": int(candidate.get("page", 0)),
        "bbox": _bbox(candidate),
        "ambiguous": bool(int(candidate.get("ambiguous", 0) or 0)),
        "needs_confirmation": True,
        "ai_suggested": True,
        "candidate_id": int(candidate.get("cand_id", -1)),
        "model_version": model_version,
        "blank_reason": "",
        "why": why,
    }


def _has_valid_to_context(candidate: dict[str, Any]) -> bool:
    local_context = " ".join(
        str(candidate.get(column, "") or "")
        for column in ("ctx_left", "ctx_right", "line_text")
    )
    above_context = str(candidate.get("ctx_above", "") or "")

    def matches(context: str) -> bool:
        normalized = context.replace("va1id", "valid").replace("volid", "valid")
        normalized = normalized.replace("valld", "valid").replace("cxpiry", "expiry")
        return bool(_VALID_TO_CONTEXT.search(normalized))

    if matches(local_context):
        return True
    unrelated_labels = re.compile(
        r"\b(?:printed on|date of birth|date of possession|stamp paper|"
        r"rent revision|last date|application received|date of notice)\b",
        re.IGNORECASE,
    )
    return matches(above_context) and not unrelated_labels.search(local_context)


def _ambiguous_role_hint(candidate: dict[str, Any]) -> str | None:
    context = str(candidate.get("ctx_left", "") or "")
    if _VALID_TO_CONTEXT.search(context):
        return "valid_to"
    if _ISSUE_DATE_CONTEXT.search(context):
        return "issue_date"
    return None


def predict_fields(candidates: list[dict[str, Any]], doc_type: str) -> dict[str, dict[str, Any]]:
    """Return all four AI-suggested fields; callers must retain the human-confirmation safeguard."""
    return _predict_many_with_model({"0": (doc_type, candidates)}, _load_model())["0"]


def _predict_many_with_model(
    documents: dict[str, tuple[str, list[dict[str, Any]]]],
    model: dict[str, Any],
) -> dict[str, dict[str, dict[str, Any]]]:
    version = str(model["model_version"])
    results = {
        doc_id: {field: _blank("no candidate found", version) for field in FIELDS}
        for doc_id in documents
    }
    candidates_by_kind: dict[str, list[tuple[str, dict[str, Any]]]] = {
        kind: [] for kind in C.KIND_ROLES
    }
    selected_by_doc: dict[str, dict[str, tuple[str, dict[str, Any], float]]] = {
        doc_id: {} for doc_id in documents
    }
    ambiguous_by_doc: dict[str, dict[str, tuple[float, dict[str, Any]]]] = {}
    ambiguous_counts: dict[str, int] = {}
    ambiguous_fallback: dict[str, dict[str, Any]] = {}
    for doc_id, (doc_type, candidates) in documents.items():
        normalized_type = doc_type if doc_type in C.DOC_TYPES else "other"
        for item in candidates:
            candidate = dict(item)
            candidate.setdefault("doc_type", normalized_type)
            kind = str(candidate.get("kind", ""))
            if kind in candidates_by_kind:
                candidates_by_kind[kind].append((doc_id, candidate))

    for kind, role_names in C.KIND_ROLES.items():
        kind_rows = candidates_by_kind[kind]
        if not kind_rows:
            continue
        kind_candidates = [item for _, item in kind_rows]
        bundle = model["models"][kind]
        estimator = bundle["estimator"]
        frame = _candidate_frame(kind_candidates, "")
        probabilities = bundle["calibrator"].predict_proba(estimator, frame)
        classes = list(bundle["calibrator"].classes_)
        indexes_by_doc: dict[str, list[int]] = {}
        for index, (doc_id, _) in enumerate(kind_rows):
            indexes_by_doc.setdefault(doc_id, []).append(index)
        if kind == "date":
            for index, (doc_id, candidate) in enumerate(kind_rows):
                if not int(candidate.get("ambiguous", 0) or 0):
                    continue
                ambiguous_counts[doc_id] = ambiguous_counts.get(doc_id, 0) + 1
                ambiguous_fallback.setdefault(doc_id, candidate)
                hinted_role = _ambiguous_role_hint(candidate)
                if hinted_role is not None:
                    ambiguous_by_doc.setdefault(doc_id, {})[hinted_role] = (1.0, candidate)
                    continue
                for role in ("issue_date", "valid_to"):
                    confidence = float(probabilities[index, classes.index(role)])
                    if confidence < 0.10:
                        continue
                    existing = ambiguous_by_doc.setdefault(doc_id, {}).get(role)
                    if existing is None or confidence > existing[0]:
                        ambiguous_by_doc[doc_id][role] = (confidence, candidate)
        for doc_id, indexes in indexes_by_doc.items():
            for role in role_names:
                if role == "none" or role not in FIELDS or role not in classes:
                    continue
                column = classes.index(role)
                ranked = sorted(
                    ((float(probabilities[index, column]), kind_candidates[index]) for index in indexes),
                    key=lambda entry: (-entry[0], int(entry[1].get("cand_id", -1))),
                )
                if not ranked:
                    continue
                best_probability, best_candidate = ranked[0]
                runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
                confidence = min(best_probability, 0.89) if best_probability - runner_up < 0.15 else best_probability
                selected_by_doc[doc_id][role] = (kind, best_candidate, confidence)

    for doc_id, roles in ambiguous_by_doc.items():
        for role, (_, candidate) in roles.items():
            selected_by_doc[doc_id][role] = ("date", candidate, 0.0)
    for doc_id, count in ambiguous_counts.items():
        if count >= 2:
            candidate = ambiguous_fallback[doc_id]
            selected_by_doc[doc_id]["issue_date"] = ("date", candidate, 0.0)
            selected_by_doc[doc_id]["valid_to"] = ("date", candidate, 0.0)

    explanations_by_doc: dict[str, dict[str, str]] = {doc_id: {} for doc_id in documents}
    for kind in C.KIND_ROLES:
        explain_rows = []
        for doc_id, role_selections in selected_by_doc.items():
            for role, (field_kind, candidate, confidence) in role_selections.items():
                if field_kind == kind and confidence >= 0.60 and not int(candidate.get("ambiguous", 0) or 0):
                    doc_type = documents[doc_id][0]
                    normalized_type = doc_type if doc_type in C.DOC_TYPES else "other"
                    candidate = dict(candidate)
                    candidate.setdefault("doc_type", normalized_type)
                    explain_rows.append((doc_id, role, candidate, normalized_type))
        explanations = _why_many(
            model, kind, [(role, candidate, doc_type) for _, role, candidate, doc_type in explain_rows]
        )
        for (doc_id, role, _, _), explanation in zip(explain_rows, explanations):
            explanations_by_doc[doc_id][role] = explanation

    for doc_id, role_selections in selected_by_doc.items():
        for role, (kind, candidate, confidence) in role_selections.items():
            if int(candidate.get("ambiguous", 0) or 0):
                results[doc_id][role] = _blank("ambiguous_date", version, ambiguous=True)
            elif confidence < 0.60:
                results[doc_id][role] = _blank("confidence_below_threshold", version)
            elif role == "valid_to" and not _has_valid_to_context(candidate):
                results[doc_id][role] = _blank("no_validity_context", version)
            else:
                results[doc_id][role] = _prediction(
                    candidate, confidence, version, explanations_by_doc[doc_id].get(role, "")
                )
        issue = results[doc_id]["issue_date"]
        valid = results[doc_id]["valid_to"]
        if issue["value"] and valid["value"] and issue["value"] >= valid["value"]:
            lower = "issue_date" if issue["confidence"] <= valid["confidence"] else "valid_to"
            results[doc_id][lower] = _blank("date_order_check_failed", version)
    return results


def predict_many(documents: dict[str, tuple[str, list[dict[str, Any]]]]) -> dict[str, dict[str, dict[str, Any]]]:
    """Batch inference helper used by evaluation to share sparse transforms across documents."""
    return _predict_many_with_model(documents, _load_model())
