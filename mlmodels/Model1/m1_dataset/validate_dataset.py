#!/usr/bin/env python3
"""Checks the M1 dataset: no nulls, valid labels, no duplicates, no layout/text leakage between splits."""
import csv, hashlib, json, os, sys
from collections import Counter, defaultdict
D = os.path.dirname(os.path.abspath(__file__))
labels = {c["id"] for c in json.load(open(os.path.join(D, "labels.json")))["classes"]}
rows = list(csv.DictReader(open(os.path.join(D, "m1_documents_full.csv"), encoding="utf-8")))
cols = ["doc_id","text","label","layout_id","quality","split","source","n_words"]
errs = []
for i, r in enumerate(rows):
    for c in cols:
        if r.get(c) is None or str(r[c]).strip() == "": errs.append(f"row {i}: empty {c}")
    if r["label"] not in labels: errs.append(f"row {i}: bad label {r['label']}")
    if r["quality"] not in {"clean","scanned","skewed","blurred"}: errs.append(f"row {i}: bad quality")
    if r["split"] not in {"train","val","test"}: errs.append(f"row {i}: bad split")
    if int(r["n_words"]) != len(r["text"].split()): errs.append(f"row {i}: n_words mismatch")
    if int(r["n_words"]) < 15: errs.append(f"row {i}: too short")
    if not r["layout_id"].startswith(r["label"].split("_")[0]) and r["label"] != "other": errs.append(f"row {i}: layout/label mismatch")
if len({r["doc_id"] for r in rows}) != len(rows): errs.append("duplicate doc_id")
th = Counter(hashlib.md5(r["text"].encode()).hexdigest() for r in rows)
if any(v > 1 for v in th.values()): errs.append("duplicate texts")
ls = defaultdict(set)
for r in rows: ls[r["layout_id"]].add(r["split"])
bad = [k for k, v in ls.items() if len(v) > 1]
if bad: errs.append(f"layouts in several splits: {bad}")
for s in ("train", "val", "test"):
    sub = list(csv.DictReader(open(os.path.join(D, f"m1_{s}.csv"), encoding="utf-8")))
    if any(r["split"] != s for r in sub): errs.append(f"m1_{s}.csv has wrong split rows")
    print(s, len(sub), dict(sorted(Counter(r["label"] for r in sub).items())))
print("TOTAL", len(rows), "| unique layouts", len(ls))
if errs: print("FAILED:", *errs[:20], sep="\n  "); sys.exit(1)
print("OK: no nulls, no empty text, labels valid, no duplicates, no layout leakage.")
