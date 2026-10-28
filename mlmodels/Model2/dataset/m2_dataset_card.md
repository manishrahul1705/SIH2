# M2 dataset card
Synthetic, fictional demo data. 12,000 documents (1,500 per M1 class x 8 classes, after dropping 34 that failed a check), 201,423 candidate rows.
Splits by layout (16 layouts per class: 10 train, 3 val, 3 test): train 7,502, val 2,247, test 2,251 documents. No layout is shared between splits.
Docs with an ambiguous target date (for example 04/05/2027, expected blank): train 1101, val 288, test 364.
Docs with no valid-to date (audited accounts and some "other"): train 1393, val 407, test 425.
Checks: every ground-truth field is recovered by the candidate finder as an exact word match; issue < valid-to; issue date not after 27 Oct 2026; no empty required cells; no duplicate texts; no layout leakage.
Noise: about 28 percent of documents have OCR-style noise on non-target words and lower word confidence. Target values are never corrupted.
Limits: template-generated, so easier than real documents. Do not claim production accuracy.
