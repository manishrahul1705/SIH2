#!/usr/bin/env python3
"""Train the local, explainable ApprovalTrack M3 lease-candidate ranker."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import joblib
import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.decomposition import TruncatedSVD
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import OneHotEncoder, StandardScaler

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATASET = ROOT / "dataset"
MODEL_PATH = HERE / "m3_model.joblib"
MODEL_VERSION = "m3-1.0.0"
SEED = 2026
LABELS = ("lease_start", "lease_end", "term_value", "other")
TEXT_FIELDS = ("left_ctx", "right_ctx")
NUMERIC_FEATURES = (
    "page", "n_pages", "rel_pos", "date_order", "n_dates",
    "date_chrono_rank", "term_order", "n_terms", "term_months",
    "ambiguous", "line_no",
)
POSITION_FEATURES = {
    "page", "n_pages", "rel_pos", "date_order", "n_dates",
    "date_chrono_rank", "term_order", "n_terms", "line_no",
}
FEATURE_LIST = (*TEXT_FIELDS, "kind", *NUMERIC_FEATURES)
sys.modules.setdefault("m3_train", sys.modules[__name__])


def _contexts(frame: pd.DataFrame, field: str) -> list[str]:
    from m3_common import normalize_m3

    return [normalize_m3(value) for value in frame[field].fillna("").astype(str)]


class FeatureBuilder:
    """Train-only text/categorical/numeric transformer shared by training and inference."""

    def __init__(
        self,
        include_context: bool = True,
        include_numeric: bool = True,
        include_position: bool = True,
    ) -> None:
        self.include_context = include_context
        self.include_numeric = include_numeric
        self.include_position = include_position
        self.vectorizers: dict[str, TfidfVectorizer] = {}
        self.encoder: OneHotEncoder | None = None
        self.scaler: StandardScaler | None = None
        self.numeric_fields: list[str] = []
        self.fitted = False

    def fit(self, frame: pd.DataFrame) -> "FeatureBuilder":
        if self.include_context:
            for field in TEXT_FIELDS:
                vectorizer = TfidfVectorizer(
                    ngram_range=(1, 3),
                    min_df=2,
                    max_features=50000,
                    sublinear_tf=True,
                    token_pattern=r"(?u)\b\w+\b",
                    dtype=np.float32,
                )
                vectorizer.fit(_contexts(frame, field))
                self.vectorizers[field] = vectorizer

        self.encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=True)
        self.encoder.fit(frame[["kind"]].fillna("").astype(str))

        selected = [
            field for field in NUMERIC_FEATURES
            if self.include_numeric and (self.include_position or field not in POSITION_FEATURES)
        ]
        self.numeric_fields = selected
        if selected:
            values = frame[selected].apply(pd.to_numeric, errors="coerce").fillna(0.0)
            self.scaler = StandardScaler(with_mean=False)
            self.scaler.fit(values)
        self.fitted = True
        return self

    def transform(self, frame: pd.DataFrame) -> sparse.csr_matrix:
        if not self.fitted or self.encoder is None:
            raise RuntimeError("FeatureBuilder must be fitted on training data before transform")
        blocks: list[sparse.spmatrix] = []
        if self.include_context:
            for field in TEXT_FIELDS:
                blocks.append(self.vectorizers[field].transform(_contexts(frame, field)))
        blocks.append(self.encoder.transform(frame[["kind"]].fillna("").astype(str)))
        if self.numeric_fields:
            if self.scaler is None:
                raise RuntimeError("Numeric scaler was not fitted")
            values = frame[self.numeric_fields].apply(pd.to_numeric, errors="coerce").fillna(0.0)
            blocks.append(sparse.csr_matrix(self.scaler.transform(values)))
        return sparse.hstack(blocks, format="csr", dtype=np.float32)

    def context_feature_names(self) -> list[str]:
        names: list[str] = []
        for field in TEXT_FIELDS:
            vectorizer = self.vectorizers.get(field)
            if vectorizer:
                names.extend(f"{field}::{term}" for term in vectorizer.get_feature_names_out())
        return names


FeatureBuilder.__module__ = "m3_train"


def _balanced_weights(labels: np.ndarray) -> np.ndarray:
    classes, counts = np.unique(labels, return_counts=True)
    weights = {label: len(labels) / (len(classes) * count) for label, count in zip(classes, counts)}
    return np.asarray([weights[label] for label in labels], dtype=np.float64)


def _grouped_model_selection(
    matrix: sparse.csr_matrix,
    labels: np.ndarray,
    groups: np.ndarray,
    folds: int = 5,
) -> tuple[str, dict[str, Any], dict[str, float]]:
    group_count = len(np.unique(groups))
    n_splits = min(folds, group_count)
    if n_splits < 2:
        raise ValueError("At least two training layouts are required for grouped model selection")

    sample_limit = 400
    sampled_indices = (
        pd.DataFrame({"index": np.arange(len(labels)), "label": labels, "group": groups})
        .groupby(["group", "label"], group_keys=False, sort=True)
        .apply(lambda part: part.sample(n=min(sample_limit, len(part)), random_state=SEED),
               include_groups=False)["index"]
        .to_numpy(dtype=int)
    )
    cv_matrix = matrix[sampled_indices]
    cv_labels = labels[sampled_indices]
    cv_groups = groups[sampled_indices]
    svd = TruncatedSVD(n_components=min(20, cv_matrix.shape[1] - 1), n_iter=2, random_state=SEED)
    dense = svd.fit_transform(cv_matrix).astype(np.float32)
    choices: dict[str, tuple[Any, dict[str, Any]]] = {
        "LogisticRegression": (
            lambda: LogisticRegression(
                C=1.0, class_weight="balanced", max_iter=100, solver="saga",
                tol=1e-3, random_state=SEED,
            ),
            {"C": 1.0, "class_weight": "balanced", "max_iter": 100,
             "solver": "saga", "tol": 1e-3},
        ),
        "HistGradientBoostingClassifier": (
            lambda: HistGradientBoostingClassifier(
                learning_rate=0.1, max_iter=35, max_leaf_nodes=15,
                min_samples_leaf=30, l2_regularization=1.0,
                early_stopping=False, random_state=SEED,
            ),
            {"learning_rate": 0.1, "max_iter": 35, "max_leaf_nodes": 15,
             "min_samples_leaf": 30, "l2_regularization": 1.0, "early_stopping": False},
        ),
    }
    results: dict[str, float] = {}
    splitter = GroupKFold(n_splits=n_splits)
    for name, (factory, _params) in choices.items():
        fold_scores = []
        for train_idx, val_idx in splitter.split(cv_matrix, cv_labels, cv_groups):
            model = factory()
            train_x = cv_matrix[train_idx] if name == "LogisticRegression" else dense[train_idx]
            val_x = cv_matrix[val_idx] if name == "LogisticRegression" else dense[val_idx]
            sample_weight = _balanced_weights(cv_labels[train_idx])
            model.fit(train_x, cv_labels[train_idx], sample_weight=sample_weight)
            prediction = model.predict(val_x)
            fold_scores.append(
                f1_score(cv_labels[val_idx], prediction, labels=list(LABELS),
                         average="macro", zero_division=0)
            )
        results[name] = float(np.mean(fold_scores))

    selected = max(results, key=results.get)
    return selected, choices[selected][1], results


def _sha256_files(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode("utf-8"))
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def _verify_shared_finder(candidate_frame: pd.DataFrame, page_csv: Path) -> int:
    """Check that the only production candidate finder reproduces training candidates."""
    from m3_common import find_lease_candidates

    pages = pd.read_csv(page_csv, keep_default_na=False)
    expected: dict[str, list[dict[str, Any]]] = {
        doc_id: group.sort_values("cand_id").to_dict("records")
        for doc_id, group in candidate_frame.groupby("doc_id", sort=False)
    }
    checked = 0
    for doc_id, group in pages.groupby("doc_id", sort=False):
        page_values = [
            {"page": int(row.page), "text": row.text}
            for row in group.sort_values("page").itertuples(index=False)
        ]
        actual = find_lease_candidates(page_values)
        records = expected.get(doc_id, [])
        if len(actual) != len(records):
            raise ValueError(
                f"Shared finder candidate count mismatch for {doc_id}: "
                f"{len(actual)} != {len(records)}"
            )
        for found, row in zip(actual, records):
            if (str(found["cand_id"]) != str(row["cand_id"])
                    or str(found["kind"]) != str(row["kind"])
                    or str(found["value"]) != str(row["value"])
                    or found["left_ctx"] != row["left_ctx"]
                    or found["right_ctx"] != row["right_ctx"]):
                raise ValueError(f"Shared finder mismatch for {doc_id}/{row['cand_id']}")
        checked += 1
    if checked != candidate_frame["doc_id"].nunique():
        raise ValueError("Candidate CSV and page CSV contain different document sets")
    return checked


def _fit_sigmoid_calibrators(model: Any, model_input: Any, labels: np.ndarray) -> list[LogisticRegression]:
    probabilities = model.predict_proba(model_input)
    calibrators = []
    for column, label in enumerate(model.classes_):
        raw = np.clip(probabilities[:, column], 1e-6, 1 - 1e-6)
        logits = np.log(raw / (1 - raw)).reshape(-1, 1)
        calibrator = LogisticRegression(C=1.0, solver="lbfgs", max_iter=200, random_state=SEED)
        calibrator.fit(logits, (labels == label).astype(int))
        calibrators.append(calibrator)
    return calibrators


def _calibrate(model: Any, calibrators: list[LogisticRegression], model_input: Any) -> np.ndarray:
    probabilities = model.predict_proba(model_input)
    output = np.empty_like(probabilities, dtype=np.float64)
    for column, calibrator in enumerate(calibrators):
        raw = np.clip(probabilities[:, column], 1e-6, 1 - 1e-6)
        logits = np.log(raw / (1 - raw)).reshape(-1, 1)
        output[:, column] = calibrator.predict_proba(logits)[:, 1]
    totals = output.sum(axis=1, keepdims=True)
    return output / np.maximum(totals, 1e-12)


def train(data_dir: Path = DATASET, output_path: Path = MODEL_PATH) -> dict[str, Any]:
    train_csv = data_dir / "m3_candidates_train.csv"
    val_csv = data_dir / "m3_candidates_val.csv"
    pages_csv = data_dir / "m3_pages_train.csv"
    required = [train_csv, val_csv, pages_csv]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing training input(s): {', '.join(missing)}")

    train_frame = pd.read_csv(train_csv, keep_default_na=False)
    val_frame = pd.read_csv(val_csv, keep_default_na=False)
    if not set(train_frame["role"]).issubset(LABELS):
        raise ValueError("Unexpected M3 candidate role labels")
    checked_docs = _verify_shared_finder(train_frame, pages_csv)

    builder = FeatureBuilder().fit(train_frame)
    train_x = builder.transform(train_frame)
    val_x = builder.transform(val_frame)
    y_train = train_frame["role"].astype(str).to_numpy()
    y_val = val_frame["role"].astype(str).to_numpy()
    selected, hyperparameters, cv_scores = _grouped_model_selection(
        train_x, y_train, train_frame["layout_id"].to_numpy()
    )
    if selected == "LogisticRegression":
        model = LogisticRegression(
            C=hyperparameters["C"], class_weight="balanced",
            max_iter=hyperparameters["max_iter"], solver=hyperparameters["solver"],
            tol=hyperparameters["tol"],
            random_state=SEED,
        )
        model_input_train = train_x
        model_input_val = val_x
        svd = None
    else:
        svd = TruncatedSVD(n_components=min(20, train_x.shape[1] - 1), n_iter=2,
                           random_state=SEED)
        model_input_train = svd.fit_transform(train_x).astype(np.float32)
        model_input_val = svd.transform(val_x).astype(np.float32)
        model = HistGradientBoostingClassifier(**hyperparameters, random_state=SEED)
    model.fit(model_input_train, y_train, sample_weight=_balanced_weights(y_train))
    calibrators = _fit_sigmoid_calibrators(model, model_input_val, y_val)
    val_probabilities = _calibrate(model, calibrators, model_input_val)
    val_prediction = np.asarray(model.classes_)[val_probabilities.argmax(axis=1)]
    val_macro_f1 = f1_score(y_val, val_prediction, labels=list(LABELS), average="macro", zero_division=0)

    files_for_hash = [
        data_dir / "m3_candidates_train.csv",
        data_dir / "m3_documents_train.csv",
        data_dir / "m3_pages_train.csv",
    ]
    report_path = data_dir / "m3_dataset_report.json"
    report_hash = hashlib.sha256(report_path.read_bytes()).hexdigest() if report_path.exists() else ""
    bundle = {
        "model_version": MODEL_VERSION,
        "training_date_utc": datetime.now(timezone.utc).date().isoformat(),
        "training_csv_sha256": _sha256_files(files_for_hash),
        "dataset_report_sha256": report_hash,
        "seed": SEED,
        "algorithm": selected,
        "hyperparameters": hyperparameters,
        "grouped_cv_macro_f1": cv_scores,
        "validation_macro_f1": float(val_macro_f1),
        "feature_list": list(FEATURE_LIST),
        "labels": list(model.classes_),
        "feature_builder": builder,
        "model": model,
        "svd": svd,
        "calibrators": calibrators,
        "shared_finder_train_docs_verified": checked_docs,
        "calibration": "one-vs-rest sigmoid (Platt) fitted on validation layouts",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, output_path, compress=3)
    return {
        "model_path": str(output_path),
        "model_version": MODEL_VERSION,
        "algorithm": selected,
        "hyperparameters": hyperparameters,
        "grouped_cv_macro_f1": cv_scores,
        "validation_macro_f1": float(val_macro_f1),
        "training_csv_sha256": bundle["training_csv_sha256"],
        "dataset_report_sha256": report_hash,
        "shared_finder_train_docs_verified": checked_docs,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATASET)
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    args = parser.parse_args()
    print(json.dumps(train(args.data_dir, args.output), indent=2))


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
