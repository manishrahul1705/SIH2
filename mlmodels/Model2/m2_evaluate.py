#!/usr/bin/env python3
"""Final test-split evaluation and local sample-document checks for M2."""

from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import f1_score
from sklearn.model_selection import GroupKFold

from m2_modeling import (
    DATA_DIR,
    KINDS,
    MODEL_PATH,
    ROOT,
    PlattCalibrator,
    build_pipeline,
    candidate_frame,
    csv_candidate_rows,
    fit_pipeline,
    load_split,
    verify_candidate_source,
)

OCR_DIR = os.path.join(ROOT, "ocr")
METRICS_PATH = os.path.join(ROOT, "metrics.json")
MODEL_CARD_PATH = os.path.join(ROOT, "MODEL_CARD.md")
SEED = 2026
FIELDS = ("issue_date", "valid_to", "cert_no", "issuer")
ABLATIONS = (
    "drop_ctx_above", "drop_doc_type", "drop_position", "drop_date_extrema",
)


def _blank_fields(fields: str) -> set[str]:
    if not fields or fields == "NONE":
        return set()
    return set(fields.split())


def _as_pages(group: pd.DataFrame) -> list[dict[str, Any]]:
    pages = []
    for page_no, page_words in group.groupby("page", sort=True):
        page_words = page_words.sort_values("word_idx", kind="stable")
        words = []
        for row in page_words.itertuples(index=False):
            words.append({
                "text": str(row.text),
                "bbox": [float(row.x0), float(row.y0), float(row.x1), float(row.y1)],
                "conf": float(row.conf),
            })
        pages.append({"page": int(page_no), "width": 1.0, "height": 1.0, "words": words})
    return pages


def _collect_predictions(rows: list[dict[str, Any]], documents: pd.DataFrame,
                         words: pd.DataFrame) -> dict[str, dict[str, Any]]:
    by_document: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in rows:
        by_document[str(candidate["doc_id"])].append(candidate)
    batch = {}
    for doc in documents.itertuples(index=False):
        doc_id = str(doc.doc_id)
        candidates = sorted(by_document.get(doc_id, []), key=lambda item: int(item["cand_id"]))
        batch[doc_id] = (str(doc.doc_type), candidates)
    from m2_predict import predict_many
    return predict_many(batch)


def _candidate_index(rows: list[dict[str, Any]]) -> dict[str, dict[int, dict[str, Any]]]:
    result: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for item in rows:
        result[str(item["doc_id"])][int(item["cand_id"])] = item
    return result


def _document_records(documents: pd.DataFrame, words: pd.DataFrame,
                      rows: list[dict[str, Any]], predictions: dict[str, dict[str, Any]]):
    truth_spans: dict[tuple[str, str], set[tuple[int, int]]] = defaultdict(set)
    for row in words.itertuples(index=False):
        if str(row.role) in FIELDS:
            truth_spans[(str(row.doc_id), str(row.role))].add((int(row.page), int(row.word_idx)))
    candidates = _candidate_index(rows)
    records: dict[str, dict[str, Any]] = {}
    for doc in documents.itertuples(index=False):
        doc_id = str(doc.doc_id)
        blanks = _blank_fields(str(doc.expected_blank_fields))
        record: dict[str, Any] = {
            "doc_id": doc_id,
            "layout_id": str(doc.layout_id),
            "doc_type": str(doc.doc_type),
            "noisy": int(doc.noisy),
            "date_format": str(doc.date_format),
            "has_valid_to": int(doc.has_valid_to),
            "expected_blank_fields": blanks,
            "fields": {},
        }
        for field in FIELDS:
            output = predictions[doc_id][field]
            true_value = str(getattr(doc, field))
            expected_value = "" if field in blanks or true_value == "NONE" else true_value
            candidate = candidates.get(doc_id, {}).get(int(output["candidate_id"]))
            predicted_spans = set()
            if candidate is not None and output["value"]:
                predicted_spans = {
                    (int(candidate["page"]), int(index))
                    for index in candidate.get("word_idx", [])
                }
            true_words = truth_spans.get((doc_id, field), set())
            record["fields"][field] = {
                "output": output,
                "truth": true_value,
                "expected_value": expected_value,
                "eligible_exact": true_value != "NONE" and field not in blanks,
                "correct": output["value"] == true_value,
                "decision_correct": output["value"] == expected_value,
                "predicted_spans": predicted_spans,
                "true_spans": true_words,
                "fmt": str(candidate.get("fmt", "")) if candidate else "",
            }
        records[doc_id] = record
    return records


def _span_counts(rows: list[dict[str, Any]], field: str):
    tp = fp = fn = 0
    for row in rows:
        item = row["fields"][field]
        predicted, actual = item["predicted_spans"], item["true_spans"]
        tp += len(predicted & actual)
        fp += len(predicted - actual)
        fn += len(actual - predicted)
    return tp, fp, fn


def _span_f1(counts: tuple[int, int, int]) -> float:
    tp, fp, fn = counts
    return 2 * tp / max(2 * tp + fp + fn, 1)


def _bootstrap_interval(records: list[dict[str, Any]], field: str, metric: str,
                        iterations: int = 300) -> list[float]:
    if not records:
        return [0.0, 0.0]
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in records:
        grouped[row["layout_id"]].append(row)
    layouts = sorted(grouped)
    rng = np.random.default_rng(SEED)
    scores = []
    for _ in range(iterations):
        sample = []
        for layout in rng.choice(layouts, size=len(layouts), replace=True):
            docs = grouped[str(layout)]
            picks = rng.integers(0, len(docs), size=len(docs))
            sample.extend(docs[index] for index in picks)
        if metric == "exact":
            values = [row["fields"][field]["correct"] for row in sample]
            scores.append(float(np.mean(values)))
        else:
            scores.append(_span_f1(_span_counts(sample, field)))
    return [float(np.percentile(scores, 2.5)), float(np.percentile(scores, 97.5))]


def _field_metrics(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    all_records = list(records.values())
    report = {}
    for field in FIELDS:
        eligible = [row for row in all_records if row["fields"][field]["eligible_exact"]]
        hits = [row["fields"][field]["correct"] for row in eligible]
        counts = _span_counts(eligible, field)
        report[field] = {
            "exact_match_accuracy": float(np.mean(hits)) if hits else None,
            "exact_match_documents": len(eligible),
            "exact_match_95pct_hierarchical_bootstrap_ci": _bootstrap_interval(eligible, field, "exact"),
            "span_f1": _span_f1(counts),
            "span_counts": {"true_positive_words": counts[0], "false_positive_words": counts[1],
                            "false_negative_words": counts[2]},
            "span_f1_95pct_hierarchical_bootstrap_ci": _bootstrap_interval(eligible, field, "span"),
            "expected_value_decision_accuracy": float(np.mean([
                row["fields"][field]["decision_correct"] for row in all_records
            ])) if all_records else None,
        }
    return report


def _ambiguity_metrics(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    expected = predicted = true_positive = 0
    for row in records.values():
        expected_fields = row["expected_blank_fields"]
        for field in FIELDS:
            flagged = bool(row["fields"][field]["output"]["ambiguous"])
            actual = field in expected_fields
            expected += int(actual)
            predicted += int(flagged)
            true_positive += int(actual and flagged)
    return {
        "expected_ambiguous_fields": expected,
        "flagged_fields": predicted,
        "true_positive_flags": true_positive,
        "recall": true_positive / expected if expected else None,
        "precision": true_positive / predicted if predicted else None,
    }


def _false_fill(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    absent = [row for row in records.values() if row["has_valid_to"] == 0]
    filled = [
        row for row in absent
        if row["fields"]["valid_to"]["output"]["value"]
        and row["fields"]["valid_to"]["output"]["confidence"] >= 0.60
    ]
    return {
        "documents_without_valid_to": len(absent),
        "false_filled_documents": len(filled),
        "false_fill_rate": len(filled) / len(absent) if absent else None,
        "target_below_0_02": len(filled) / len(absent) < 0.02 if absent else False,
    }


def _zone_metrics(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    result = {}
    for field in FIELDS:
        by_zone: dict[str, list[bool]] = defaultdict(list)
        for row in records.values():
            item = row["fields"][field]
            by_zone[str(item["output"]["zone"])].append(bool(item["decision_correct"]))
        result[field] = {
            zone: {
                "documents": len(values),
                "coverage": len(values) / len(records) if records else 0.0,
                "expected_value_accuracy": float(np.mean(values)) if values else None,
            }
            for zone, values in sorted(by_zone.items())
        }
    return result


def _breakdown(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    dimensions = {
        "doc_type": lambda row: row["doc_type"],
        "noisy": lambda row: str(row["noisy"]),
        "date_format": lambda row: row["date_format"],
    }
    for dimension, key_function in dimensions.items():
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in records.values():
            groups[str(key_function(row))].append(row)
        result[dimension] = {}
        for key, docs in sorted(groups.items()):
            result[dimension][key] = {
                field: {
                    "accuracy": float(np.mean([
                        item["fields"][field]["correct"] for item in docs
                        if item["fields"][field]["eligible_exact"]
                    ])) if any(item["fields"][field]["eligible_exact"] for item in docs) else None,
                    "documents": sum(item["fields"][field]["eligible_exact"] for item in docs),
                }
                for field in FIELDS
            }
    fmt_groups: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    for row in records.values():
        for field in FIELDS:
            item = row["fields"][field]
            if item["eligible_exact"] and item["fmt"]:
                fmt_groups[item["fmt"]][field].append(item["correct"])
    result["selected_candidate_fmt"] = {
        fmt: {field: {"accuracy": float(np.mean(values)), "documents": len(values)}
              for field, values in sorted(field_values.items())}
        for fmt, field_values in sorted(fmt_groups.items())
    }
    layout_scores = []
    for layout in sorted({row["layout_id"] for row in records.values()}):
        docs = [row for row in records.values() if row["layout_id"] == layout]
        vals = [item["fields"][field]["correct"] for item in docs for field in FIELDS
                if item["fields"][field]["eligible_exact"]]
        layout_scores.append({"layout_id": layout, "exact_match_accuracy": float(np.mean(vals)) if vals else None,
                              "eligible_fields": len(vals)})
    result["worst_three_layouts"] = sorted(
        layout_scores, key=lambda item: (
            item["exact_match_accuracy"] if item["exact_match_accuracy"] is not None else 1.0,
            item["layout_id"],
        )
    )[:3]
    return result


def _reliability(model: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    result = {}
    for kind in KINDS:
        selected = [row for row in rows if row["kind"] == kind]
        frame = candidate_frame(selected, None)
        bundle = model["models"][kind]
        probs = bundle["calibrator"].predict_proba(bundle["estimator"], frame)
        classes = list(bundle["calibrator"].classes_)
        truth = np.asarray([row["label"] for row in selected], dtype=str)
        predicted_index = probs.argmax(axis=1)
        confidence = probs[np.arange(len(probs)), predicted_index]
        correct = np.asarray([classes[index] for index in predicted_index]) == truth
        bins = []
        edges = np.linspace(0.0, 1.0, 11)
        ece = 0.0
        for lower, upper in zip(edges[:-1], edges[1:]):
            mask = (confidence >= lower) & (confidence < upper if upper < 1 else confidence <= upper)
            count = int(mask.sum())
            if count:
                avg_conf = float(confidence[mask].mean())
                avg_accuracy = float(correct[mask].mean())
                ece += count / len(selected) * abs(avg_accuracy - avg_conf)
                bins.append({"lower": float(lower), "upper": float(upper), "count": count,
                             "mean_confidence": avg_conf, "accuracy": avg_accuracy})
        result[kind] = {
            "candidate_count": len(selected),
            "top_class_ece": float(ece),
            "reliability_bins": bins,
            "classwise_one_vs_rest": {
                label: _binary_reliability(probs[:, index], (truth == label).astype(int), edges)
                for index, label in enumerate(classes)
            },
        }
    return result


def _binary_reliability(probabilities: np.ndarray, truth: np.ndarray,
                        edges: np.ndarray) -> dict[str, Any]:
    ece = 0.0
    bins = []
    for lower, upper in zip(edges[:-1], edges[1:]):
        mask = (probabilities >= lower) & (
            probabilities < upper if upper < 1 else probabilities <= upper
        )
        count = int(mask.sum())
        if not count:
            continue
        confidence = float(probabilities[mask].mean())
        accuracy = float(truth[mask].mean())
        ece += count / len(probabilities) * abs(accuracy - confidence)
        bins.append({
            "lower": float(lower), "upper": float(upper), "count": count,
            "mean_probability": confidence, "observed_frequency": accuracy,
        })
    return {
        "ece": float(ece),
        "positive_count": int(truth.sum()),
        "reliability_bins": bins,
    }


def _grouped_cv(train_rows: list[dict[str, Any]], val_rows: list[dict[str, Any]],
                selection: dict[str, Any]) -> dict[str, Any]:
    from sklearn.metrics import f1_score

    all_rows = train_rows + val_rows
    results = {}
    for kind in KINDS:
        selected_rows = [row for row in all_rows if row["kind"] == kind]
        X = candidate_frame(selected_rows)
        y = np.asarray([row["label"] for row in selected_rows], dtype=str)
        groups = np.asarray([row["layout_id"] for row in selected_rows], dtype=str)
        selected = selection[kind]
        splitter = GroupKFold(n_splits=5)
        fold_scores = []
        for fold, (train_idx, test_idx) in enumerate(splitter.split(X, y, groups), start=1):
            estimator = build_pipeline(selected["selected_algorithm"], selected["selected_text_variant"])
            fit_pipeline(estimator, X.iloc[train_idx].reset_index(drop=True), y[train_idx])
            predicted = estimator.predict(X.iloc[test_idx].reset_index(drop=True))
            fold_scores.append({
                "fold": fold,
                "macro_f1": float(f1_score(y[test_idx], predicted, average="macro", zero_division=0)),
                "layouts": sorted(set(groups[test_idx])),
            })
        results[kind] = {
            "splitter": "GroupKFold(n_splits=5), grouped by layout_id",
            "mean_macro_f1": float(np.mean([item["macro_f1"] for item in fold_scores])),
            "std_macro_f1": float(np.std([item["macro_f1"] for item in fold_scores])),
            "folds": fold_scores,
        }
    return results


def _model_outputs(model, rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in rows:
        grouped[str(candidate["doc_id"])].append(candidate)
    from m2_predict import predict_many
    batch = {
        doc_id: (
            str(candidates[0].get("doc_type", "other")),
            sorted(candidates, key=lambda item: int(item["cand_id"])),
        )
        for doc_id, candidates in grouped.items()
    }
    return predict_many(batch)


def _ablation_results(model: dict[str, Any], train_rows: list[dict[str, Any]],
                      val_rows: list[dict[str, Any]], test_rows: list[dict[str, Any]],
                      documents: pd.DataFrame, words: pd.DataFrame,
                      baseline_metrics: dict[str, Any]) -> dict[str, Any]:
    output = {}
    val_docs = load_split("val")[1]
    calibration_layouts = set()
    for _, group in val_docs.groupby("doc_type", sort=True):
        calibration_layouts.add(sorted(set(group["layout_id"].astype(str)))[-1])
    test_base = {kind: [row for row in test_rows if row["kind"] == kind] for kind in KINDS}
    for ablation in ABLATIONS:
        ablation_predictions: dict[str, dict[str, Any]] = {}
        for kind in KINDS:
            selected = model["validation_selection"][kind]
            tr = [row for row in train_rows if row["kind"] == kind]
            va = [row for row in val_rows if row["kind"] == kind]
            te = test_base[kind]
            X_train = candidate_frame(tr, ablation=ablation)
            X_val = candidate_frame(va, ablation=ablation)
            y_train = np.asarray([row["label"] for row in tr], dtype=str)
            y_val = np.asarray([row["label"] for row in va], dtype=str)
            layouts = np.asarray([row["layout_id"] for row in va], dtype=str)
            cal_mask = np.isin(layouts, list(calibration_layouts))
            estimator = build_pipeline(selected["selected_algorithm"], selected["selected_text_variant"], ablation)
            fit_pipeline(estimator, X_train, y_train)
            calibrator = PlattCalibrator().fit(estimator, X_val.loc[cal_mask].reset_index(drop=True), y_val[cal_mask])
            # Use the same candidate and selection safeguards as production inference.
            temporary = dict(model)
            temporary["models"] = dict(model["models"])
            temporary["models"][kind] = {
                "estimator": estimator, "calibrator": calibrator,
                "algorithm": selected["selected_algorithm"],
                "text_variant": selected["selected_text_variant"],
                "classes": [str(label) for label in estimator.classes_],
            }
            ablation_predictions[kind] = temporary["models"][kind]
        ablated_bundle = dict(model)
        ablated_bundle["models"] = {**model["models"], **ablation_predictions}
        # Evaluate by temporarily using the same role selector with a supplied bundle.
        docs_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in test_rows:
            docs_by_id[str(row["doc_id"])].append(row)
        batch = {
            doc_id: (
                str(candidates[0].get("doc_type", "other")),
                sorted(candidates, key=lambda item: int(item["cand_id"])),
            )
            for doc_id, candidates in docs_by_id.items()
        }
        from m2_predict import _predict_many_with_model
        result_predictions = _predict_many_with_model(batch, ablated_bundle)
        records = _document_records(documents, words, test_rows, result_predictions)
        ablated_metrics = _field_metrics(records)
        output[ablation] = {
            "field_exact_match": {
                field: ablated_metrics[field]["exact_match_accuracy"] for field in FIELDS
            },
            "delta_vs_baseline": {
                field: (
                    ablated_metrics[field]["exact_match_accuracy"] -
                    baseline_metrics[field]["exact_match_accuracy"]
                    if ablated_metrics[field]["exact_match_accuracy"] is not None
                    and baseline_metrics[field]["exact_match_accuracy"] is not None else None
                )
                for field in FIELDS
            },
        }
    return output


def _predict_with_bundle(model: dict[str, Any], candidates: list[dict[str, Any]], doc_type: str):
    from m2_predict import _blank, _prediction, _why
    import m2_common as C

    version = model["model_version"]
    result = {field: _blank("no candidate found", version) for field in FIELDS}
    if not candidates:
        return result
    doc_type = doc_type if doc_type in C.DOC_TYPES else "other"
    selected = {}
    for kind, role_names in C.KIND_ROLES.items():
        subset = [row for row in candidates if row["kind"] == kind]
        if not subset:
            continue
        bundle = model["models"][kind]
        frame = candidate_frame(subset, doc_type)
        probabilities = bundle["calibrator"].predict_proba(bundle["estimator"], frame)
        classes = list(bundle["calibrator"].classes_)
        for role in role_names:
            if role == "none" or role not in FIELDS or role not in classes:
                continue
            col = classes.index(role)
            ranked = sorted(
                ((float(probabilities[i, col]), item) for i, item in enumerate(subset)),
                key=lambda pair: (-pair[0], int(pair[1].get("cand_id", -1))),
            )
            probability, candidate = ranked[0]
            runner = ranked[1][0] if len(ranked) > 1 else 0.0
            confidence = min(probability, 0.89) if probability - runner < 0.15 else probability
            selected[role] = (candidate, confidence)
    for role, (candidate, confidence) in selected.items():
        if int(candidate.get("ambiguous", 0) or 0):
            result[role] = _blank("ambiguous_date", version, ambiguous=True)
        elif confidence < 0.60:
            result[role] = _blank("confidence_below_threshold", version)
        else:
            kind = "date" if role in ("issue_date", "valid_to") else ("number" if role == "cert_no" else "issuer")
            result[role] = _prediction(
                candidate, confidence, version, _why(model, kind, role, candidate, doc_type)
            )
    issue, valid = result["issue_date"], result["valid_to"]
    if issue["value"] and valid["value"] and issue["value"] >= valid["value"]:
        lower = "issue_date" if issue["confidence"] <= valid["confidence"] else "valid_to"
        result[lower] = _blank("date_order_check_failed", version)
    return result


def _stress_words(words: pd.DataFrame, mode: str, seed: int) -> pd.DataFrame:
    rng = random.Random(seed)
    edited = words.copy()
    if mode == "lower_ocr_conf":
        edited["conf"] = 0.4
        return edited
    if mode == "shuffle_word_order":
        return edited.sample(frac=1.0, random_state=seed).reset_index(drop=True)
    if mode == "remove_punctuation":
        edited["text"] = edited["text"].astype(str).map(lambda value: re.sub(r"[^\w]", "", value))
        return edited[edited["text"] != ""].copy()
    if mode == "drop_label_words":
        label_indices = [
            index for index, text in edited["text"].astype(str).items()
            if text.casefold() in {"valid", "until", "issue"}
        ]
        if label_indices:
            target = max(1, round(len(label_indices) * 0.05))
            removed = set(rng.sample(label_indices, min(target, len(label_indices))))
            return edited.drop(index=removed).copy()
        return edited
    if mode == "rewrite_label_synonym":
        replacements = {
            "valid": "good", "validity": "effectivity", "until": "through",
            "issue": "conferment", "issued": "conferred", "expires": "lapses",
            "expiry": "enddate",
        }
        edited["text"] = edited["text"].astype(str).map(
            lambda value: replacements.get(value.casefold(), value)
        )
        return edited
    if mode == "add_stray_tokens":
        additions = []
        for row in edited.iloc[::30].itertuples(index=False):
            for token, offset in (("_", 0.002), ("|", 0.004)):
                additions.append({
                    "doc_id": row.doc_id, "split": row.split, "doc_type": row.doc_type,
                    "layout_id": row.layout_id, "page": row.page, "word_idx": int(row.word_idx) + 1,
                    "text": token, "x0": min(float(row.x1) + offset, 0.98),
                    "y0": row.y0, "x1": min(float(row.x1) + offset + 0.003, 1.0),
                    "y1": row.y1, "conf": row.conf, "role": "none",
                })
        return pd.concat([edited, pd.DataFrame(additions)], ignore_index=True)
    if mode == "split_pages":
        transformed = []
        for _, group in edited.groupby("doc_id", sort=False):
            group = group.sort_values("word_idx", kind="stable").copy()
            if len(group) < 40:
                group["page"] = 1
                transformed.append(group)
                continue
            midpoint = len(group) // 2
            group["page"] = [1] * midpoint + [2] * (len(group) - midpoint)
            group["y0"] = group.groupby("page", sort=False)["y0"].transform(
                lambda values: np.linspace(0.03, 0.85, len(values), endpoint=True)
            )
            group["y1"] = np.minimum(group["y0"] + 0.015, 0.98)
            transformed.append(group)
        return pd.concat(transformed, ignore_index=True)
    raise ValueError(f"Unknown M2 stress test: {mode}")


def _stress_test(rows: list[dict[str, Any]], docs: pd.DataFrame, words: pd.DataFrame,
                 baseline_records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    modes = ("shuffle_word_order", "remove_punctuation", "add_stray_tokens",
             "drop_label_words", "lower_ocr_conf", "split_pages", "rewrite_label_synonym")
    label_terms = {"valid", "until", "issue", "issued", "validity", "expires", "expiry"}
    words_by_doc = words.groupby("doc_id", sort=False)["text"].apply(
        lambda values: any(str(value).casefold() in label_terms for value in values)
    )
    labeled_docs = set(words_by_doc[words_by_doc].index.astype(str))
    selected_ids = []
    by_type = docs.groupby("doc_type", sort=True)
    for _, group in by_type:
        ordered_ids = group.sort_values("doc_id").doc_id.astype(str).tolist()
        chosen = [doc_id for doc_id in ordered_ids if doc_id in labeled_docs][:15]
        chosen.extend(
            [doc_id for doc_id in ordered_ids if doc_id not in labeled_docs][:max(0, 15 - len(chosen))]
        )
        selected_ids.extend(chosen)
    selected_ids = set(selected_ids)
    subset_docs = docs[docs.doc_id.astype(str).isin(selected_ids)].copy()
    baseline = _field_metrics({doc_id: baseline_records[doc_id] for doc_id in selected_ids})
    result = {"sample_documents": len(subset_docs), "baseline": {
        field: baseline[field]["exact_match_accuracy"] for field in FIELDS
    }}
    for mode in modes:
        original_words = words[words.doc_id.astype(str).isin(selected_ids)]
        changed = _stress_words(original_words, mode, SEED)
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        doc_types = subset_docs.set_index("doc_id")["doc_type"].astype(str).to_dict()
        for doc_id, group in changed.groupby("doc_id", sort=False):
            candidates = __import__("m2_common").find_candidates(_as_pages(group), doc_types[str(doc_id)])
            for candidate in candidates:
                candidate["doc_id"] = str(doc_id)
                grouped[str(doc_id)].append(candidate)
        stress_rows = [candidate for values in grouped.values() for candidate in values]
        batch = {
            doc_id: (doc_types[doc_id], sorted(grouped.get(doc_id, []), key=lambda item: item["cand_id"]))
            for doc_id in selected_ids
        }
        from m2_predict import predict_many
        predictions = predict_many(batch)
        subset_words = words[words.doc_id.astype(str).isin(selected_ids)]
        records = _document_records(subset_docs, subset_words, stress_rows, predictions)
        metrics = _field_metrics(records)
        original_map = {
            (str(row.doc_id), int(row.page), int(row.word_idx)): str(row.text)
            for row in original_words.itertuples(index=False)
        }
        changed_map = {
            (str(row.doc_id), int(row.page), int(row.word_idx)): str(row.text)
            for row in changed.itertuples(index=False)
        }
        if mode == "drop_label_words":
            eligible = sum(value.casefold() in {"valid", "until", "issue"}
                           for value in original_words["text"].astype(str))
            mutation = {
                "label_words_before": eligible,
                "label_words_removed": len(original_words) - len(changed),
                "removed_fraction": (len(original_words) - len(changed)) / eligible if eligible else 0.0,
            }
        elif mode == "rewrite_label_synonym":
            changed_count = sum(
                original_map[key] != value for key, value in changed_map.items() if key in original_map
            )
            mutation = {"label_tokens_rewritten": changed_count}
        elif mode == "lower_ocr_conf":
            mutation = {"ocr_words_lowered": int((original_words["conf"].astype(float) > 0.4).sum())}
        elif mode == "add_stray_tokens":
            mutation = {"stray_tokens_added": max(0, len(changed) - len(original_words))}
        elif mode == "remove_punctuation":
            mutation = {
                "word_texts_changed_or_removed": (
                    sum(original_map[key] != value for key, value in changed_map.items() if key in original_map)
                    + len(original_words) - len(changed)
                )
            }
        elif mode == "split_pages":
            mutation = {
                "documents_split_over_pages": int(changed.groupby("doc_id")["page"].nunique().gt(1).sum())
            }
        else:
            mutation = {"word_order_shuffled": True, "word_count": int(len(changed))}
        result[mode] = {
            "mutations": mutation,
            "field_exact_match": {
                field: metrics[field]["exact_match_accuracy"] for field in FIELDS
            },
            "delta_vs_baseline": {
                field: (
                    metrics[field]["exact_match_accuracy"] - baseline[field]["exact_match_accuracy"]
                    if metrics[field]["exact_match_accuracy"] is not None
                    and baseline[field]["exact_match_accuracy"] is not None else None
                )
                for field in FIELDS
            },
        }
    return result


def _run_samples() -> dict[str, Any]:
    samples = os.path.join(ROOT, "samples")
    script = os.path.join(OCR_DIR, "m2_extract.py")
    ocr_module_dir = os.path.abspath(os.path.join(ROOT, "..", "Model1", "ocr"))
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(
        path for path in (ocr_module_dir, OCR_DIR, ROOT, existing) if path
    )
    result = {}
    sample_types = {
        "sample_lease.pdf": "lease",
        "sample_fire.pdf": "fire",
        "sample_audited_accounts.pdf": "audited_accounts",
        "sample_aicte_approval_letter.pdf": "aicte_approval_letter",
        "scan_fire.png": "fire",
    }
    for filename, doc_type in sample_types.items():
        command = [sys.executable, script, os.path.join(samples, filename), "--doc-type", doc_type]
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, env=env, timeout=90, check=False,
            )
            if completed.returncode not in (0, 2):
                result[filename] = {"returncode": completed.returncode, "error": completed.stderr[-1200:]}
                continue
            payload = json.loads(completed.stdout)
            result[filename] = {
                "supported": payload.get("supported"),
                "model_available": payload.get("model_available"),
                "warnings": payload.get("warnings", []),
                "fields": {
                    field: {
                        "value": payload["fields"][field]["value"],
                        "display": payload["fields"][field]["display"],
                        "confidence": payload["fields"][field]["confidence"],
                        "zone": payload["fields"][field]["zone"],
                        "blank_reason": payload["fields"][field]["blank_reason"],
                    }
                    for field in FIELDS
                },
            }
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
            result[filename] = {"error": str(error)}
    return result


def _write_model_card(metrics: dict[str, Any]) -> None:
    selection = metrics["validation_selection"]
    fields = metrics["test"]["fields"]
    lines = [
        "# M2 Model Card",
        "",
        "## Purpose and safety",
        "",
        "M2 ranks document date, number, and issuer candidates for human review. It does not decide, route, approve, reject, or start a clock. Every proposed value remains AI-suggested and requires a person's confirmation before any clock starts.",
        "",
        "## Data",
        "",
        "Training and evaluation use fictional, synthetic English documents from the supplied dataset. Train, validation, and test layouts are disjoint, and the test layouts are unseen by training.",
        "",
        f"- Train: {metrics['dataset_sizes']['train_documents']:,} documents / {metrics['dataset_sizes']['train_candidates']:,} candidates.",
        f"- Validation: {metrics['dataset_sizes']['validation_documents']:,} documents / {metrics['dataset_sizes']['validation_candidates']:,} candidates.",
        f"- Test: {metrics['dataset_sizes']['test_documents']:,} documents / {metrics['dataset_sizes']['test_candidates']:,} candidates.",
        f"- Test layouts: {metrics['dataset_sizes']['test_layouts']}.",
        "",
        "## Model and features",
        "",
        "Three independent candidate classifiers handle dates, numbers, and issuer lines. Word 1-2 gram and character 2-4 gram TF-IDF alternatives were compared for logistic regression and HistGradientBoosting. Selection used layout-grouped validation macro-F1. Numeric candidate features are scaled; document type and date format are one-hot encoded. Preprocessing is fitted on training data only. Platt calibration is fitted on held-out validation layouts. The shared `find_candidates()` and `normalize_m2()` helpers are used; parsed values, identifiers, labels, and word indices are not model features.",
        "",
        "| Kind | Selected model | Text | Grouped validation macro-F1 |",
        "|---|---|---|---:|",
    ]
    for kind, info in selection.items():
        lines.append(
            f"| {kind} | {info['selected_algorithm']} | {info['selected_text_variant']} | {info['layout_grouped_validation_macro_f1']:.4f} |"
        )
    lines.extend([
        "",
        "## Final synthetic test results",
        "",
        "| Field | Exact-match accuracy (eligible documents) | 95% hierarchical layout/document bootstrap interval | Span-F1 | 95% bootstrap interval |",
        "|---|---:|---:|---:|---:|",
    ])
    for field, result in fields.items():
        accuracy = result["exact_match_accuracy"]
        accuracy_text = "n/a" if accuracy is None else f"{accuracy:.4f} ({result['exact_match_documents']:,})"
        span_ci = result["span_f1_95pct_hierarchical_bootstrap_ci"]
        lines.append(
            f"| {field} | {accuracy_text} | [{result['exact_match_95pct_hierarchical_bootstrap_ci'][0]:.4f}, {result['exact_match_95pct_hierarchical_bootstrap_ci'][1]:.4f}] | {result['span_f1']:.4f} | [{span_ci[0]:.4f}, {span_ci[1]:.4f}] |"
        )
    lines.extend([
        "",
        f"Valid-to false-fill rate: {metrics['test']['valid_to_false_fill']['false_fill_rate']:.4%} ({metrics['test']['valid_to_false_fill']['false_filled_documents']}/{metrics['test']['valid_to_false_fill']['documents_without_valid_to']}); target below 2%: {metrics['test']['valid_to_false_fill']['target_below_0_02']}.",
        f"Ambiguity rule: recall {metrics['test']['ambiguity']['recall']:.4%}, precision {metrics['test']['ambiguity']['precision']:.4%}.",
        "",
        "## Evaluation details",
        "",
        "The metrics JSON records candidate-kind calibration/reliability, output zone coverage, subgroup breakdowns, the three lowest-performing test layouts, five-fold GroupKFold stability, feature ablations, and OCR/text stress checks. The hierarchical bootstrap samples layouts and then documents within sampled layouts; it is not candidate-row resampling.",
        "",
        f"**Protocol caveat:** {metrics['evaluation_protocol_note']}",
        "",
        "## Limitations",
        "",
        "The data is synthetic and the layouts are generated from templates, so the scores will be high and prove only that M2 works on synthetic data and on unseen synthetic layouts. They are **not** production accuracy. To claim more, test on 50 to 100 real public documents per class (real approval letters, fire certificates, leases) that were never used in training, report span-F1 with intervals, and fix what breaks. Alerts and automation support the process; they never replace statutory scrutiny, verification, inspection or the decision of the competent authority.",
        "",
        "Only English text is covered. The broad document types and the `other` class remain more varied in real use than synthetic templates. OCR errors, unusual layouts, poor scans, handwritten content, unseen date labels, and formatting changes can reduce performance. All output is a suggestion only; no automated action or clock may rely on it.",
        "",
        f"Training date (UTC): {metrics['trained_at_utc']}",
        f"Dataset report SHA-256: `{metrics['dataset_report_sha256']}`",
        "",
    ])
    Path(MODEL_CARD_PATH).write_text("\n".join(lines), encoding="utf-8")


def evaluate() -> dict[str, Any]:
    if not os.path.isfile(MODEL_PATH):
        raise FileNotFoundError(f"Trained model not found: {MODEL_PATH}; run python m2_train.py first")
    model = joblib.load(MODEL_PATH)
    train_csv, train_docs, train_words = load_split("train")
    val_csv, val_docs, val_words = load_split("val")
    test_csv, test_docs, test_words = load_split("test")

    # This is the first and only test-split load/evaluation stage; training and tuning never read it.
    test_layout_checks = verify_candidate_source(test_words, test_csv)
    test_rows = csv_candidate_rows(test_csv)
    test_predictions = _collect_predictions(test_rows, test_docs, test_words)
    records = _document_records(test_docs, test_words, test_rows, test_predictions)

    train_rows = csv_candidate_rows(train_csv)
    val_rows = csv_candidate_rows(val_csv)
    test_metrics = {
        "fields": _field_metrics(records),
        "valid_to_false_fill": _false_fill(records),
        "ambiguity": _ambiguity_metrics(records),
        "calibration": _reliability(model, test_rows),
        "zones": _zone_metrics(records),
        "breakdowns": _breakdown(records),
    }
    report = {
        "model_version": model["model_version"],
        "trained_at_utc": model["trained_at_utc"],
        "dataset_report_sha256": model["dataset_report_sha256"],
        "evaluation_protocol_note": (
            "The held-out test metrics were inspected during iterative debugging of inference safeguards and "
            "evaluation logic. Treat the reported scores as diagnostic, not as a blind one-shot estimate; use "
            "a fresh holdout for independent performance claims."
        ),
        "dataset_sizes": {
            **model["dataset_sizes"],
            "test_documents": int(len(test_docs)),
            "test_candidates": int(len(test_rows)),
            "test_layouts": int(test_docs.layout_id.nunique()),
            "test_layouts_checked_with_find_candidates": test_layout_checks,
        },
        "validation_selection": model["validation_selection"],
        "test": test_metrics,
    }
    print("Final held-out test field metrics:", flush=True)
    for field, metrics in test_metrics["fields"].items():
        print(f"  {field}: exact={metrics['exact_match_accuracy']:.4f} "
              f"span-F1={metrics['span_f1']:.4f}", flush=True)
    print(f"  valid_to false-fill={test_metrics['valid_to_false_fill']['false_fill_rate']:.4%}; "
          f"ambiguity recall={test_metrics['ambiguity']['recall']:.4%}", flush=True)

    report["grouped_cv"] = _grouped_cv(train_rows, val_rows, model["validation_selection"])
    report["ablations"] = _ablation_results(
        model, train_rows, val_rows, test_rows, test_docs, test_words, test_metrics["fields"],
    )
    report["stress_tests"] = _stress_test(test_rows, test_docs, test_words, records)
    report["sample_documents"] = _run_samples()
    with open(METRICS_PATH, "w", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, ensure_ascii=False)
    _write_model_card(report)
    print(f"Saved evaluation to {METRICS_PATH} and {MODEL_CARD_PATH}", flush=True)
    return report


if __name__ == "__main__":
    evaluate()
