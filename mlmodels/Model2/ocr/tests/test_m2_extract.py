import sys
from pathlib import Path

import pytest

OCR_DIR = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(OCR_DIR))
sys.path.insert(0, str(REPOSITORY_ROOT / "mlmodels" / "Model1" / "ocr"))

import m2_extract  # noqa: E402
from m2_label_extract import extract_encumbrance_fields, extract_labeled_fields  # noqa: E402


def test_extract_labeled_fields_from_encumbrance_text():
    text = (
        "Certificate number: TEST-ENC-2026-001\n"
        "Search period: 01 September 2016 to 31 August 2026\n"
        "Issue date: 01 September 2026\n"
        "Issuer: Example Land Records Office\n"
    )
    fields = extract_labeled_fields(text)
    assert {name: field["value"] for name, field in fields.items()} == {
        "valid_from": "2016-09-01",
        "valid_to": "2026-08-31",
        "issue_date": "2026-09-01",
        "cert_no": "TEST-ENC-2026-001",
        "issuer": "Example Land Records Office",
    }
    assert extract_encumbrance_fields(text) == {
        "certificate_number": "TEST-ENC-2026-001",
        "valid_from": "01/09/2016",
        "valid_to": "31/08/2026",
        "issue_date": "01/09/2026",
        "issuer": "Example Land Records Office",
    }


@pytest.mark.parametrize("separator", ["to", "TO", "-", "till", "until"])
def test_search_period_supports_documented_separators(separator):
    result = extract_encumbrance_fields(
        f"Search period: 01 September 2016 {separator} 31 August 2026\n"
        "Issue date: 01 September 2026"
    )
    assert result["valid_from"] == "01/09/2016"
    assert result["valid_to"] == "31/08/2026"
    assert result["issue_date"] == "01/09/2026"


def test_search_period_extracts_each_endpoint_independently():
    result = extract_encumbrance_fields(
        "Search period: 32 September 2016 to 31 August 2026\n"
        "Issue date: 32 September 2026"
    )
    assert result["valid_from"] is None
    assert result["valid_to"] == "31/08/2026"
    assert result["issue_date"] is None


def test_search_period_keeps_readable_endpoint_when_other_is_unreadable():
    result = extract_encumbrance_fields(
        "Search period: unreadable OCR text to 31 August 2026"
    )
    assert result["valid_from"] is None
    assert result["valid_to"] == "31/08/2026"


def test_search_period_supports_compact_hyphen_separator():
    result = extract_encumbrance_fields(
        "Search period: 01 September 2016-31 August 2026"
    )
    assert result["valid_from"] == "01/09/2016"
    assert result["valid_to"] == "31/08/2026"


def test_numeric_search_period_uses_required_day_month_year_order():
    fields = extract_labeled_fields(
        "Search period: 01/09/2016 to 31/08/2026\n"
        "Issue date: 01/09/2026\n"
        "Issuer: Example Records Office"
    )
    assert fields["valid_from"]["value"] == "2016-09-01"
    assert fields["valid_to"]["value"] == "2026-08-31"
    assert fields["issue_date"]["value"] == "2026-09-01"
    assert extract_encumbrance_fields(
        "Search period: 01/09/2016 to 31/08/2026\n"
        "Issue date: 01/09/2026\n"
        "Certificate number: TEST-ENC-2026-001\n"
        "Issuer: Example Records Office"
    ) == {
        "certificate_number": "TEST-ENC-2026-001",
        "valid_from": "01/09/2016",
        "valid_to": "31/08/2026",
        "issue_date": "01/09/2026",
        "issuer": "Example Records Office",
    }


def test_encumbrance_json_returns_null_for_missing_fields():
    assert extract_encumbrance_fields("No labelled fields in this document.") == {
        "certificate_number": None,
        "valid_from": None,
        "valid_to": None,
        "issue_date": None,
        "issuer": None,
    }


def test_numeric_encumbrance_dates_reach_m2_fields(monkeypatch):
    monkeypatch.setattr(m2_extract, "_load_predictor", lambda: (None, "M2 unavailable"))
    text = (
        "Certificate number: TEST-ENC-2026-001\n"
        "Search period: 01/09/2016 to 31/08/2026\n"
        "Issue date: 01/09/2026\n"
        "Issuer: Example Land Records Office\n"
    )
    ocr_data = {
        "file": "encumbrance.pdf",
        "supported": True,
        "quarantined": False,
        "quarantine_reason": "",
        "pages": [{
            "page": 1,
            "width": 1,
            "height": 1,
            "source": "embedded",
            "text": text,
            "words": [],
        }],
        "full_text": text,
        "used_ocr": False,
        "mean_ocr_conf": 1.0,
        "warnings": [],
    }

    result = m2_extract.run("encumbrance.pdf", "other", ocr_data=ocr_data)

    assert {
        name: result["fields"][name]["value"]
        for name in ("valid_from", "valid_to", "issue_date")
    } == {
        "valid_from": "2016-09-01",
        "valid_to": "2026-08-31",
        "issue_date": "2026-09-01",
    }
    assert result["encumbrance_fields"] == {
        "certificate_number": "TEST-ENC-2026-001",
        "valid_from": "01/09/2016",
        "valid_to": "31/08/2026",
        "issue_date": "01/09/2026",
        "issuer": "Example Land Records Office",
    }


def test_labeled_dates_survive_m2_prediction_failure(monkeypatch):
    def fail_prediction(_candidates, _doc_type):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(m2_extract, "_load_predictor", lambda: (fail_prediction, ""))
    text = (
        "Search period: 01/09/2016 to 31/08/2026\n"
        "Issue date: 01 September 2026\n"
    )
    ocr_data = {
        "file": "encumbrance.pdf",
        "supported": True,
        "quarantined": False,
        "quarantine_reason": "",
        "pages": [{
            "page": 1,
            "width": 1,
            "height": 1,
            "source": "embedded",
            "text": text,
            "words": [],
        }],
        "full_text": text,
        "used_ocr": False,
        "mean_ocr_conf": 1.0,
        "warnings": [],
    }

    result = m2_extract.run("encumbrance.pdf", "other", ocr_data=ocr_data)

    assert result["fields"]["valid_from"]["value"] == "2016-09-01"
    assert result["fields"]["valid_to"]["value"] == "2026-08-31"
    assert result["fields"]["issue_date"]["value"] == "2026-09-01"
    assert result["encumbrance_fields"]["valid_from"] == "01/09/2016"
    assert result["encumbrance_fields"]["valid_to"] == "31/08/2026"
    assert result["encumbrance_fields"]["issue_date"] == "01/09/2026"
    assert result["manual_entry_required"] is True


def test_explicit_fields_are_available_when_m2_model_is_unavailable(monkeypatch):
    monkeypatch.setattr(m2_extract, "_load_predictor", lambda: (None, "M2 unavailable"))
    document = REPOSITORY_ROOT / "test-documents" / "conversion_diploma_to_degree" / "CONDITIONAL_encumbrance_certificate_SYNTHETIC.pdf"
    result = m2_extract.run(str(document), "other")
    assert result["model_available"] is False
    assert {name: result["fields"][name]["value"] for name in (
        "valid_from", "valid_to", "issue_date", "cert_no", "issuer",
    )} == {
        "valid_from": "2016-09-01",
        "valid_to": "2026-08-31",
        "issue_date": "2026-09-01",
        "cert_no": "TEST-ENC-2026-001",
        "issuer": "Example Land Records Office",
    }
    assert result["encumbrance_fields"] == {
        "certificate_number": "TEST-ENC-2026-001",
        "valid_from": "01/09/2016",
        "valid_to": "31/08/2026",
        "issue_date": "01/09/2026",
        "issuer": "Example Land Records Office",
    }
    assert all(result["fields"][name]["needs_confirmation"] for name in (
        "valid_from", "valid_to", "issue_date", "cert_no", "issuer",
    ))


def test_precomputed_ocr_data_skips_file_ocr(monkeypatch):
    ocr_data = {
        "file": "unused.pdf",
        "supported": True,
        "quarantined": False,
        "quarantine_reason": "",
        "pages": [{
            "page": 1,
            "width": 1,
            "height": 1,
            "source": "embedded",
            "text": "Fire safety certificate issued by the regional fire authority",
            "words": [],
        }],
        "full_text": "Fire safety certificate issued by the regional fire authority",
        "used_ocr": False,
        "mean_ocr_conf": 0.99,
        "warnings": [],
    }
    monkeypatch.setattr(
        m2_extract.ocr_extract,
        "extract_document",
        lambda _path: pytest.fail("M2 must reuse precomputed OCR data"),
    )
    result = m2_extract.run("unused.pdf", "fire", ocr_data=ocr_data)
    assert result["supported"] is True
    assert result["pages"][0]["page"] == 1


@pytest.mark.parametrize(
    ("application_type", "filename", "doc_type", "expected"),
    [
        (
            "conversion_diploma_to_degree",
            "CONDITIONAL_encumbrance_certificate_SYNTHETIC.pdf",
            "other",
            {
                "valid_from": "2016-09-01",
                "valid_to": "2026-08-31",
                "issue_date": "2026-09-01",
                "cert_no": "TEST-ENC-2026-001",
                "issuer": "Example Land Records Office",
            },
        ),
        (
            "conversion_diploma_to_degree",
            "REQUIRED_fire_SYNTHETIC.pdf",
            "fire",
            {
                "issue_date": "2023-10-03",
                "cert_no": "FS/2023/54873",
                "issuer": "Regional Fire Officer, Greenvale",
            },
        ),
        (
            "conversion_diploma_to_degree",
            "CONDITIONAL_lease_SYNTHETIC.pdf",
            "lease",
            {
                "issue_date": "2014-10-12",
                "cert_no": "REG/2014/78384",
                "issuer": "Demopur",
            },
        ),
        (
            "conversion_diploma_to_degree",
            "CONDITIONAL_structural_SYNTHETIC.pdf",
            "structural",
            {
                "valid_to": "2036-04-11",
            },
        ),
    ],
)
def test_explicit_document_labels_override_conflicting_model_ranks(application_type, filename, doc_type, expected):
    document = REPOSITORY_ROOT / "test-documents" / application_type / filename
    assert document.is_file()
    result = m2_extract.run(str(document), doc_type)
    assert result["supported"] is True
    assert result["model_available"] is True
    for name, value in expected.items():
        assert result["fields"][name]["value"] == value
        assert result["fields"][name]["needs_confirmation"] is True
    if filename == "CONDITIONAL_encumbrance_certificate_SYNTHETIC.pdf":
        assert result["encumbrance_fields"] == {
            "certificate_number": "TEST-ENC-2026-001",
            "valid_from": "01/09/2016",
            "valid_to": "31/08/2026",
            "issue_date": "01/09/2026",
            "issuer": "Example Land Records Office",
        }
