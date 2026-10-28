"""
ApprovalTrack M3 - deterministic lease logic (no machine learning, no hidden clocks).

Everything here is plain, unit-tested arithmetic:

  lease_end_date(start, term_months)      calendar-correct end date
  months_between_lease(start, end)        whole-month term, or None
  reconcile_lease(start, end, term, ...)  combine what was read from the deed
  lease_status(start, end, term, as_of)   live / expires_soon / expired / ...
  status_from_reconciled(rec, as_of)      lease_status on a reconcile_lease result

SAFEGUARD: these functions only describe a lease. An AI-suggested date counts only
after a person confirms it, and the lease flag affects the Action Score only after an
authorised official confirms the review flag. Nothing here writes to a score, a
routing table or a policy table, and nothing here reads the system clock: the caller
always passes `as_of` explicitly.

Month arithmetic rule ("anniversary rule"):
  The anniversary of a start date `n` months later is the same day-of-month. If that
  day does not exist in the target month (31 Jan + 1 month, 29 Feb + 12 months), the
  anniversary is the 1st of the following month. The lease END is the day before the
  anniversary, so the end is inclusive:
    15 Jan 2026 + 11 months  -> ends 14 Dec 2026
    29 Feb 2024 + 12 months  -> ends 28 Feb 2025
    31 Jan 2026 + 1 month    -> ends 28 Feb 2026
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta

DEMO_AS_OF = date(2026, 10, 27)          # demo date used across the project
DEFAULT_REMINDER_DAYS = 30               # editable setting, not an AICTE value
STATUSES = ("live", "expires_soon", "expired", "not_started", "inconsistent", "needs_review")

_MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"]


# --------------------------------------------------------------------------- inputs
def _to_date(value, name="date"):
    """Accept date, ISO string, '' or None. Reject datetimes and other types."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        raise TypeError(f"{name} must be a date, not a datetime")
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            raise ValueError(f"{name} must be an ISO date YYYY-MM-DD, got {value!r}") from None
    raise TypeError(f"{name} must be a date or ISO string, got {type(value).__name__}")


def _to_term(value):
    """Accept int, digit string, '' or None. Returns int (may be <= 0) or None."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise TypeError("term_months must be an integer, not bool")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    raise TypeError(f"term_months must be an integer, got {value!r}")


# --------------------------------------------------------------------------- arithmetic
def add_months_anniversary(start: date, n: int) -> date:
    """Anniversary of `start` n months later (see the module docstring)."""
    if n < 0:
        raise ValueError("n must be >= 0")
    total = start.year * 12 + (start.month - 1) + n
    year, month0 = divmod(total, 12)
    month = month0 + 1
    last = calendar.monthrange(year, month)[1]
    if start.day <= last:
        return date(year, month, start.day)
    return date(year, month, last) + timedelta(days=1)


def lease_end_date(start: date, term_months: int) -> date:
    """Last day of a lease that starts on `start` and runs `term_months` months."""
    if isinstance(term_months, bool) or not isinstance(term_months, int) or term_months < 1:
        raise ValueError("term_months must be an integer >= 1")
    return add_months_anniversary(start, term_months) - timedelta(days=1)


def months_between_lease(start: date, end: date):
    """Whole-month term of a lease running start..end inclusive, or None if not whole."""
    if end < start:
        return None
    after = end + timedelta(days=1)
    approx = (after.year - start.year) * 12 + (after.month - start.month)
    for n in (approx, approx - 1, approx + 1):
        if n >= 1 and lease_end_date(start, n) == end:
            return n
    return None


# --------------------------------------------------------------------------- display
def display_date(d: date) -> str:
    return f"{d.day} {_MONTH_NAMES[d.month]} {d.year}"


def format_term(months: int) -> str:
    if months < 1:
        return ""
    y, m = divmod(months, 12)
    parts = []
    if y:
        parts.append(f"{y} year{'s' if y != 1 else ''}")
    if m:
        parts.append(f"{m} month{'s' if m != 1 else ''}")
    return " ".join(parts)


# --------------------------------------------------------------------------- reconcile
def _rec(start, end, term, end_derived, term_derived, state, reason, flags):
    return {
        "start": start.isoformat() if start else "",
        "end": end.isoformat() if end else "",
        "term_months": int(term) if term else 0,
        "end_derived": bool(end_derived),
        "term_derived": bool(term_derived),
        "state": state,                      # ok | derived | inconsistent | needs_review
        "reason": reason,
        "flags": list(flags),
    }


def reconcile_lease(start, end, term_months, *, start_ambiguous=False, end_ambiguous=False):
    """
    Combine what was read from a deed. Inputs are what the reader proposed (dates or ISO
    strings, term in whole months); an ambiguous or blank value is passed as None with the
    matching *_ambiguous flag. Never chooses silently between disagreeing values.
    """
    start = _to_date(start, "start")
    end = _to_date(end, "end")
    term = _to_term(term_months)
    flags = []
    if term is not None and term < 1:
        term = None
        flags.append("term_invalid")
    if start_ambiguous:
        start = None
        flags.append("start_ambiguous")
    if end_ambiguous:
        end = None
        flags.append("end_ambiguous")

    if start is None:
        reason = "start_ambiguous" if start_ambiguous else "start_missing"
        return _rec(None, end, term, False, False, "needs_review", reason, flags)
    if end_ambiguous:
        return _rec(start, None, term, False, False, "needs_review", "end_ambiguous", flags)
    if end is not None and end <= start:
        flags.append("end_not_after_start")
        return _rec(None, None, term, False, False, "needs_review", "end_not_after_start", flags)
    if end is None and term is None:
        return _rec(start, None, None, False, False, "needs_review", "end_and_term_missing", flags)

    if end is not None and term is not None:
        computed = lease_end_date(start, term)
        if computed == end:
            return _rec(start, end, term, False, False, "ok", "consistent", flags)
        flags.append("end_disagrees_with_term")
        return _rec(start, end, term, False, False, "inconsistent",
                    "stated_end_disagrees_with_term", flags)

    if end is None:                                   # term only: derive the end
        return _rec(start, lease_end_date(start, term), term, True, False,
                    "derived", "end_derived_from_term", flags)

    n = months_between_lease(start, end)              # end only: derive the term
    if n is not None:
        return _rec(start, end, n, False, True, "derived", "term_derived_from_dates", flags)
    flags.append("term_not_whole_months")
    return _rec(start, end, None, False, False, "ok", "term_not_whole_months", flags)


# --------------------------------------------------------------------------- status
def _status_result(status, reason, as_of, reminder_days, start=None, end=None, term=None,
                   end_derived=False, computed_end=None, to_start=-1, remaining=-1, since=-1):
    return {
        "status": status,
        "reason": reason,
        "as_of": as_of.isoformat(),
        "start": start.isoformat() if start else "",
        "end": end.isoformat() if end else "",
        "computed_end": computed_end.isoformat() if computed_end else "",
        "term_months": int(term) if term else 0,
        "end_derived": bool(end_derived),
        "days_to_start": to_start,           # -1 means "not applicable"
        "days_remaining": remaining,         # -1 means "not applicable"; 0 = last day
        "days_since_expiry": since,          # -1 means "not applicable"
        "reminder_days": reminder_days,
    }


def lease_status(start, end, term_months, as_of, reminder_days=DEFAULT_REMINDER_DAYS):
    """
    Status of a lease on `as_of`.  live | expires_soon | expired | not_started |
    inconsistent | needs_review.  The end date is inclusive (the lease is still in force
    on its last day, which counts as 0 days remaining).
    """
    as_of_d = _to_date(as_of, "as_of")
    if as_of_d is None:
        raise ValueError("as_of is required: there are no hidden clocks")
    if isinstance(reminder_days, bool) or not isinstance(reminder_days, int) or reminder_days < 0:
        raise ValueError("reminder_days must be an integer >= 0")
    start_d = _to_date(start, "start")
    end_d = _to_date(end, "end")
    term = _to_term(term_months)

    def res(status, reason, **kw):
        return _status_result(status, reason, as_of_d, reminder_days, **kw)

    if start_d is None:
        return res("needs_review", "start_missing", end=end_d, term=term)
    if term is not None and term < 1:
        return res("needs_review", "term_invalid", start=start_d, end=end_d)
    if end_d is None and term is None:
        return res("needs_review", "end_and_term_missing", start=start_d)

    computed = lease_end_date(start_d, term) if term is not None else None
    if end_d is not None and computed is not None and end_d != computed:
        diff = abs((end_d - computed).days)
        return res("inconsistent",
                   f"stated end {end_d.isoformat()} differs from start plus term "
                   f"({computed.isoformat()}) by {diff} days",
                   start=start_d, end=end_d, term=term, computed_end=computed)

    effective = end_d if end_d is not None else computed
    derived = end_d is None
    term_out = term if term is not None else (months_between_lease(start_d, effective) or 0)
    common = dict(start=start_d, end=effective, term=term_out, end_derived=derived,
                  computed_end=computed)

    if effective <= start_d:
        return res("needs_review", "end_not_after_start", start=start_d, end=effective)
    if as_of_d < start_d:
        return res("not_started", "lease has not started yet",
                   to_start=(start_d - as_of_d).days, **common)
    if as_of_d > effective:
        return res("expired", "lease end date has passed",
                   since=(as_of_d - effective).days, **common)
    remaining = (effective - as_of_d).days
    if remaining <= reminder_days:
        return res("expires_soon", f"lease ends in {remaining} days", remaining=remaining, **common)
    return res("live", "lease is in force", remaining=remaining, **common)


def status_from_reconciled(rec, as_of, reminder_days=DEFAULT_REMINDER_DAYS):
    """lease_status for a reconcile_lease() result; needs_review stays needs_review."""
    as_of_d = _to_date(as_of, "as_of")
    if as_of_d is None:
        raise ValueError("as_of is required: there are no hidden clocks")
    if rec["state"] == "needs_review":
        return _status_result("needs_review", rec["reason"], as_of_d, reminder_days,
                              start=_to_date(rec["start"]), end=_to_date(rec["end"]),
                              term=rec["term_months"] or None)
    return lease_status(rec["start"] or None, rec["end"] or None,
                        rec["term_months"] or None, as_of_d, reminder_days)
