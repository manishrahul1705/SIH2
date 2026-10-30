"""Deterministic extraction for explicitly labelled document fields."""

from __future__ import annotations

import re
from datetime import date, datetime

_MONTH = (
    r"(?:January|February|March|April|May|June|July|August|September|October|"
    r"November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)"
)
DATE_TOKEN = (
    rf"(?:\d{{1,2}}\s+{_MONTH}[a-z]*\.?,?\s+\d{{4}}|"
    rf"{_MONTH}\s+\d{{1,2}},?\s+\d{{4}}|"
    r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|"
    r"\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2})"
)
_SEARCH_PERIOD_LINE = re.compile(
    r"\bsearch\s*period\b\s*[:=]?\s*(.*)",
    re.IGNORECASE,
)
_SEARCH_PERIOD_WORD_SEPARATOR = re.compile(
    r"\b(?:to|till|until|through)\b",
    re.IGNORECASE,
)
_SEARCH_PERIOD_DASH_SEPARATOR = re.compile(r"\s+[-–—]\s+")
_ISSUE_DATE = re.compile(
    rf"\bissue\s*date\b\s*[:=\-–—]?\s*({DATE_TOKEN})",
    re.IGNORECASE,
)
_CERTIFICATE_NUMBER = re.compile(
    r"\bcertificate\s*(?:number|no\.?|#)\s*[:=\-–—]?\s*"
    r"([A-Za-z0-9][A-Za-z0-9/\-_.]*)",
    re.IGNORECASE,
)
_ISSUER = re.compile(r"^\s*issuer\s*[:=\-–—]?\s*(.*?)\s*$", re.IGNORECASE | re.MULTILINE)


def _parse_date(raw: str) -> str | None:
    value = re.sub(r"\s+", " ", raw.strip()).replace(",", "")
    formats = (
        "%d %B %Y",
        "%d %b %Y",
        "%B %d %Y",
        "%b %d %Y",
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
    )
    for date_format in formats:
        try:
            return datetime.strptime(value, date_format).date().isoformat()
        except ValueError:
            continue

    match = re.fullmatch(r"(\d{1,2})([/.\-])(\d{1,2})\2(\d{4})", value)
    if match:
        first, _, second, year = match.groups()
        try:
            return date(int(year), int(second), int(first)).isoformat()
        except ValueError:
            return None

    match = re.fullmatch(r"(\d{4})([/.\-])(\d{1,2})\2(\d{1,2})", value)
    if match:
        year, _, month, day = match.groups()
        try:
            return date(int(year), int(month), int(day)).isoformat()
        except ValueError:
            return None
    return None


def extract_labeled_fields(text: str) -> dict[str, dict[str, str]]:
    """Extract clearly labelled dates, certificate number, and issuer from OCR text."""
    normalized = text.replace("\u2013", "-").replace("\u2014", "-").replace("\r", "")
    flat = re.sub(r"\s+", " ", normalized)
    fields: dict[str, dict[str, str]] = {}

    for line in normalized.splitlines():
        period_line = _SEARCH_PERIOD_LINE.search(line)
        if not period_line:
            continue
        period_value = period_line.group(1)
        left_match = re.search(DATE_TOKEN, period_value, re.IGNORECASE)
        separator = _SEARCH_PERIOD_WORD_SEPARATOR.search(period_value)
        if separator:
            left_side, right_side = period_value[:separator.start()], period_value[separator.end():]
        elif left_match:
            right_side = period_value[left_match.end():]
            dash = re.match(r"\s*[-–—]\s*", right_side)
            if not dash:
                continue
            left_side, right_side = period_value[:left_match.end()], right_side[dash.end():]
        else:
            separator = _SEARCH_PERIOD_DASH_SEPARATOR.search(period_value)
            if not separator:
                continue
            left_side, right_side = period_value[:separator.start()], period_value[separator.end():]

        left_date = re.search(DATE_TOKEN, left_side, re.IGNORECASE)
        if left_date:
            left_raw = left_date.group(0)
            left = _parse_date(left_raw)
            if left:
                fields["valid_from"] = {"value": left, "display": left_raw}
        right_match = re.search(DATE_TOKEN, right_side, re.IGNORECASE)
        if right_match:
            right_raw = right_match.group(0)
            right = _parse_date(right_raw)
            if right:
                fields["valid_to"] = {"value": right, "display": right_raw}
        break

    issue_date = _ISSUE_DATE.search(flat)
    if issue_date:
        raw = issue_date.group(1)
        parsed = _parse_date(raw)
        if parsed:
            fields["issue_date"] = {"value": parsed, "display": raw}

    certificate_number = _CERTIFICATE_NUMBER.search(flat)
    if certificate_number:
        value = certificate_number.group(1).strip().rstrip(".")
        fields["cert_no"] = {"value": value, "display": value}

    issuer = _ISSUER.search(normalized)
    if issuer and issuer.group(1).strip():
        value = issuer.group(1).strip()
        fields["issuer"] = {"value": value, "display": value}
    return fields


def extract_encumbrance_fields(text: str) -> dict[str, str | None]:
    """Return the requested Encumbrance Certificate JSON fields in display format."""
    extracted = extract_labeled_fields(text)

    def display_date(name: str) -> str | None:
        value = extracted.get(name, {}).get("value")
        if not value:
            return None
        try:
            return datetime.strptime(value, "%Y-%m-%d").strftime("%d/%m/%Y")
        except ValueError:
            return None

    return {
        "certificate_number": extracted.get("cert_no", {}).get("value"),
        "valid_from": display_date("valid_from"),
        "valid_to": display_date("valid_to"),
        "issue_date": display_date("issue_date"),
        "issuer": extracted.get("issuer", {}).get("value"),
    }
