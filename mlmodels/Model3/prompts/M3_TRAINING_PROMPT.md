# Prompt: train ApprovalTrack M3 (lease reader) - give this to the training AI together with the ApprovalTrack_M3 folder

You are training "M3" for ApprovalTrack (SIH26262, AICTE approval-process tracker). M3 reads a lease deed and PROPOSES lease start, lease end and lease term. A person confirms; only then does anything count. All data is fictional demo data. Deliver complete working files, not snippets. Python 3.10+, scikit-learn only. No foundation model, no deep learning, no internet at inference time.

SAFEGUARD (put it in the model card): DEMO DATA - NOT REAL AICTE DEADLINES. AI-suggested values are not verified. A person must confirm every value; the software never replaces the competent authority. No model output may start a clock, change routing, or write to any score or policy table. Rules decide, AI only suggests.

## Files you are given (do NOT modify any of them)
- ocr/m3_common.py: find_lease_candidates(pages) - the ONLY candidate finder. Training and inference must both call it. Also normalise_pages, normalize_m3 (keeps digits).
- ocr/m3_lease.py: reconcile_lease, lease_status, status_from_reconciled, lease_end_date (deterministic, tested). The model never does this arithmetic.
- ocr/m3_extract.py: the OCR wrapper. It already calls m3_predict.predict_lease(candidates) and expects the exact shape below.
- dataset/*.csv: m3_documents_*, m3_candidates_*, m3_pages_*, m3_layouts.csv, plus generate_m3_dataset.py, validate_m3_dataset.py, and the validation report (0 errors, 8,000 deeds: 5,000 train / 1,500 val / 1,500 test, split by layout 10/3/3, 132,010 candidates).
- samples/ (8 PDFs + 1 scan) with expected_outputs.json; tests/ (126 passing pytest cases).
Never modify ocr_extract.py, m1_text.py, the M1 model, m2_common.py, m2_extract.py or the M2 model. Never use a digit-masking normaliser.

## Dataset fields
m3_candidates_*.csv, one row per date/term candidate: doc_id, split, layout_id, role (lease_start | lease_end | term_value | other), cand_id, kind (date|term), page, line_no, char_start, char_end, text, value (ISO date, or total months for a term), alt_value, term_months, ambiguous (0/1), date_order, n_dates, date_chrono_rank, term_order, n_terms, rel_pos, left_ctx, right_ctx (candidate spans masked as <DATE>/<TERM>; digits kept), bbox_x0..bbox_y1, n_pages. The label for non-targets is `other` (never "none"). NONE means not present.
m3_documents_*.csv, one row per deed: doc_id, split, layout_id, n_pages, scenario (A start+end; B start+term, end must be derived; C all three consistent; D stated end disagrees with start+term), stated_start, stated_end, stated_term_months, end_stated, term_stated, consistency, start_ambiguous, end_ambiguous, date_style, term_style, has_older_lease, has_renewal, has_schedule, n_candidates, end_from_term, expected_start, expected_end, expected_term_months, expected_state, expected_reason, expected_status (as of 2026-10-27), status_as_of.
m3_pages_*.csv: doc_id, split, layout_id, page, text (exact text the finder ran on). m3_layouts.csv: layout parameters and split.
The same candidate may repeat (schedule page repeats the key values; a footer date repeats on every page). Distractors on purpose: execution/registration/stamp/possession/NOC/rent-revision/footer dates, an earlier lease quoted in the recitals (dates AND a term), renewal options, notice, lock-in, deposit months, lessor age. About 12% of deeds have an ambiguous numeric start date (must be output blank).

## Build (new files only)
1. ocr/m3_train.py - small, calibrated, explainable candidate ranker over roles lease_start, lease_end, term_value, other. Features: TF-IDF (word 1-3 grams, digits kept) of left_ctx and right_ctx, plus kind, page, n_pages, rel_pos, date_order, n_dates, date_chrono_rank, term_order, n_terms, term_months, ambiguous, line_no. Choose logistic regression vs HistGradientBoosting by layout-grouped validation (GroupKFold on layout_id). Fit on train only, tune and calibrate on val, touch test ONCE. Seed everything. Save the model with a version string and a hash of the training CSVs. RECORD THE CHOSEN ALGORITHM AND HYPERPARAMETERS IN THE MODEL CARD.
2. ocr/m3_predict.py - predict_lease(candidates) -> {"model_version": str, "roles": {"lease_start": {...}, "lease_end": {...}, "term_value": {...}}}, each role = {"candidate_id": "" or id, "confidence": float, "blank_reason": str}; no nulls. Candidates with identical role/value count as one answer (document how you aggregate repeats). Deterministic checks after ranking: ambiguous candidate -> blank; best probability < 0.60 -> blank (red); runner-up within 0.15 -> cap confidence at 0.89; zones green >= 0.90, amber 0.60-0.89, red < 0.60. Derivation, inconsistency and blanking of end<=start are done by reconcile_lease (already called in m3_extract), not by you. Works offline and loads the saved model from disk.
3. ocr/m3_evaluate.py - run once on test (val for tuning):
   - exact-match and span-F1 per field with layout-level bootstrap 95% intervals;
   - end-to-end accuracy of expected_start / expected_end / expected_term_months / expected_state / expected_status against m3_documents (run candidates -> predict_lease -> reconcile_lease -> status_from_reconciled);
   - derived-value accuracy (scenario B end; scenario A term), inconsistency detection recall and false-alarm rate (scenario D vs others), false-fill rate when a field is absent (A has no term, B no end), ambiguous-date blank rate (must be 100%);
   - ECE, zone accuracy and coverage;
   - breakdowns per layout, per page count, per scenario, per term_style; 5-fold layout-grouped cross-validation; ablations (no context text, no numeric features, no position features);
   - stress tests: extra OCR noise, shuffled clause order, key clause pushed to a late page, an older quoted lease placed next to the real clause, a footer date repeated on every page.
   If any field is weak, investigate before reporting: worst three layouts, a table of which wrong candidates were chosen instead, counts of each blank_reason, and a rerun with the deterministic checks off, to tell a bug from an over-strict rule.
4. tests/test_m3_predict.py (output shape, no nulls, ambiguous -> blank, determinism, end-to-end through m3_extract.build_result without a stub) and run the full pytest suite plus samples/ against expected_outputs.json.
5. M3_MODEL_CARD.md: purpose, data, algorithm, features, metrics with intervals, limitations (including: a term or date split across a page break by a page header is not matched), the safeguard paragraph, and this paragraph verbatim: "These results are on synthetic deeds with unseen synthetic layouts only. They show the pipeline works; they are not production accuracy. Production accuracy needs 50 to 100 real public lease deeds with stated metrics."

## Rules
Never present synthetic scores as production accuracy. Report weak results plainly. At the end print the exact commands to reproduce training, evaluation and tests, and the final test results.
