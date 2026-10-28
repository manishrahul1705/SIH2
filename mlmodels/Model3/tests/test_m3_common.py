"""Tests for the M3 candidate finder (dates, terms, ambiguity, contexts, boxes)."""
import pytest

from m3_common import find_lease_candidates, normalise_pages, number_value, normalize_m3


def dates(text):
    return [(c["text"], c["value"], c["ambiguous"]) for c in find_lease_candidates([text])
            if c["kind"] == "date"]


def terms(text):
    return [(c["text"], c["term_months"]) for c in find_lease_candidates([text])
            if c["kind"] == "term"]


@pytest.mark.parametrize("text,iso", [
    ("12 March 2026", "2026-03-12"),
    ("12th March, 2026", "2026-03-12"),
    ("12-Mar-2026", "2026-03-12"),
    ("March 12, 2026", "2026-03-12"),
    ("2026-03-12", "2026-03-12"),
    ("on this 12th day of March, 2026", "2026-03-12"),
    ("31/03/2026", "2026-03-31"),
    ("31.03.26", "2026-03-31"),
    ("31-03-2026", "2026-03-31"),
    ("1st September 2026", "2026-09-01"),
    ("29 February 2024", "2024-02-29"),
    ("5 Sept 2026", "2026-09-05"),
])
def test_unambiguous_dates(text, iso):
    got = dates(f"The lease starts on {text} and goes on.")
    assert len(got) == 1 and got[0][1] == iso and got[0][2] == 0


@pytest.mark.parametrize("text", ["04/05/2027", "04.05.2027", "04-05-27", "11/12/2026"])
def test_ambiguous_dates_flagged(text):
    got = dates(f"Start {text}.")
    assert len(got) == 1 and got[0][2] == 1


@pytest.mark.parametrize("text", ["05/05/2027", "13/05/2027", "31/12/2026"])
def test_not_ambiguous(text):
    assert dates(f"Start {text}.")[0][2] == 0


def test_month_first_only_reading_used():
    c = find_lease_candidates(["Start 03/25/2026."])[0]
    assert c["value"] == "2026-03-25" and c["ambiguous"] == 0


@pytest.mark.parametrize("text", ["31 February 2026", "32/01/2026", "Clause 4.2.1", "Rs. 12.50", "PIN 638052"])
def test_not_dates(text):
    assert dates(f"x {text} y") == []


@pytest.mark.parametrize("text,months", [
    ("nine years", 108), ("9 years", 108), ("9 (nine) years", 108), ("nine (9) years", 108),
    ("eleven months", 11), ("11 months", 11), ("one year", 12), ("1 (one) year", 12),
    ("thirty years", 360), ("twenty-nine years", 348), ("twenty nine years", 348),
    ("5 years and 6 months", 66), ("five (5) years and six (6) months", 66),
    ("5 years 6 months", 66), ("Nine Years", 108), ("1 month", 1),
])
def test_terms(text, months):
    got = terms(f"for a period of {text} from now")
    assert got == [(text, months)]


@pytest.mark.parametrize("text", ["30 days", "90 days notice", "the year 1998", "nine pages", "aged 5 and 6 months old of"])
def test_not_terms(text):
    got = terms(f"x {text} y")
    assert all(t[1] != 108 for t in got)
    if "days" in text or "pages" in text or "1998" in text:
        assert got == []


def test_term_with_comma_is_two_terms_not_compound():
    got = terms("further term of three (3) years, by giving six (6) months notice")
    assert [g[1] for g in got] == [36, 6]


def test_older_lease_terms_are_still_candidates_for_the_ranker():
    got = terms("earlier lease for a period of nine (9) years; new lease eleven (11) months")
    assert [g[1] for g in got] == [108, 11]


def test_number_value():
    assert number_value("9") == 9 and number_value("Twenty-Nine") == 29
    assert number_value("eleven") == 11 and number_value("banana") is None


def test_contexts_mask_candidates_and_cross_pages():
    p1 = "The lease shall commence from\n"
    p2 = "12 March 2026 and expire on 11 March 2027."
    c = find_lease_candidates([p1, p2])
    assert [x["value"] for x in c] == ["2026-03-12", "2027-03-11"]
    assert "commence from" in c[0]["left_ctx"]            # context crosses the page break
    assert c[0]["page"] == 2 and c[0]["n_pages"] == 2
    assert "<DATE>" in c[0]["right_ctx"] and "<DATE>" in c[1]["left_ctx"]
    assert c[0]["date_order"] == 1 and c[1]["date_order"] == 2 and c[0]["n_dates"] == 2
    assert c[0]["date_chrono_rank"] == 1 and c[1]["date_chrono_rank"] == 2


def test_digits_are_kept_in_context():
    c = find_lease_candidates(["Clause 7 says the lease starts on 12 March 2026."])[0]
    assert "7" in c["left_ctx"]


def test_no_nulls_and_sentinels():
    c = find_lease_candidates(["12 March 2026"])[0]
    assert c["left_ctx"] == "<BOS>" and c["right_ctx"] == "<EOS>"
    for k, v in c.items():
        assert v is not None and v != "", k


def test_bbox_estimate_from_text_lines():
    c = find_lease_candidates(["line one\nstart 12 March 2026 here\nline three"])[0]
    assert c["line_no"] == 2
    assert 0 <= c["bbox_x0"] < c["bbox_x1"] <= 1 and 0.3 < c["bbox_y0"] < c["bbox_y1"] < 0.7


def test_bbox_from_real_word_boxes():
    words = []
    x = 0.1
    for w in "Lease starts on 12 March 2026 today".split():
        words.append({"text": w, "bbox": [x, 0.2, x + 0.05, 0.22]})
        x += 0.07
    pages = normalise_pages({"pages": [{"page": 1, "words": words}]})
    c = find_lease_candidates(pages)[0]
    assert c["value"] == "2026-03-12" and c["page"] == 1
    assert abs(c["bbox_x0"] - (0.1 + 3 * 0.07)) < 1e-6 and abs(c["bbox_x1"] - (0.1 + 5 * 0.07 + 0.05)) < 1e-6


def test_normalise_pages_shapes():
    assert normalise_pages(["a", "b"])[1]["page"] == 2
    assert normalise_pages({"pages": [{"text": "x"}]})[0]["text"] == "x"
    assert normalise_pages({"text": "whole"})[0]["text"] == "whole"
    got = normalise_pages({"pages": [{"lines": ["a", {"text": "b"}]}]})
    assert got[0]["text"] == "a\nb"
    got = normalise_pages([{"words": [["Hi", 0.1, 0.1, 0.2, 0.12], ["there", 0.25, 0.1, 0.4, 0.12]]}])
    assert got[0]["text"] == "Hi there"


def test_normalize_m3_keeps_digits():
    assert normalize_m3("  Term:  9 YEARS ") == "term: 9 years"


def test_long_document_not_cut_to_page_one():
    pages = ["filler text " * 50 for _ in range(10)]
    pages[8] = "The term of this Lease is nine (9) years from 12 March 2026."
    c = find_lease_candidates(pages)
    assert {x["page"] for x in c} == {9}
