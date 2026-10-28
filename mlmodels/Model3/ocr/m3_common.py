"""
ApprovalTrack M3 - shared lease candidate finder.

Training and inference MUST both call find_lease_candidates(pages), so the model sees
identical candidates in both places (same rule as M2's find_candidates).

NOTE ON M2: this file is self-contained on purpose. It uses the same date formats and the
same ambiguity rule as M2's find_candidates (a numeric date such as 04/05/2027 with two
valid readings is flagged `ambiguous` and must be returned blank), but it does not import
m2_common.py, because M3 also needs term candidates and doc-level context. No M1 or M2
file is imported or modified.

A candidate is either
  kind="date": a real calendar date  (value = ISO date, day-first reading)
  kind="term": a duration in years/months  (value = total months as text)

Contexts (left_ctx / right_ctx) come from the WHOLE document text stream (pages joined),
so a clause that starts on one page and ends on the next keeps its context. Every
candidate span in the context is replaced by <DATE> or <TERM> so a ranker learns the
wording, not particular dates. Digits are NOT masked (do not use normalize_for_m1).

SAFEGUARD: candidates are only proposals. Nothing here starts a clock.
"""
from __future__ import annotations

import re
from datetime import date

MODEL_ROLES = ("lease_start", "lease_end", "term_value", "other")   # "other", never "none": must not look like a null
CTX_LEFT_CHARS = 200
CTX_RIGHT_CHARS = 120

CANDIDATE_FIELDS = (
    "cand_id", "kind", "page", "line_no", "char_start", "char_end", "text", "value",
    "alt_value", "term_months", "ambiguous", "date_order", "n_dates", "date_chrono_rank",
    "term_order", "n_terms", "rel_pos", "left_ctx", "right_ctx",
    "bbox_x0", "bbox_y0", "bbox_x1", "bbox_y1", "n_pages",
)

# --------------------------------------------------------------------------- dates
MONTH_NUM = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
    "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH = "(?:" + "|".join(sorted(MONTH_NUM, key=len, reverse=True)) + ")"
_LB = r"(?<![\w/.\-])"
_ORD = r"(?:st|nd|rd|th)?"

P_DAYOF = re.compile(rf"{_LB}(\d{{1,2}}){_ORD}\s+day\s+of\s+({_MONTH})\b\.?,?\s+(\d{{4}})(?!\d)", re.I)
P_DMY = re.compile(rf"{_LB}(\d{{1,2}}){_ORD}[\s\-]+({_MONTH})\b\.?,?[\s\-]*(\d{{4}})(?!\d)", re.I)
P_MDY = re.compile(rf"(?<!\w)({_MONTH})\b\.?\s+(\d{{1,2}}){_ORD},?\s+(\d{{4}})(?!\d)", re.I)
P_ISO = re.compile(rf"{_LB}(\d{{4}})-(\d{{2}})-(\d{{2}})(?![\d\-])")
P_NUM = re.compile(rf"{_LB}(\d{{1,2}})([/.\-])(\d{{1,2}})\2(\d{{4}}|\d{{2}})(?![\d/]|\.\d)")


def _mk(y, m, d):
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _year(txt):
    y = int(txt)
    if len(txt) == 2:
        y = 2000 + y if y <= 69 else 1900 + y
    return y


def _date_hits(text):
    """Yield (start, end, value_iso, alt_iso, ambiguous) for every real calendar date."""
    for m in P_DAYOF.finditer(text):
        d = _mk(int(m.group(3)), MONTH_NUM[m.group(2).lower()], int(m.group(1)))
        if d:
            yield m.start(), m.end(), d.isoformat(), "", False
    for m in P_DMY.finditer(text):
        d = _mk(int(m.group(3)), MONTH_NUM[m.group(2).lower()], int(m.group(1)))
        if d:
            yield m.start(), m.end(), d.isoformat(), "", False
    for m in P_MDY.finditer(text):
        d = _mk(int(m.group(3)), MONTH_NUM[m.group(1).lower()], int(m.group(2)))
        if d:
            yield m.start(), m.end(), d.isoformat(), "", False
    for m in P_ISO.finditer(text):
        d = _mk(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if d:
            yield m.start(), m.end(), d.isoformat(), "", False
    for m in P_NUM.finditer(text):
        a, b, y = int(m.group(1)), int(m.group(3)), _year(m.group(4))
        if not 1900 <= y <= 2100:
            continue
        dayfirst, monthfirst = _mk(y, b, a), _mk(y, a, b)
        if dayfirst and monthfirst and dayfirst != monthfirst:
            yield m.start(), m.end(), dayfirst.isoformat(), monthfirst.isoformat(), True
        elif dayfirst:
            yield m.start(), m.end(), dayfirst.isoformat(), "", False
        elif monthfirst:
            yield m.start(), m.end(), monthfirst.isoformat(), "", False


# --------------------------------------------------------------------------- terms
_ONES = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
         "eight": 8, "nine": 9}
_TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
          "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
         "eighty": 80, "ninety": 90}
_NUMW = (r"\b(?:(?:" + "|".join(_TENS) + r")(?:[\s\-]+(?:" + "|".join(_ONES) + r"))?|"
         + "|".join(_TEENS) + "|" + "|".join(_ONES) + r")\b")
_NUM = rf"(?:\d{{1,3}}|{_NUMW})"
P_TERM = re.compile(
    rf"(?<![\w/.\-,])(?P<n1>{_NUM})(?:\s*\(\s*(?P<p1>{_NUM})\s*\))?\s+(?P<u1>years?|yrs?|months?)\b"
    rf"(?:(?:\s+and\s+|\s+)(?P<n2>{_NUM})(?:\s*\(\s*(?P<p2>{_NUM})\s*\))?\s+(?P<u2>months?)\b)?",
    re.I,
)


def number_value(token):
    """'9' -> 9, 'nine' -> 9, 'twenty-nine' -> 29, 'Twenty Nine' -> 29. None if unknown."""
    t = token.strip().lower()
    if t.isdigit():
        return int(t)
    parts = re.split(r"[\s\-]+", t)
    total = 0
    for p in parts:
        if p in _TENS:
            total += _TENS[p]
        elif p in _TEENS:
            total += _TEENS[p]
        elif p in _ONES:
            total += _ONES[p]
        else:
            return None
    return total or None


def _term_hits(text):
    """Yield (start, end, total_months, mismatch) for every years/months duration."""
    for m in P_TERM.finditer(text):
        v1 = number_value(m.group("n1"))
        p1 = m.group("p1")
        if v1 is None:
            continue
        mismatch = False
        if p1 is not None:
            pv = number_value(p1)
            if pv is not None and pv != v1:
                mismatch = True
                v1 = int(m.group("n1")) if m.group("n1").isdigit() else pv
        years_unit = m.group("u1").lower().startswith("y")
        total = v1 * 12 if years_unit else v1
        if m.group("n2"):
            v2 = number_value(m.group("n2"))
            if v2 is None:
                continue
            p2 = m.group("p2")
            if p2 is not None:
                pv2 = number_value(p2)
                if pv2 is not None and pv2 != v2:
                    mismatch = True
            total += v2
        if total < 1:
            continue
        yield m.start(), m.end(), total, mismatch


# --------------------------------------------------------------------------- pages
def normalize_m3(text):
    """Lower-case and collapse whitespace. KEEPS digits (M3 never uses the M1 digit mask)."""
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def _words_to_text(words):
    """Group OCR words (normalised 0..1 boxes) into reading-order lines; track char spans."""
    if not words:
        return "", []
    heights = sorted(max(w["y1"] - w["y0"], 0.004) for w in words)
    tol = 0.6 * heights[len(heights) // 2]
    ordered = sorted(words, key=lambda w: ((w["y0"] + w["y1"]) / 2, w["x0"]))
    lines, cur, cur_y = [], [], None
    for w in ordered:
        yc = (w["y0"] + w["y1"]) / 2
        if cur and abs(yc - cur_y) > tol:
            lines.append(cur)
            cur = []
        if not cur:
            cur_y = yc
        cur.append(w)
    if cur:
        lines.append(cur)
    out, placed, pos = [], [], 0
    for li, line in enumerate(lines):
        line.sort(key=lambda w: w["x0"])
        for wi, w in enumerate(line):
            if wi:
                out.append(" ")
                pos += 1
            out.append(w["text"])
            placed.append({**w, "s": pos, "e": pos + len(w["text"]), "line": li})
            pos += len(w["text"])
        if li < len(lines) - 1:
            out.append("\n")
            pos += 1
    return "".join(out), placed


def _word_from_raw(w):
    """Accept {text|word|t, bbox|box|x0..} or [text,x0,y0,x1,y1]. Returns dict or None."""
    try:
        if isinstance(w, (list, tuple)) and len(w) >= 5:
            text, x0, y0, x1, y1 = w[0], w[1], w[2], w[3], w[4]
        elif isinstance(w, dict):
            text = w.get("text", w.get("word", w.get("t", "")))
            box = w.get("bbox", w.get("box"))
            if isinstance(box, (list, tuple)) and len(box) == 4:
                x0, y0, x1, y1 = box
            elif isinstance(box, dict):
                x0, y0 = box.get("x0", box.get("left")), box.get("y0", box.get("top"))
                x1, y1 = box.get("x1", box.get("right")), box.get("y1", box.get("bottom"))
            elif "x0" in w:
                x0, y0, x1, y1 = w["x0"], w["y0"], w["x1"], w["y1"]
            elif "left" in w:
                x0, y0 = w["left"], w["top"]
                x1, y1 = x0 + w["width"], y0 + w["height"]
            else:
                return None
        else:
            return None
        text = str(text).strip()
        if not text:
            return None
        c = lambda v: min(1.0, max(0.0, float(v)))
        return {"text": text, "x0": c(x0), "y0": c(y0), "x1": c(x1), "y1": c(y1)}
    except (TypeError, ValueError, KeyError):
        return None


def normalise_pages(raw):
    """
    Turn whatever the OCR layer returned into [{"page", "text", "words"}].
    Accepts a list of page strings, {"pages": [...]}, pages that are dicts with
    "text", "lines" or "words" (boxes normalised 0..1).
    """
    pages_raw = raw.get("pages") if isinstance(raw, dict) else raw
    if pages_raw is None and isinstance(raw, dict) and isinstance(raw.get("text"), str):
        pages_raw = [raw["text"]]
    out = []
    for i, p in enumerate(pages_raw or [], 1):
        if isinstance(p, str):
            out.append({"page": i, "text": p, "words": []})
            continue
        if not isinstance(p, dict):
            continue
        num = p.get("page", p.get("page_number", i))
        num = num if isinstance(num, int) and num >= 1 else i
        words = [x for x in (_word_from_raw(w) for w in (p.get("words") or [])) if x]
        if words:
            text, placed = _words_to_text(words)
            out.append({"page": num, "text": text, "words": placed})
            continue
        text = p.get("text")
        if not isinstance(text, str):
            lines = p.get("lines") or []
            text = "\n".join(l if isinstance(l, str) else str(l.get("text", "")) for l in lines)
        out.append({"page": num, "text": text, "words": []})
    return out


def _coerce_pages(pages):
    out = []
    for i, p in enumerate(pages, 1):
        if isinstance(p, str):
            out.append({"page": i, "text": p, "words": []})
        else:
            out.append({"page": p.get("page", i), "text": p.get("text", ""),
                        "words": p.get("words") or []})
    return out


def _bbox_and_line(page, s, e):
    """Highlight box and 1-based line number for text[s:e] of one page."""
    words = page["words"]
    if words:
        hit = [w for w in words if w["s"] < e and w["e"] > s]
        if hit:
            return (min(w["x0"] for w in hit), min(w["y0"] for w in hit),
                    max(w["x1"] for w in hit), max(w["y1"] for w in hit)), hit[0]["line"] + 1
    text = page["text"]
    lines = text.split("\n")
    width = max(1, max(len(l) for l in lines))
    n = max(1, len(lines))
    li = text.count("\n", 0, s)
    line_start = text.rfind("\n", 0, s) + 1
    nl = text.find("\n", s)
    line_end_pos = len(text) if nl == -1 else nl
    col0 = s - line_start
    col1 = min(e, line_end_pos) - line_start
    box = (col0 / width, li / n, min(1.0, max(col1, col0 + 1) / width), (li + 1) / n)
    return box, li + 1


# --------------------------------------------------------------------------- finder
def _scan(text):
    """All non-overlapping candidates in one page text: (s, e, kind, value, alt, amb, months)."""
    hits = []
    for s, e, v, alt, amb in _date_hits(text):
        hits.append((s, e, "date", v, alt, amb, 0))
    for s, e, months, mismatch in _term_hits(text):
        hits.append((s, e, "term", str(months), "", mismatch, months))
    hits.sort(key=lambda h: (h[0], -(h[1] - h[0])))
    out, last = [], -1
    for h in hits:
        if h[0] >= last:
            out.append(h)
            last = h[1]
    return out


def _clean(s):
    return re.sub(r"\s+", " ", s).strip()


def find_lease_candidates(pages, doc_type="lease"):
    """
    pages: list of page strings or {"page", "text", "words"?} dicts (see normalise_pages).
    Returns one dict per candidate, in reading order, with the keys in CANDIDATE_FIELDS.
    No nulls: empty text values are "" or sentinel tokens, numbers are 0 when not applicable.
    """
    pages = _coerce_pages(pages)
    offsets, pos = [], 0
    for p in pages:
        offsets.append(pos)
        pos += len(p["text"]) + 1
    stream = "\n".join(p["text"] for p in pages)

    raw = []
    for pi, p in enumerate(pages):
        for s, e, kind, val, alt, amb, months in _scan(p["text"]):
            raw.append((offsets[pi] + s, offsets[pi] + e, pi, s, e, kind, val, alt, amb, months))
    raw.sort(key=lambda r: r[0])

    pieces, mspans, last, mlen = [], [], 0, 0
    for r in raw:
        chunk = stream[last:r[0]]
        pieces.append(chunk)
        mlen += len(chunk)
        token = "<DATE>" if r[5] == "date" else "<TERM>"
        mspans.append((mlen, mlen + len(token)))
        pieces.append(token)
        mlen += len(token)
        last = r[1]
    pieces.append(stream[last:])
    masked = "".join(pieces)

    n_dates = sum(1 for r in raw if r[5] == "date")
    n_terms = len(raw) - n_dates
    distinct_vals = sorted({r[6] for r in raw if r[5] == "date"})
    rank = {v: i + 1 for i, v in enumerate(distinct_vals)}
    total_len = max(1, len(stream))
    n_pages = len(pages)

    cands, d_i, t_i = [], 0, 0
    for idx, (r, (ms, me)) in enumerate(zip(raw, mspans), 1):
        gs, ge, pi, s, e, kind, val, alt, amb, months = r
        a = max(0, ms - CTX_LEFT_CHARS)
        left = masked[a:ms]
        if a > 0 and not masked[a - 1].isspace():
            left = left.split(" ", 1)[1] if " " in left else ""
        b = min(len(masked), me + CTX_RIGHT_CHARS)
        right = masked[me:b]
        if b < len(masked) and not masked[b].isspace():
            right = right.rsplit(" ", 1)[0] if " " in right else ""
        left, right = _clean(left) or "<BOS>", _clean(right) or "<EOS>"
        box, line_no = _bbox_and_line(pages[pi], s, e)
        if kind == "date":
            d_i += 1
        else:
            t_i += 1
        cands.append({
            "cand_id": f"c{idx:03d}", "kind": kind, "page": pages[pi]["page"],
            "line_no": line_no, "char_start": s, "char_end": e,
            "text": _clean(pages[pi]["text"][s:e]), "value": val, "alt_value": alt or "NONE",
            "term_months": months, "ambiguous": int(bool(amb)),
            "date_order": d_i if kind == "date" else 0, "n_dates": n_dates,
            "date_chrono_rank": rank[val] if kind == "date" else 0,
            "term_order": t_i if kind == "term" else 0, "n_terms": n_terms,
            "rel_pos": round(gs / total_len, 5), "left_ctx": left, "right_ctx": right,
            "bbox_x0": round(box[0], 4), "bbox_y0": round(box[1], 4),
            "bbox_x1": round(box[2], 4), "bbox_y1": round(box[3], 4), "n_pages": n_pages,
        })
    return cands
