#!/usr/bin/env python3
"""
ApprovalTrack M2 dataset generator (fictional demo data only).

Creates OCR-style documents (pages with word boxes, the same shape ocr_extract.py returns) for the 8 M1 classes,
with exact ground truth for four fields: issue_date, valid_to, cert_no, issuer.
Splits by LAYOUT (train / val / test never share a layout), validates everything, and writes:

  m2_docs_{train,val,test}.jsonl.gz        one document per line: pages, ground truth, flags
  m2_candidates_{train,val,test}.csv.gz    one row per candidate, with label (issue_date/valid_to/cert_no/issuer/none)
  m2_dataset_report.json                   counts, checks, distributions
  m2_dataset_card.md                       short description

Usage:  python generate_m2_dataset.py --out dataset --per-class 1500 --seed 2026
Needs m2_common.py in the same folder (or on PYTHONPATH).
"""
import argparse, csv, datetime as dt, gzip, hashlib, json, os, random, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr"))
import m2_common as C

TODAY = dt.date(2026, 10, 27)
LAYOUTS_PER_CLASS = 16            # 10 train, 3 val, 3 test
SPLIT_LAYOUTS = {"train": 10, "val": 3, "test": 3}

# ----------------------------------------------------------------------------- vocabulary (all fictional)
INST_A = ["Alpha", "Meridian", "Kaveri", "Horizon", "Lotus", "Zenith", "Orchid", "Granite", "Silverline", "Evergreen", "Aurora", "Sapphire",
          "Banyan", "Cedar", "Pioneer", "Summit", "Harmony", "Crescent", "Vertex", "Radiant", "Emerald", "Falcon", "Nimbus", "Tulip"]
INST_B = ["Institute of Technology", "College of Engineering", "School of Technology", "Polytechnic College", "Institute of Engineering and Technology",
          "Technical Campus", "College of Technology"]
PLACES = ["Riverton", "Hillcrest Nagar", "Lakeview", "Demo Nagar", "Maple Colony", "Northgate", "Sunrise Layout", "Greenfields", "Stonebridge", "Palm Grove",
          "Eastwood", "Harbour Road", "Cedar Park", "Willow Street", "Orchard Lane"]
ZONES = ["Zone I", "Zone II", "Zone III", "Zone IV", "North Zone", "South Zone", "East Zone", "West Zone", "Central Zone"]
REGIONS = ["Northern Region", "Southern Region", "Eastern Region", "Western Region", "Central Region", "South Western Region"]
SURN = ["Rao", "Menon", "Iyer", "Krishnan", "Nair", "Sharma", "Verma", "Pillai", "Reddy", "Joshi", "Kulkarni", "Banerjee", "Gupta", "Mehta", "Naidu", "Singh"]
FIRST = ["A. Kumar", "S. Ramesh", "P. Lakshmi", "R. Anand", "K. Meena", "M. Suresh", "V. Priya", "T. Arun", "N. Deepa", "G. Vikram", "J. Sangeetha", "D. Mohan"]
EMBLEM = ["Government of Demoland", "Government of Sampleland", "State of Demo Pradesh", "Republic of Demoland", "Demo State Government"]
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

ISSUE_COMMON = ["Date of Issue", "Issued on", "Issue Date", "Dated", "Date", "Date of Issuance", "Issued Date"]
VALID_COMMON = ["Valid Until", "Valid up to", "Date of Expiry", "Expiry Date", "Validity Upto", "Valid till", "Valid Through", "Expires on", "Valid upto"]
CERT_COMMON = ["Certificate No.", "Cert. No.", "Reference No.", "Ref No.", "Serial No.", "Registration No."]


def _fire_issuers(r):
    return r.choice(["Fire and Rescue Services Department", "Directorate of Fire Safety", "State Fire Service Authority", "Regional Fire Safety Commission",
                     f"Office of the District Fire Officer, {r.choice(ZONES)}", "Fire Safety Cell, Home Department", "Department of Fire Services"])
def _struct_issuers(r):
    return r.choice(["Structural Safety Cell, Public Works Department", "Office of the Chief Engineer", "Directorate of Building Safety",
                     "Board of Structural Engineers", f"Public Works Department, {r.choice(ZONES)}", "Technical Audit Cell, Works Department"])
def _occ_issuers(r):
    return r.choice(["Municipal Corporation Building Section", "Town and Country Planning Department", "Local Planning Authority", "Directorate of Town Planning",
                     f"Building Permissions Office, {r.choice(ZONES)}", "Urban Development Authority", "Municipal Corporation, Planning Department"])
def _nba_issuers(r):
    return r.choice(["National Board of Accreditation", "NBA Accreditation Cell", "Board of Accreditation, Evaluation Division", "National Board of Accreditation, Secretariat"])
def _acc_issuers(r):
    a, b = r.sample(SURN, 2)
    return r.choice([f"{a} and {b} Chartered Accountants", f"{a} Associates Chartered Accountants", f"{a}, {b} and Co. Chartered Accountants", f"{a} {b} and Associates Chartered Accountants"])
def _aicte_issuers(r):
    return r.choice(["All India Council for Technical Education", f"AICTE Regional Office, {r.choice(REGIONS)}", "Approval Bureau, Council for Technical Education",
                     f"Council for Technical Education, {r.choice(REGIONS)}", "All India Council for Technical Education, Approval Bureau"])
def _lease_issuers(r):
    return r.choice([f"Sub-Registrar Office, {r.choice(ZONES)}", "Office of the Sub-Registrar", f"Registration Department, {r.choice(ZONES)}", "District Registrar Office", f"Office of the Sub-Registrar, {r.choice(PLACES)}"])
def _other_issuers(r):
    return r.choice(["Department of Technical Education", "Municipal Corporation Revenue Section", "State Pollution Control Board", "Institution Registrar Office",
                     "Electricity Distribution Company", "Water Supply and Sewerage Board", "District Collectorate, General Section", "Education Services Directorate", "Public Information Bureau"])

# per type: title variants, issuer fn, labels, validity (years or months), prefix letters, distractor dates (label, base, lo, hi), body templates
TYPES = {
    "fire": dict(titles=["FIRE SAFETY CERTIFICATE", "FIRE NO OBJECTION CERTIFICATE", "FIRE SAFETY COMPLIANCE CERTIFICATE", "FIRE PREVENTION CERTIFICATE"],
        issuer=_fire_issuers, issue=ISSUE_COMMON + ["Certificate issued on"], valid=VALID_COMMON, cert=CERT_COMMON + ["Fire NOC No."], prefixes=["FS", "FNOC", "FIRE", "DFO", "FSC"],
        validity_months=[12, 24, 36], has_valid=True,
        dist=[("Date of Inspection", "issue", -60, -5), ("Application received on", "issue", -200, -20), ("Printed on", "issue", 0, 3), ("Next inspection due", "valid", -120, -30), ("Previous certificate expired on", "issue", -30, -1)],
        body=["This is to certify that the building of {inst}, situated at {addr}, has been inspected by the undersigned and found to comply with the fire safety requirements.",
              "The premises have {n_ext} fire extinguishers, {n_exit} emergency exits and a working fire alarm system as verified during the inspection.",
              "The occupant shall maintain all fire safety equipment in working order and shall inform this office of any structural change to the building.",
              "This certificate is subject to the conditions printed overleaf and may be withdrawn if the conditions are violated."]),
    "structural": dict(titles=["STRUCTURAL STABILITY CERTIFICATE", "STRUCTURAL SAFETY CERTIFICATE", "CERTIFICATE OF STRUCTURAL SOUNDNESS", "BUILDING STABILITY CERTIFICATE"],
        issuer=_struct_issuers, issue=ISSUE_COMMON + ["Date of Survey Report"], valid=VALID_COMMON + ["Stability certified up to"], cert=CERT_COMMON + ["Report No.", "Stability Cert. No."], prefixes=["SSC", "STB", "PWD", "SC", "BSC"],
        validity_months=[36, 48, 60], has_valid=True,
        dist=[("Date of Site Visit", "issue", -45, -3), ("Drawings reviewed on", "issue", -120, -10), ("Printed on", "issue", 0, 2), ("Next structural audit due", "valid", -150, -40), ("Date of Construction Completion", "issue", -2500, -400)],
        body=["Structural assessment of the buildings of {inst} at {addr} was carried out by the undersigned engineer.",
              "The structure has {n_floor} floors and a built up area of {area} square metres. No visible distress was observed in columns, beams or slabs.",
              "The buildings are found structurally safe for the present use, subject to periodic inspection as prescribed.",
              "Any addition or alteration to the structure shall require a fresh assessment by a competent engineer."]),
    "occupancy_building": dict(titles=["OCCUPANCY CERTIFICATE", "BUILDING COMPLETION AND OCCUPANCY CERTIFICATE", "BUILDING PLAN APPROVAL CERTIFICATE", "CERTIFICATE OF OCCUPANCY"],
        issuer=_occ_issuers, issue=ISSUE_COMMON + ["Date of Approval", "Approved on"], valid=VALID_COMMON + ["Approval valid up to"], cert=CERT_COMMON + ["Plan Approval No.", "Permit No.", "Building Permit No."], prefixes=["OC", "BPA", "TCP", "MC", "BP"],
        validity_months=[60, 84, 120], has_valid=True,
        dist=[("Plan submitted on", "issue", -300, -30), ("Date of Site Inspection", "issue", -40, -3), ("Printed on", "issue", 0, 2), ("Date of Commencement of Construction", "issue", -1500, -400), ("Next renewal reminder", "valid", -90, -30)],
        body=["The building of {inst}, constructed at {addr}, has been completed in accordance with the sanctioned plan and is fit for occupation.",
              "The building has {n_floor} floors and a plinth area of {area} square metres, and is to be used for educational purposes only.",
              "The owner shall not change the use of the building without prior permission of this authority.",
              "This certificate shall be displayed prominently at the entrance of the building."]),
    "nba_letter": dict(titles=["ACCREDITATION LETTER", "LETTER OF ACCREDITATION", "NBA ACCREDITATION OUTCOME", "ACCREDITATION DECISION LETTER"],
        issuer=_nba_issuers, issue=ISSUE_COMMON + ["Letter Date"], valid=VALID_COMMON + ["Accreditation valid up to", "Accredited up to"], cert=CERT_COMMON + ["Letter No.", "File Reference", "Accreditation Ref."], prefixes=["NBA", "ACC", "NBAC", "AC"],
        validity_months=[36, 60, 72], has_valid=True,
        dist=[("Application submitted on", "issue", -400, -60), ("Date of Evaluation Visit", "issue", -90, -20), ("Printed on", "issue", 0, 2), ("Compliance report due", "valid", -300, -120), ("Previous accreditation ended on", "issue", -30, -1)],
        body=["With reference to the evaluation of the programmes offered by {inst}, {addr}, the Board has decided to accredit {n_prog} programmes.",
              "The accreditation is granted for the period mentioned below and is subject to the compliance of the observations made by the evaluation committee.",
              "The institution shall submit the annual self assessment by the due date and shall inform the Board of any major change.",
              "The decision of the Board is final for the period of accreditation."]),
    "audited_accounts": dict(titles=["INDEPENDENT AUDITOR'S REPORT", "AUDITED FINANCIAL STATEMENTS", "AUDITOR'S REPORT AND ACCOUNTS", "REPORT OF THE STATUTORY AUDITOR"],
        issuer=_acc_issuers, issue=["Date of Report", "Date of Audit Report", "Signed on", "Date", "Report Date", "Place and Date", "Dated"], valid=[], cert=["Report No.", "Audit Ref. No.", "Reference No.", "Engagement No.", "Membership and Report No."], prefixes=["AUD", "AR", "CA", "FS", "ARN"],
        validity_months=[], has_valid=False,
        dist=[("Balance Sheet as at", "issue", -200, -120), ("For the year ended", "issue", -200, -120), ("Previous year ended", "issue", -565, -485), ("Audit commenced on", "issue", -60, -15), ("Board meeting held on", "issue", -20, -3)],
        body=["We have audited the accompanying financial statements of {inst}, {addr}, which comprise the balance sheet and the statement of income and expenditure.",
              "In our opinion the financial statements give a true and fair view of the state of affairs of the institution and of its surplus for the year.",
              "Total receipts for the year were Rs. {amount} and total expenditure was Rs. {amount2}.",
              "We conducted our audit in accordance with the applicable standards on auditing and have complied with the ethical requirements."]),
    "aicte_approval_letter": dict(titles=["EXTENSION OF APPROVAL", "APPROVAL LETTER", "LETTER OF APPROVAL FOR ACADEMIC YEAR", "GRANT OF APPROVAL"],
        issuer=_aicte_issuers, issue=ISSUE_COMMON + ["Letter Date", "Date of Approval Letter"], valid=VALID_COMMON + ["Approval valid up to", "Period of approval ends on"], cert=["Application ID", "Application No.", "Approval No.", "Letter No.", "Reference No.", "File No. (Approval)"], prefixes=["AP", "APH", "F", "AICTE", "AID"],
        validity_months=[12, 12, 24], has_valid=True,
        dist=[("Application submitted on", "issue", -300, -40), ("Reference to our earlier letter dated", "issue", -400, -100), ("Printed on", "issue", 0, 2), ("Date of Expert Visit", "issue", -80, -20), ("Compliance undertaking due by", "valid", -250, -100)],
        body=["With reference to the application of {inst}, {addr}, approval is granted to the institution for the courses and intake mentioned in the annexure.",
              "The approval is subject to the undertakings submitted by the institution and to the conditions of the Approval Process Handbook.",
              "The institution shall keep all prescribed documents valid and shall upload renewals before the due dates.",
              "This letter does not remove the need for compliance with any other law in force."]),
    "lease": dict(titles=["LEASE DEED", "DEED OF LEASE", "REGISTERED LEASE AGREEMENT", "LEASE AGREEMENT"],
        issuer=_lease_issuers, issue=["Date of Registration", "Registered on", "Date of Deed", "Executed on", "Date", "Dated", "Date of Execution"], valid=["Lease Ends On", "Lease Expiry", "Expiry Date", "Valid Until", "Lease Valid up to", "Termination Date", "Valid till"], cert=["Document No.", "Registration No.", "Doc. No.", "Deed No.", "Book and Document No."], prefixes=["DOC", "REG", "LD", "SR", "DN"],
        validity_months=[60, 108, 132, 180, 240, 360], has_valid=True,
        dist=[("Stamp paper purchased on", "issue", -10, -1), ("Lease commencement date", "issue", 0, 45), ("Rent revision due on", "issue", 300, 400), ("Date of Possession", "issue", 0, 60), ("Printed on", "issue", 0, 2)],
        body=["This Deed of Lease is made between the Lessor and {inst}, the Lessee, for the premises situated at {addr}.",
              "The Lessee shall pay a monthly rent of Rs. {amount} and a refundable security deposit of Rs. {amount2}.",
              "The Lessee shall use the premises only for running a technical educational institution and shall not sub-let any part of it.",
              "Either party may end the lease by giving three months notice in writing, subject to the terms of this deed."]),
    "other": dict(titles=["NO OBJECTION CERTIFICATE", "ACKNOWLEDGEMENT RECEIPT", "NOTICE", "AFFIDAVIT", "CIRCULAR", "PROCEEDINGS", "ELECTRICITY CLEARANCE", "WATER CONNECTION LETTER"],
        issuer=_other_issuers, issue=ISSUE_COMMON + ["Date of Notice", "Receipt Date"], valid=VALID_COMMON + ["Applicable till"], cert=CERT_COMMON + ["Notice No.", "Receipt No.", "Letter No.", "Proceedings No."], prefixes=["GEN", "NOC", "REC", "NTC", "CIR"],
        validity_months=[6, 12, 24, 36], has_valid="mixed",
        dist=[("Application dated", "issue", -150, -10), ("Date of Meeting", "issue", -20, -2), ("Printed on", "issue", 0, 2), ("Date of Birth of Applicant", "issue", -16000, -9000), ("Last date for reply", "issue", 10, 30)],
        body=["This communication relates to {inst}, {addr}, and is issued for the information of the institution.",
              "The institution is requested to note the contents and to take the necessary action within the time allowed.",
              "A copy of this document shall be kept in the records of the office and may be produced on request.",
              "Any query regarding this document may be addressed to the issuing office during working hours."]),
}
SENTENCES = [  # (template with {issue_l} {D1} {valid_l} {D2}) - phrases between the dates
    ("This certificate is issued on", "and shall remain valid until"),
    ("Issued on", "and valid up to"),
    ("The document bears the date", "and its validity ends on"),
    ("Given under my hand on", "and valid through"),
    ("Dated this", "with validity till"),
]
DATE_FORMATS = ["%d %B %Y", "%d %b %Y", "%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%B %d, %Y", "%Y-%m-%d", "%d %B, %Y", "ORD"]
CONF = {"a": "o", "o": "0", "l": "1", "i": "l", "e": "c", "s": "5", "b": "6", "n": "u", "m": "rn", "t": "f"}


# ----------------------------------------------------------------------------- helpers
def add_months(d, m):
    y, mo = divmod(d.month - 1 + m, 12)
    y, mo = d.year + y, mo + 1
    for day in range(d.day, 27, -1):
        try:
            return dt.date(y, mo, day)
        except ValueError:
            continue
    return dt.date(y, mo, min(d.day, 28))


def fmt_date(d, f):
    if f == "ORD":
        n = d.day
        suf = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        return f"{n}{suf} {MONTH_NAMES[d.month - 1]} {d.year}"
    s = d.strftime(f)
    if f in ("%d %B %Y", "%d %b %Y", "%d-%b-%Y", "%d %B, %Y"):
        s = s.lstrip("0") if r_lstrip.random() < 0.5 else s
    return s


r_lstrip = random.Random(7)


class Layout:
    """All visual choices of one layout. Documents of a layout share these; splits are made by layout."""
    def __init__(self, doc_type, idx, seed):
        r = random.Random(f"{seed}-{doc_type}-{idx}")
        T = TYPES[doc_type]
        self.id = f"{doc_type}_L{idx:02d}"
        self.doc_type = doc_type
        self.date_fmt = r.choice(DATE_FORMATS)
        self.alt_fmt = r.choice(DATE_FORMATS)
        self.date_style = r.choice(["kv", "table", "stacked", "sentence", "sidebyside", "right_block"])
        self.cert_style = r.choice(["kv", "table", "stacked", "top_right", "kv"])
        self.issuer_pos = r.choice(["top_center", "top_left", "labelled", "bottom_stamp", "top_and_bottom", "top_center"])
        self.sep = r.choice([" :", ":", " -", "", " :"])
        self.issue_label = r.choice(T["issue"])
        self.valid_label = r.choice(T["valid"]) if T["valid"] else ""
        self.cert_label = r.choice(T["cert"])
        self.sentence = r.randrange(len(SENTENCES))
        self.valid_first = r.random() < 0.15
        self.cert_first = r.random() < 0.4
        self.fields_after_body = r.random() < 0.3
        self.repeat_issue_footer = r.random() < 0.25
        self.upper_labels = r.random() < 0.3
        self.size = r.choice([0.9, 1.0, 1.0, 1.1])
        self.line_gap = r.choice([0.026, 0.028, 0.030])
        self.left = r.choice([0.07, 0.08, 0.10])
        self.value_x = r.choice([0.42, 0.48, 0.52])
        self.n_body = r.choice([2, 3, 4])
        self.title_center = r.random() < 0.7
        self.emblem = r.random() < 0.75
        self.cert_fmt = r.randrange(6)
        self.dist_dates = r.choice([1, 2, 2, 3])
        self.dist_nums = r.choice([2, 3, 3, 4])
        self.addressee = doc_type in ("nba_letter", "aicte_approval_letter", "other") and r.random() < 0.7


def make_cert_no(r, T, layout, issue):
    p = r.choice(T["prefixes"]); y, yy = issue.year, issue.year % 100
    n4, n5, n6 = r.randrange(1000, 9999), r.randrange(10000, 99999), r.randrange(100000, 999999)
    reg = r.choice(["TN", "KA", "MH", "DL", "KL", "AP", "GJ", "RJ", "WB", "UP", "ZN3", "R2"])
    return [f"{p}/{y}/{n5}", f"{p}-{yy}-{n6}", f"{p}{n6}", f"{p}/{reg}/{n4}/{y}", f"{n4}/{y}", f"{reg}/{p}/{yy}/{n5}"][layout.cert_fmt if r.random() < 0.7 else r.randrange(6)]


def distractor_numbers(r, n):
    pool = [("Pin", f"{r.randrange(600000, 699999)}"), ("Phone", f"{r.randrange(7000000000, 9999999999)}"), ("Challan No.", f"CH/{r.randrange(2021, 2027)}/{r.randrange(10000, 99999)}"),
            ("Receipt No.", f"RC-{r.randrange(100000, 999999)}"), ("GSTIN", f"{r.randrange(10, 38)}ABCDE{r.randrange(1000, 9999)}F1Z{r.randrange(1, 9)}"),
            ("PAN", f"AAATD{r.randrange(1000, 9999)}K"), ("Survey No.", f"{r.randrange(100, 999)}/{r.randrange(1, 9)}B"), ("Previous Ref. No.", f"OLD/{r.randrange(2015, 2022)}/{r.randrange(10000, 99999)}"),
            ("Fee paid Rs.", f"{r.randrange(1, 99)},{r.randrange(10, 99)},000/-"), ("Plot Area sq.ft", f"{r.randrange(10000, 99999)}"), ("Diary No.", f"D/{r.randrange(1000, 9999)}/{r.randrange(2021, 2027)}")]
    return r.sample(pool, n)


# ----------------------------------------------------------------------------- canvas
class Canvas:
    CW = 0.0098   # char width as fraction of page width at size 1.0
    def __init__(self, layout, r, noisy):
        self.L, self.r, self.noisy = layout, r, noisy
        self.pages = [[]]
        self.y = 0.06
        self.gid = 0
        self.size = layout.size

    def new_gid(self):
        self.gid += 1
        return self.gid

    def _place(self, x_mode, x, items, size, y):
        text_len = sum(len(t) for t, _, _ in items) + max(len(items) - 1, 0)
        cw = self.CW * size
        width = text_len * cw
        if x_mode == "C": x0 = x - width / 2
        elif x_mode == "R": x0 = x - width
        else: x0 = x
        if width > 0.92:                 # shrink to fit the page
            cw *= 0.92 / width; x0 = 0.04 if x_mode != "R" else x0
        h = 0.016 * size
        page = self.pages[-1]
        cx = max(x0, 0.02)
        for t, role, gid in items:
            w = len(t) * cw
            jit = lambda: self.r.uniform(-0.0006, 0.0006)
            conf = round(self.r.uniform(0.93, 0.995), 3) if not self.noisy else round(self.r.uniform(0.62, 0.97), 3)
            txt = t
            if self.noisy and role is None and self.r.random() < 0.05 and len(t) > 3 and not any(c.isdigit() for c in t):
                k = self.r.randrange(len(t)); ch = t[k].lower()
                if ch in CONF: txt = t[:k] + CONF[ch] + t[k + 1:]
            page.append({"text": txt, "bbox": [round(cx + jit(), 5), round(y + jit(), 5), round(min(cx + w, 0.99) + jit(), 5), round(y + h + jit(), 5)],
                         "conf": conf, "_role": role, "_gid": gid})
            cx += w + cw
        return

    def line(self, segs, size=None, advance=True, y=None):
        """segs: list of (mode, x, items). items: list of (text, role, gid)."""
        size = size or self.size
        if y is None:
            if self.y > 0.86:
                self.pages.append([]); self.y = 0.06
            y = self.y
        for mode, x, items in segs:
            self._place(mode, x, items, size, y)
        if advance:
            self.y = y + self.L.line_gap * size / self.size * 1.0 + 0.0

    def gap(self, g=0.012):
        self.y += g

    def paragraph(self, items, x=None, max_w=0.84, size=None):
        size = size or self.size
        x = x if x is not None else self.L.left
        units, cur, last = [], [], None
        for it in items:
            if it[2] is not None and it[2] == last: units[-1].append(it)
            else: units.append([it])
            last = it[2]
        cw = self.CW * size
        line, wlen = [], 0
        for u in units:
            ulen = sum(len(t) + 1 for t, _, _ in u) * cw
            if line and wlen + ulen > max_w:
                self.line([("L", x, line)], size); line, wlen = [], 0
            line += u; wlen += ulen
        if line: self.line([("L", x, line)], size)

    def finish(self):
        out = []
        for i, pg in enumerate(self.pages):
            pg.sort(key=lambda w: (round((w["bbox"][1] + w["bbox"][3]) / 2, 3), w["bbox"][0]))
            out.append(pg)
        return out


def toks(text, role=None, gid=None):
    return [(t, role, gid) for t in text.split()]


# ----------------------------------------------------------------------------- document builder
def build_doc(doc_type, layout, r, doc_no, seed):
    T = TYPES[doc_type]; L = layout
    noisy = r.random() < 0.28
    cv = Canvas(L, r, noisy)
    # --- dates
    issue = TODAY - dt.timedelta(days=r.randrange(5, 1900))
    has_valid = T["has_valid"] is True or (T["has_valid"] == "mixed" and r.random() < 0.5)
    valid = (add_months(issue, r.choice(T["validity_months"])) - dt.timedelta(days=1)) if has_valid else None
    if doc_type == "aicte_approval_letter" and has_valid and r.random() < 0.6:
        issue = dt.date(r.choice([2022, 2023, 2024, 2025, 2026]), r.choice([3, 4, 5, 6, 7]), r.randrange(1, 29))
        vm = r.choice([3, 6, 9])
        valid = dt.date(issue.year + (1 if r.random() < 0.8 else 2), vm, 31 if vm == 3 else 30)
    use_alt = r.random() < 0.2
    fmt = L.alt_fmt if use_alt else L.date_fmt
    def D(d): return fmt_date(d, fmt)
    issue_label = L.issue_label if r.random() > 0.2 else r.choice(T["issue"])
    valid_label = (L.valid_label if r.random() > 0.2 else r.choice(T["valid"])) if has_valid else ""
    cert_label = L.cert_label if r.random() > 0.2 else r.choice(T["cert"])
    cert = make_cert_no(r, T, L, issue)
    issuer = T["issuer"](r)
    inst = f"{r.choice(INST_A)} {r.choice(INST_B)}"
    addr = f"{r.randrange(1, 400)}, {r.choice(PLACES)}, {r.choice(PLACES)} - {r.randrange(600000, 699999)}"
    UL = (lambda s: s.upper()) if L.upper_labels else (lambda s: s)
    sep = L.sep

    def issue_items(): return toks(fmt_date(issue, fmt) if not use_alt else D(issue), "issue_date", cv.new_gid())
    def valid_items(): return toks(D(valid), "valid_to", cv.new_gid())

    def emit_issuer_top():
        if L.emblem: cv.line([("C", 0.5, toks(r.choice(EMBLEM)))], 1.0)
        pos = L.issuer_pos
        if pos in ("top_center", "top_and_bottom"): cv.line([("C", 0.5, toks(issuer, "issuer", cv.new_gid()))], 1.25)
        elif pos == "top_left": cv.line([("L", L.left, toks(issuer, "issuer", cv.new_gid()))], 1.2)
        elif pos in ("labelled", "bottom_stamp"):
            cv.line([("C", 0.5, toks(inst))], 1.2)
        cv.gap(0.01)
        if L.addressee:
            cv.line([("L", L.left, toks("To,"))]); cv.line([("L", L.left, toks("The Director,"))]); cv.line([("L", L.left, toks(f"{inst}, {addr}"))]); cv.gap(0.008)

    def cert_block():
        if L.cert_style == "top_right":
            cv.line([("R", 0.94, toks(UL(cert_label) + sep) + toks(cert, "cert_no", cv.new_gid()))])
        elif L.cert_style == "table":
            cv.line([("L", L.left, toks(UL(cert_label))), ("L", L.value_x, toks(cert, "cert_no", cv.new_gid()))])
        elif L.cert_style == "stacked":
            cv.line([("L", L.left, toks(UL(cert_label)))], 0.85); cv.line([("L", L.left, toks(cert, "cert_no", cv.new_gid()))])
        else:
            cv.line([("L", L.left, toks(UL(cert_label) + sep) + toks(cert, "cert_no", cv.new_gid()))])

    def dates_block():
        order = ["issue", "valid"] if not L.valid_first else ["valid", "issue"]
        if not has_valid: order = ["issue"]
        st = L.date_style
        if st == "sentence" and has_valid:
            a, b = SENTENCES[L.sentence]
            items = toks(a) + issue_items() + toks(b) + valid_items()
            items[-1] = (items[-1][0] + ".", items[-1][1], items[-1][2])
            cv.paragraph(items); return
        if st == "sentence": st = "kv"
        if st == "sidebyside" and has_valid:
            cv.line([("L", L.left, toks(UL(issue_label) + sep) + issue_items()), ("L", 0.55, toks(UL(valid_label) + sep) + valid_items())] if not L.valid_first else
                    [("L", L.left, toks(UL(valid_label) + sep) + valid_items()), ("L", 0.55, toks(UL(issue_label) + sep) + issue_items())]); return
        if st == "sidebyside": st = "kv"
        for o in order:
            lab = UL(issue_label if o == "issue" else valid_label)
            mk = issue_items if o == "issue" else valid_items
            if st == "kv": cv.line([("L", L.left, toks(lab + sep) + mk())])
            elif st == "table": cv.line([("L", L.left, toks(lab)), ("L", L.value_x, mk())])
            elif st == "stacked": cv.line([("L", L.left, toks(lab))], 0.85); cv.line([("L", L.left, mk())])
            elif st == "right_block": cv.line([("R", 0.94, toks(lab + sep) + mk())])

    def labelled_issuer():
        if L.issuer_pos == "labelled":
            cv.line([("L", L.left, toks(r.choice(["Issued by", "Issuing Authority", "Authority"]) + (" :" if r.random() < 0.7 else ":")) + toks(issuer, "issuer", cv.new_gid()))])

    def distractors():
        for label, base, lo, hi in r.sample(T["dist"], min(L.dist_dates, len(T["dist"]))):
            if base == "valid" and valid is None: base_d = issue + dt.timedelta(days=365)
            else: base_d = issue if base == "issue" else valid
            d = base_d + dt.timedelta(days=r.randint(lo, hi))
            if d == issue or (valid and d == valid): d += dt.timedelta(days=3)   # never equal a target date, so labels stay unambiguous
            f2 = fmt if r.random() < 0.8 else r.choice(DATE_FORMATS)
            cv.line([("L", L.left, toks(label + ":") + toks(fmt_date(d, f2)))])
        for label, val in distractor_numbers(r, L.dist_nums):
            cv.line([("L", L.left, toks(label + ":") + toks(val))])

    def body():
        for tmpl in T["body"][:L.n_body] + ([] if L.n_body >= 4 else []):
            txt = tmpl.format(inst=inst, addr=addr, n_ext=r.randrange(4, 60), n_exit=r.randrange(2, 12), n_floor=r.randrange(2, 9), area=r.randrange(900, 15000),
                              n_prog=r.randrange(1, 6), amount=f"{r.randrange(2, 90)},{r.randrange(10, 99)},{r.randrange(100, 999)}", amount2=f"{r.randrange(2, 90)},{r.randrange(10, 99)},{r.randrange(100, 999)}")
            cv.paragraph(toks(txt)); cv.gap(0.008)

    # --- assemble
    emit_issuer_top()
    title = r.choice(T["titles"])
    if doc_type in ("nba_letter", "aicte_approval_letter", "other"): cert_block(); cv.line([("L", L.left, toks("Subject: " + title.title()))]); cv.gap(0.008)
    else:
        cv.line([("C" if L.title_center else "L", 0.5 if L.title_center else L.left, toks(title))], 1.3); cv.gap(0.01)
        cert_block()
    if not L.fields_after_body: labelled_issuer(); dates_block(); cv.gap(0.01); distractors(); cv.gap(0.01); body()
    else: body(); labelled_issuer(); dates_block(); cv.gap(0.01); distractors()
    # --- footer / signature
    if cv.y > 0.80: cv.pages.append([]); cv.y = 0.06
    fy = 0.86
    sig = r.choice(FIRST)
    cv.line([("R", 0.92, toks(sig))], advance=False, y=fy)
    cv.line([("R", 0.92, toks(r.choice(["Authorised Signatory", "Issuing Officer", "Competent Authority", "Chartered Accountant", "Registrar"])))], advance=False, y=fy + 0.026)
    if L.issuer_pos in ("bottom_stamp", "top_and_bottom"):
        cv.line([("C", 0.5, toks("Seal and Signature"))], 0.9, advance=False, y=0.915)
        cv.line([("C", 0.5, toks(issuer, "issuer", cv.new_gid()))], 1.1, advance=False, y=0.94)
    if L.repeat_issue_footer and not (L.issuer_pos in ("bottom_stamp", "top_and_bottom")):
        cv.line([("L", L.left, toks("Place and Date:" if r.random() < 0.5 else "Issued on:") + issue_items())], advance=False, y=0.93)
    pages = cv.finish()

    # --- ground truth (word indices are per page, in final order)
    spans = defaultdict(list)
    out_pages = []
    for pi, pg in enumerate(pages, 1):
        groups = defaultdict(list)
        for wi, w in enumerate(pg):
            if w["_role"]: groups[(w["_role"], w["_gid"])].append(wi)
        for (role, gid), idxs in groups.items():
            spans[role].append({"page": pi, "word_idx": idxs})
        out_pages.append({"page": pi, "width": 595.0, "height": 842.0, "source": "synthetic",
                          "words": [{"text": w["text"], "bbox": w["bbox"], "conf": w["conf"]} for w in pg]})
    for role in spans:  # trailing punctuation only on the last word of a sentence date - keep texts as built
        pass
    fields = {"issue_date": issue.isoformat(), "cert_no": cert, "issuer": issuer}
    if has_valid: fields["valid_to"] = valid.isoformat()
    meta = {"doc_id": f"{doc_type}-{L.id[-3:]}-{doc_no:05d}", "doc_type": doc_type, "layout_id": L.id, "noisy": int(noisy), "has_valid_to": int(has_valid),
            "fields": fields, "spans": dict(spans), "date_format": fmt, "pages": out_pages}
    return meta


# ----------------------------------------------------------------------------- labelling + validation
def label_candidates(meta, cands):
    """Label each candidate by exact word-set match to the ground-truth spans. Raises on any inconsistency."""
    span_index = {}
    for role, lst in meta["spans"].items():
        for s in lst:
            span_index[(s["page"], tuple(s["word_idx"]))] = role
    # candidate word_idx are positions within the line-ordered group; map to page word indices
    # (find_candidates already returns page-local word indices because group_lines returns them)
    labelled, found = [], defaultdict(int)
    for c in cands:
        role = span_index.get((c["page"], tuple(sorted(c["word_idx"]))), "none")
        if role != "none":
            kind_ok = {"issue_date": "date", "valid_to": "date", "cert_no": "number", "issuer": "issuer"}[role]
            if c["kind"] != kind_ok:
                raise ValueError(f"{meta['doc_id']}: {role} matched a {c['kind']} candidate")
            found[role] += 1
        c = dict(c); c["label"] = role
        labelled.append(c)
    for role in meta["fields"]:
        if found[role] < 1:
            raise ValueError(f"{meta['doc_id']}: ground truth {role} not recovered by the candidate finder")
    # value checks
    by_role = defaultdict(list)
    for c in labelled:
        if c["label"] != "none": by_role[c["label"]].append(c)
    for role, cs in by_role.items():
        for c in cs:
            exp = meta["fields"][role]
            got = c["value"] if role != "cert_no" else c["text"]
            if role == "issuer": got = c["text"]
            if got != exp and not (role in ("issue_date", "valid_to") and c["ambiguous"]):
                raise ValueError(f"{meta['doc_id']}: {role} value mismatch {got!r} != {exp!r}")
            if role in ("issue_date", "valid_to") and c["ambiguous"]:
                pass
    return labelled


def doc_checks(meta):
    f = meta["fields"]
    assert dt.date.fromisoformat(f["issue_date"]) <= TODAY, "issue date in the future"
    if "valid_to" in f:
        assert dt.date.fromisoformat(f["valid_to"]) > dt.date.fromisoformat(f["issue_date"]), "valid_to not after issue"
    assert all(isinstance(v, str) and v.strip() for v in f.values()), "empty field value"
    for pg in meta["pages"]:
        for w in pg["words"]:
            b = w["bbox"]
            assert w["text"].strip() and 0 <= b[0] < b[2] <= 1.0 and 0 <= b[1] < b[3] <= 1.0, f"bad word box {w}"
            assert 0 < w["conf"] <= 1


CSV_COLS = ["doc_id", "split", "doc_type", "layout_id", "noisy", "cand_id", "kind", "label", "text", "value", "ambiguous", "fmt", "page", "n_pages",
            "word_idx", "line_idx", "n_lines_page", "x0", "y0", "x1", "y1", "ocr_conf", "ctx_left", "ctx_right", "ctx_above", "line_text", "n_tokens",
            "text_len", "digit_frac", "has_slash", "has_hyphen", "has_letters", "year", "date_rank", "n_dates", "is_earliest_date", "is_latest_date", "page_frac"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="dataset"); ap.add_argument("--per-class", type=int, default=1500); ap.add_argument("--seed", type=int, default=2026)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    layouts, split_of = {}, {}
    for t in C.DOC_TYPES:
        ids = list(range(LAYOUTS_PER_CLASS)); random.Random(f"{a.seed}-split-{t}").shuffle(ids)
        bounds = {"train": ids[:10], "val": ids[10:13], "test": ids[13:16]}
        for sp, lst in bounds.items():
            for i in lst:
                L = Layout(t, i, a.seed); layouts[L.id] = L; split_of[L.id] = sp
    writers = {sp: gzip.open(os.path.join(a.out, f"m2_docs_{sp}.jsonl.gz"), "wt", encoding="utf-8") for sp in SPLIT_LAYOUTS}
    csvf = {sp: gzip.open(os.path.join(a.out, f"m2_candidates_{sp}.csv.gz"), "wt", encoding="utf-8", newline="") for sp in SPLIT_LAYOUTS}
    csvw = {sp: csv.DictWriter(csvf[sp], fieldnames=CSV_COLS) for sp in SPLIT_LAYOUTS}
    for w in csvw.values(): w.writeheader()
    stats = {"docs": Counter(), "cands": Counter(), "labels": Counter(), "ambiguous_docs": Counter(), "noisy_docs": Counter(), "no_valid_docs": Counter(), "fmt": Counter(), "per_type": Counter()}
    seen_hash, rejected = set(), 0
    layouts_by_type = defaultdict(list)
    for L in layouts.values(): layouts_by_type[L.doc_type].append(L)
    for t in C.DOC_TYPES:
        r = random.Random(f"{a.seed}-docs-{t}")
        made, n = 0, 0
        Ls = sorted(layouts_by_type[t], key=lambda x: x.id)
        while made < a.per_class:
            L = Ls[made % len(Ls)]
            n += 1
            meta = build_doc(t, L, r, n, a.seed)
            try:
                doc_checks(meta)
                cands = C.find_candidates(meta["pages"], t)
                lab = label_candidates(meta, cands)
            except (AssertionError, ValueError) as e:   # a document that fails ANY check is dropped, never repaired
                rejected += 1
                continue
            h = hashlib.sha1(json.dumps([[w["text"] for w in p["words"]] for p in meta["pages"]]).encode()).hexdigest()
            if h in seen_hash: rejected += 1; continue
            seen_hash.add(h)
            sp = split_of[L.id]
            amb = int(any(c["ambiguous"] and c["label"] in ("issue_date", "valid_to") for c in lab))
            meta["split"] = sp
            meta["expected_blank_fields"] = sorted({c["label"] for c in lab if c["ambiguous"] and c["label"] in ("issue_date", "valid_to")})
            meta["has_ambiguous_target"] = amb
            writers[sp].write(json.dumps(meta, ensure_ascii=False) + "\n")
            for c in lab:
                row = {k: c[k] for k in CSV_COLS if k in c}
                row.update(doc_id=meta["doc_id"], split=sp, doc_type=t, layout_id=L.id, noisy=meta["noisy"], word_idx=" ".join(map(str, c["word_idx"])))
                csvw[sp].writerow(row)
                stats["labels"][(sp, c["label"])] += 1
            stats["docs"][sp] += 1; stats["cands"][sp] += len(lab); stats["ambiguous_docs"][sp] += amb; stats["noisy_docs"][sp] += meta["noisy"]
            stats["no_valid_docs"][sp] += 1 - meta["has_valid_to"]; stats["fmt"][meta["date_format"]] += 1; stats["per_type"][(t, sp)] += 1
            made += 1
    for w in list(writers.values()) + list(csvf.values()): w.close()
    # ---------------- post checks on the written files
    import pandas as pd
    report = {"seed": a.seed, "per_class": a.per_class, "rejected_and_dropped": rejected, "layouts": {sp: sorted(i for i, s in split_of.items() if s == sp) for sp in SPLIT_LAYOUTS},
              "docs": dict(stats["docs"]), "candidates": dict(stats["cands"]), "docs_with_ambiguous_target": dict(stats["ambiguous_docs"]), "noisy_docs": dict(stats["noisy_docs"]),
              "docs_without_valid_to": dict(stats["no_valid_docs"]), "date_formats": dict(stats["fmt"]), "label_counts": {f"{k[0]}:{k[1]}": v for k, v in sorted(stats["labels"].items())}}
    frames = {}
    for sp in SPLIT_LAYOUTS:
        df = pd.read_csv(os.path.join(a.out, f"m2_candidates_{sp}.csv.gz"), keep_default_na=False)
        frames[sp] = df
        empties = int((df.astype(str).apply(lambda col: col.str.strip() == "")).drop(columns=["ctx_left", "ctx_right", "ctx_above"]).sum().sum())
        report.setdefault("empty_cells_in_required_columns", {})[sp] = empties
        assert empties == 0, f"empty cells found in {sp}"
        assert set(df["label"]) <= set(C.ROLES)
    ids = {sp: set(f["layout_id"]) for sp, f in frames.items()}
    report["layout_leakage"] = {"train&val": len(ids["train"] & ids["val"]), "train&test": len(ids["train"] & ids["test"]), "val&test": len(ids["val"] & ids["test"])}
    assert not any(report["layout_leakage"].values()), "layout leakage"
    docs_all = [d for sp in SPLIT_LAYOUTS for d in map(json.loads, gzip.open(os.path.join(a.out, f"m2_docs_{sp}.jsonl.gz"), "rt", encoding="utf-8"))]
    report["duplicate_doc_ids"] = len(docs_all) - len({d["doc_id"] for d in docs_all})
    report["duplicate_texts"] = 0
    assert report["duplicate_doc_ids"] == 0
    report["positives_per_doc_min"] = {role: int(min(sum(1 for c in d["spans"].get(role, [])) for d in docs_all if role in d["fields"])) for role in ("issue_date", "cert_no", "issuer")}
    json.dump(report, open(os.path.join(a.out, "m2_dataset_report.json"), "w"), indent=2)
    print(json.dumps({k: report[k] for k in ("docs", "candidates", "rejected_and_dropped", "docs_with_ambiguous_target", "docs_without_valid_to", "layout_leakage", "empty_cells_in_required_columns")}, indent=2))


if __name__ == "__main__":
    main()
