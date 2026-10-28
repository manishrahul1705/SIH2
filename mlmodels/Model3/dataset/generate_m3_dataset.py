#!/usr/bin/env python3
"""
ApprovalTrack M3 - synthetic lease-deed dataset generator.

All names, places, amounts and numbers are fictional demo data.

Writes plain CSV (no nulls, no empty cells; "NONE" means "not present / must be blank"):
  m3_documents_{train,val,test}.csv   one row per deed: true fields + expected outputs
  m3_candidates_{train,val,test}.csv  one row per date/term candidate with its role label
  m3_pages_{train,val,test}.csv       one row per page: the deed text the finder ran on
  m3_layouts.csv                      the 16 layouts and their split
  m3_dataset_report.json              counts and the drop log

Split is BY LAYOUT (10 train / 3 val / 3 test), so no test layout is seen in training.

Every deed is checked while it is generated, and any deed that fails is DROPPED, never
repaired: every candidate the finder sees must be labelled, and every true field must
be recovered exactly (an ambiguous date must be flagged and carry the true reading).

Usage:  python generate_m3_dataset.py --out . --docs-per-layout 500 --seed 2026
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import textwrap
from collections import Counter
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ocr"))
from m3_common import CANDIDATE_FIELDS, find_lease_candidates          # noqa: E402
from m3_lease import (DEMO_AS_OF, lease_end_date, lease_status,           # noqa: E402
                      reconcile_lease, status_from_reconciled)

N_LAYOUTS = 16
SPLIT_OF_RANK = ["train"] * 10 + ["val"] * 3 + ["test"] * 3

MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
NUMERIC_STYLES = ["dmy_slash", "dmy_dot", "dmy_dash", "dmy_dot2"]


class Skip(Exception):
    pass


# ----------------------------------------------------------------------------- words
_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
_TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
          "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def words(n):
    assert 1 <= n <= 99
    if n < 10:
        return _ONES[n]
    if n < 20:
        return _TEENS[n - 10]
    t, o = divmod(n, 10)
    return _TENS[t] + ("-" + _ONES[o] if o else "")


def ordinal(n):
    if 10 <= n % 100 <= 20:
        return f"{n}th"
    return f"{n}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th') }"


def inr(n):
    s = str(n)
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts + [tail])


def fmt_date(d, style):
    mon = MONTHS[d.month]
    if style == "dmy_long":
        return f"{d.day} {mon} {d.year}"
    if style == "dmy_ord":
        return f"{ordinal(d.day)} {mon}, {d.year}"
    if style == "dmy_abbr":
        return f"{d.day:02d}-{mon[:3]}-{d.year}"
    if style == "dmy_slash":
        return f"{d.day:02d}/{d.month:02d}/{d.year}"
    if style == "dmy_dot":
        return f"{d.day:02d}.{d.month:02d}.{d.year}"
    if style == "dmy_dot2":
        return f"{d.day:02d}.{d.month:02d}.{d.year % 100:02d}"
    if style == "dmy_dash":
        return f"{d.day:02d}-{d.month:02d}-{d.year}"
    if style == "iso":
        return d.isoformat()
    if style == "mdy":
        return f"{mon} {d.day}, {d.year}"
    if style == "dayof":
        return f"{ordinal(d.day)} day of {mon}, {d.year}"
    raise ValueError(style)


def fmt_term(months, num_style, rnd):
    """Render a term such as 'nine (9) years' / '5 years and 6 months' / 'eleven months'."""
    y, m = divmod(months, 12)
    parts = [(y, "year"), (m, "month")] if (y and m) else ([(y, "year")] if y else [(months, "month")])

    def num(n):
        return {"d": str(n), "w": words(n), "p": f"{words(n)} ({n})", "q": f"{n} ({words(n)})"}[num_style]

    out = [f"{num(n)} {u}{'s' if n != 1 else ''}" for n, u in parts]
    return (" and " if rnd.random() < 0.7 else " ").join(out)


def sub_months_start(end_plus_1, months):
    """Candidate start so that start + months has anniversary end_plus_1 (verified by caller)."""
    total = end_plus_1.year * 12 + (end_plus_1.month - 1) - months
    y, m0 = divmod(total, 12)
    m = m0 + 1
    import calendar
    last = calendar.monthrange(y, m)[1]
    return date(y, m, min(end_plus_1.day, last))


# ----------------------------------------------------------------------------- pools
FIRST = ["Arvind", "Meera", "Karthik", "Lakshmi", "Rajan", "Sunita", "Venkat", "Anitha", "Ramesh",
         "Geetha", "Murugan", "Kavitha", "Suresh", "Revathi", "Balaji", "Nandini", "Harish", "Padma",
         "Senthil", "Vimala", "Gopal", "Shanthi", "Dinesh", "Radha", "Manoj", "Usha", "Prakash",
         "Janaki", "Siva", "Malathi"]
LAST = ["Iyer", "Nair", "Reddy", "Pillai", "Kumar", "Naidu", "Menon", "Rao", "Chandran",
        "Subramanian", "Gounder", "Das", "Bhat", "Sharma", "Varma", "Krishnan", "Mudaliar", "Patel",
        "Shetty", "Hegde"]
PLACE_A = ["Kadam", "Vel", "Pon", "Nal", "Sen", "Arun", "Mani", "Then", "Karu", "Ilam", "Poy",
           "Anai", "Veera", "Sol", "Madu"]
PLACE_B = ["pur", "palli", "nagar", "kottai", "halli", "puram", "vadi", "kudi", "patti", "malai"]
INST_A = ["Kaveri", "Nilgiri", "Amaravati", "Sahyadri", "Aravalli", "Vindhya", "Meenakshi", "Bhairavi",
          "Tamarai", "Sundara", "Thendral", "Ponni", "Agasthya", "Mahendra", "Vaigai", "Siruvani"]
INST_B = ["Institute of Technology", "College of Engineering", "School of Engineering and Technology",
          "Institute of Engineering and Management", "Polytechnic College", "Institute of Management Studies"]
TRUST_A = ["Sri", "Shree", "Annai", "Vidya", "Gnana", "Bharathi"]
TRUST_B = ["Educational Trust", "Charitable Society", "Education Foundation", "Vidyalaya Trust"]
STREETS = ["Gandhi", "Nehru", "Temple", "Market", "College", "Lake View", "Mill", "Station", "Garden"]
STATES = ["Thenmalai Pradesh", "Kaveri Province"]
OLD_TENANTS = ["Vel Traders", "Annapoorna Stores", "Sakthi Textiles", "Pon Agencies", "Nila Printers"]
AUTHORITIES = ["Municipal Corporation", "Town Panchayat", "Fire and Rescue Services Department",
               "District Town Planning Office"]

TITLES = ["LEASE DEED", "DEED OF LEASE", "LEASE AGREEMENT", "INDENTURE OF LEASE", "REGISTERED LEASE DEED"]
CLAUSE_STYLES = ["{n}.", "{n})", "Clause {n}:", "({n})", "ARTICLE {n} -"]
HEADER_STYLES = ["{title} - Page {n} of {N}", "Page {n}/{N}  |  {title}", "-- {n} --", "{title} ({n})", "PAGE {n}"]
LAYOUT_DATE_STYLES = [
    ["dmy_long"], ["dmy_ord", "dmy_long"], ["dmy_abbr", "dmy_long"], ["dmy_slash", "dmy_long"],
    ["dmy_dot", "dmy_ord"], ["iso", "dmy_long"], ["mdy", "dmy_long"], ["dayof", "dmy_ord"],
    ["dmy_dash", "dmy_abbr"], ["dmy_dot2", "dmy_long"], ["dmy_slash", "dmy_dot"], ["dmy_ord", "mdy"],
    ["dayof", "dmy_long"], ["dmy_long", "dmy_abbr"], ["dmy_slash", "dmy_dash", "dmy_ord"],
    ["iso", "dmy_slash"],
]

# Boilerplate that must never contain a date or a "<number> years/months" phrase.
FILLER = [
    "The Lessee shall pay the monthly rent of Rs. {rent}/- on or before the seventh day of every English calendar month by bank transfer to the account designated by the Lessor.",
    "The Lessee has paid a refundable interest-free security deposit of Rs. {deposit}/- which the Lessor shall return without deduction other than lawful dues when the Lessee hands back vacant possession.",
    "The Lessee shall use the Premises only for running an educational institution, hostel, laboratory or allied administrative activities and for no other purpose.",
    "The Lessee shall keep the Premises in good and tenantable condition and shall carry out ordinary repairs at its own cost, while structural repairs shall be undertaken by the Lessor.",
    "All municipal taxes, property taxes and water charges relating to the Premises shall be borne by the Lessor, whereas electricity, internet and similar consumption charges shall be borne by the Lessee.",
    "The Lessee shall not sublet, assign or part with possession of the Premises or any portion thereof without the prior written consent of the Lessor.",
    "The Lessor and its authorised representatives may inspect the Premises at reasonable hours after giving reasonable prior intimation to the Lessee.",
    "The Lessee shall obtain and keep in force all licences, consents and approvals required from statutory authorities for operating its institution in the Premises.",
    "The Lessee shall maintain adequate fire safety equipment in the Premises and shall comply with the directions of the competent fire authority from time to time.",
    "The Lessee may make internal partitions, install laboratory fittings and fix signboards at its own cost, provided that no structural damage is caused to the building.",
    "The Lessor declares that it has a clear and marketable title to the Premises, that the Premises are free from encumbrances, litigation and attachment, and that it has full power to grant this Lease.",
    "The Lessee shall indemnify the Lessor against any claim, loss or liability arising from the negligence or unlawful acts of the Lessee, its staff or visitors in the Premises.",
    "Any dispute arising out of this Deed shall first be settled by mutual discussion, failing which it shall be referred to a sole arbitrator appointed by mutual consent under the Arbitration and Conciliation Act, 1996, and the seat of arbitration shall be {place}.",
    "The stamp duty, registration charges and incidental expenses of this Deed shall be borne equally by the Lessor and the Lessee.",
    "This Deed shall be governed by the laws of India and the courts at {district} shall have exclusive jurisdiction in respect of all matters arising out of it.",
    "The Lessee shall insure the contents and equipment kept in the Premises at its own cost, and the Lessor shall insure the building structure against fire and allied perils.",
    "Any notice under this Deed shall be in writing and shall be sent by registered post or by courier to the address of the other party stated above, and it shall be deemed to be served when delivered at that address.",
    "The Lessee shall not store hazardous, explosive or prohibited materials in the Premises and shall observe all applicable environmental and safety regulations.",
    "The Lessor shall provide uninterrupted access to the common areas, parking space, water supply and the approach road for students, staff and visitors of the Lessee.",
    "If the Lessee commits default in payment of rent for a continuous period and fails to rectify it after written notice, the Lessor shall be entitled to initiate lawful proceedings for recovery of dues and possession.",
    "On the expiry or earlier determination of this Lease the Lessee shall remove its movable assets and hand over vacant and peaceful possession of the Premises in the same condition, ordinary wear and tear excepted.",
    "The Premises measure about {area} square feet of built-up area and are situated in Survey No. {survey}, at {place}, {district}.",
    "The parties confirm that they have read and understood every clause of this Deed in the language known to them and have signed it voluntarily and without any coercion or undue influence.",
    "The Lessee shall display its approval and affiliation details at a prominent place in the Premises and shall ensure that the Premises continue to satisfy the norms prescribed by the regulatory authorities.",
    "Force majeure events such as natural calamity, epidemic, riot or governmental restriction shall suspend the performance of the affected obligations only for the duration of such event.",
    "Time shall be of the essence in respect of all payments and obligations of the Lessee under this Deed.",
]

START_PHR = [
    'The term of this Lease shall commence from {S} (the "Commencement Date").',
    "This Lease shall be effective w.e.f. {S}.",
    "The Lessee shall hold the Premises with effect from {S}, the date of commencement of the tenancy.",
    "Commencement of the lease: {S}.",
    "The tenancy hereby created shall begin on {S}.",
]
END_PHR = [
    "This Lease shall expire on {E} unless renewed or sooner determined in accordance with this Deed.",
    "The Lease shall come to an end on {E}.",
    "The Lessee shall vacate the Premises on or before {E}, being the date of expiry.",
    "Date of expiry of the lease: {E}.",
]
TERM_PHR = [
    "The Lease shall be for a period of {T}.",
    "The duration of the tenancy shall be {T} computed from the Commencement Date.",
    "The term of this Lease is {T}.",
    "The Lessee is granted the Premises for a term of {T}.",
]
COMB_SE = [
    "The lease shall be for the period commencing from {S} and expiring on {E}.",
    "The Lessor demises the Premises to the Lessee for the period from {S} to {E}, both days inclusive.",
    "The term shall run from {S} up to and including {E}.",
    "Lease period: {S} to {E}.",
]
COMB_ST = [
    "The Lease shall be for a period of {T} commencing from {S}.",
    "With effect from {S}, the Lessee shall hold the Premises for a term of {T}.",
    "The Lease is granted for {T} from {S}.",
    "Term and commencement: {T} from {S}.",
]
COMB_SET = [
    "The Lease shall be for a period of {T} commencing from {S} and expiring on {E}.",
    "For a term of {T} beginning {S} and ending {E}, the Lessor lets the Premises to the Lessee.",
    "The Lessee shall enjoy the Premises for {T}, that is from {S} until {E}.",
    "Term: {T} ({S} to {E}).",
]


# ----------------------------------------------------------------------------- layouts
def make_layouts(seed):
    rnd = random.Random(seed)
    ids = list(range(N_LAYOUTS))
    rnd.shuffle(ids)
    split = {lid: SPLIT_OF_RANK[i] for i, lid in enumerate(ids)}
    widths = [64, 68, 72, 76, 80, 84, 88, 92, 70, 74, 78, 82, 86, 66, 90, 96]
    rnd.shuffle(widths)
    layouts = []
    for lid in range(N_LAYOUTS):
        layouts.append({
            "layout_id": lid, "split": split[lid], "width": widths[lid],
            "lines_per_page": rnd.randint(34, 52), "date_styles": LAYOUT_DATE_STYLES[lid],
            "family": rnd.randrange(5), "title": TITLES[lid % len(TITLES)],
            "clause_style": CLAUSE_STYLES[(lid * 3 + rnd.randrange(2)) % len(CLAUSE_STYLES)],
            "header": HEADER_STYLES[(lid + rnd.randrange(2)) % len(HEADER_STYLES)],
            "footer_date": lid % 3 == 0, "has_schedule": lid % 2 == 1,
            "combined_prob": [0.25, 0.5, 0.75][lid % 3], "age_in_party": lid % 4 != 0,
        })
    return layouts


# ----------------------------------------------------------------------------- noise
def noise_text(text, rnd, rate=0.05):
    out = []
    for w in text.split(" "):
        if len(w) >= 5 and w.isalpha() and rnd.random() < rate:
            k = rnd.randrange(5)
            i = rnd.randrange(1, len(w) - 1)
            if k == 0:
                w = w.replace("rn", "m", 1) if "rn" in w else w[:i] + w[i + 1:]
            elif k == 1:
                w = w[:i] + ("I" if w[i] == "l" else w[i]) + w[i + 1:]
            elif k == 2:
                w = w[:i] + ("c" if w[i] == "e" else w[i]) + w[i + 1:]
            elif k == 3:
                w = w[:i] + w[i + 1:]
            else:
                w = w[:i] + w[i] + w[i:]
        out.append(w)
    return " ".join(out)


# ----------------------------------------------------------------------------- one deed
def sample_term(rnd):
    cat = rnd.choices(["months", "years", "ym"], [25, 50, 25])[0]
    if cat == "months":
        return rnd.choice([3, 6, 9, 11, 11, 11, 15, 18, 24, 36])
    if cat == "years":
        y = rnd.choice([1, 2, 3, 3, 5, 5, 9, 9, 10, 10, 15, 20, 25, 29, 30, rnd.randint(1, 30)])
        return y * 12
    return rnd.randint(1, 15) * 12 + rnd.randint(1, 11)


def pick_start_and_term(rnd, forced_amb):
    target = rnd.choices(["expired", "live", "expires_soon", "not_started"], [30, 40, 12, 18])[0]
    for _ in range(600):
        term = sample_term(rnd)
        if target == "expires_soon":
            e0 = DEMO_AS_OF + timedelta(days=rnd.randint(0, 30))
            start = sub_months_start(e0 + timedelta(days=1), term)
        else:
            start = date(2008, 1, 1) + timedelta(days=rnd.randrange(0, 365 * 22))
        if forced_amb and not (start.day <= 12 and start.day != start.month):
            continue
        end = lease_end_date(start, term)
        if end.year > 2065 or start.year < 2005:
            continue
        if target == "expires_soon" and end != e0:
            continue
        if lease_status(start, end, term, DEMO_AS_OF)["status"] == target:
            return start, term, target
    raise Skip("could_not_sample_start")


def build_deed(rnd, layout, k):
    scenario = rnd.choices(["A", "B", "C", "D"], [25, 25, 35, 15])[0]
    forced_amb = rnd.random() < 0.12
    start, term, _target = pick_start_and_term(rnd, forced_amb)
    true_end = lease_end_date(start, term)

    styles = layout["date_styles"]
    if forced_amb:
        pool = [s for s in styles if s in NUMERIC_STYLES] or NUMERIC_STYLES
        main_style = rnd.choice(pool)
    else:
        main_style = rnd.choice(styles)
    num_style = rnd.choices(["d", "w", "p", "q"], [30, 30, 20, 20])[0]

    end_stated = scenario in ("A", "C", "D")
    term_stated = scenario in ("B", "C", "D")
    stated_end = true_end if end_stated else None
    if scenario == "D":
        for _ in range(60):
            kind = rnd.choice(["years", "months", "days"])
            delta = {"years": 12 * rnd.randint(1, 3), "months": rnd.randint(1, 6),
                     "days": None}[kind]
            if kind == "days":
                cand = true_end + timedelta(days=rnd.choice([-1, 1]) * rnd.randint(1, 45))
            else:
                cand = lease_end_date(start, max(1, term + rnd.choice([-1, 1]) * delta))
            if cand > start and cand != true_end and cand.year <= 2066:
                stated_end = cand
                break
        else:
            raise Skip("could_not_make_inconsistent_end")

    key_values = {start, true_end}
    if stated_end:
        key_values.add(stated_end)

    reg = {}                                     # (kind, text) -> role

    def register(kind, text, role):
        old = reg.get((kind, text))
        if old is not None and old != role:
            raise Skip("role_conflict")
        reg[(kind, text)] = role
        return text

    def D(d, role, style=None):
        return register("date", fmt_date(d, style or main_style), role)

    def other_style():
        return rnd.choice(styles)

    def free_date(base, lo, hi):
        for _ in range(60):
            d = base + timedelta(days=rnd.randint(lo, hi))
            if d not in key_values:
                return d
        raise Skip("no_free_date")

    used_term_months = {term}

    def free_term(choices):
        opts = [c for c in choices if c not in used_term_months]
        if not opts:
            raise Skip("no_free_term")
        m = rnd.choice(opts)
        used_term_months.add(m)
        return m

    def Tn(months, role, style=None):
        return register("term", fmt_term(months, style or rnd.choice(["d", "w", "p", "q"]), rnd), role)

    # ---- fictional parties and property
    place = rnd.choice(PLACE_A) + rnd.choice(PLACE_B)
    district = rnd.choice(PLACE_A) + rnd.choice(PLACE_B)
    state = rnd.choice(STATES)
    inst = f"{rnd.choice(INST_A)} {rnd.choice(INST_B)}"
    trust = f"{rnd.choice(TRUST_A)} {rnd.choice(INST_A)} {rnd.choice(TRUST_B)}"
    chair = f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"
    addr = lambda: (f"No. {rnd.randint(1, 450)}, {rnd.choice(STREETS)} Street, "
                    f"{rnd.choice(PLACE_A) + rnd.choice(PLACE_B)}, {district} District, {state}, "
                    f"PIN {rnd.randint(600000, 699999)}")
    individual = rnd.random() < 0.7
    if individual:
        lessor = f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"
        if layout["age_in_party"]:
            lessor_txt = (f"{lessor}, son of {rnd.choice(FIRST)} {rnd.choice(LAST)}, aged about "
                          f"{register('term', str(rnd.randint(31, 79)) + ' years', 'none')}, residing at {addr()}")
        else:
            lessor_txt = f"{lessor}, son of {rnd.choice(FIRST)} {rnd.choice(LAST)}, residing at {addr()}"
    else:
        lessor = f"M/s {rnd.choice(INST_A)} {rnd.choice(['Estates', 'Properties', 'Realty'])} LLP"
        lessor_txt = f"{lessor}, represented by its partner {rnd.choice(FIRST)} {rnd.choice(LAST)}, having its office at {addr()}"
    rent = inr(rnd.randrange(15, 400) * 1000)
    fill_ctx = {"rent": rent, "deposit": inr(rnd.randrange(1, 40) * 100000),
                "area": inr(rnd.randrange(8, 90) * 500), "survey": f"{rnd.randint(11, 899)}/{rnd.randint(1, 9)}{rnd.choice('ABC')}",
                "place": place, "district": district}

    # ---- dates that are NOT the lease start or end
    exec_d = start - timedelta(days=rnd.randint(1, 45))
    if exec_d in key_values:
        raise Skip("exec_collision")
    reg_d = free_date(exec_d, 0, 10)
    stamp_d = free_date(exec_d, -12, 0)
    poss_d = start - timedelta(days=rnd.randint(1, 20))
    noc_d = free_date(exec_d, -400, -30)
    exec_style = "dayof" if rnd.random() < 0.5 else other_style()

    # ---- paragraphs: (kind, text, is_filler)
    head = []
    head.append(("plain", f"THIS {layout['title'].split()[-1]} is made and executed at {place} on this "
                          f"{D(exec_d, 'none', exec_style)}", False))
    head.append(("plain", f"BETWEEN {lessor_txt}, hereinafter called the LESSOR of the one part;", False))
    head.append(("plain", f"AND {inst}, run by {trust}, represented by its Chairman {chair}, having its office at "
                          f"{addr()}, hereinafter called the LESSEE of the other part.", False))
    recitals = [("plain", f"WHEREAS the Lessor is the absolute owner of the land and building in Survey No. "
                          f"{fill_ctx['survey']}, {place}, {district} District, hereinafter called the Premises, and the Lessee "
                          f"has requested the Lessor to let the Premises for its institution.", False)]
    has_older = rnd.random() < 0.3
    if has_older:
        od1 = exec_d - timedelta(days=rnd.randint(500, 3600))
        od2 = od1 + timedelta(days=rnd.randint(0, 20))
        od3 = free_date(od2, 300, 1500)
        if od3 >= start:
            raise Skip("older_lease_overlap")
        o_term = free_term([6, 9, 11, 12, 24, 36, 60, 108, 120, 180, 240])
        recitals.append(("plain", f"WHEREAS the Premises were earlier let to M/s {rnd.choice(OLD_TENANTS)} under a lease deed dated "
                                  f"{D(od1, 'none', other_style())} for a period of {Tn(o_term, 'none')} commencing from "
                                  f"{D(od2, 'none', other_style())}, which lease stood terminated on "
                                  f"{D(od3, 'none', other_style())}.", False))
    recitals.append(("plain", f"NOW THIS DEED WITNESSETH AS FOLLOWS:", False))

    S = D(start, "lease_start")
    E = D(stated_end, "lease_end") if stated_end else ""
    T = Tn(term, "term_value", num_style) if term_stated else ""
    fam = layout["family"]
    pick = lambda lst: lst[(fam + rnd.choice([0, 1])) % len(lst)]
    combined = rnd.random() < layout["combined_prob"]
    key_paras = []
    if scenario == "A":
        key_paras = ([pick(COMB_SE).format(S=S, E=E)] if combined
                     else [pick(START_PHR).format(S=S), pick(END_PHR).format(E=E)])
    elif scenario == "B":
        key_paras = ([pick(COMB_ST).format(S=S, T=T)] if combined
                     else [pick(START_PHR).format(S=S), pick(TERM_PHR).format(T=T)])
    else:
        key_paras = ([pick(COMB_SET).format(S=S, E=E, T=T)] if combined
                     else [pick(START_PHR).format(S=S), pick(TERM_PHR).format(T=T), pick(END_PHR).format(E=E)])

    dist = []
    dist.append(f"The Lessee has been put in possession of the Premises on {D(poss_d, 'none', other_style())} "
                f"for fit-out work, and the Lessor acknowledges the same.")
    dist.append(f"This Deed is presented for registration before the Sub-Registrar, {place}, on "
                f"{D(reg_d, 'none', other_style())}, and the stamp paper used for it was purchased on "
                f"{D(stamp_d, 'none', other_style())}.")
    dist.append(f"A copy of the no-objection certificate dated {D(noc_d, 'none', other_style())} issued by the "
                f"{rnd.choice(AUTHORITIES)} is annexed to this Deed.")
    if rnd.random() < 0.6:
        dm = free_term([2, 3, 6])
        dist.append(f"The Lessee has deposited with the Lessor, as interest-free security, a sum equal to "
                    f"{Tn(dm, 'none')}' rent, that is Rs. {fill_ctx['deposit']}/-.")
    if rnd.random() < 0.5:
        rm = free_term([11, 12, 24, 36, 60])
        nm = free_term([1, 2, 3, 4, 6])
        dist.append(f"The Lessee may, at its option, renew this Lease for a further term of {Tn(rm, 'none')} on mutually "
                    f"agreed rent by giving not less than {Tn(nm, 'none')} written notice before the expiry of the Lease.")
    elif rnd.random() < 0.5:
        nm = free_term([1, 2, 3, 4, 6])
        dist.append(f"Either party may terminate this Lease by giving the other party {Tn(nm, 'none')} prior written "
                    f"notice and by settling all dues, and by giving not less than 30 days' further notice for handover.")
    if rnd.random() < 0.35:
        lk = free_term([6, 9, 12, 24, 36])
        dist.append(f"The Lessee shall not terminate this Lease during the lock-in period of {Tn(lk, 'none')}.")
    has_renew = any("renew this Lease" in p for p in dist)
    if term >= 36 and rnd.random() < 0.35:
        rev = None
        from m3_lease import add_months_anniversary
        cand = add_months_anniversary(start, 36)
        if cand not in key_values:
            rev = cand
        if rev:
            step = free_term([24, 36, 48, 60])
            dist.append(f"The rent shall stand enhanced by {rnd.choice([5, 7, 10])} per cent w.e.f. "
                        f"{D(rev, 'none', other_style())} and thereafter at intervals of every {Tn(step, 'none')}.")

    operative = [("clause", t, False) for t in key_paras + dist]
    rnd.shuffle(operative)
    # keep start-before-end/term order most of the time
    if rnd.random() < 0.85:
        idx = [i for i, p in enumerate(operative) if p[1] in key_paras]
        ordered = sorted((p for p in operative if p[1] in key_paras), key=lambda p: key_paras.index(p[1]))
        for i, p in zip(sorted(idx), ordered):
            operative[i] = p

    closing = [("plain", "IN WITNESS WHEREOF the parties have set their hands to this Deed at the place first written above "
                         "in the presence of the following witnesses:", False),
               ("plain", f"WITNESSES: 1. {rnd.choice(FIRST)} {rnd.choice(LAST)}   2. {rnd.choice(FIRST)} {rnd.choice(LAST)}", False),
               ("plain", f"Place: {place}    Date: {D(exec_d, 'none', exec_style)}", False)]
    schedule = []
    if layout["has_schedule"]:
        schedule.append(("plain", "SCHEDULE OF PARTICULARS", False))
        schedule.append(("plain", f"Commencement date: {D(start, 'lease_start')}", False))
        if stated_end:
            schedule.append(("plain", f"Date of expiry: {D(stated_end, 'lease_end')}", False))
        if term_stated:
            schedule.append(("plain", f"Lease term: {Tn(term, 'term_value', num_style)}", False))
        schedule.append(("plain", f"Monthly rent: Rs. {rent}/-", False))

    # ---- length: 3..12 pages, key clause lands anywhere
    target_pages = rnd.choices(range(3, 13), [14, 16, 14, 12, 10, 9, 8, 7, 6, 4])[0]
    lpp = layout["lines_per_page"]
    footer = layout["footer_date"]
    bpp = lpp - 1 - (1 if footer else 0)
    wrapper = textwrap.TextWrapper(width=layout["width"], break_long_words=False, break_on_hyphens=False)

    def est_lines(paras):
        return sum(len(wrapper.wrap(p[1])) + 1 for p in paras)

    def filler_para():
        sents = rnd.sample(FILLER, rnd.choice([2, 3]))
        txt = " ".join(s.format(**fill_ctx) for s in sents)
        if rnd.random() < 0.28:
            txt = noise_text(txt, rnd)
        return ("clause", txt, True)

    need = (target_pages - 1) * bpp + 8
    total_est = est_lines(head + recitals + operative + closing + schedule)
    while total_est < need:
        para = filler_para()
        total_est += len(wrapper.wrap(para[1])) + 1
        operative.insert(rnd.randint(0, len(operative)), para)

    def render(paras_all):
        lines, n = [], 0
        for kind, text, _f in paras_all:
            if kind == "clause":
                n += 1
                prefix = layout["clause_style"].format(n=n) + " "
                w = textwrap.TextWrapper(width=layout["width"], break_long_words=False, break_on_hyphens=False,
                                         initial_indent=prefix, subsequent_indent=" " * len(prefix))
            else:
                w = wrapper
            lines.extend(w.wrap(text))
            lines.append("")
        while lines and lines[-1] == "":
            lines.pop()
        return lines

    all_paras = head + recitals + operative + closing + schedule
    lines = render(all_paras)
    while len(lines) < (3 - 1) * bpp + 3:
        operative.insert(rnd.randint(0, len(operative)), filler_para())
        all_paras = head + recitals + operative + closing + schedule
        lines = render(all_paras)

    print_d = free_date(date(2021, 1, 1), 0, 2000) if footer else None
    pages_body = [lines[i:i + bpp] for i in range(0, len(lines), bpp)]
    n_pages = len(pages_body)
    if not 3 <= n_pages <= 12:
        raise Skip("page_count_out_of_range")
    foot_txt = None
    if footer:
        foot_txt = f"Printed on {D(print_d, 'none', rnd.choice(styles))}   Ref {rnd.randint(10000, 99999)}"
    pages = []
    for i, body in enumerate(pages_body, 1):
        while body and body[0] == "":
            body = body[1:]
        parts = [layout["header"].format(title=layout["title"], n=i, N=n_pages)] + body
        if foot_txt:
            parts.append(foot_txt)
        pages.append("\n".join(parts))

    return {
        "scenario": scenario, "start": start, "stated_end": stated_end, "stated_term": term if term_stated else None,
        "true_end_from_term": true_end if term_stated else None, "reg": reg, "pages": pages,
        "main_style": main_style, "num_style": num_style if term_stated else "NONE",
        "has_older": has_older, "has_renew": has_renew, "has_schedule": layout["has_schedule"],
        "n_pages": n_pages,
    }


# ----------------------------------------------------------------------------- label + check
def label_and_check(deed):
    pages = [{"page": i, "text": t, "words": []} for i, t in enumerate(deed["pages"], 1)]
    cands = find_lease_candidates(pages)
    reg = deed["reg"]
    seen_texts = set()
    for c in cands:
        role = reg.get((c["kind"], c["text"]))
        if role is None:
            raise Skip("unlabelled_candidate")
        c["role"] = "other" if role == "none" else role      # "other", never "none": must not look like a null
        seen_texts.add((c["kind"], c["text"]))
    for key, role in reg.items():
        if key not in seen_texts:
            raise Skip("registered_text_not_found")
    start_iso = deed["start"].isoformat()

    def find(role, iso):
        rows = [c for c in cands if c["role"] == role]
        if not rows:
            raise Skip(f"{role}_missing")
        for c in rows:
            if c["ambiguous"]:
                if iso not in (c["value"], c["alt_value"]):
                    raise Skip(f"{role}_not_recovered")
            elif c["value"] != iso:
                raise Skip(f"{role}_not_recovered")
        return rows[0]["ambiguous"]

    start_amb = bool(find("lease_start", start_iso))
    end_amb = False
    if deed["stated_end"]:
        end_amb = bool(find("lease_end", deed["stated_end"].isoformat()))
    elif any(c["role"] == "lease_end" for c in cands):
        raise Skip("unexpected_end")
    if deed["stated_term"]:
        rows = [c for c in cands if c["role"] == "term_value"]
        if not rows or any(c["term_months"] != deed["stated_term"] or c["ambiguous"] for c in rows):
            raise Skip("term_not_recovered")
    elif any(c["role"] == "term_value" for c in cands):
        raise Skip("unexpected_term")
    return cands, start_amb, end_amb


# ----------------------------------------------------------------------------- csv
DOC_FIELDS = ["doc_id", "split", "layout_id", "n_pages", "scenario", "stated_start", "stated_end",
              "stated_term_months", "end_stated", "term_stated", "consistency", "start_ambiguous",
              "end_ambiguous", "date_style", "term_style", "has_older_lease", "has_renewal",
              "has_schedule", "n_candidates", "end_from_term", "expected_start", "expected_end",
              "expected_term_months", "expected_state", "expected_reason", "expected_status",
              "status_as_of"]
CAND_FIELDS = ["doc_id", "split", "layout_id", "role"] + list(CANDIDATE_FIELDS)


def doc_row(doc_id, layout, deed, cands, start_amb, end_amb):
    stated_end = deed["stated_end"]
    term = deed["stated_term"]
    rec = reconcile_lease(None if start_amb else deed["start"],
                          None if (stated_end is None or end_amb) else stated_end,
                          term, start_ambiguous=start_amb, end_ambiguous=end_amb)
    status = status_from_reconciled(rec, DEMO_AS_OF)
    consistency = "inconsistent" if deed["scenario"] == "D" else "consistent"
    if consistency == "inconsistent" and not start_amb and not end_amb:
        assert rec["state"] == "inconsistent", (doc_id, rec)
    nz = lambda v: "NONE" if v in (None, "") else v
    return {
        "doc_id": doc_id, "split": layout["split"], "layout_id": layout["layout_id"],
        "n_pages": deed["n_pages"], "scenario": deed["scenario"], "stated_start": deed["start"].isoformat(),
        "stated_end": nz(stated_end.isoformat() if stated_end else None),
        "stated_term_months": nz(term), "end_stated": int(stated_end is not None),
        "term_stated": int(term is not None), "consistency": consistency,
        "start_ambiguous": int(start_amb), "end_ambiguous": int(end_amb),
        "date_style": deed["main_style"], "term_style": deed["num_style"],
        "has_older_lease": int(deed["has_older"]), "has_renewal": int(deed["has_renew"]),
        "has_schedule": int(deed["has_schedule"]), "n_candidates": len(cands),
        "end_from_term": nz(deed["true_end_from_term"].isoformat() if deed["true_end_from_term"] else None),
        "expected_start": nz(rec["start"]), "expected_end": nz(rec["end"]),
        "expected_term_months": nz(rec["term_months"] or None), "expected_state": rec["state"],
        "expected_reason": rec["reason"], "expected_status": status["status"],
        "status_as_of": DEMO_AS_OF.isoformat(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=HERE)
    ap.add_argument("--docs-per-layout", type=int, default=500)
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    layouts = make_layouts(args.seed)
    files, writers = {}, {}
    for split in ("train", "val", "test"):
        for name, fields in (("documents", DOC_FIELDS), ("candidates", CAND_FIELDS),
                             ("pages", ["doc_id", "split", "layout_id", "page", "text"])):
            f = open(os.path.join(args.out, f"m3_{name}_{split}.csv"), "w", newline="", encoding="utf-8")
            files[(name, split)] = f
            writers[(name, split)] = csv.DictWriter(f, fieldnames=fields)
            writers[(name, split)].writeheader()

    drops, counts = Counter(), Counter()
    roles, scen, status_by_split, pages_hist = Counter(), Counter(), {}, Counter()
    amb_docs = Counter()
    for layout in layouts:
        rnd = random.Random(f"{args.seed}-{layout['layout_id']}")
        made, attempts = 0, 0
        while made < args.docs_per_layout:
            attempts += 1
            if attempts > args.docs_per_layout * 6:
                raise SystemExit(f"layout {layout['layout_id']}: too many drops")
            try:
                deed = build_deed(rnd, layout, made)
                cands, s_amb, e_amb = label_and_check(deed)
            except Skip as e:
                drops[str(e)] += 1
                continue
            doc_id = f"L{layout['layout_id']:02d}-{made:04d}"
            split = layout["split"]
            row = doc_row(doc_id, layout, deed, cands, s_amb, e_amb)
            writers[("documents", split)].writerow(row)
            for c in cands:
                writers[("candidates", split)].writerow(
                    {"doc_id": doc_id, "split": split, "layout_id": layout["layout_id"], **c})
                roles[(split, c["role"])] += 1
            for i, t in enumerate(deed["pages"], 1):
                writers[("pages", split)].writerow({"doc_id": doc_id, "split": split,
                                                    "layout_id": layout["layout_id"], "page": i, "text": t})
            counts[split] += 1
            scen[(split, deed["scenario"])] += 1
            status_by_split.setdefault(split, Counter())[row["expected_status"]] += 1
            pages_hist[deed["n_pages"]] += 1
            amb_docs[(split, "start_ambiguous")] += s_amb
            amb_docs[(split, "end_ambiguous")] += e_amb
            made += 1
    for f in files.values():
        f.close()

    with open(os.path.join(args.out, "m3_layouts.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["layout_id", "split", "width_chars", "lines_per_page", "date_styles", "title",
                    "clause_style", "page_header", "footer_has_print_date", "has_schedule_page",
                    "combined_clause_prob", "age_in_party_block", "phrase_family"])
        for l in layouts:
            w.writerow([l["layout_id"], l["split"], l["width"], l["lines_per_page"],
                        "|".join(l["date_styles"]), l["title"], l["clause_style"], l["header"],
                        int(l["footer_date"]), int(l["has_schedule"]), l["combined_prob"],
                        int(l["age_in_party"]), l["family"]])
    report = {
        "seed": args.seed, "as_of_for_status": DEMO_AS_OF.isoformat(),
        "documents": dict(counts), "dropped_by_reason": dict(drops),
        "candidate_roles": {f"{s}/{r}": n for (s, r), n in sorted(roles.items())},
        "scenarios": {f"{s}/{c}": n for (s, c), n in sorted(scen.items())},
        "expected_status": {s: dict(c) for s, c in status_by_split.items()},
        "ambiguous_docs": {f"{s}/{k}": n for (s, k), n in sorted(amb_docs.items())},
        "pages_histogram": dict(sorted(pages_hist.items())),
        "layouts": {l["layout_id"]: l["split"] for l in layouts},
    }
    with open(os.path.join(args.out, "m3_dataset_report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({"documents": dict(counts), "dropped": dict(drops)}, indent=1))


if __name__ == "__main__":
    main()
