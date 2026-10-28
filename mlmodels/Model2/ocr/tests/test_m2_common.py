import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import m2_common as C


def page(lines):
    """Build an OCR-style page from a list of text lines (one line each, evenly spaced)."""
    words = []
    for li, text in enumerate(lines):
        x = 0.08
        for tok in text.split():
            w = 0.0098 * len(tok)
            words.append({"text": tok, "bbox": [x, 0.1 + li * 0.03, x + w, 0.116 + li * 0.03], "conf": 0.99})
            x += w + 0.0098
    return [{"page": 1, "width": 595, "height": 842, "words": words}]


def dates(lines):
    return [(c["text"], c["value"], c["ambiguous"]) for c in C.find_candidates(page(lines)) if c["kind"] == "date"]


def test_text_month_dates_parse():
    assert dates(["Issued on 12 March 2026"]) == [("12 March 2026", "2026-03-12", 0)]
    assert dates(["Valid till 12-Mar-2027."]) == [("12-Mar-2027", "2027-03-12", 0)]
    assert dates(["Dated 5th July, 2025"])[0][1] == "2025-07-05"
    assert dates(["March 9, 2026"])[0][1] == "2026-03-09"


def test_ambiguous_numeric_date_is_flagged_not_parsed_silently():
    (txt, val, amb), = dates(["Date of issue: 04/05/2027"])
    assert amb == 1


def test_unambiguous_numeric_dates():
    assert dates(["Date: 25/03/2027"]) == [("25/03/2027", "2027-03-25", 0)]
    assert dates(["Date: 05/05/2027"])[0][2] == 0          # both readings are the same day
    assert dates(["Date: 2027-03-25"])[0][1] == "2027-03-25"


def test_impossible_dates_are_not_candidates():
    assert dates(["Date: 31/04/2027"]) == []
    assert dates(["Date: 30 February 2027"]) == []


def test_certificate_number_candidates_and_bare_year_excluded():
    cands = C.find_candidates(page(["Certificate No. FS/2026/04512 issued 2026", "Pin 600001 Phone 9876543210"]))
    nums = {c["text"] for c in cands if c["kind"] == "number"}
    assert "FS/2026/04512" in nums and "600001" in nums and "2026" not in nums


def test_numbers_inside_dates_are_not_number_candidates():
    cands = C.find_candidates(page(["Date: 12/03/2026"]))
    assert not [c for c in cands if c["kind"] == "number"]


def test_context_stops_at_previous_date_on_same_line():
    c = [c for c in C.find_candidates(page(["Date of issue: 12 March 2026 Valid until: 12 March 2027"])) if c["kind"] == "date"]
    assert "Valid until:" in c[1]["ctx_left"] and "2026" not in c[1]["ctx_left"]


def test_issuer_label_is_stripped():
    cands = C.find_candidates(page(["Issued by : Fire and Rescue Services Department"]))
    assert "Fire and Rescue Services Department" in {c["text"] for c in cands if c["kind"] == "issuer"}


def test_normalize_m2_keeps_digits():
    assert C.normalize_m2("Valid  until\u00a012/03/2027") == "Valid until 12/03/2027"


def test_candidates_have_no_empty_required_values():
    for c in C.find_candidates(page(["Certificate No. AB/2026/12345", "Issued on 12 March 2026"], )):
        assert c["text"] and c["value"] and c["bbox"][0] < c["bbox"][2]
