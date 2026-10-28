"""Unit tests for the deterministic lease logic (the 'tested function' of the design)."""
from datetime import date, datetime, timedelta

import pytest

from m3_lease import (DEMO_AS_OF, add_months_anniversary, display_date, format_term,
                      lease_end_date, lease_status, months_between_lease, reconcile_lease,
                      status_from_reconciled)

D = date.fromisoformat


@pytest.mark.parametrize("start,months,end", [
    ("2026-01-15", 11, "2026-12-14"),     # the spec example
    ("2026-01-01", 12, "2026-12-31"),
    ("2026-01-01", 1, "2026-01-31"),
    ("2026-12-15", 3, "2027-03-14"),
    ("2026-01-31", 1, "2026-02-28"),      # month-end start, short month
    ("2024-01-31", 1, "2024-02-29"),      # month-end start, leap February
    ("2026-03-31", 1, "2026-04-30"),
    ("2026-05-31", 1, "2026-06-30"),
    ("2023-08-31", 6, "2024-02-29"),
    ("2024-02-29", 12, "2025-02-28"),     # Feb 29 start, non-leap anniversary
    ("2024-02-29", 48, "2028-02-28"),     # Feb 29 start, leap anniversary
    ("2024-02-29", 1, "2024-03-28"),
    ("2024-02-29", 24, "2026-02-28"),
    ("2026-04-01", 108, "2035-03-31"),    # nine years
    ("2026-04-01", 360, "2056-03-31"),    # thirty years
    ("2020-02-01", 12, "2021-01-31"),
    ("2019-12-31", 2, "2020-02-29"),
    ("2026-10-27", 66, "2032-04-26"),     # five years six months
    ("2000-02-29", 12, "2001-02-28"),
    ("2026-07-31", 7, "2027-02-28"),
])
def test_lease_end_date(start, months, end):
    assert lease_end_date(D(start), months) == D(end)


@pytest.mark.parametrize("bad", [0, -1, 1.5, "3", True, None])
def test_lease_end_date_rejects_bad_term(bad):
    with pytest.raises(ValueError):
        lease_end_date(D("2026-01-01"), bad)


def test_anniversary_rolls_over_when_day_missing():
    assert add_months_anniversary(D("2026-01-31"), 1) == D("2026-03-01")
    assert add_months_anniversary(D("2026-01-30"), 1) == D("2026-03-01")
    assert add_months_anniversary(D("2026-01-29"), 1) == D("2026-03-01")
    assert add_months_anniversary(D("2024-01-29"), 1) == D("2024-02-29")


def test_round_trip_months_between_many_starts():
    d = D("2019-12-25")
    for _ in range(800):
        for n in (1, 2, 5, 11, 12, 13, 24, 36, 107, 108, 360):
            assert months_between_lease(d, lease_end_date(d, n)) == n
        d += timedelta(days=1)


def test_months_between_not_whole():
    assert months_between_lease(D("2026-01-01"), D("2026-01-20")) is None
    assert months_between_lease(D("2026-03-01"), D("2026-02-01")) is None


def st(start, end, term, as_of, **kw):
    return lease_status(start, end, term, as_of, **kw)


def test_live_with_demo_date():
    r = st("2020-04-01", None, 120, DEMO_AS_OF)
    assert r["status"] == "live" and r["end"] == "2030-03-31" and r["end_derived"] is True


def test_start_day_boundaries():
    assert st("2026-06-01", "2030-05-31", None, "2026-05-31")["status"] == "not_started"
    assert st("2026-06-01", "2030-05-31", None, "2026-05-31")["days_to_start"] == 1
    assert st("2026-06-01", "2030-05-31", None, "2026-06-01")["status"] == "live"


def test_end_day_boundaries():
    end = D("2027-03-31")
    r = st("2026-04-01", None, 12, "2027-03-31")
    assert r["status"] == "expires_soon" and r["days_remaining"] == 0
    r = st("2026-04-01", None, 12, "2027-04-01")
    assert r["status"] == "expired" and r["days_since_expiry"] == 1
    assert st("2026-04-01", None, 12, end - timedelta(days=30))["status"] == "expires_soon"
    assert st("2026-04-01", None, 12, end - timedelta(days=31))["status"] == "live"


def test_reminder_window_is_editable():
    end = D("2030-03-31")
    assert st("2020-04-01", None, 120, end - timedelta(days=60), reminder_days=60)["status"] == "expires_soon"
    assert st("2020-04-01", None, 120, end - timedelta(days=61), reminder_days=60)["status"] == "live"
    assert st("2020-04-01", None, 120, end, reminder_days=0)["status"] == "expires_soon"
    assert st("2020-04-01", None, 120, end - timedelta(days=1), reminder_days=0)["status"] == "live"


def test_expired_and_counts():
    r = st("2015-01-01", "2024-12-31", None, DEMO_AS_OF)
    assert r["status"] == "expired"
    assert r["days_since_expiry"] == (DEMO_AS_OF - D("2024-12-31")).days


def test_inconsistent_is_never_resolved_silently():
    r = st("2026-01-15", "2027-12-14", 11, DEMO_AS_OF)
    assert r["status"] == "inconsistent" and "2026-12-14" in r["reason"]
    assert st("2026-01-15", "2026-12-14", 11, DEMO_AS_OF)["status"] != "inconsistent"


@pytest.mark.parametrize("start,end,term,reason", [
    (None, "2030-01-01", 12, "start_missing"),
    ("", None, None, "start_missing"),
    ("2026-01-01", None, None, "end_and_term_missing"),
    ("2026-01-01", None, 0, "term_invalid"),
    ("2026-01-01", None, -5, "term_invalid"),
    ("2026-05-01", "2026-05-01", None, "end_not_after_start"),
    ("2026-05-01", "2026-04-01", None, "end_not_after_start"),
])
def test_needs_review(start, end, term, reason):
    r = st(start, end, term, DEMO_AS_OF)
    assert r["status"] == "needs_review" and r["reason"] == reason


def test_string_inputs_and_errors():
    assert st("2020-01-01", "2030-01-01", None, "2026-10-27")["status"] == "live"
    with pytest.raises(ValueError):
        st("01/02/2020", None, 12, DEMO_AS_OF)
    with pytest.raises(ValueError):
        lease_status("2020-01-01", None, 12, None)
    with pytest.raises(ValueError):
        lease_status("2020-01-01", None, 12, DEMO_AS_OF, reminder_days=-1)
    with pytest.raises(TypeError):
        lease_status(datetime(2020, 1, 1), None, 12, DEMO_AS_OF)


def test_term_months_reported_when_only_end_given():
    assert st("2026-01-15", "2026-12-14", None, DEMO_AS_OF)["term_months"] == 11


def test_eleven_month_lease_state():
    assert st("2026-01-15", None, 11, "2026-12-14")["status"] == "expires_soon"
    assert st("2026-01-15", None, 11, "2026-12-15")["status"] == "expired"


def test_reconcile_consistent():
    r = reconcile_lease("2026-01-15", "2026-12-14", 11)
    assert (r["state"], r["reason"]) == ("ok", "consistent")


def test_reconcile_derives_end():
    r = reconcile_lease("2026-01-15", None, 11)
    assert r["state"] == "derived" and r["end"] == "2026-12-14" and r["end_derived"]


def test_reconcile_derives_term():
    r = reconcile_lease("2026-01-15", "2036-01-14", None)
    assert r["state"] == "derived" and r["term_months"] == 120 and r["term_derived"]


def test_reconcile_term_not_whole():
    r = reconcile_lease("2026-01-15", "2026-02-20", None)
    assert r["state"] == "ok" and r["term_months"] == 0 and "term_not_whole_months" in r["flags"]


def test_reconcile_inconsistent_keeps_all_values():
    r = reconcile_lease("2026-01-15", "2029-01-14", 11)
    assert r["state"] == "inconsistent"
    assert (r["start"], r["end"], r["term_months"]) == ("2026-01-15", "2029-01-14", 11)


def test_reconcile_ambiguous_start_blank():
    r = reconcile_lease("2026-04-05", "2027-04-04", 12, start_ambiguous=True)
    assert r["state"] == "needs_review" and r["start"] == "" and r["reason"] == "start_ambiguous"


def test_reconcile_ambiguous_end_not_derived():
    r = reconcile_lease("2026-01-15", None, 12, end_ambiguous=True)
    assert r["state"] == "needs_review" and r["end"] == "" and not r["end_derived"]


def test_reconcile_end_not_after_start_blanks_both():
    r = reconcile_lease("2026-05-01", "2026-04-01", 12)
    assert r["state"] == "needs_review" and r["start"] == "" and r["end"] == ""


def test_reconcile_missing_pieces():
    assert reconcile_lease(None, None, None)["reason"] == "start_missing"
    assert reconcile_lease("2026-01-01", None, None)["reason"] == "end_and_term_missing"


def test_status_from_reconciled():
    rec = reconcile_lease("2020-04-01", None, 120)
    assert status_from_reconciled(rec, DEMO_AS_OF)["status"] == "live"
    rec = reconcile_lease("2026-01-15", "2029-01-14", 11)
    assert status_from_reconciled(rec, DEMO_AS_OF)["status"] == "inconsistent"
    rec = reconcile_lease("2026-04-05", None, 12, start_ambiguous=True)
    assert status_from_reconciled(rec, DEMO_AS_OF)["status"] == "needs_review"
    rec = reconcile_lease("2026-01-15", None, 12, end_ambiguous=True)
    assert status_from_reconciled(rec, DEMO_AS_OF)["status"] == "needs_review"


def test_display_helpers():
    assert display_date(D("2026-03-05")) == "5 March 2026"
    assert format_term(108) == "9 years" and format_term(11) == "11 months"
    assert format_term(66) == "5 years 6 months" and format_term(12) == "1 year"
    assert format_term(0) == ""


def test_no_hidden_clock():
    import inspect
    import m3_lease
    src = inspect.getsource(m3_lease)
    assert "date.today" not in src and "datetime.now" not in src and "import time" not in src
