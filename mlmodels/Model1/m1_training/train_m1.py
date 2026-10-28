#!/usr/bin/env python3
"""Train, calibrate, evaluate, and package M1 using only local files."""

from __future__ import annotations

import json
import random
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import sklearn
from sklearn.calibration import CalibratedClassifierCV
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import FeatureUnion, Pipeline

from config import (
    AMBER,
    ARTIFACT_DIR,
    ARTIFACT_PATH,
    CLASSES,
    DATA_DIR,
    GREEN,
    PARAMETER_GRID,
    REPORT_DIR,
    SEED,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ocr"))
from m1_text import normalize_for_m1  # noqa: E402

KEYWORDS = (
    "lease",
    "lessor",
    "lessee",
    "fire",
    "structural",
    "accredit",
    "audit",
    "occupancy",
    "approval",
)
OCR_CONFUSIONS = {
    "a": "4",
    "e": "c",
    "i": "l",
    "o": "0",
    "s": "5",
    "t": "f",
    "l": "1",
    "0": "o",
}
OCR_FALLBACK_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def _read_split(name: str) -> pd.DataFrame:
    path = DATA_DIR / f"m1_{name}.csv"
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    if frame.empty or frame[["text", "label", "quality", "layout_id"]].isna().any().any():
        raise ValueError(f"{path} is empty or contains missing required values")
    frame["normalized"] = frame["text"].map(normalize_for_m1)
    return frame


def _build_estimator(params: dict[str, Any]) -> Pipeline:
    features = FeatureUnion(
        [
            (
                "word",
                TfidfVectorizer(
                    analyzer="word",
                    ngram_range=tuple(params["word_ngram_range"]),
                    sublinear_tf=True,
                    min_df=2,
                    strip_accents="unicode",
                    dtype=np.float32,
                ),
            ),
            (
                "char",
                TfidfVectorizer(
                    analyzer="char_wb",
                    ngram_range=tuple(params["char_ngram_range"]),
                    sublinear_tf=True,
                    min_df=2,
                    dtype=np.float32,
                ),
            ),
        ]
    )
    return Pipeline(
        [
            ("features", features),
            (
                "classifier",
                LogisticRegression(
                    C=float(params["C"]),
                    class_weight="balanced",
                    max_iter=2000,
                    random_state=SEED,
                    solver="lbfgs",
                ),
            ),
        ]
    )


def _ece(
    probabilities: np.ndarray,
    y_true: np.ndarray,
    classes: np.ndarray,
    bins: int = 10,
) -> tuple[float, list[dict[str, Any]]]:
    confidence = probabilities.max(axis=1)
    predicted = classes[probabilities.argmax(axis=1)]
    correct = (predicted == y_true).astype(float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    table: list[dict[str, Any]] = []
    total = max(1, len(confidence))
    ece = 0.0
    for index in range(bins):
        lower, upper = float(edges[index]), float(edges[index + 1])
        mask = (confidence >= lower) & (
            confidence <= upper if index == bins - 1 else confidence < upper
        )
        count = int(mask.sum())
        mean_conf = float(confidence[mask].mean()) if count else None
        accuracy = float(correct[mask].mean()) if count else None
        if count:
            ece += count / total * abs(mean_conf - accuracy)
        table.append(
            {
                "bin": f"{lower:.1f}-{upper:.1f}",
                "count": count,
                "mean_confidence": mean_conf,
                "accuracy": accuracy,
            }
        )
    return float(ece), table


def _zone_report(
    probabilities: np.ndarray,
    y_true: np.ndarray,
    classes: np.ndarray,
) -> dict[str, Any]:
    confidence = probabilities.max(axis=1)
    prediction = classes[probabilities.argmax(axis=1)]
    zones = np.where(confidence >= GREEN, "green", np.where(confidence >= AMBER, "amber", "red"))
    result: dict[str, Any] = {}
    for zone in ("green", "amber", "red"):
        mask = zones == zone
        result[zone] = {
            "count": int(mask.sum()),
            "coverage": float(mask.mean()) if len(mask) else 0.0,
            "accuracy": float((prediction[mask] == y_true[mask]).mean()) if mask.any() else None,
        }
    return result


def _evaluate(
    model: CalibratedClassifierCV,
    frame: pd.DataFrame,
) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    x_values = frame["normalized"].tolist()
    labels = frame["label"].to_numpy()
    probabilities = model.predict_proba(x_values)
    predictions = model.classes_[probabilities.argmax(axis=1)]
    report = classification_report(
        labels,
        predictions,
        labels=list(CLASSES),
        output_dict=True,
        zero_division=0,
    )
    per_quality = {
        quality: {
            "count": int(mask.sum()),
            "macro_f1": float(f1_score(labels[mask], predictions[mask], labels=list(CLASSES), average="macro", zero_division=0)),
        }
        for quality in ("clean", "scanned", "skewed", "blurred")
        if (mask := frame["quality"].to_numpy() == quality).any()
    }
    ece, reliability = _ece(probabilities, labels, model.classes_)
    labels_report = {
        label: {
            "precision": float(report[label]["precision"]),
            "recall": float(report[label]["recall"]),
            "f1": float(report[label]["f1-score"]),
            "support": int(report[label]["support"]),
        }
        for label in CLASSES
    }
    return (
        {
            "accuracy": float(accuracy_score(labels, predictions)),
            "macro_f1": float(f1_score(labels, predictions, labels=list(CLASSES), average="macro", zero_division=0)),
            "per_class": labels_report,
            "per_quality": per_quality,
            "zones": _zone_report(probabilities, labels, model.classes_),
            "ece": ece,
            "reliability": reliability,
            "confusion_matrix": confusion_matrix(labels, predictions, labels=list(CLASSES)).tolist(),
            "predictions": predictions.tolist(),
            "probabilities": probabilities,
        },
        predictions,
        probabilities,
    )


def _select_parameters(train: pd.DataFrame, tune: pd.DataFrame) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    best: dict[str, Any] | None = None
    results: list[dict[str, Any]] = []
    for params in PARAMETER_GRID:
        candidate = _build_estimator(params)
        candidate.fit(train["normalized"].tolist(), train["label"].to_numpy())
        predicted = candidate.predict(tune["normalized"].tolist())
        score = float(
            f1_score(tune["label"], predicted, labels=list(CLASSES), average="macro", zero_division=0)
        )
        results.append({"params": params, "tuning_macro_f1": score})
        print(f"validation grid {params}: macro-F1={score:.6f}", file=sys.stderr)
        if best is None or score > best["tuning_macro_f1"]:
            best = {"params": params, "tuning_macro_f1": score}
    assert best is not None
    return best["params"], results


def _group_cv(train: pd.DataFrame, params: dict[str, Any]) -> dict[str, float]:
    splitter = GroupKFold(n_splits=5)
    scores = []
    for fold, (train_idx, valid_idx) in enumerate(
        splitter.split(train["normalized"], train["label"], groups=train["layout_id"]), start=1
    ):
        model = _build_estimator(params)
        model.fit(train["normalized"].iloc[train_idx].tolist(), train["label"].iloc[train_idx])
        predicted = model.predict(train["normalized"].iloc[valid_idx].tolist())
        score = float(
            f1_score(
                train["label"].iloc[valid_idx],
                predicted,
                labels=list(CLASSES),
                average="macro",
                zero_division=0,
            )
        )
        scores.append(score)
        print(f"group CV fold {fold}/5: macro-F1={score:.6f}", file=sys.stderr)
    return {
        "fold_scores": scores,
        "mean_macro_f1": float(np.mean(scores)),
        "std_macro_f1": float(np.std(scores, ddof=1)),
        "folds": 5,
        "group": "layout_id",
    }


def _keyword_ablation(text: str) -> str:
    pattern = re.compile(r"\b(?:" + "|".join(re.escape(word) for word in KEYWORDS) + r")\w*\b", re.I)
    return re.sub(r"\s+", " ", pattern.sub(" ", text)).strip()


def _corrupt_ocr(text: str, rate: float, rng: random.Random) -> str:
    chars = list(text)
    eligible = [index for index, char in enumerate(chars) if char.isalnum()]
    count = int(len(chars) * rate)
    if count <= 0 or not eligible:
        return text
    positions = rng.sample(eligible, min(count, len(eligible)))
    for index in positions:
        original = chars[index]
        replacement = OCR_CONFUSIONS.get(original.lower())
        if replacement is None:
            alphabet_index = OCR_FALLBACK_ALPHABET.index(original.lower())
            replacement = OCR_FALLBACK_ALPHABET[(alphabet_index + 1) % len(OCR_FALLBACK_ALPHABET)]
        chars[index] = replacement.upper() if original.isupper() else replacement
    return "".join(chars)


def _stress_tests(model: CalibratedClassifierCV, test: pd.DataFrame) -> dict[str, Any]:
    original = test["normalized"].tolist()
    labels = test["label"].to_numpy()

    def measure(texts: list[str]) -> float:
        predictions = model.predict(texts)
        return float(f1_score(labels, predictions, labels=list(CLASSES), average="macro", zero_division=0))

    baseline = measure(original)
    ablated = measure([_keyword_ablation(text) for text in original])
    results: dict[str, Any] = {
        "keyword_ablation": {
            "macro_f1": ablated,
            "drop_from_test_macro_f1": baseline - ablated,
            "keywords_removed": list(KEYWORDS),
        }
    }
    for rate in (0.03, 0.06):
        rng = random.Random(SEED + int(rate * 100))
        corrupted = [_corrupt_ocr(text, rate, rng) for text in original]
        score = measure(corrupted)
        results[f"extra_ocr_noise_{int(rate * 100)}pct"] = {
            "macro_f1": score,
            "drop_from_test_macro_f1": baseline - score,
        }
    truncated = [" ".join(text.split()[: max(1, int(len(text.split()) * 0.4))]) for text in original]
    truncated_score = measure(truncated)
    results["first_40_percent_truncation"] = {
        "macro_f1": truncated_score,
        "drop_from_test_macro_f1": baseline - truncated_score,
    }
    return results


def _save_confusion_matrix(matrix: list[list[int]], path: Path, title: str) -> None:
    figure, axis = plt.subplots(figsize=(11, 9))
    image = axis.imshow(matrix, interpolation="nearest", cmap="Blues")
    figure.colorbar(image, ax=axis, fraction=0.046, pad=0.04)
    axis.set(
        xticks=np.arange(len(CLASSES)),
        yticks=np.arange(len(CLASSES)),
        xticklabels=CLASSES,
        yticklabels=CLASSES,
        ylabel="True label",
        xlabel="Predicted label",
        title=title,
    )
    plt.setp(axis.get_xticklabels(), rotation=35, ha="right", rotation_mode="anchor")
    threshold = max((max(row) for row in matrix), default=0) / 2
    for row in range(len(CLASSES)):
        for column in range(len(CLASSES)):
            axis.text(column, row, matrix[row][column], ha="center", va="center", color="white" if matrix[row][column] > threshold else "#14325c")
    figure.tight_layout()
    figure.savefig(path, dpi=160)
    plt.close(figure)


def _write_misclassified(
    frame: pd.DataFrame,
    predictions: np.ndarray,
    probabilities: np.ndarray,
    path: Path,
) -> list[dict[str, Any]]:
    rows = []
    for index, predicted in enumerate(predictions):
        true = frame.iloc[index]["label"]
        if true == predicted:
            continue
        rows.append(
            {
                "doc_id": frame.iloc[index]["doc_id"],
                "true_label": true,
                "predicted_label": predicted,
                "confidence": float(probabilities[index].max()),
                "text_preview": frame.iloc[index]["text"][:200],
            }
        )
    pd.DataFrame(rows, columns=["doc_id", "true_label", "predicted_label", "confidence", "text_preview"]).to_csv(path, index=False)
    return rows


def _markdown_metrics(name: str, metrics: dict[str, Any]) -> str:
    rows = [
        f"### {name}",
        "",
        f"- Accuracy: **{metrics['accuracy']:.4f}**",
        f"- Macro-F1: **{metrics['macro_f1']:.4f}**",
        f"- Expected calibration error (10 bins): **{metrics['ece']:.4f}**",
        "",
        "| Class | Precision | Recall | F1 | Support |",
        "|---|---:|---:|---:|---:|",
    ]
    for label in CLASSES:
        item = metrics["per_class"][label]
        rows.append(f"| {label} | {item['precision']:.4f} | {item['recall']:.4f} | {item['f1']:.4f} | {item['support']} |")
    rows.extend(["", "| Quality | Count | Macro-F1 |", "|---|---:|---:|"])
    for quality, item in metrics["per_quality"].items():
        rows.append(f"| {quality} | {item['count']} | {item['macro_f1']:.4f} |")
    rows.extend(["", "| Zone | Count | Coverage | Accuracy |", "|---|---:|---:|---:|"])
    for zone, item in metrics["zones"].items():
        accuracy = "n/a" if item["accuracy"] is None else f"{item['accuracy']:.4f}"
        rows.append(f"| {zone} | {item['count']} | {item['coverage']:.2%} | {accuracy} |")
    rows.extend(["", "| Confidence bin | Count | Mean confidence | Accuracy |", "|---|---:|---:|---:|"])
    for item in metrics["reliability"]:
        conf = "n/a" if item["mean_confidence"] is None else f"{item['mean_confidence']:.4f}"
        acc = "n/a" if item["accuracy"] is None else f"{item['accuracy']:.4f}"
        rows.append(f"| {item['bin']} | {item['count']} | {conf} | {acc} |")
    return "\n".join(rows)


def main() -> None:
    random.seed(SEED)
    np.random.seed(SEED)
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    validator = DATA_DIR / "validate_dataset.py"
    subprocess.run(
        [sys.executable, str(validator)],
        check=True,
        stdout=sys.stderr,
        stderr=sys.stderr,
        text=True,
    )
    train = _read_split("train")
    validation = _read_split("val")
    test = _read_split("test")
    if set(train["layout_id"]) & set(validation["layout_id"]) or set(train["layout_id"]) & set(test["layout_id"]) or set(validation["layout_id"]) & set(test["layout_id"]):
        raise ValueError("Layout leakage detected between dataset splits")
    if set(train["label"]) != set(CLASSES):
        raise ValueError("Training labels do not match configured classes")

    tune_indices, calibration_indices = next(
        GroupKFold(n_splits=2).split(
            validation["normalized"],
            validation["label"],
            groups=validation["layout_id"],
        )
    )
    tune = validation.iloc[tune_indices]
    calibration = validation.iloc[calibration_indices]
    if set(tune["label"]) != set(CLASSES) or set(calibration["label"]) != set(CLASSES):
        raise ValueError("Both validation partitions must include every class for tuning and calibration")
    params, grid_results = _select_parameters(train, tune)
    selected = _build_estimator(params)
    selected.fit(train["normalized"].tolist(), train["label"].to_numpy())

    # Calibration is fitted only on the held-out half of the validation split.
    calibrated = CalibratedClassifierCV(FrozenEstimator(selected), method="sigmoid")
    calibrated.fit(calibration["normalized"].tolist(), calibration["label"].to_numpy())
    joblib.dump(
        {
            "model": calibrated,
            "classes": list(selected.classes_),
            "parameters": params,
            "model_version": "m1-v1.0.0",
            "thresholds": {"GREEN": GREEN, "AMBER": AMBER},
            "seed": SEED,
            "sklearn_version": sklearn.__version__,
        },
        ARTIFACT_PATH,
        compress=3,
    )

    cv = _group_cv(train, params)
    validation_metrics, _, _ = _evaluate(calibrated, validation)
    test_metrics, test_predictions, test_probabilities = _evaluate(calibrated, test)
    stress = _stress_tests(calibrated, test)
    other_misclassified = _write_misclassified(
        test[test["label"] == "other"].reset_index(drop=True),
        test_predictions[test["label"].to_numpy() == "other"],
        test_probabilities[test["label"].to_numpy() == "other"],
        REPORT_DIR / "misclassified_test.csv",
    )
    # Keep both split matrices available; the canonical names refer to the test set.
    _save_confusion_matrix(test_metrics["confusion_matrix"], REPORT_DIR / "confusion_matrix.png", "M1 test confusion matrix")
    pd.DataFrame(test_metrics["confusion_matrix"], index=CLASSES, columns=CLASSES).to_csv(REPORT_DIR / "confusion_matrix.csv")
    _save_confusion_matrix(
        validation_metrics["confusion_matrix"],
        REPORT_DIR / "confusion_matrix_validation.png",
        "M1 validation confusion matrix",
    )
    pd.DataFrame(validation_metrics["confusion_matrix"], index=CLASSES, columns=CLASSES).to_csv(
        REPORT_DIR / "confusion_matrix_validation.csv"
    )

    from predict_m1 import predict_file

    sample_predictions = []
    expected_samples = {
        "fire_safety_certificate.pdf": "fire",
        "lease_deed_excerpt.pdf": "lease",
        "approval_letter_sample.pdf": "aicte_approval_letter",
    }
    for sample_path in sorted((Path(__file__).resolve().parents[1] / "samples").iterdir()):
        if not sample_path.is_file():
            continue
        prediction = predict_file(sample_path)
        sample_predictions.append(
            {
                "file": sample_path.name,
                "expected": expected_samples.get(sample_path.name),
                "prediction": prediction,
                "correct": prediction["value"] == expected_samples[sample_path.name]
                if sample_path.name in expected_samples
                else None,
            }
        )
    (REPORT_DIR / "sample_predictions.json").write_text(
        json.dumps(sample_predictions, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    def serializable_metrics(value: dict[str, Any]) -> dict[str, Any]:
        return {key: item for key, item in value.items() if key not in {"predictions", "probabilities"}}

    metrics_json = {
        "model": "M1",
        "model_version": "m1-v1.0.0",
        "dataset": {"synthetic_documents": 9600, "source": "synthetic", "classes": list(CLASSES)},
        "python": sys.version.split()[0],
        "scikit_learn": sklearn.__version__,
        "seed": SEED,
        "selected_parameters": params,
        "validation_grid": grid_results,
        "calibration": {
            "method": "sigmoid",
            "fit_split": "layout-grouped half of validation; model/vectorizers fit on train only",
        },
        "grouped_cross_validation": cv,
        "validation": serializable_metrics(validation_metrics),
        "test": serializable_metrics(test_metrics),
        "stress_tests": stress,
        "sample_predictions": [
            {
                "file": item["file"],
                "expected": item["expected"],
                "predicted": item["prediction"]["value"],
                "confidence": item["prediction"]["confidence"],
                "zone": item["prediction"]["zone"],
                "needs_manual_entry": item["prediction"]["needs_manual_entry"],
                "correct": item["correct"],
            }
            for item in sample_predictions
        ],
        "other_test_misclassified": other_misclassified,
        "targets": {"validation_macro_f1": 0.90, "test_macro_f1": 0.90},
        "target_met": {
            "validation": validation_metrics["macro_f1"] >= 0.90,
            "test": test_metrics["macro_f1"] >= 0.90,
        },
        "honesty": (
            "Works on synthetic data and on layouts unseen in training. A score near 1.0 on "
            "synthetic documents does not predict accuracy on real AICTE documents. Only English "
            "is covered; the broad 'other' class is less varied than real-world documents. "
            "No production accuracy is claimed."
        ),
    }
    (REPORT_DIR / "metrics.json").write_text(json.dumps(metrics_json, indent=2, ensure_ascii=False), encoding="utf-8")

    report = [
        "# M1 document type classifier evaluation",
        "",
        "## Scope and limitations",
        "",
        metrics_json["honesty"],
        "",
        "The dataset is entirely synthetic. To support claims about real documents, add 50–100 "
        "hand-labelled public real documents per class, run the same OCR pipeline, and evaluate "
        "them separately as `real_test`. This model only proposes a document type; a person confirms it.",
        "",
        "## Model and reproducibility",
        "",
        f"- Pipeline: normalized text → word TF-IDF and character `char_wb` TF-IDF → balanced logistic regression → sigmoid probability calibration.",
        f"- Selected parameters: `{json.dumps(params, sort_keys=True)}`",
        f"- Calibration data: layout-held-out half of validation ({len(calibration)} documents).",
        f"- Grouped 5-fold layout CV mean macro-F1: **{cv['mean_macro_f1']:.4f} ± {cv['std_macro_f1']:.4f}**.",
        f"- Macro-F1 targets (0.90): validation **{'met' if metrics_json['target_met']['validation'] else 'not met'}**, test **{'met' if metrics_json['target_met']['test'] else 'not met'}**.",
        "",
        _markdown_metrics("Validation (full validation split)", validation_metrics),
        "",
        _markdown_metrics("Test (used once after model selection)", test_metrics),
        "",
        "## Stress tests",
        "",
        "A negative drop means the ablation scored slightly higher than the clean test baseline on this synthetic split.",
        "",
        "| Stress test | Macro-F1 | Drop from clean test |",
        "|---|---:|---:|",
    ]
    report.extend(
        f"| {name} | {item['macro_f1']:.4f} | {item['drop_from_test_macro_f1']:.4f} |"
        for name, item in stress.items()
    )
    other_report = test_metrics["per_class"]["other"]
    report.extend(
        [
            "",
            "## Other class",
            "",
            f"- Test precision: **{other_report['precision']:.4f}**",
            f"- Test recall: **{other_report['recall']:.4f}**",
            f"- Misclassified `other` rows are in `misclassified_test.csv`, with ids, labels, confidence and a 200-character text preview.",
            "",
            "## Artifacts",
            "",
            "- `metrics.json`: complete machine-readable metrics and confusion matrix.",
            "- `confusion_matrix.png` and `confusion_matrix.csv`: test set.",
            "- `misclassified_test.csv`: test errors for the `other` class.",
            f"- Model artifact: `{ARTIFACT_PATH.relative_to(Path(__file__).resolve().parents[1])}`.",
            "",
            "## Sample document smoke evaluation",
            "",
            "The provided sample documents are evaluated through `predict_m1.py` and recorded in `sample_predictions.json`.",
            "The supplied blurred JPG is also attempted through local OCR; if OCR is unavailable or extraction fails, the safe result is manual entry, not a guessed prediction.",
            "",
            "| File | Expected | Suggested | Confidence | Zone | Result |",
            "|---|---|---|---:|---|---|",
        ]
    )
    report.extend(
        f"| {item['file']} | {item['expected'] or 'not labelled'} | {item['prediction']['value']} | "
        f"{item['prediction']['confidence']:.4f} | {item['prediction']['zone']} | "
        f"{'correct' if item['correct'] is True else 'manual review' if item['prediction']['zone'] == 'red' else 'not labelled'} |"
        for item in sample_predictions
    )
    (REPORT_DIR / "REPORT.md").write_text("\n".join(report) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "validation_macro_f1": validation_metrics["macro_f1"],
                "test_macro_f1": test_metrics["macro_f1"],
                "grouped_cv_mean_macro_f1": cv["mean_macro_f1"],
                "stress_tests": stress,
                "sample_predictions": metrics_json["sample_predictions"],
                "artifact": str(ARTIFACT_PATH),
                "limits": metrics_json["honesty"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
