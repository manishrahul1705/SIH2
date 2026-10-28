"""Shared, local-only training and evaluation helpers for ApprovalTrack M2."""

from __future__ import annotations

import os
import sys
from collections import defaultdict
from typing import Any

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import TruncatedSVD
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = os.path.dirname(os.path.abspath(__file__))
OCR_DIR = os.path.join(ROOT, "ocr")
if OCR_DIR not in sys.path:
    sys.path.insert(0, OCR_DIR)

import m2_common as C

DATA_DIR = os.path.join(ROOT, "dataset")
MODEL_PATH = os.path.join(ROOT, "m2_model.joblib")
SEED = 2026
MODEL_VERSION = "m2-1.0.0"
KINDS = ("date", "number", "issuer")
CONTEXT_COLUMNS = ("ctx_left", "ctx_above", "ctx_right", "line_text")
POSITION_COLUMNS = ("page", "page_frac", "line_idx", "n_lines_page", "x0", "y0",
                    "x1", "y1", "date_rank", "n_dates")
EXTREMA_COLUMNS = ("is_earliest_date", "is_latest_date")


def read_csv(name: str) -> pd.DataFrame:
    return pd.read_csv(os.path.join(DATA_DIR, name), keep_default_na=False)


def load_split(split: str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    return (
        read_csv(f"m2_candidates_{split}.csv"),
        read_csv(f"m2_documents_{split}.csv"),
        read_csv(f"m2_words_{split}.csv"),
    )


def csv_candidate_rows(candidate_rows: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert the generator's shared-finder candidate CSV into inference-shaped dictionaries."""
    rows = candidate_rows.to_dict("records")
    for row in rows:
        row["doc_id"] = str(row["doc_id"])
        row["layout_id"] = str(row["layout_id"])
        row["cand_id"] = int(row["cand_id"])
        row["page"] = int(row["page"])
        row["word_idx"] = [int(value) for value in str(row["word_idx"]).split()]
        row["bbox"] = [_number(row[name]) for name in ("x0", "y0", "x1", "y1")]
    return rows


def verify_candidate_source(words: pd.DataFrame, candidate_rows: pd.DataFrame) -> int:
    """Re-run find_candidates on one document per layout and check CSV parity."""
    sample_ids = (
        candidate_rows.sort_values(["layout_id", "doc_id", "cand_id"], kind="stable")
        .groupby("layout_id", sort=True)["doc_id"].first().astype(str).tolist()
    )
    selected = set(sample_ids)
    sample_words = words[words["doc_id"].astype(str).isin(selected)]
    sample_candidates = candidate_rows[candidate_rows["doc_id"].astype(str).isin(selected)]
    found = reconstruct_candidates(sample_words, sample_candidates)
    by_document: dict[str, list[dict[str, Any]]] = defaultdict(list)
    source_by_document: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in found:
        by_document[str(row["doc_id"])].append(row)
    for row in csv_candidate_rows(sample_candidates):
        source_by_document[str(row["doc_id"])].append(row)
    for doc_id in sample_ids:
        actual = by_document.get(doc_id, [])
        expected = sorted(source_by_document.get(doc_id, []), key=lambda row: row["cand_id"])
        if len(actual) != len(expected):
            raise ValueError(f"Shared candidate finder count mismatch for {doc_id}")
        for generated, source in zip(actual, expected):
            for key in ("cand_id", "kind", "text", "value", "fmt", "page", "word_idx"):
                if generated[key] != source[key]:
                    raise ValueError(f"Shared candidate finder mismatch for {doc_id} field {key}")
    return len(sample_ids)


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def candidate_frame(candidates: list[dict[str, Any]], doc_type: str | None = None,
                    ablation: str | None = None) -> pd.DataFrame:
    rows = []
    for candidate in candidates:
        row = {}
        for column in CONTEXT_COLUMNS:
            if ablation == "drop_ctx_above" and column == "ctx_above":
                continue
            row[column] = C.normalize_m2(str(candidate.get(column, "") or "")) or "m2emptytoken"
        row["doc_type"] = str(doc_type or candidate.get("doc_type", "other") or "other")
        row["fmt"] = str(candidate.get("fmt", "") or "")
        for column in C.NUMERIC_FEATURES:
            if ablation == "drop_position" and column in POSITION_COLUMNS:
                continue
            if ablation == "drop_date_extrema" and column in EXTREMA_COLUMNS:
                continue
            row[column] = _number(candidate.get(column, 0))
        if ablation == "drop_doc_type":
            row.pop("doc_type", None)
        rows.append(row)
    return pd.DataFrame(rows)


def build_pipeline(algorithm: str, text_variant: str, ablation: str | None = None) -> Pipeline:
    transformers = []
    for column in CONTEXT_COLUMNS:
        if ablation == "drop_ctx_above" and column == "ctx_above":
            continue
        vectorizer = TfidfVectorizer(
            analyzer="word" if text_variant == "word" else "char_wb",
            ngram_range=(1, 2) if text_variant == "word" else (2, 4),
            min_df=2,
            max_features=5000,
            sublinear_tf=True,
            dtype=np.float32,
        )
        transformers.append((f"text_{column}", vectorizer, column))

    categorical = ["fmt"]
    if ablation != "drop_doc_type":
        categorical.append("doc_type")
    transformers.append(("categorical", OneHotEncoder(handle_unknown="ignore"), categorical))

    numeric = [
        column for column in C.NUMERIC_FEATURES
        if not (ablation == "drop_position" and column in POSITION_COLUMNS)
        and not (ablation == "drop_date_extrema" and column in EXTREMA_COLUMNS)
    ]
    transformers.append(("numeric", StandardScaler(with_mean=False), numeric))

    features = ColumnTransformer(transformers, remainder="drop", sparse_threshold=0.25)
    if algorithm == "logistic":
        classifier = LogisticRegression(
            C=0.5, class_weight="balanced", max_iter=150, random_state=SEED,
            solver="saga", tol=0.01,
        )
        return Pipeline([("features", features), ("classifier", classifier)])
    if algorithm == "hist_gradient_boosting":
        classifier = HistGradientBoostingClassifier(
            max_iter=80, max_leaf_nodes=15, l2_regularization=1.0,
            learning_rate=0.12, random_state=SEED, early_stopping=False,
        )
        return Pipeline([
            ("features", features),
            ("svd", TruncatedSVD(n_components=24, random_state=SEED)),
            ("classifier", classifier),
        ])
    raise ValueError(f"Unknown M2 algorithm: {algorithm}")


class PlattCalibrator:
    """One-vs-rest sigmoid calibration fitted only on held-out validation layouts."""

    def __init__(self) -> None:
        self.classes_: np.ndarray | None = None
        self.models: list[LogisticRegression] = []

    @staticmethod
    def _scores(model: Pipeline, X: pd.DataFrame) -> np.ndarray:
        if hasattr(model, "decision_function"):
            result = np.asarray(model.decision_function(X))
            if result.ndim == 1:
                result = np.column_stack((-result, result))
            return result
        return np.log(np.clip(model.predict_proba(X), 1e-6, 1.0))

    def fit(self, model: Pipeline, X: pd.DataFrame, y: np.ndarray) -> "PlattCalibrator":
        self.classes_ = np.asarray(model.classes_)
        scores = self._scores(model, X)
        self.models = []
        for index, label in enumerate(self.classes_):
            binary_y = (y == label).astype(int)
            if len(np.unique(binary_y)) != 2:
                raise ValueError(f"Calibration split lacks both sides of class {label!r}")
            calibrator = LogisticRegression(C=1e3, solver="lbfgs", random_state=SEED)
            calibrator.fit(scores[:, index].reshape(-1, 1), binary_y)
            self.models.append(calibrator)
        return self

    def predict_proba(self, model: Pipeline, X: pd.DataFrame) -> np.ndarray:
        if self.classes_ is None or not self.models:
            raise RuntimeError("M2 probability calibrator has not been fitted")
        scores = self._scores(model, X)
        columns = [
            calibrator.predict_proba(scores[:, index].reshape(-1, 1))[:, 1]
            for index, calibrator in enumerate(self.models)
        ]
        result = np.column_stack(columns)
        result /= np.clip(result.sum(axis=1, keepdims=True), 1e-12, None)
        return result


def reconstruct_candidates(words: pd.DataFrame, candidate_rows: pd.DataFrame) -> list[dict[str, Any]]:
    """Call the shared finder for each source document and attach dataset labels by candidate id."""
    labels: dict[str, dict[int, str]] = defaultdict(dict)
    for row in candidate_rows[["doc_id", "cand_id", "label"]].itertuples(index=False):
        labels[str(row.doc_id)][int(row.cand_id)] = str(row.label)

    reconstructed: list[dict[str, Any]] = []
    grouped = words.groupby("doc_id", sort=False)
    for doc_id, group in grouped:
        group = group.sort_values(["page", "word_idx"], kind="stable")
        pages = []
        for page_no, page_words in group.groupby("page", sort=True):
            page_words = page_words.sort_values("word_idx", kind="stable")
            pages.append({
                "page": int(page_no), "width": 1.0, "height": 1.0,
                "words": [{
                    "text": str(row.text),
                    "bbox": [_number(row.x0), _number(row.y0), _number(row.x1), _number(row.y1)],
                    "conf": _number(row.conf),
                } for row in page_words.itertuples(index=False)],
            })
        doc_type = str(group.iloc[0]["doc_type"])
        found = C.find_candidates(pages, doc_type)
        expected = labels[str(doc_id)]
        if len(found) != len(expected):
            raise ValueError(f"Shared candidate finder mismatch for {doc_id}: {len(found)} != {len(expected)}")
        for candidate in found:
            candidate_id = int(candidate["cand_id"])
            if candidate_id not in expected:
                raise ValueError(f"Candidate id {candidate_id} missing from labels for {doc_id}")
            candidate["label"] = expected[candidate_id]
            candidate["doc_id"] = str(doc_id)
            candidate["layout_id"] = str(group.iloc[0]["layout_id"])
            reconstructed.append(candidate)
    if len(reconstructed) != len(candidate_rows):
        raise ValueError(f"Reconstructed {len(reconstructed)} candidates, expected {len(candidate_rows)}")
    return reconstructed


def balanced_sample_weights(y: np.ndarray) -> np.ndarray:
    classes, counts = np.unique(y, return_counts=True)
    weights = {label: len(y) / (len(classes) * count) for label, count in zip(classes, counts)}
    return np.asarray([weights[label] for label in y], dtype=np.float64)


def fit_pipeline(model: Pipeline, X: pd.DataFrame, y: np.ndarray) -> Pipeline:
    if "svd" in model.named_steps:
        model.fit(X, y, classifier__sample_weight=balanced_sample_weights(y))
    else:
        model.fit(X, y)
    return model


def layout_validation_score(model: Pipeline, X: pd.DataFrame, y: np.ndarray,
                            layout_ids: np.ndarray) -> tuple[float, dict[str, float]]:
    from sklearn.metrics import f1_score

    predictions = model.predict(X)
    group_scores = {}
    for layout in sorted(set(layout_ids)):
        mask = layout_ids == layout
        group_scores[str(layout)] = float(f1_score(y[mask], predictions[mask], average="macro", zero_division=0))
    return float(np.mean(list(group_scores.values()))) if group_scores else 0.0, group_scores
