from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

TRAIN_DIR = Path(__file__).resolve().parents[1]
ROOT = TRAIN_DIR.parent
sys.path.insert(0, str(TRAIN_DIR))

import predict_m1  # noqa: E402
from config import CLASSES, SAMPLES_DIR  # noqa: E402


EXPECTED_KEYS = {
    "model",
    "model_version",
    "field",
    "ai_suggested",
    "value",
    "display_name",
    "confidence",
    "zone",
    "prefill",
    "top3",
    "ocr",
    "needs_manual_entry",
    "message",
}


def _result(confidence: float, words: int = 20) -> dict:
    probabilities = [confidence] + [
        (1 - confidence) / (len(CLASSES) - 1)
    ] * (len(CLASSES) - 1)
    return predict_m1._prediction_from_probabilities(
        probabilities,
        list(CLASSES),
        word_count=words,
    )


def test_prediction_json_contract_types() -> None:
    result = predict_m1.predict("A lease deed made between a fictional lessor and lessee.")
    assert set(result) == EXPECTED_KEYS
    assert isinstance(result["model"], str)
    assert isinstance(result["model_version"], str)
    assert isinstance(result["field"], str)
    assert isinstance(result["ai_suggested"], bool)
    assert isinstance(result["value"], str)
    assert isinstance(result["display_name"], str)
    assert isinstance(result["confidence"], float)
    assert isinstance(result["zone"], str)
    assert isinstance(result["prefill"], bool)
    assert isinstance(result["top3"], list)
    assert isinstance(result["ocr"], dict)
    assert isinstance(result["needs_manual_entry"], bool)
    assert result["message"] is None or isinstance(result["message"], str)
    assert set(result["ocr"]) == {"used_ocr", "mean_ocr_conf", "pages", "warnings"}


@pytest.mark.parametrize(
    ("confidence", "zone", "prefill"),
    [
        (0.90, "green", True),
        (0.89, "amber", True),
        (0.60, "amber", True),
        (0.59, "red", False),
    ],
)
def test_confidence_zone_boundaries(confidence: float, zone: str, prefill: bool) -> None:
    result = _result(confidence)
    assert result["zone"] == zone
    assert result["prefill"] is prefill


def test_short_text_is_red_even_with_high_confidence() -> None:
    result = _result(0.99, words=14)
    assert result["zone"] == "red"
    assert result["prefill"] is False
    assert any("Fewer than 15 words" in warning for warning in result["ocr"]["warnings"])


def test_low_ocr_confidence_reduces_confidence_and_adds_warning() -> None:
    result = predict_m1._prediction_from_probabilities(
        [0.95] + [0.05 / (len(CLASSES) - 1)] * (len(CLASSES) - 1),
        list(CLASSES),
        word_count=25,
        used_ocr=True,
        mean_ocr_conf=0.30,
    )
    assert result["confidence"] == pytest.approx(0.475)
    assert result["zone"] == "red"
    assert result["prefill"] is False
    assert any("Low OCR confidence" in warning for warning in result["ocr"]["warnings"])


def test_same_text_has_deterministic_prediction() -> None:
    text = "FIRE SAFETY CERTIFICATE Demo regional fire service certificate valid through March 2027."
    assert predict_m1.predict(text) == predict_m1.predict(text)


@pytest.mark.parametrize(
    ("filename", "expected_label"),
    [
        ("fire_safety_certificate.pdf", "fire"),
        ("lease_deed_excerpt.pdf", "lease"),
        ("approval_letter_sample.pdf", "aicte_approval_letter"),
    ],
)
def test_sample_pdfs_are_classified(filename: str, expected_label: str) -> None:
    result = predict_m1.predict_file(SAMPLES_DIR / filename)
    assert result["value"] == expected_label
    assert result["needs_manual_entry"] is False
    assert result["ocr"]["warnings"] == []


def test_blurred_image_uses_local_ocr_and_red_confidence_zone() -> None:
    result = predict_m1.predict_file(SAMPLES_DIR / "blurred_scan_ambiguous_date.jpg")
    assert result["ocr"]["used_ocr"] is True
    assert result["ocr"]["mean_ocr_conf"] < 0.60
    assert result["zone"] == "red"
    assert result["prefill"] is False
    assert any("Low OCR confidence" in warning for warning in result["ocr"]["warnings"])


def test_missing_file_returns_manual_entry_and_exit_code_2(capsys: pytest.CaptureFixture) -> None:
    missing = SAMPLES_DIR / "not-present.pdf"
    assert predict_m1.predict_file(missing)["needs_manual_entry"] is True
    assert predict_m1.main(["--file", str(missing)]) == 2
    output = capsys.readouterr().out
    assert json.loads(output)["needs_manual_entry"] is True


def test_renamed_executable_is_quarantined_and_exit_code_2(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    disguised = tmp_path / "certificate.pdf"
    disguised.write_bytes(b"MZ" + b"\x00" * 64)
    result = predict_m1.predict_file(disguised)
    assert result["needs_manual_entry"] is True
    assert "quarantined" in result["message"].lower()
    assert predict_m1.main(["--file", str(disguised)]) == 2
    assert json.loads(capsys.readouterr().out)["needs_manual_entry"] is True


def test_sample_predictions_are_persisted_by_training_run() -> None:
    sample_report = TRAIN_DIR / "reports" / "sample_predictions.json"
    if not sample_report.exists():
        pytest.skip("Run python train_m1.py first to generate sample prediction report.")
    predictions = json.loads(sample_report.read_text(encoding="utf-8"))
    by_file = {item["file"]: item for item in predictions}
    for filename in (
        "fire_safety_certificate.pdf",
        "lease_deed_excerpt.pdf",
        "approval_letter_sample.pdf",
    ):
        assert by_file[filename]["correct"] is True
    blurred = by_file["blurred_scan_ambiguous_date.jpg"]["prediction"]
    assert blurred["zone"] == "red"
    assert blurred["prefill"] is False
