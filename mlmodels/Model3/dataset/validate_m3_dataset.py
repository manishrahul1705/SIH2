#!/usr/bin/env python3
"""
Independent validation of the M3 dataset. Reads the CSVs from disk (not the generator's
memory) and re-checks everything:

  1. no empty cell and no null/nan/None/n-a text anywhere (the marker NONE is allowed)
  2. layouts are disjoint across train / val / test
  3. doc_ids are unique and every candidate/page row belongs to a document of that split
  4. the finder, re-run on the stored page text, reproduces every candidate row exactly
  5. every true field is recovered exactly (ambiguous dates are flagged and carry the true reading)
  6. exactly the right roles exist (end only if stated, term only if stated)
  7. expected_* columns and status equal a fresh run of reconcile_lease / lease_status
  8. 3 <= n_pages <= 12, stated start < stated end, scenario D really disagrees

Exit code 0 only if everything passes.   Usage: python validate_m3_dataset.py [dataset_dir]
"""
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ocr"))
from m3_common import find_lease_candidates                                   # noqa: E402
from m3_lease import (DEMO_AS_OF, lease_end_date, reconcile_lease,             # noqa: E402
                      status_from_reconciled)

csv.field_size_limit(10 ** 9)
SPLITS = ("train", "val", "test")
BAD_TEXT = {"null", "NULL", "Null", "nan", "NaN", "NAN", "none", "None", "n/a", "N/A", "undefined"}  # "NONE" is the allowed marker


def read(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else HERE
    errors, stats = [], Counter()

    def err(msg):
        if len(errors) < 40:
            errors.append(msg)
        stats["errors"] += 1

    docs, cands, pages, layouts_of = {}, defaultdict(list), defaultdict(dict), defaultdict(set)
    for s in SPLITS:
        for name in ("documents", "candidates", "pages"):
            rows = read(os.path.join(d, f"m3_{name}_{s}.csv"))
            stats[f"rows_{name}_{s}"] = len(rows)
            for r in rows:
                for k, v in r.items():
                    if v is None or v == "" or v.strip() in BAD_TEXT:
                        err(f"{name}_{s}: empty/null cell in column {k}")
                if name == "documents":
                    if r["doc_id"] in docs:
                        err(f"duplicate doc_id {r['doc_id']}")
                    docs[r["doc_id"]] = r
                    layouts_of[s].add(r["layout_id"])
                    if r["split"] != s:
                        err(f"{r['doc_id']}: split column mismatch")
                elif name == "candidates":
                    cands[r["doc_id"]].append(r)
                else:
                    pages[r["doc_id"]][int(r["page"])] = r["text"]
    for a in SPLITS:
        for b in SPLITS:
            if a < b and layouts_of[a] & layouts_of[b]:
                err(f"layouts shared between {a} and {b}: {layouts_of[a] & layouts_of[b]}")
    stats.update({f"docs_{s}": sum(1 for x in docs.values() if x["split"] == s) for s in SPLITS})
    stats.update({f"layouts_{s}": len(layouts_of[s]) for s in SPLITS})

    for doc_id, row in docs.items():
        pg = pages.get(doc_id)
        if not pg or sorted(pg) != list(range(1, len(pg) + 1)):
            err(f"{doc_id}: pages missing or not contiguous")
            continue
        n_pages = int(row["n_pages"])
        if len(pg) != n_pages or not 3 <= n_pages <= 12:
            err(f"{doc_id}: bad page count")
        found = find_lease_candidates([{"page": i, "text": pg[i], "words": []} for i in sorted(pg)])
        rows = cands.get(doc_id, [])
        if len(found) != len(rows):
            err(f"{doc_id}: finder found {len(found)} candidates, CSV has {len(rows)}")
            continue
        for f, r in zip(found, rows):
            for key in ("cand_id", "kind", "text", "value", "alt_value", "left_ctx", "right_ctx"):
                if str(f[key]) != r[key]:
                    err(f"{doc_id}/{r['cand_id']}: {key} differs from a fresh finder run")
            for key in ("page", "char_start", "char_end", "term_months", "ambiguous"):
                if int(f[key]) != int(r[key]):
                    err(f"{doc_id}/{r['cand_id']}: {key} differs from a fresh finder run")
            if r["role"] not in ("lease_start", "lease_end", "term_value", "other"):
                err(f"{doc_id}: unknown role {r['role']}")
            if r["role"] in ("lease_start", "lease_end") and r["kind"] != "date":
                err(f"{doc_id}: date role on a term")
            if r["role"] == "term_value" and r["kind"] != "term":
                err(f"{doc_id}: term role on a date")
        stats["candidates_checked"] += len(rows)

        start = row["stated_start"]
        starts = [r for r in rows if r["role"] == "lease_start"]
        ends = [r for r in rows if r["role"] == "lease_end"]
        terms = [r for r in rows if r["role"] == "term_value"]
        if not starts:
            err(f"{doc_id}: no lease_start candidate")
        for r in starts:
            ok = (r["value"] == start) if r["ambiguous"] == "0" else (start in (r["value"], r["alt_value"]))
            if not ok:
                err(f"{doc_id}: start not recovered exactly")
        s_amb = bool(starts) and starts[0]["ambiguous"] == "1"
        e_amb = bool(ends) and ends[0]["ambiguous"] == "1"
        if int(row["start_ambiguous"]) != int(s_amb) or int(row["end_ambiguous"]) != int(e_amb):
            err(f"{doc_id}: ambiguity flags disagree with candidates")
        if row["end_stated"] == "1":
            if not ends:
                err(f"{doc_id}: stated end missing from candidates")
            for r in ends:
                ok = (r["value"] == row["stated_end"]) if r["ambiguous"] == "0" else (
                    row["stated_end"] in (r["value"], r["alt_value"]))
                if not ok:
                    err(f"{doc_id}: end not recovered exactly")
            if date.fromisoformat(row["stated_end"]) <= date.fromisoformat(start):
                err(f"{doc_id}: stated end not after start")
        elif ends:
            err(f"{doc_id}: lease_end candidate although no end is stated")
        if row["term_stated"] == "1":
            if not terms or any(int(r["term_months"]) != int(row["stated_term_months"]) for r in terms):
                err(f"{doc_id}: term not recovered exactly")
        elif terms:
            err(f"{doc_id}: term_value candidate although no term is stated")

        # scenario / consistency integrity
        if row["term_stated"] == "1":
            computed = lease_end_date(date.fromisoformat(start), int(row["stated_term_months"])).isoformat()
            if row["end_from_term"] != computed:
                err(f"{doc_id}: end_from_term wrong")
            if row["end_stated"] == "1":
                agree = computed == row["stated_end"]
                if (row["consistency"] == "consistent") != agree:
                    err(f"{doc_id}: consistency label wrong")
        elif row["end_from_term"] != "NONE":
            err(f"{doc_id}: end_from_term should be NONE")

        # expected outputs recomputed from scratch
        end_d = None if (row["stated_end"] == "NONE" or e_amb) else row["stated_end"]
        term = None if row["stated_term_months"] == "NONE" else int(row["stated_term_months"])
        rec = reconcile_lease(None if s_amb else start, end_d, term,
                              start_ambiguous=s_amb, end_ambiguous=e_amb)
        stat = status_from_reconciled(rec, DEMO_AS_OF)
        exp = {"expected_start": rec["start"] or "NONE", "expected_end": rec["end"] or "NONE",
               "expected_term_months": str(rec["term_months"]) if rec["term_months"] else "NONE",
               "expected_state": rec["state"], "expected_reason": rec["reason"],
               "expected_status": stat["status"]}
        for k, v in exp.items():
            if row[k] != v:
                err(f"{doc_id}: {k} is {row[k]!r}, recomputed {v!r}")
        stats["docs_checked"] += 1

    report = {"ok": stats["errors"] == 0, "stats": dict(stats), "first_errors": errors}
    with open(os.path.join(d, "m3_validation_report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
