#!/usr/bin/env python3
"""Evaluate M3 once on the held-out synthetic test layouts."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import date
import json
from pathlib import Path
import random
import re
import sys
from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATASET = ROOT / "dataset"
REPORT_PATH = ROOT / "m3_metrics.json"
DATE_FIELDS = {"lease_start": "expected_start", "lease_end": "expected_end"}
FIELD_COLUMNS = {
    "lease_start": "expected_start",
    "lease_end": "expected_end",
    "term_value": "expected_term_months",
}
CHECK_FIELDS = (
    "expected_start", "expected_end", "expected_term_months",
    "expected_state", "expected_status",
)


def _truth(value: Any) -> str:
    value = str(value).strip()
    return "" if value.upper() in {"", "NONE", "NAN"} else value


def _candidate_value(candidate: dict[str, Any] | None, role: str) -> str:
    if candidate is None:
        return ""
    if role == "term_value":
        return str(int(candidate.get("term_months", 0) or 0)) if int(
            candidate.get("term_months", 0) or 0
        ) > 0 else ""
    return _truth(candidate.get("value", ""))


def _run_reconcile(prediction: dict[str, Any], candidates: list[dict[str, Any]],
                   as_of: str, reminder_days: int = 30,
                   apply_checks: bool = True) -> dict[str, Any]:
    from m3_lease import reconcile_lease, status_from_reconciled

    by_id = {str(c["cand_id"]): c for c in candidates}
    roles = prediction.get("roles", {})
    selected = {
        role: by_id.get(str(roles.get(role, {}).get("candidate_id", "")))
        for role in ("lease_start", "lease_end", "term_value")
    }

    def usable(role: str) -> dict[str, Any] | None:
        picked = selected[role]
        role_result = roles.get(role, {})
        if picked is None or (apply_checks and float(role_result.get("confidence", 0.0)) < 0.60):
            return None
        if apply_checks and int(picked.get("ambiguous", 0) or 0):
            return None
        return picked

    start = usable("lease_start")
    end = usable("lease_end")
    term = usable("term_value")
    start_ambiguous = bool(
        selected["lease_start"] and int(selected["lease_start"].get("ambiguous", 0) or 0)
    )
    end_ambiguous = bool(
        selected["lease_end"] and int(selected["lease_end"].get("ambiguous", 0) or 0)
    )
    rec = reconcile_lease(
        _candidate_value(start, "lease_start") or None,
        _candidate_value(end, "lease_end") or None,
        _candidate_value(term, "term_value") or None,
        start_ambiguous=start_ambiguous,
        end_ambiguous=end_ambiguous,
    )
    status = status_from_reconciled(rec, date.fromisoformat(as_of), reminder_days)
    return {
        "reconciliation": rec,
        "status": status,
        "selected_candidates": selected,
        "used_candidates": {"lease_start": start, "lease_end": end, "term_value": term},
    }


def _output_confidences(prediction: dict[str, Any], reconciliation: dict[str, Any]) -> dict[str, float]:
    roles = prediction["roles"]
    start_conf = float(roles["lease_start"]["confidence"])
    end_conf = float(roles["lease_end"]["confidence"])
    term_conf = float(roles["term_value"]["confidence"])
    inconsistent = reconciliation["state"] == "inconsistent"
    cap = lambda value: min(float(value), 0.89)
    return {
        "lease_start": (
            cap(start_conf) if inconsistent else start_conf
        ) if reconciliation["start"] else 0.0,
        "lease_end": (
            cap(min(start_conf, term_conf)) if reconciliation["end_derived"]
            else cap(end_conf) if inconsistent else end_conf
        ) if reconciliation["end"] else 0.0,
        "term_value": (
            cap(min(start_conf, end_conf)) if reconciliation["term_derived"]
            else cap(term_conf) if inconsistent else term_conf
        ) if reconciliation["term_months"] else 0.0,
    }


def _field_results(documents: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for role, expected_column in FIELD_COLUMNS.items():
        present = [row for row in documents if row["expected"][expected_column] != ""]
        correct = sum(row["actual"][expected_column] == row["expected"][expected_column]
                      for row in present)
        result[role] = {
            "documents_with_field": len(present),
            "exact_match_count": int(correct),
            "exact_match_accuracy": correct / len(present) if present else 0.0,
        }
    return result


def _layout_bootstrap(documents: list[dict[str, Any]], field: str,
                      replicates: int = 500) -> dict[str, float]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in documents:
        if row["expected"][field] != "":
            groups[str(row["layout_id"])].append(row)
    layouts = sorted(groups)
    if not layouts:
        return {"lower_95": 0.0, "upper_95": 0.0, "replicates": 0}
    rng = np.random.default_rng(2026)
    scores = []
    for _ in range(replicates):
        sampled_layouts = rng.choice(layouts, size=len(layouts), replace=True)
        sample = []
        for layout in sampled_layouts:
            members = groups[str(layout)]
            picks = rng.integers(0, len(members), size=len(members))
            sample.extend(members[index] for index in picks)
        scores.append(np.mean([
            row["actual"][field] == row["expected"][field] for row in sample
        ]))
    low, high = np.quantile(scores, [0.025, 0.975])
    return {"lower_95": float(low), "upper_95": float(high), "replicates": replicates}


def _span_metrics(
    docs: list[dict[str, Any]],
    truth_candidates: pd.DataFrame,
) -> dict[str, Any]:
    result = {}
    for role in FIELD_COLUMNS:
        tp = fp = fn = 0
        for doc in docs:
            document_id = doc["doc_id"]
            gold = truth_candidates[
                (truth_candidates["doc_id"] == document_id)
                & (truth_candidates["role"] == role)
                & (truth_candidates["ambiguous"].astype(int) == 0)
            ]
            gold_spans = {
                (int(row.page), int(row.char_start), int(row.char_end))
                for row in gold.itertuples(index=False)
            }
            chosen = doc["chosen"][role]
            predicted_span = (
                (int(chosen["page"]), int(chosen["char_start"]), int(chosen["char_end"]))
                if chosen is not None else None
            )
            doc_tp, doc_fp, doc_fn = _span_counts(gold_spans, predicted_span)
            tp += doc_tp
            fp += doc_fp
            fn += doc_fn
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        result[role] = {
            "true_positive_spans": tp,
            "false_positive_spans": fp,
            "false_negative_spans": fn,
            "span_precision": precision,
            "span_recall": recall,
            "span_f1": 2 * precision * recall / (precision + recall)
            if precision + recall else 0.0,
            "span_definition": (
                "one answer span per document; exact page/character span match against any "
                "non-ambiguous role-labeled copy, so repeated schedule copies are equivalent"
            ),
        }
    return result


def _span_counts(
    gold_spans: set[tuple[int, int, int]],
    predicted_span: tuple[int, int, int] | None,
) -> tuple[int, int, int]:
    if gold_spans and predicted_span in gold_spans:
        return 1, 0, 0
    if gold_spans:
        return 0, int(predicted_span is not None), 1
    return 0, int(predicted_span is not None), 0


def _span_bootstrap(docs: list[dict[str, Any]], truth_candidates: pd.DataFrame,
                    replicates: int = 500) -> dict[str, Any]:
    results = {}
    rng = np.random.default_rng(2026)
    for role in FIELD_COLUMNS:
        counts_by_doc = []
        for doc in docs:
            gold = truth_candidates[
                (truth_candidates["doc_id"] == doc["doc_id"])
                & (truth_candidates["role"] == role)
                & (truth_candidates["ambiguous"].astype(int) == 0)
            ]
            gold_spans = {
                (int(row.page), int(row.char_start), int(row.char_end))
                for row in gold.itertuples(index=False)
            }
            chosen = doc["chosen"][role]
            predicted_span = (
                (int(chosen["page"]), int(chosen["char_start"]), int(chosen["char_end"]))
                if chosen is not None else None
            )
            counts_by_doc.append((
                doc["layout_id"], _span_counts(gold_spans, predicted_span)
            ))
        grouped: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
        for layout, counts in counts_by_doc:
            grouped[layout].append(counts)
        layouts = sorted(grouped)
        scores = []
        for _ in range(replicates):
            totals = np.zeros(3, dtype=float)
            for layout in rng.choice(layouts, size=len(layouts), replace=True):
                group = grouped[int(layout)]
                for index in rng.integers(0, len(group), size=len(group)):
                    totals += group[index]
            tp, fp, fn = totals
            precision = tp / (tp + fp) if tp + fp else 0.0
            recall = tp / (tp + fn) if tp + fn else 0.0
            scores.append(2 * precision * recall / (precision + recall)
                          if precision + recall else 0.0)
        low, high = np.quantile(scores, [0.025, 0.975])
        results[role] = {
            "lower_95": float(low),
            "upper_95": float(high),
            "replicates": replicates,
        }
    return results


def _calibration(documents: list[dict[str, Any]]) -> dict[str, Any]:
    reports = {}
    for role, expected_column in FIELD_COLUMNS.items():
        rows = [row for row in documents if row["expected"][expected_column] != ""]
        confidences = np.asarray([row["confidence"][role] for row in rows], dtype=float)
        correct = np.asarray([
            row["actual"][expected_column] == row["expected"][expected_column] for row in rows
        ], dtype=float)
        ece = 0.0
        reliability = []
        for lower in np.linspace(0.0, 0.9, 10):
            upper = lower + 0.1
            mask = (confidences >= lower) & (
                confidences < upper if upper < 1.0 else confidences <= upper
            )
            count = int(mask.sum())
            if count:
                mean_conf = float(confidences[mask].mean())
                accuracy = float(correct[mask].mean())
                ece += count / max(len(rows), 1) * abs(accuracy - mean_conf)
                reliability.append({
                    "bin": f"{lower:.1f}-{upper:.1f}",
                    "count": count,
                    "mean_confidence": mean_conf,
                    "accuracy": accuracy,
                })
        zones: dict[str, list[bool]] = {"green": [], "amber": [], "red": []}
        for row in rows:
            conf = row["confidence"][role]
            zone = "green" if conf >= 0.90 else "amber" if conf >= 0.60 else "red"
            zones[zone].append(row["actual"][expected_column] == row["expected"][expected_column])
        reports[role] = {
            "ece": float(ece),
            "reliability": reliability,
            "zone_accuracy_and_coverage": {
                zone: {
                    "count": len(values),
                    "coverage": len(values) / len(rows) if rows else 0.0,
                    "accuracy": float(np.mean(values)) if values else 0.0,
                }
                for zone, values in zones.items()
            },
        }
    return reports


def _wrong_candidates(docs: list[dict[str, Any]], limit: int = 20) -> dict[str, list[dict[str, Any]]]:
    results = {}
    for role, expected_column in FIELD_COLUMNS.items():
        wrong = []
        for row in docs:
            expected = row["expected"][expected_column]
            if row["actual"][expected_column] != expected:
                chosen = row["ranked_candidates"][role]
                wrong.append({
                    "doc_id": row["doc_id"],
                    "expected": expected,
                    "predicted": row["actual"][expected_column],
                    "candidate_id": str(chosen.get("cand_id", "")) if chosen else "",
                    "candidate_text": str(chosen.get("text", "")) if chosen else "",
                    "candidate_value": str(chosen.get("value", "")) if chosen else "",
                    "blank_reason": row["prediction"]["roles"][role]["blank_reason"],
                })
        results[role] = wrong[:limit]
    return results


def _mutate_pages(
    mode: str,
    pages: list[dict[str, Any]],
    labeled: pd.DataFrame,
    rng: random.Random,
) -> list[dict[str, Any]]:
    edited = [{"page": p["page"], "text": p["text"]} for p in pages]
    if mode == "extra_ocr_noise":
        substitutions = {"e": "c", "a": "o", "i": "l", "s": "5", "0": "O"}
        for page in edited:
            chars = list(page["text"])
            indices = [i for i, char in enumerate(chars) if char.lower() in substitutions]
            rng.shuffle(indices)
            for index in indices[:max(1, len(indices) // 150)]:
                chars[index] = substitutions[chars[index].lower()]
            page["text"] = "".join(chars)
    elif mode == "shuffled_clause_order":
        for page in edited:
            lines = page["text"].splitlines()
            rng.shuffle(lines)
            page["text"] = "\n".join(lines)
    elif mode == "key_clause_late_page":
        moves: set[tuple[int, int]] = set()
        for row in labeled[labeled["role"] != "other"].itertuples(index=False):
            moves.add((int(row.page), int(row.line_no) - 1))
        removed = []
        for page in edited:
            lines = page["text"].splitlines()
            keep = []
            for line_index, line in enumerate(lines):
                if (int(page["page"]), line_index) in moves:
                    removed.append(line)
                else:
                    keep.append(line)
            page["text"] = "\n".join(keep)
        if removed and edited:
            edited[-1]["text"] = "\n".join([edited[-1]["text"], *removed]).strip()
    elif mode == "older_quoted_lease":
        phrase = " An earlier lease commenced on 14 January 2007 for a period of five years."
        target_page = next((
            int(row.page) for row in labeled[labeled["role"] != "other"].itertuples(index=False)
        ), int(edited[0]["page"]) if edited else 1)
        target = next((p for p in edited if int(p["page"]) == target_page), edited[0])
        target_lines = target["text"].splitlines()
        matching_line = next((
            int(row.line_no) - 1 for row in labeled[labeled["role"] != "other"].itertuples(index=False)
            if int(row.page) == target_page
        ), 0)
        if target_lines:
            matching_line = max(0, min(matching_line, len(target_lines) - 1))
            target_lines[matching_line] += phrase
            target["text"] = "\n".join(target_lines)
        else:
            target["text"] = phrase
    elif mode == "repeated_footer_date":
        for page in edited:
            page["text"] += "\nRegistered at Sennagar on 03 November 2025."
    return edited


def _sample_evaluation(predictor: Any, extract: Any) -> list[dict[str, Any]]:
    expected_path = ROOT / "samples" / "expected_outputs.json"
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    results = []
    for name, truth in expected.items():
        path = ROOT / "samples" / name
        output = extract.build_result(
            str(path), "lease", date(2026, 10, 27), 30, predictor=predictor.predict_lease
        )
        actual_fields = output.get("fields", {})
        matches = {}
        for field, column in (
            ("lease_start", "expected_start"),
            ("lease_end", "expected_end"),
            ("lease_term", "expected_term_months"),
        ):
            expected_value = _truth(truth.get(column, ""))
            if field == "lease_term":
                actual_value = str(actual_fields.get(field, {}).get("months", 0) or 0)
                expected_value = expected_value or "0"
            else:
                actual_value = _truth(actual_fields.get(field, {}).get("value", ""))
            matches[field] = {
                "expected": expected_value,
                "actual": actual_value,
                "match": expected_value == actual_value,
            }
        results.append({
            "file": name,
            "model_loaded": bool(output.get("model_loaded")),
            "reconciliation_state": output.get("reconciliation", {}).get("state", ""),
            "status": output.get("preview_status", {}).get("status", ""),
            "fields": matches,
            "ocr_engine": output.get("ocr_engine", ""),
        })
    return results


def evaluate(
    data_dir: Path = DATASET,
    output_path: Path = REPORT_PATH,
    include_stress: bool = True,
    include_samples: bool = True,
) -> dict[str, Any]:
    sys.path.insert(0, str(HERE))
    from m3_common import find_lease_candidates
    import m3_predict
    import m3_train
    from m3_lease import reconcile_lease

    test_csv = data_dir / "m3_candidates_test.csv"
    pages_csv = data_dir / "m3_pages_test.csv"
    docs_csv = data_dir / "m3_documents_test.csv"
    train_csv = data_dir / "m3_candidates_train.csv"
    val_csv = data_dir / "m3_candidates_val.csv"
    train_docs = pd.read_csv(train_csv, keep_default_na=False)
    val_docs = pd.read_csv(val_csv, keep_default_na=False)
    labeled_candidates = pd.read_csv(test_csv, keep_default_na=False)
    pages_frame = pd.read_csv(pages_csv, keep_default_na=False)
    document_frame = pd.read_csv(docs_csv, keep_default_na=False)
    truth_by_doc = {
        doc_id: group.sort_values("cand_id")
        for doc_id, group in labeled_candidates.groupby("doc_id", sort=False)
    }
    docs_by_id = {str(row.doc_id): row._asdict() for row in document_frame.itertuples(index=False)}
    evaluated = []
    raw_role_labels: list[str] = []
    raw_role_predictions: list[str] = []

    for doc_id, page_group in pages_frame.groupby("doc_id", sort=False):
        page_data = [
            {"page": int(row.page), "text": row.text}
            for row in page_group.sort_values("page").itertuples(index=False)
        ]
        candidates = find_lease_candidates(page_data)
        truth_group = truth_by_doc.get(doc_id, pd.DataFrame())
        if len(candidates) != len(truth_group):
            raise ValueError(f"Test candidate count differs from shared finder for {doc_id}")
        if not truth_group.empty:
            for predicted, expected in zip(candidates, truth_group.to_dict("records")):
                if (predicted["cand_id"] != expected["cand_id"]
                        or predicted["value"] != expected["value"]
                        or predicted["left_ctx"] != expected["left_ctx"]
                        or predicted["right_ctx"] != expected["right_ctx"]):
                    raise ValueError(f"Test candidate mismatch for {doc_id}/{predicted['cand_id']}")

        prediction, raw_prediction = m3_predict.predict_lease_variants(candidates)
        run = _run_reconcile(prediction, candidates, docs_by_id[str(doc_id)]["status_as_of"])
        raw_run = _run_reconcile(
            raw_prediction, candidates, docs_by_id[str(doc_id)]["status_as_of"],
            apply_checks=False,
        )
        doc_truth = docs_by_id[str(doc_id)]
        expected = {
            "expected_start": _truth(doc_truth["expected_start"]),
            "expected_end": _truth(doc_truth["expected_end"]),
            "expected_term_months": _truth(doc_truth["expected_term_months"]),
            "expected_state": _truth(doc_truth["expected_state"]),
            "expected_status": _truth(doc_truth["expected_status"]),
        }
        rec = run["reconciliation"]
        actual = {
            "expected_start": rec["start"],
            "expected_end": rec["end"],
            "expected_term_months": str(rec["term_months"] or ""),
            "expected_state": rec["state"],
            "expected_status": run["status"]["status"],
        }
        chosen = run["selected_candidates"]
        confidences = _output_confidences(prediction, rec)
        evaluated.append({
            "doc_id": str(doc_id),
            "layout_id": int(doc_truth["layout_id"]),
            "n_pages": int(doc_truth["n_pages"]),
            "scenario": str(doc_truth["scenario"]),
            "term_style": str(doc_truth["term_style"]),
            "expected": expected,
            "actual": actual,
            "chosen": run["used_candidates"],
            "ranked_candidates": chosen,
            "confidence": confidences,
            "prediction": prediction,
            "candidates": candidates,
            "raw_run": raw_run,
            "document": doc_truth,
        })

        if not truth_group.empty:
            raw_role_labels.extend(truth_group["role"].astype(str).tolist())
            matrix = m3_predict._load_model()["feature_builder"].transform(
                pd.DataFrame(candidates)
            )
            bundle = m3_predict._load_model()
            if bundle.get("svd") is not None:
                matrix = bundle["svd"].transform(matrix).astype(np.float32)
            pred_idx = bundle["model"].predict(matrix)
            raw_role_predictions.extend(str(x) for x in pred_idx)

    exact = _field_results(evaluated)
    intervals = {
        field: _layout_bootstrap(evaluated, field)
        for field in ("expected_start", "expected_end", "expected_term_months")
    }
    spans = _span_metrics(evaluated, labeled_candidates)
    calibration = _calibration(evaluated)

    end_to_end = {
        field: {
            "correct": sum(row["actual"][field] == row["expected"][field] for row in evaluated),
            "total": len(evaluated),
            "accuracy": float(np.mean([
                row["actual"][field] == row["expected"][field] for row in evaluated
            ])),
        }
        for field in CHECK_FIELDS
    }
    scenario_b = [row for row in evaluated if row["document"]["scenario"] == "B"]
    scenario_a = [row for row in evaluated if row["document"]["scenario"] == "A"]
    present_false_fill = {
        "scenario_A_term_absent": {
            "documents": sum(row["document"]["scenario"] == "A" for row in evaluated),
            "false_filled": sum(
                row["document"]["scenario"] == "A"
                and row["prediction"]["roles"]["term_value"]["candidate_id"] != ""
                and row["prediction"]["roles"]["term_value"]["confidence"] >= 0.60
                for row in evaluated
            ),
        },
        "scenario_B_stated_end_absent": {
            "documents": sum(row["document"]["scenario"] == "B" for row in evaluated),
            "false_filled": sum(
                row["document"]["scenario"] == "B"
                and row["prediction"]["roles"]["lease_end"]["candidate_id"] != ""
                and row["prediction"]["roles"]["lease_end"]["confidence"] >= 0.60
                for row in evaluated
            ),
        },
    }
    for item in present_false_fill.values():
        item["rate"] = item["false_filled"] / item["documents"] if item["documents"] else 0.0

    scenario_d = [row for row in evaluated if row["document"]["scenario"] == "D"]
    non_d = [row for row in evaluated if row["document"]["scenario"] != "D"]
    expected_inconsistent = [
        row for row in evaluated if row["expected"]["expected_state"] == "inconsistent"
    ]
    inconsistency = {
        "scenario_D_documents": len(scenario_d),
        "true_positive": sum(row["actual"]["expected_state"] == "inconsistent" for row in scenario_d),
        "recall": (
            sum(row["actual"]["expected_state"] == "inconsistent" for row in scenario_d)
            / len(scenario_d) if scenario_d else 0.0
        ),
        "non_D_documents": len(non_d),
        "false_positive": sum(row["actual"]["expected_state"] == "inconsistent" for row in non_d),
        "false_alarm_rate": (
            sum(row["actual"]["expected_state"] == "inconsistent" for row in non_d)
            / len(non_d) if non_d else 0.0
        ),
        "expected_inconsistent_documents": len(expected_inconsistent),
        "expected_inconsistent_recall": (
            sum(row["actual"]["expected_state"] == "inconsistent"
                for row in expected_inconsistent) / len(expected_inconsistent)
            if expected_inconsistent else 0.0
        ),
        "scenario_D_needs_review_due_to_ambiguity": sum(
            row["document"]["scenario"] == "D"
            and row["expected"]["expected_state"] == "needs_review"
            for row in evaluated
        ),
    }
    ambiguous_counts = {}
    for role, column in (("lease_start", "start_ambiguous"), ("lease_end", "end_ambiguous")):
        group = [row for row in evaluated if str(row["document"][column]) in {"1", "True", "true"}]
        blank = sum(
            row["prediction"]["roles"][role]["confidence"] == 0.0
            and row["prediction"]["roles"][role]["blank_reason"] == "ambiguous_date"
            for row in group
        )
        ambiguous_counts[role] = {
            "ambiguous_documents": len(group),
            "blanked": blank,
            "blank_rate": blank / len(group) if group else 1.0,
        }

    breakdowns = {}
    for field in FIELD_COLUMNS:
        column = FIELD_COLUMNS[field]
        breakdowns[field] = {}
        for dimension in ("layout_id", "n_pages", "scenario", "term_style"):
            groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in evaluated:
                groups[str(row[dimension])].append(row)
            breakdowns[field][dimension] = {
                key: {
                    "documents": len(rows),
                    "accuracy": float(np.mean([
                        row["actual"][column] == row["expected"][column]
                        for row in rows if row["expected"][column] != ""
                    ])) if any(row["expected"][column] != "" for row in rows) else 0.0,
                }
                for key, rows in groups.items()
            }

    aggregate_layout_scores = []
    for layout in sorted({row["layout_id"] for row in evaluated}):
        rows = [row for row in evaluated if row["layout_id"] == layout]
        scores = [
            float(np.mean([
                row["actual"][field] == row["expected"][field]
                for row in rows
            ]))
            for field in CHECK_FIELDS
        ]
        aggregate_layout_scores.append({
            "layout_id": layout,
            "documents": len(rows),
            "end_to_end_accuracy": float(np.mean(scores)) if scores else 0.0,
        })
    worst_layouts = sorted(aggregate_layout_scores, key=lambda x: x["end_to_end_accuracy"])[:3]

    wrong_reasons = Counter(
        prediction["blank_reason"]
        for row in evaluated
        for prediction in row["prediction"]["roles"].values()
        if prediction["confidence"] == 0.0
    )
    wrongs = _wrong_candidates(evaluated)
    e2e_mismatches = [
        {
            "doc_id": row["doc_id"],
            "layout_id": row["layout_id"],
            "scenario": row["scenario"],
            "expected": row["expected"],
            "actual": row["actual"],
            "ranked_candidate_ids": {
                role: str(candidate.get("cand_id", "")) if candidate else ""
                for role, candidate in row["ranked_candidates"].items()
            },
            "blank_reasons": {
                role: value["blank_reason"]
                for role, value in row["prediction"]["roles"].items()
            },
        }
        for row in evaluated
        if any(row["actual"][field] != row["expected"][field] for field in CHECK_FIELDS)
    ]
    no_check_exact: dict[str, list[bool]] = defaultdict(list)
    for row in evaluated:
        raw_result = row["raw_run"]
        for field in CHECK_FIELDS:
            no_check_exact[field].append(
                raw_result["reconciliation"]["start"] == row["expected"]["expected_start"]
                if field == "expected_start" else
                raw_result["reconciliation"]["end"] == row["expected"]["expected_end"]
                if field == "expected_end" else
                str(raw_result["reconciliation"]["term_months"] or "")
                == row["expected"]["expected_term_months"]
                if field == "expected_term_months" else
                raw_result["reconciliation"]["state"] == row["expected"]["expected_state"]
                if field == "expected_state" else
                raw_result["status"]["status"] == row["expected"]["expected_status"]
            )

    ablations = _run_ablations(
        train_docs, val_docs, labeled_candidates, m3_predict,
        float(f1_score(raw_role_labels, raw_role_predictions, labels=list(m3_predict.ROLE_LABELS),
                       average="macro", zero_division=0)),
    )
    stress_results = _run_stress(
        evaluated, pages_frame, labeled_candidates, find_lease_candidates, m3_predict
    ) if include_stress else {"skipped": True, "reason": "disabled by caller"}
    samples = _sample_evaluation(m3_predict, __import__("m3_extract")) if include_samples else []
    report = {
        "model_version": m3_predict._load_model()["model_version"],
        "test_documents": len(evaluated),
        "test_layouts": len({row["layout_id"] for row in evaluated}),
        "candidate_class_macro_f1": float(f1_score(
            raw_role_labels, raw_role_predictions, labels=list(m3_predict.ROLE_LABELS),
            average="macro", zero_division=0,
        )),
        "field_exact_match": exact,
        "field_exact_match_layout_document_bootstrap_95_ci": intervals,
        "field_span_f1": spans,
        "field_span_f1_layout_document_bootstrap_95_ci": _span_bootstrap(
            evaluated, labeled_candidates
        ),
        "end_to_end_accuracy": end_to_end,
        "derived_value_accuracy": {
            "scenario_B_end_from_term": {
                "documents": len(scenario_b),
                "accuracy": float(np.mean([
                    row["actual"]["expected_end"] == row["expected"]["expected_end"]
                    for row in scenario_b
                ])) if scenario_b else 0.0,
            },
            "scenario_A_term_from_dates": {
                "documents": len(scenario_a),
                "accuracy": float(np.mean([
                    row["actual"]["expected_term_months"]
                    == row["expected"]["expected_term_months"] for row in scenario_a
                ])) if scenario_a else 0.0,
            },
        },
        "inconsistency_detection": inconsistency,
        "false_fill_rate": present_false_fill,
        "ambiguous_date_blank_rate": ambiguous_counts,
        "calibration": calibration,
        "breakdowns": breakdowns,
        "layout_scores": aggregate_layout_scores,
        "worst_three_layouts": worst_layouts,
        "blank_reason_counts": dict(wrong_reasons),
        "wrong_candidate_examples": wrongs,
        "end_to_end_mismatch_examples": e2e_mismatches[:25],
        "deterministic_checks_off": {
            field: {
                "correct": int(sum(values)),
                "total": len(values),
                "accuracy": float(np.mean(values)) if values else 0.0,
            }
            for field, values in no_check_exact.items()
        },
        "five_fold_grouped_cv": {
            "training_only": True,
            "metrics": m3_predict._load_model()["grouped_cv_macro_f1"],
            "sampled_candidates_per_layout_role_max": 400,
        },
        "ablations": ablations,
        "stress_tests": stress_results,
        "samples": samples,
        "safeguard": (
            "DEMO DATA - NOT REAL AICTE DEADLINES. AI-suggested values are not verified. "
            "A person must confirm every value; the software never replaces the competent "
            "authority. No model output may start a clock, change routing, or write to any "
            "score or policy table. Rules decide, AI only suggests."
        ),
    }
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def _run_ablations(train_docs: pd.DataFrame, val_docs: pd.DataFrame,
                   test_docs: pd.DataFrame, predictor: Any,
                   full_test_f1: float) -> dict[str, Any]:
    from m3_train import FeatureBuilder, _balanced_weights

    train_y = train_docs["role"].astype(str).to_numpy()
    val_y = val_docs["role"].astype(str).to_numpy()
    test_y = test_docs["role"].astype(str).to_numpy()
    results = {}
    for name, settings in (
        ("no_context", {"include_context": False}),
        ("no_numeric", {"include_numeric": False}),
        ("no_position", {"include_position": False}),
    ):
        builder = FeatureBuilder(**settings).fit(train_docs)
        train_x, val_x, test_x = (
            builder.transform(frame) for frame in (train_docs, val_docs, test_docs)
        )
        model = LogisticRegression(
            C=1.0, class_weight="balanced", max_iter=100, solver="saga",
            tol=1e-3, random_state=2026,
        )
        model.fit(train_x, train_y, sample_weight=_balanced_weights(train_y))
        from m3_train import _fit_sigmoid_calibrators, _calibrate
        calibrators = _fit_sigmoid_calibrators(model, val_x, val_y)
        _calibrate(model, calibrators, val_x)
        test_prob = _calibrate(model, calibrators, test_x)
        pred = np.asarray(model.classes_)[test_prob.argmax(axis=1)]
        score = f1_score(test_y, pred, labels=list(predictor.ROLE_LABELS),
                         average="macro", zero_division=0)
        results[name] = {
            "candidate_macro_f1": float(score),
            "drop_from_full_test": float(full_test_f1 - score),
        }
    return results


def _run_stress(
    evaluated: list[dict[str, Any]],
    pages_frame: pd.DataFrame,
    labeled: pd.DataFrame,
    finder: Any,
    predictor: Any,
    sample_limit: int = 100,
) -> dict[str, Any]:
    rng = random.Random(2026)
    by_layout: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in evaluated:
        by_layout[row["layout_id"]].append(row)
    selected_docs = []
    per_layout = max(1, sample_limit // max(len(by_layout), 1))
    for layout in sorted(by_layout):
        selected_docs.extend(sorted(by_layout[layout], key=lambda row: row["doc_id"])[:per_layout])
    selected_docs = selected_docs[:sample_limit]
    pages_by_doc = {
        doc_id: [
            {"page": int(row.page), "text": row.text}
            for row in group.sort_values("page").itertuples(index=False)
        ]
        for doc_id, group in pages_frame.groupby("doc_id", sort=False)
    }
    candidates_by_doc = {
        doc_id: group for doc_id, group in labeled.groupby("doc_id", sort=False)
    }
    modes = (
        "extra_ocr_noise", "shuffled_clause_order", "key_clause_late_page",
        "older_quoted_lease", "repeated_footer_date",
    )
    reports = {}
    for mode in modes:
        correct = Counter()
        totals = Counter()
        blank_reasons = Counter()
        wrong_examples: dict[str, list[dict[str, Any]]] = {
            role: [] for role in FIELD_COLUMNS
        }
        for doc in selected_docs:
            doc_id = doc["doc_id"]
            mutated_pages = _mutate_pages(
                mode, pages_by_doc[doc_id], candidates_by_doc[doc_id], rng
            )
            candidates = finder(mutated_pages)
            prediction = predictor.predict_lease(candidates)
            run = _run_reconcile(prediction, candidates, doc["document"]["status_as_of"])
            rec = run["reconciliation"]
            actual = {
                "lease_start": rec["start"],
                "lease_end": rec["end"],
                "term_value": str(rec["term_months"] or ""),
            }
            for role, expected_column in FIELD_COLUMNS.items():
                expected = doc["expected"][expected_column]
                if expected:
                    totals[role] += 1
                    correct[role] += actual[role] == expected
                result = prediction["roles"][role]
                if result["confidence"] == 0.0:
                    blank_reasons[f"{role}:{result['blank_reason']}"] += 1
                if actual[role] != doc["expected"][expected_column]:
                    chosen = run["selected_candidates"][role]
                    if len(wrong_examples[role]) < 10:
                        wrong_examples[role].append({
                            "doc_id": doc_id,
                            "expected": doc["expected"][expected_column],
                            "actual": actual[role],
                            "candidate_id": str(chosen.get("cand_id", "")) if chosen else "",
                            "candidate_text": str(chosen.get("text", "")) if chosen else "",
                            "candidate_value": str(chosen.get("value", "")) if chosen else "",
                            "blank_reason": result["blank_reason"],
                        })
        reports[mode] = {
            "documents": len(selected_docs),
            "field_accuracy": {
                role: {
                    "correct": int(correct[role]),
                    "total": int(totals[role]),
                    "accuracy": correct[role] / totals[role] if totals[role] else 0.0,
                }
                for role in FIELD_COLUMNS
            },
            "blank_reason_counts": dict(blank_reasons),
            "wrong_candidate_examples": wrong_examples,
        }
    return reports


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATASET)
    parser.add_argument("--output", type=Path, default=REPORT_PATH)
    parser.add_argument("--no-stress", action="store_true")
    parser.add_argument("--no-samples", action="store_true")
    args = parser.parse_args()
    report = evaluate(
        args.data_dir, args.output, not args.no_stress, not args.no_samples
    )
    print(json.dumps({
        "report": str(args.output),
        "test_documents": report["test_documents"],
        "candidate_class_macro_f1": report["candidate_class_macro_f1"],
        "field_exact_match": report["field_exact_match"],
        "end_to_end_accuracy": report["end_to_end_accuracy"],
        "ambiguous_date_blank_rate": report["ambiguous_date_blank_rate"],
        "worst_three_layouts": report["worst_three_layouts"],
    }, indent=2))


if __name__ == "__main__":
    main()
