#!/usr/bin/env python3
"""Make sample lease PDFs (+ one scanned PNG) with expected answers, for checking m3_extract.py.
Usage: python make_samples.py ../samples"""
import json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ocr"))
import generate_m3_dataset as g
from m3_lease import DEMO_AS_OF, reconcile_lease, status_from_reconciled
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "samples")
os.makedirs(out, exist_ok=True)
L = g.make_layouts(2026)

def pdf(path, pages):
    c = canvas.Canvas(path, pagesize=A4)
    for text in pages:
        t = c.beginText(36, 800); t.setFont("Courier", 8)
        for line in text.split("\n"): t.textLine(line)
        c.drawText(t); c.showPage()
    c.save()

WANT = [  # (name, scenario, ambiguous, min_pages, status wanted or None)
    ("01_start_end_dates", "A", False, 3, "live"),
    ("02_start_and_term_derive_end", "B", False, 3, None),
    ("03_all_three_consistent", "C", False, 3, "expired"),
    ("04_stated_end_disagrees_with_term", "D", False, 3, None),
    ("05_ambiguous_numeric_date", "C", True, 3, None),
    ("06_long_deed_key_clause_late", "C", False, 9, "not_started"),
    ("07_expires_soon", "A", False, 3, "expires_soon"),
    ("08_term_only_words", "B", False, 3, "live"),
]
manifest = {}
for name, scen, amb, minp, want_status in WANT:
    rnd = random.Random(f"sample-{name}")
    for k in range(20000):
        try:
            d = g.build_deed(rnd, L[k % 16], k)
            cands, s_amb, e_amb = g.label_and_check(d)
        except g.Skip:
            continue
        if d["scenario"] != scen or (s_amb or e_amb) != amb or d["n_pages"] < minp:
            continue
        rec = reconcile_lease(None if s_amb else d["start"],
                              None if (d["stated_end"] is None or e_amb) else d["stated_end"],
                              d["stated_term"], start_ambiguous=s_amb, end_ambiguous=e_amb)
        st = status_from_reconciled(rec, DEMO_AS_OF)["status"]
        if want_status and st != want_status:
            continue
        pdf(os.path.join(out, name + ".pdf"), d["pages"])
        manifest[name + ".pdf"] = {
            "expected_start": rec["start"] or "NONE", "expected_end": rec["end"] or "NONE",
            "expected_term_months": rec["term_months"] or "NONE", "expected_state": rec["state"],
            "expected_status_as_of_2026-10-27": st, "n_pages": d["n_pages"],
            "start_ambiguous": s_amb, "end_ambiguous": e_amb}
        break
    else:
        print("could not make", name)

# scanned sample: text rendered to an image so Tesseract must be used
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
img = Image.new("RGB", (1700, 520), "white"); dr = ImageDraw.Draw(img)
dr.text((40, 50), "LEASE DEED - the lease shall commence from 12 March 2026", fill="black", font=font)
dr.text((40, 130), "and shall be for a period of nine (9) years.", fill="black", font=font)
dr.text((40, 210), "Executed on 2 March 2026. Renewal option: a further term of 3 years.", fill="black", font=font)
img.save(os.path.join(out, "09_scanned_image.png"))
manifest["09_scanned_image.png"] = {"expected_start": "2026-03-12", "expected_end": "2035-03-11",
    "expected_term_months": 108, "expected_state": "derived",
    "expected_status_as_of_2026-10-27": "live", "n_pages": 1, "start_ambiguous": False, "end_ambiguous": False}
json.dump(manifest, open(os.path.join(out, "expected_outputs.json"), "w"), indent=2)
print(len(manifest), "samples written to", out)
