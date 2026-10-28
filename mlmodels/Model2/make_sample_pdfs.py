#!/usr/bin/env python3
"""Render a few TEST-split dataset documents as real PDFs (embedded text) and one scanned PNG, to try the OCR + M2 pipeline end to end.
Usage: python make_sample_pdfs.py dataset out_dir   (needs pymupdf)"""
import gzip, json, os, sys, random
import pymupdf as fitz
ds, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
docs = [json.loads(l) for l in gzip.open(os.path.join(ds, "m2_docs_test.jsonl.gz"), "rt", encoding="utf-8")]
r = random.Random(11)
want = ["fire", "lease", "aicte_approval_letter", "audited_accounts"]
picked = []
for t in want:
    pool = [d for d in docs if d["doc_type"] == t and not d["noisy"]]
    amb = [d for d in pool if d["has_ambiguous_target"]] if t == "audited_accounts" else [d for d in pool if not d["has_ambiguous_target"]]
    picked.append(r.choice(amb or pool))
for d in picked:
    pdf = fitz.open()
    for pg in d["pages"]:
        page = pdf.new_page(width=595, height=842)
        for w in pg["words"]:
            x0, y0, x1, y1 = w["bbox"][0] * 595, w["bbox"][1] * 842, w["bbox"][2] * 595, w["bbox"][3] * 842
            fs = (y1 - y0) * 0.66
            page.insert_text((x0, y1 - (y1 - y0) * 0.2), w["text"], fontsize=fs, fontname="helv")
    name = f"sample_{d['doc_type']}.pdf"
    pdf.save(os.path.join(out, name))
    print(name, d["fields"], "ambiguous:", d["expected_blank_fields"])
    if d is picked[0]:   # scanned version of the first one
        pix = pdf[0].get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72), alpha=False)
        pix.save(os.path.join(out, f"scan_{d['doc_type']}.png"))
