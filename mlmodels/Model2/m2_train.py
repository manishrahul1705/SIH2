#!/usr/bin/env python3
"""Train M2 locally from the synthetic candidate and OCR-word CSVs."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone

import joblib
import numpy as np
from sklearn.metrics import f1_score

from m2_modeling import (
    DATA_DIR,
    KINDS,
    MODEL_PATH,
    MODEL_VERSION,
    SEED,
    PlattCalibrator,
    build_pipeline,
    candidate_frame,
    csv_candidate_rows,
    fit_pipeline,
    layout_validation_score,
    load_split,
    verify_candidate_source,
)


ALGORITHMS = ("logistic", "hist_gradient_boosting")
TEXT_VARIANTS = ("word", "char")


def _kind_frame(rows: list[dict], kind: str, doc_type: str | None = None,
                ablation: str | None = None):
    chosen = [row for row in rows if row["kind"] == kind]
    return chosen, candidate_frame(chosen, doc_type, ablation)


def _select_calibration_layouts(documents):
    selected = set()
    for _, group in documents.groupby("doc_type", sort=True):
        selected.add(sorted(set(group["layout_id"].astype(str)))[-1])
    return selected


def train_model() -> dict:
    train_csv, train_docs, train_words = load_split("train")
    val_csv, val_docs, val_words = load_split("val")

    train_layout_checks = verify_candidate_source(train_words, train_csv)
    val_layout_checks = verify_candidate_source(val_words, val_csv)
    train_rows = csv_candidate_rows(train_csv)
    val_rows = csv_candidate_rows(val_csv)
    calibration_layouts = _select_calibration_layouts(val_docs)

    trained = {}
    selection_report = {}
    for kind in KINDS:
        train_kind, X_train = _kind_frame(train_rows, kind)
        val_kind, X_val = _kind_frame(val_rows, kind)
        y_train = np.asarray([row["label"] for row in train_kind], dtype=str)
        y_val = np.asarray([row["label"] for row in val_kind], dtype=str)
        layout_ids = np.asarray([row["layout_id"] for row in val_kind], dtype=str)
        calibration_mask = np.isin(layout_ids, list(calibration_layouts))
        tune_mask = ~calibration_mask
        if not calibration_mask.any() or not tune_mask.any():
            raise ValueError(f"Validation calibration/tuning partition is empty for {kind}")

        candidates = []
        for algorithm in ALGORITHMS:
            for text_variant in TEXT_VARIANTS:
                estimator = build_pipeline(algorithm, text_variant)
                fit_pipeline(estimator, X_train, y_train)
                tune_score, per_layout = layout_validation_score(
                    estimator, X_val.loc[tune_mask].reset_index(drop=True),
                    y_val[tune_mask], layout_ids[tune_mask],
                )
                candidates.append({
                    "estimator": estimator,
                    "algorithm": algorithm,
                    "text_variant": text_variant,
                    "validation_macro_f1": tune_score,
                    "validation_layout_scores": per_layout,
                })
        best = max(
            candidates,
            key=lambda item: (item["validation_macro_f1"], -ALGORITHMS.index(item["algorithm"]),
                              -TEXT_VARIANTS.index(item["text_variant"])),
        )
        calib = PlattCalibrator().fit(
            best["estimator"],
            X_val.loc[calibration_mask].reset_index(drop=True),
            y_val[calibration_mask],
        )
        trained[kind] = {
            "estimator": best["estimator"],
            "explain_estimator": (
                best["estimator"]
                if best["algorithm"] == "logistic" and best["text_variant"] == "word" else
                fit_pipeline(
                    build_pipeline("logistic", "word"),
                    X_train, y_train,
                )
            ),
            "explanation_text_variant": "word",
            "calibrator": calib,
            "algorithm": best["algorithm"],
            "text_variant": best["text_variant"],
            "classes": [str(label) for label in best["estimator"].classes_],
        }
        selection_report[kind] = {
            "selected_algorithm": best["algorithm"],
            "selected_text_variant": best["text_variant"],
            "layout_grouped_validation_macro_f1": best["validation_macro_f1"],
            "layout_scores": best["validation_layout_scores"],
            "calibration_layouts": sorted(calibration_layouts),
            "candidate_comparison": [{
                "algorithm": item["algorithm"],
                "text_variant": item["text_variant"],
                "layout_grouped_validation_macro_f1": item["validation_macro_f1"],
                "layout_scores": item["validation_layout_scores"],
            } for item in candidates],
        }
        print(f"{kind}: {best['algorithm']} / {best['text_variant']} "
              f"(grouped val macro-F1={best['validation_macro_f1']:.4f})", flush=True)

    with open(os.path.join(DATA_DIR, "m2_dataset_report.json"), "rb") as stream:
        report_hash = hashlib.sha256(stream.read()).hexdigest()

    package = {
        "model_version": MODEL_VERSION,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset_report_sha256": report_hash,
        "seed": SEED,
        "features": {
            "contexts": ["ctx_left", "ctx_above", "ctx_right", "line_text"],
            "categorical": ["doc_type", "fmt"],
            "numeric": list(__import__("m2_common").NUMERIC_FEATURES),
            "forbidden_features": ["doc_id", "layout_id", "split", "label", "value", "word_idx", "cand_id"],
        },
        "models": trained,
        "validation_selection": selection_report,
        "dataset_sizes": {
            "train_documents": int(len(train_docs)),
            "validation_documents": int(len(val_docs)),
            "train_candidates": int(len(train_rows)),
            "validation_candidates": int(len(val_rows)),
            "train_layouts_checked_with_find_candidates": train_layout_checks,
            "validation_layouts_checked_with_find_candidates": val_layout_checks,
        },
    }
    joblib.dump(package, MODEL_PATH, compress=3)
    print(f"Saved {MODEL_PATH}", flush=True)
    return package


if __name__ == "__main__":
    train_model()
