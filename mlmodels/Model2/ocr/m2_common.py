"""
ApprovalTrack M2 - shared candidate finder.

Dataset generation, training AND inference must all call find_candidates() from this file, so the
model sees exactly the same candidates in training and in production.

IMPORTANT: M2 must NOT use m1_text.normalize_for_m1(). That function replaces every digit with 0,
which would destroy dates and certificate numbers. M2 uses normalize_m2() below instead.

Input  : "pages" exactly as returned by ocr_extract.extract_document()["pages"]
         [{"page": 1, "width": .., "height": .., "words": [{"text": str, "bbox": [x0,y0,x1,y1] (0..1), "conf": 0..1}]}]
Output : a list of candidate dicts (flat, no nulls) for three kinds:
         "date"   - every real calendar date written in any supported format
         "number" - certificate / application / reference number-like tokens
         "issuer" - header, stamp and labelled lines that could name the issuing authority
"""
import datetime as dt
import re
import statistics
import unicodedata

ROLES = ("issue_date", "valid_to", "cert_no", "issuer", "none")
DOC_TYPES = ("lease", "fire", "structural", "occupancy_building", "nba_letter",
             "audited_accounts", "aicte_approval_letter", "other")
KIND_ROLES = {"date": ("issue_date", "valid_to", "none"),
              "number": ("cert_no", "none"),
              "issuer": ("issuer", "none")}

MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8,
          "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_MON = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|"
        r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")

# order matters: longer / more specific patterns first
DATE_PATTERNS = [
    ("dmy_text", re.compile(rf"(?<![\w/])(\d{{1,2}})(?:st|nd|rd|th)?[\s\-/.]*(?:of\s+)?({_MON})\.?,?[\s\-/.]*(\d{{4}})(?![\w/])", re.I)),
    ("mdy_text", re.compile(rf"(?<![\w/])({_MON})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})(?![\w/])", re.I)),
    ("iso", re.compile(r"(?<![\w/])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?![\w/])")),
    ("num", re.compile(r"(?<![\w/])(\d{1,2})([/\-.])(\d{1,2})\2(\d{4}|\d{2})(?![\w/])")),
]
ISSUER_LABEL = re.compile(
    r"^[\s\-–—•*]*(issuer|issued by|issuing authority|issuing office|authority|registering office|registered at|"
    r"sub[\s-]*registrar(?:y)? office|audited by|auditor|signed by)\s*[:=\-–—]\s*",
    re.I,
)
ISSUER_KEYWORDS = re.compile(r"\b(department|council|office|authority|board|directorate|committee|registrar|commission|"
                             r"services|corporation|chartered|accountants|association|bureau|cell|section|company)\b", re.I)
_TRAIL = ".,;:)(]["


# ----------------------------------------------------------------------------- text helpers
def normalize_m2(text):
    """NFKC, drop control characters, collapse whitespace. Keeps case and digits."""
    text = unicodedata.normalize("NFKC", text or "")
    text = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    return re.sub(r"[ \t]+", " ", text).strip()


def _valid_date(y, m, d):
    try:
        if not 1990 <= y <= 2100:
            return None
        return dt.date(y, m, d)
    except ValueError:
        return None


def parse_date_match(kind, m):
    """Return (iso_default, ambiguous, fmt) or None when it is not a real date."""
    g = m.groups()
    if kind == "dmy_text":
        d = _valid_date(int(g[2]), MONTHS[g[1][:3].lower()], int(g[0]))
        return (d.isoformat(), False, "dmy_text") if d else None
    if kind == "mdy_text":
        d = _valid_date(int(g[2]), MONTHS[g[0][:3].lower()], int(g[1]))
        return (d.isoformat(), False, "mdy_text") if d else None
    if kind == "iso":
        d = _valid_date(int(g[0]), int(g[2]), int(g[3]))
        return (d.isoformat(), False, "iso") if d else None
    a, sep, b, y = int(g[0]), g[1], int(g[2]), g[3]
    year = int(y) if len(y) == 4 else 2000 + int(y)
    dmy, mdy = _valid_date(year, b, a), _valid_date(year, a, b)
    readings = {d for d in (dmy, mdy) if d}
    fmt = "num_" + {"/": "slash", "-": "dash", ".": "dot"}[sep] + ("4" if len(y) == 4 else "2")
    if not readings:
        return None
    if len(readings) == 1:
        return (readings.pop().isoformat(), False, fmt)
    # two different valid readings (for example 04/05/2027): never parse silently, flag it
    return ((dmy or mdy).isoformat(), True, fmt)


# ----------------------------------------------------------------------------- layout helpers
def group_lines(words):
    """Group word indices into visual lines. Returns list of lists of word indices, top to bottom, left to right."""
    if not words:
        return []
    hs = [max(w["bbox"][3] - w["bbox"][1], 1e-4) for w in words]
    med_h = statistics.median(hs)
    order = sorted(range(len(words)), key=lambda i: ((words[i]["bbox"][1] + words[i]["bbox"][3]) / 2, words[i]["bbox"][0]))
    lines, cur, cur_y = [], [], None
    for i in order:
        yc = (words[i]["bbox"][1] + words[i]["bbox"][3]) / 2
        if cur and abs(yc - cur_y) > 0.6 * med_h:
            lines.append(cur)
            cur = []
        cur.append(i)
        cur_y = statistics.mean((words[j]["bbox"][1] + words[j]["bbox"][3]) / 2 for j in cur)
    if cur:
        lines.append(cur)
    return [sorted(l, key=lambda i: words[i]["bbox"][0]) for l in lines]


def _union(words, idxs):
    return [round(min(words[i]["bbox"][0] for i in idxs), 5), round(min(words[i]["bbox"][1] for i in idxs), 5),
            round(max(words[i]["bbox"][2] for i in idxs), 5), round(max(words[i]["bbox"][3] for i in idxs), 5)]


def _clean(tok):
    return tok.strip(_TRAIL)


def _tokens(words, idxs):
    return [w for w in (words[i]["text"] for i in idxs)]


# ----------------------------------------------------------------------------- candidate finder
def find_candidates(pages, doc_type="other"):
    """Return all candidates for one document. Deterministic. Same code for training and inference."""
    cands = []
    n_pages = max(len(pages), 1)
    for pg in pages:
        words = pg.get("words", [])
        lines = group_lines(words)
        line_texts = [" ".join(words[i]["text"] for i in l) for l in lines]
        for li, l in enumerate(lines):
            s_parts, starts, pos = [], [], 0
            for i in l:
                starts.append(pos)
                s_parts.append(words[i]["text"])
                pos += len(words[i]["text"]) + 1
            s = " ".join(s_parts)
            ends = [st + len(words[i]["text"]) for st, i in zip(starts, l)]

            def words_in(a, b):  # word positions (within the line) overlapping char range [a,b)
                return [k for k in range(len(l)) if starts[k] < b and ends[k] > a]

            # ---- dates
            taken, date_spans = [], []
            for kind, rx in DATE_PATTERNS:
                for m in rx.finditer(s):
                    if any(m.start() < e and m.end() > b for b, e in taken):
                        continue
                    parsed = parse_date_match(kind, m)
                    if not parsed:
                        continue
                    ks = words_in(m.start(), m.end())
                    if not ks:
                        continue
                    taken.append((m.start(), m.end()))
                    date_spans.append((ks[0], ks[-1], m.group(0), parsed))
            date_spans.sort()
            span_marks = [(a, b) for a, b, _, _ in date_spans]
            for a, b, raw, (iso, amb, fmt) in date_spans:
                cands.append(_make(words, pg, l, li, lines, line_texts, a, b, "date", raw.strip(_TRAIL), iso, amb, fmt, span_marks, n_pages, len(lines)))
            # ---- number-like tokens (skip anything inside a date span)
            in_date = {k for a, b, _, _ in date_spans for k in range(a, b + 1)}
            for k, i in enumerate(l):
                if k in in_date:
                    continue
                tok = _clean(words[i]["text"])
                digits = sum(c.isdigit() for c in tok)
                if len(tok) < 4 or digits < 3 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/\-_.,]*[A-Za-z0-9]", tok):
                    continue
                if re.fullmatch(r"(19|20|21)\d\d", tok):  # a bare year
                    continue
                cands.append(_make(words, pg, l, li, lines, line_texts, k, k, "number", tok, tok, False, "number", span_marks, n_pages, len(lines)))
            # ---- issuer lines
            y0 = min(words[i]["bbox"][1] for i in l)
            first_page, last_page = pg["page"] == pages[0]["page"], pg["page"] == pages[-1]["page"]
            m_lab = ISSUER_LABEL.match(s)
            text = s[m_lab.end():] if m_lab else s
            ks_all = list(range(len(l)))
            if m_lab:
                ks_all = [k for k in ks_all if starts[k] >= m_lab.end()]
            n_w = len(ks_all)
            dig_frac = sum(c.isdigit() for c in text) / max(len(text), 1)
            zone = (first_page and y0 < 0.30) or (last_page and y0 > 0.80) or bool(m_lab) or bool(ISSUER_KEYWORDS.search(text))
            min_words = 1 if m_lab else 2
            if zone and min_words <= n_w <= 12 and dig_frac <= 0.15 and not date_spans and ks_all:
                cands.append(_make(words, pg, l, li, lines, line_texts, ks_all[0], ks_all[-1], "issuer", _clean(text), text.strip(), False,
                                   "labelled_line" if m_lab else "line", [], n_pages, len(lines)))
    _doc_level(cands, doc_type)
    for n, c in enumerate(cands):
        c["cand_id"] = n
    return cands


def _make(words, pg, l, li, lines, line_texts, a, b, kind, text, value, amb, fmt, other_spans, n_pages, n_lines):
    idxs = l[a:b + 1]
    # left context stops at a previous date span on the same line, right context at the next one
    left_stop = max([e + 1 for s0, e in other_spans if e < a], default=0)
    right_stop = min([s0 for s0, e in other_spans if s0 > b], default=len(l))
    ctx_left = " ".join(words[i]["text"] for i in l[max(left_stop, a - 6):a])
    ctx_right = " ".join(words[i]["text"] for i in l[b + 1:min(right_stop, b + 5)])
    ctx_above = ""
    if li > 0:
        prev = lines[li - 1]
        gap = min(words[i]["bbox"][1] for i in l) - max(words[i]["bbox"][3] for i in prev)
        if gap < 0.05:
            ctx_above = " ".join(words[i]["text"] for i in prev[:12])
    bbox = _union(words, idxs)
    conf = round(statistics.mean(words[i]["conf"] for i in idxs), 3)
    line_txt = " ".join(line_texts[li].split()[:25])
    return {"cand_id": -1, "kind": kind, "text": text, "value": value, "ambiguous": int(bool(amb)), "fmt": fmt,
            "page": pg["page"], "n_pages": n_pages, "word_idx": idxs, "line_idx": li, "n_lines_page": n_lines,
            "x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3], "bbox": bbox, "ocr_conf": conf,
            "ctx_left": ctx_left, "ctx_right": ctx_right, "ctx_above": ctx_above, "line_text": line_txt,
            "n_tokens": len(idxs), "text_len": len(text), "digit_frac": round(sum(c.isdigit() for c in text) / max(len(text), 1), 3),
            "has_slash": int("/" in text), "has_hyphen": int("-" in text), "has_letters": int(any(c.isalpha() for c in text)),
            "year": int(value[:4]) if kind == "date" else 0, "doc_type": "other",
            "date_rank": 0, "n_dates": 0, "is_earliest_date": 0, "is_latest_date": 0, "page_frac": round(pg["page"] / n_pages, 3)}


def _doc_level(cands, doc_type):
    dates = sorted([c for c in cands if c["kind"] == "date"], key=lambda c: (c["page"], c["y0"], c["x0"]))
    by_value = sorted(dates, key=lambda c: c["value"])
    for r, c in enumerate(dates):
        c["date_rank"], c["n_dates"] = r, len(dates)
    if by_value:
        lo, hi = by_value[0]["value"], by_value[-1]["value"]
        for c in dates:
            c["is_earliest_date"], c["is_latest_date"] = int(c["value"] == lo), int(c["value"] == hi)
    for c in cands:
        c["doc_type"] = doc_type if doc_type in DOC_TYPES else "other"


# ----------------------------------------------------------------------------- shared helpers for training / inference
NUMERIC_FEATURES = ["page", "page_frac", "line_idx", "n_lines_page", "x0", "y0", "x1", "y1", "ocr_conf", "n_tokens", "text_len",
                    "digit_frac", "has_slash", "has_hyphen", "has_letters", "year", "date_rank", "n_dates", "is_earliest_date",
                    "is_latest_date", "ambiguous"]
TEXT_FEATURES = ["ctx_left", "ctx_right", "ctx_above", "line_text", "fmt", "doc_type"]


def zone_for(conf):
    return "green" if conf >= 0.90 else ("amber" if conf >= 0.60 else "red")


def date_gap_days(a_iso, b_iso):
    return (dt.date.fromisoformat(b_iso) - dt.date.fromisoformat(a_iso)).days
