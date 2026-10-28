"""M3 model contract and OCR-wrapper integration tests."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import m3_extract
import m3_predict
from m3_common import find_lease_candidates
from m3_lease import DEMO_AS_OF

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "samples"
MODEL = ROOT / "ocr" / "m3_model.joblib"
pytestmark = pytest.mark.skipif(not MODEL.is_file(), reason="train M3 before running model tests")


def _sample_candidates():
    pages = [{
        "page": 1,
        "text": (
            "LEASE DEED\nThe lease shall commence from 12 March 2026.\n"
            "The term of this lease shall be nine years."
        ),
    }]
    return find_lease_candidates(pages)


def _assert_no_null(value):
    if isinstance(value, dict):
        assert all(item is not None for item in value.values())
        for item in value.values():
            _assert_no_null(item)
    elif isinstance(value, list):
        for item in value:
            _assert_no_null(item)


def test_predict_output_shape_and_no_nulls():
    result = m3_predict.predict_lease(_sample_candidates())
    assert set(result) == {"model_version", "roles"}
    assert set(result["roles"]) == {"lease_start", "lease_end", "term_value"}
    for role in result["roles"].values():
        assert set(role) == {"candidate_id", "confidence", "blank_reason"}
        assert isinstance(role["candidate_id"], (str, int))
        assert isinstance(role["confidence"], float)
        assert isinstance(role["blank_reason"], str)
        assert 0.0 <= role["confidence"] <= 1.0
    _assert_no_null(result)


def test_ambiguous_date_candidate_is_always_blank():
    candidates = find_lease_candidates([{
        "page": 1,
        "text": "The lease shall commence from 04/05/2027.",
    }])
    assert candidates and candidates[0]["ambiguous"] == 1
    result = m3_predict.predict_lease(candidates)
    for role in ("lease_start", "lease_end"):
        assert result["roles"][role]["confidence"] == 0.0
        assert result["roles"][role]["blank_reason"] in {"low_confidence", "ambiguous_date"}
        if result["roles"][role]["blank_reason"] == "ambiguous_date":
            assert result["roles"][role]["candidate_id"] == candidates[0]["cand_id"]
        else:
            assert result["roles"][role]["candidate_id"] == ""

    for role in ("lease_start", "lease_end"):
        picked = m3_predict._pick_role(candidates, np.array([[0.95]]), role, 0)
        assert picked == {
            "candidate_id": candidates[0]["cand_id"],
            "confidence": 0.0,
            "blank_reason": "ambiguous_date",
        }


def test_no_candidates_returns_three_blanks():
    result = m3_predict.predict_lease([])
    assert all(
        field == {"candidate_id": "", "confidence": 0.0, "blank_reason": "not_found"}
        for field in result["roles"].values()
    )


def test_prediction_is_deterministic():
    candidates = _sample_candidates()
    assert m3_predict.predict_lease(candidates) == m3_predict.predict_lease(candidates)


def test_real_model_runs_through_m3_extract_build_result():
    sample = SAMPLES / "02_start_and_term_derive_end.pdf"
    result = m3_extract.build_result(
        str(sample), "lease", DEMO_AS_OF, 30, with_candidates=True
    )
    assert result["model_loaded"] is True
    assert result["model_version"].startswith("m3-")
    assert result["candidates"]
    assert result["preview_status"]["counts_toward_score"] is False
    assert result["preview_status"]["requires_person_confirmation"] is True
    assert result["reconciliation"]["state"] in {
        "ok", "derived", "inconsistent", "needs_review"
    }
    json.dumps(result)
    _assert_no_null(result)


def test_ambiguous_end_remains_blank_after_reconciliation():
    sample = SAMPLES / "05_ambiguous_numeric_date.pdf"
    result = m3_extract.build_result(str(sample), "lease", DEMO_AS_OF, 30)
    assert result["fields"]["lease_start"]["value"] == ""
    assert result["fields"]["lease_end"]["value"] == ""
    assert result["fields"]["lease_start"]["blank_reason"] == "ambiguous_date"
    assert result["fields"]["lease_end"]["blank_reason"] == "ambiguous_date"
    assert result["reconciliation"]["state"] == "needs_review"
