import os
import sys
from types import SimpleNamespace

import numpy as np

MODEL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OCR_DIR = os.path.join(MODEL_DIR, "ocr")
MLMODELS_OCR_DIR = os.path.abspath(os.path.join(MODEL_DIR, "..", "Model1", "ocr"))
for path in (MODEL_DIR, OCR_DIR, MLMODELS_OCR_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

import m2_common
import m2_predict


class FixedCalibrator:
    def __init__(self, classes, rows):
        self.classes_ = np.asarray(classes)
        self.rows = np.asarray(rows, dtype=float)

    def predict_proba(self, estimator, frame):
        if len(self.rows) == 1:
            return np.repeat(self.rows, len(frame), axis=0)
        assert len(frame) == len(self.rows)
        return self.rows.copy()


def _model(date_probabilities=((0.8, 0.1, 0.1),)):
    models = {}
    for kind, classes in m2_common.KIND_ROLES.items():
        if kind == "date":
            probs = date_probabilities
        else:
            probs = ((0.1, 0.9),)
        models[kind] = {
            "estimator": SimpleNamespace(classes_=np.asarray(classes)),
            "calibrator": FixedCalibrator(classes, probs),
            "algorithm": "test-double",
        }
    return {"model_version": "m2-test", "models": models}


def _candidate(cand_id, value, *, kind="date", ambiguous=0, text=None):
    return {
        "cand_id": cand_id,
        "kind": kind,
        "text": text or value,
        "value": value,
        "ambiguous": ambiguous,
        "fmt": "num_slash4",
        "page": 1,
        "word_idx": [cand_id],
        "bbox": [0.1, 0.1, 0.2, 0.12],
        "doc_type": "lease",
        "ctx_left": "Date of issue",
        "ctx_right": "",
        "ctx_above": "",
        "line_text": f"Date of issue {text or value}",
    }


def _install_model(monkeypatch, model):
    monkeypatch.setattr(m2_predict, "_load_model", lambda: model)


def test_output_schema_is_complete_and_requires_confirmation(monkeypatch):
    _install_model(monkeypatch, _model())
    output = m2_predict.predict_fields([_candidate(1, "2026-03-12")], "lease")
    expected_keys = {
        "value", "display", "confidence", "zone", "page", "bbox", "ambiguous",
        "needs_confirmation", "ai_suggested", "candidate_id", "model_version",
        "blank_reason", "why",
    }
    for field in ("issue_date", "valid_to", "cert_no", "issuer"):
        assert set(output[field]) == expected_keys
        assert all(value is not None for value in output[field].values())
        assert output[field]["needs_confirmation"] is True
        assert output[field]["model_version"] == "m2-test"
    assert output["issue_date"]["value"] == "2026-03-12"
    assert output["issue_date"]["ai_suggested"] is True


def test_ambiguous_date_is_left_blank_and_flagged(monkeypatch):
    _install_model(monkeypatch, _model())
    output = m2_predict.predict_fields(
        [_candidate(1, "2027-05-04", ambiguous=1, text="04/05/2027")], "lease"
    )
    assert output["issue_date"]["value"] == ""
    assert output["issue_date"]["ambiguous"] is True
    assert output["issue_date"]["blank_reason"] == "ambiguous_date"
    assert output["issue_date"]["zone"] == "red"


def test_ambiguous_candidate_uses_its_direct_issue_label(monkeypatch):
    _install_model(monkeypatch, _model(((0.8, 0.1, 0.1), (0.2, 0.05, 0.75))))
    candidates = [
        _candidate(1, "2026-03-12"),
        _candidate(2, "2027-05-04", ambiguous=1, text="04/05/2027"),
    ]
    output = m2_predict.predict_fields(candidates, "lease")
    assert output["issue_date"]["value"] == ""
    assert output["issue_date"]["ambiguous"] is True
    assert output["issue_date"]["blank_reason"] == "ambiguous_date"
    assert output["valid_to"]["value"] == ""
    assert output["valid_to"]["ambiguous"] is False


def test_multiple_ambiguous_dates_leave_both_date_fields_for_human_review(monkeypatch):
    _install_model(monkeypatch, _model(((0.6, 0.2, 0.2), (0.2, 0.6, 0.2))))
    candidates = [
        _candidate(1, "2026-03-12", ambiguous=1, text="04/05/2026"),
        _candidate(2, "2027-06-07", ambiguous=1, text="06/07/2027"),
    ]
    output = m2_predict.predict_fields(candidates, "lease")
    for field in ("issue_date", "valid_to"):
        assert output[field]["value"] == ""
        assert output[field]["ambiguous"] is True
        assert output[field]["blank_reason"] == "ambiguous_date"


def test_audited_accounts_without_valid_to_stays_blank(monkeypatch):
    _install_model(monkeypatch, _model())
    output = m2_predict.predict_fields(
        [_candidate(1, "2025-03-12")], "audited_accounts"
    )
    assert output["valid_to"]["value"] == ""
    assert output["valid_to"]["confidence"] == 0.0
    assert output["valid_to"]["ai_suggested"] is False


def test_valid_to_requires_validity_context(monkeypatch):
    _install_model(monkeypatch, _model(((0.1, 0.8, 0.1),)))
    candidate = _candidate(1, "2025-03-12")
    candidate["ctx_left"] = "Printed on:"
    candidate["line_text"] = "Printed on: 12/03/2025"
    output = m2_predict.predict_fields([candidate], "other")
    assert output["valid_to"]["value"] == ""
    assert output["valid_to"]["blank_reason"] == "no_validity_context"


def test_invalid_date_order_blanks_lower_confidence_field(monkeypatch):
    _install_model(monkeypatch, _model(((0.8, 0.1, 0.1), (0.1, 0.8, 0.1))))
    valid = _candidate(2, "2026-05-01")
    valid["ctx_left"] = "Valid until:"
    valid["line_text"] = "Valid until: 2026-05-01"
    output = m2_predict.predict_fields(
        [_candidate(1, "2027-05-01"), valid], "lease"
    )
    assert output["issue_date"]["value"] == ""
    assert output["issue_date"]["blank_reason"] == "date_order_check_failed"
    assert output["valid_to"]["value"] == "2026-05-01"


def test_valid_to_after_issue_date_is_kept(monkeypatch):
    _install_model(monkeypatch, _model(((0.8, 0.1, 0.1), (0.1, 0.8, 0.1))))
    issue = _candidate(1, "2025-05-01")
    valid = _candidate(2, "2026-05-01")
    valid["ctx_left"] = "Valid until:"
    valid["line_text"] = "Valid until: 2026-05-01"
    output = m2_predict.predict_fields([issue, valid], "lease")
    assert output["issue_date"]["value"] == "2025-05-01"
    assert output["valid_to"]["value"] == "2026-05-01"


def test_zone_thresholds_are_exact():
    assert m2_common.zone_for(0.5999) == "red"
    assert m2_common.zone_for(0.60) == "amber"
    assert m2_common.zone_for(0.8999) == "amber"
    assert m2_common.zone_for(0.90) == "green"


def test_prediction_is_deterministic(monkeypatch):
    _install_model(monkeypatch, _model())
    candidates = [_candidate(1, "2026-03-12")]
    first = m2_predict.predict_fields(candidates, "lease")
    second = m2_predict.predict_fields(candidates, "lease")
    assert first == second


def test_no_candidates_returns_four_blank_fields(monkeypatch):
    _install_model(monkeypatch, _model())
    output = m2_predict.predict_fields([], "other")
    assert set(output) == {"issue_date", "valid_to", "cert_no", "issuer"}
    for item in output.values():
        assert item["value"] == ""
        assert item["confidence"] == 0.0
        assert item["candidate_id"] == -1
        assert item["ai_suggested"] is False
        assert item["needs_confirmation"] is True


def test_prediction_failure_never_escapes_m2_extract_run(monkeypatch):
    import m2_extract

    monkeypatch.setattr(m2_extract.ocr_extract, "extract_document", lambda path: {
        "file": path, "supported": True, "quarantined": False, "quarantine_reason": "",
        "used_ocr": False, "mean_ocr_conf": 1.0, "pages": [{
            "page": 1, "width": 1.0, "height": 1.0, "source": "test", "words": [],
        }], "warnings": [],
    })

    def fail(_candidates, _doc_type):
        raise RuntimeError("model failure for test")

    monkeypatch.setattr(m2_extract, "_load_predictor", lambda: (fail, ""))
    result = m2_extract.run("test.pdf", "lease")
    assert result["model_available"] is False
    assert result["fields"]["issue_date"]["blank_reason"] == "M2 prediction failed"
    assert any("model failure for test" in message for message in result["warnings"])
