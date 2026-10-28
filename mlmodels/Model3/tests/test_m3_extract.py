"""End-to-end tests for m3_extract.py with a stub predictor (the real model is trained later)."""
import json
import random

import pytest

fitz = pytest.importorskip("fitz")
reportlab = pytest.importorskip("reportlab")

import generate_m3_dataset as g                      # noqa: E402
import m3_extract                                    # noqa: E402
from m3_lease import DEMO_AS_OF                      # noqa: E402


def make_pdf(path, pages):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(path), pagesize=A4)
    for text in pages:
        t = c.beginText(36, 800)
        t.setFont("Courier", 8)
        for line in text.split("\n"):
            t.textLine(line)
        c.drawText(t)
        c.showPage()
    c.save()


def oracle(deed):
    """Stub predictor: picks the candidates whose text was registered as the key roles."""
    reg = deed["reg"]

    def predict(cands):
        roles = {}
        for role in ("lease_start", "lease_end", "term_value"):
            hit = next((c for c in cands if reg.get((c["kind"], c["text"])) == role), None)
            roles[role] = ({"candidate_id": hit["cand_id"], "confidence": 0.95, "blank_reason": ""}
                           if hit else {"candidate_id": "", "confidence": 0.0, "blank_reason": "not_found"})
        return {"model_version": "stub-oracle", "roles": roles}
    return predict


def deed_for(scenario, want_ambiguous=False, tries=4000):
    L = g.make_layouts(7)
    rnd = random.Random(99)
    for k in range(tries):
        try:
            d = g.build_deed(rnd, L[k % 16], k)
            _c, s_amb, e_amb = g.label_and_check(d)
        except g.Skip:
            continue
        if d["scenario"] == scenario and (s_amb or e_amb) == want_ambiguous:
            return d
    pytest.skip("no such deed")


@pytest.mark.parametrize("scenario", ["A", "B", "C"])
def test_pdf_pipeline_unambiguous(tmp_path, scenario):
    d = deed_for(scenario)
    pdf = tmp_path / "lease.pdf"
    make_pdf(pdf, d["pages"])
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30, predictor=oracle(d))
    assert out["schema"] == "m3-output-1" and out["model_loaded"] and out["page_count"] == d["n_pages"]
    f = out["fields"]
    assert f["lease_start"]["value"] == d["start"].isoformat()
    assert f["lease_start"]["zone"] == "green" and f["lease_start"]["needs_confirmation"] is True
    x0, y0, x1, y1 = f["lease_start"]["bbox"]
    assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
    expect_end = (d["stated_end"] or d["true_end_from_term"]).isoformat()
    assert f["lease_end"]["value"] == expect_end
    assert f["lease_end"]["derived"] == (scenario == "B")
    if scenario == "B":
        assert f["lease_end"]["zone"] == "amber" and f["lease_end"]["confidence"] <= 0.89
    assert out["preview_status"]["counts_toward_score"] is False and out["preview_status"]["preview"] is True
    assert out["reconciliation"]["state"] in ("ok", "derived")
    json.dumps(out)                                   # serialisable, and no None anywhere
    assert "None" not in json.dumps(out, default=str).replace('"NONE"', "")


def test_inconsistent_deed_goes_to_review(tmp_path):
    d = deed_for("D")
    pdf = tmp_path / "lease.pdf"
    make_pdf(pdf, d["pages"])
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30, predictor=oracle(d))
    assert out["reconciliation"]["state"] == "inconsistent"
    assert out["preview_status"]["status"] == "inconsistent"
    for k in ("lease_start", "lease_end", "lease_term"):
        assert out["fields"][k]["zone"] != "green"


def test_ambiguous_date_is_blank(tmp_path):
    d = deed_for("C", want_ambiguous=True)
    pdf = tmp_path / "lease.pdf"
    make_pdf(pdf, d["pages"])
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30, predictor=oracle(d))
    flagged = [k for k in ("lease_start", "lease_end") if out["fields"][k]["ambiguous"]]
    assert flagged
    for k in flagged:
        assert out["fields"][k]["value"] == "" and out["fields"][k]["blank_reason"] == "ambiguous_date"
    assert out["preview_status"]["status"] == "needs_review"


def test_model_missing_gives_blank_fields_and_candidates(tmp_path, monkeypatch):
    d = deed_for("C")
    pdf = tmp_path / "lease.pdf"
    make_pdf(pdf, d["pages"])
    monkeypatch.setattr(m3_extract, "_load_predictor", lambda: (None, "model_missing"))
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30)
    assert not out["model_loaded"] and out["candidates"]
    for k, f in out["fields"].items():
        assert f["value"] == "" and f["zone"] == "red" and f["blank_reason"] == "model_missing"


def test_model_crash_gives_blank_fields(tmp_path):
    d = deed_for("C")
    pdf = tmp_path / "lease.pdf"
    make_pdf(pdf, d["pages"])

    def boom(_):
        raise RuntimeError("x")
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30, predictor=boom)
    assert out["fields"]["lease_start"]["blank_reason"] == "model_failed:RuntimeError"


def test_not_a_lease_and_unreadable(tmp_path):
    pdf = tmp_path / "x.pdf"
    make_pdf(pdf, ["hello"])
    out = m3_extract.build_result(str(pdf), "fire", DEMO_AS_OF, 30)
    assert out["fields"]["lease_start"]["blank_reason"] == "not_a_lease"
    bad = tmp_path / "x.xyz"
    bad.write_text("nope")
    out = m3_extract.build_result(str(bad), "lease", DEMO_AS_OF, 30)
    assert out["ok"] is False and out["fields"]["lease_start"]["blank_reason"] == "unreadable_file"


def test_long_lease_key_clause_on_late_page_is_found(tmp_path):
    d = deed_for("C")
    pages = list(d["pages"])
    assert len(pages) >= 3
    pdf = tmp_path / "lease.pdf"
    make_pdf(pdf, pages)
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30, predictor=oracle(d),
                                  with_candidates=True)
    assert max(c["page"] for c in out["candidates"]) >= 2


def test_scanned_page_uses_tesseract(tmp_path):
    pytest.importorskip("pytesseract")
    from PIL import Image, ImageDraw, ImageFont
    import shutil
    if not shutil.which("tesseract"):
        pytest.skip("tesseract not installed")
    img = Image.new("RGB", (1700, 500), "white")
    dr = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
    except OSError:
        pytest.skip("no font")
    dr.text((40, 60), "The lease shall commence from 12 March 2026", fill="black", font=font)
    dr.text((40, 160), "and shall be for a period of nine years.", fill="black", font=font)
    png = tmp_path / "scan.png"
    img.save(png)
    pages, engine, q = m3_extract.read_document(str(png))
    cands = m3_extract.find_lease_candidates(pages)
    assert not q and any(c["value"] == "2026-03-12" for c in cands)
    assert any(c["term_months"] == 108 for c in cands)
    c = next(c for c in cands if c["value"] == "2026-03-12")
    assert 0 <= c["bbox_x0"] < c["bbox_x1"] <= 1 and c["bbox_y0"] < 0.3


def test_quarantine_flag_from_project_ocr(tmp_path, monkeypatch):
    pdf = tmp_path / "x.pdf"
    make_pdf(pdf, ["hello"])
    monkeypatch.setattr(m3_extract, "_read_with_project_ocr",
                        lambda p: ({"quarantined": True, "reason": "renamed executable"}, "ocr_extract.x"))
    out = m3_extract.build_result(str(pdf), "lease", DEMO_AS_OF, 30)
    assert out["quarantined"] is True and out["fields"]["lease_start"]["blank_reason"] == "quarantined"


def test_adapter_understands_a_project_ocr_shape(tmp_path, monkeypatch):
    raw = {"pages": [{"page": 1, "words": [
        {"text": "Start", "bbox": [0.1, 0.1, 0.2, 0.12]}, {"text": "12", "bbox": [0.25, 0.1, 0.28, 0.12]},
        {"text": "March", "bbox": [0.3, 0.1, 0.4, 0.12]}, {"text": "2026", "bbox": [0.42, 0.1, 0.5, 0.12]}]}]}
    monkeypatch.setattr(m3_extract, "_read_with_project_ocr", lambda p: (raw, "ocr_extract.x"))
    pages, engine, q = m3_extract.read_document("whatever.pdf")
    assert engine == "ocr_extract.x" and pages[0]["text"] == "Start 12 March 2026"
