# M1 Dataset Card: document type classification

**Purpose:** train M1, which reads the text of an uploaded document and suggests its type for the ApprovalTrack upload review page (P7). M1 only suggests. A person confirms.

**Size:** 9,600 documents, 1,200 per class, 8 classes. All text is synthetic and fictional (people, institutions, places, numbers, dates).

| Class id | Shown in the UI as |
|---|---|
| lease | Lease Deed |
| fire | Fire Safety Certificate |
| structural | Structural Stability Certificate |
| occupancy_or_building | Occupancy or Building Certificate |
| nba_letter | NBA Accreditation Letter |
| audited_accounts | Audited Accounts |
| aicte_approval_letter | AICTE Approval Letter |
| other | Other Document |

**Files:** `m1_train.csv` (6,368), `m1_val.csv` (1,562), `m1_test.csv` (1,670), `m1_documents_full.csv` (all), `labels.json`, `generate_m1_dataset.py`, `validate_dataset.py`.

**Columns (no column has empty values):** `doc_id`, `text`, `label`, `layout_id`, `quality` (clean, scanned, skewed, blurred), `split`, `source` (always `synthetic`), `n_words`.

**How it was built**
- 104+ layouts. Each class has 12 layouts (8 train, 2 val, 2 test). "other" has 22 layouts, one per document family (invoice, bank statement, tender notice and so on).
- **A layout never appears in two splits.** Validation and test layouts use wording variants, date formats, field orders and numbering styles that the training layouts never use. "other" test families (rent receipt, tender notice, bonafide certificate, electricity bill, document checklist) are entirely unseen document families.
- **Hard negatives in "other":** fire drill circular, rent receipt, NBA workshop invitation, audit committee minutes, structural analysis question paper, forwarding letter and document checklist. They deliberately use words from the real classes.
- **Realism:** 35% of documents contain a cross-reference sentence to another document type; 18% are partial pages; 12% have the title missing; 60% carry simulated OCR noise (character confusions, dropped characters, merged words, dropped lines).

**Checks (run `python validate_dataset.py`):** no empty cells, valid labels and splits, unique ids and texts, `n_words` correct, every document at least 15 words, no layout in more than one split. Lease, fire, structural, NBA and certificate dates are generated so that the end date is always after the start date.

**Limits you must state honestly**
1. **The data is synthetic.** A simple TF-IDF model scores about 0.999 macro-F1 on the test split. This does **not** predict accuracy on real documents, because synthetic classes keep their natural vocabulary and are easy to separate. Report it as "works on synthetic data, generalises to unseen synthetic layouts" and nothing more.
2. To claim more, add 50 to 100 real public documents per class (hand-labelled, run through the same OCR step) as a separate `real_test` set.
3. Label `other` is intentionally broad. Real "other" documents will be more varied than the 22 families here.
4. Only English text is covered.
