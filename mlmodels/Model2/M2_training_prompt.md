# Prompt to give to the AI: train M2 (ApprovalTrack, SIH26262)

You are a senior ML engineer. Train and test **M2**, a small, local, explainable **date-candidate ranker** that proposes four fields from an uploaded document: `issue_date`, `valid_to`, `cert_no` (certificate or application number) and `issuer`. M2 never decides anything. Its output is stored as "AI-suggested" and a person confirms it before any clock starts. All data is fictional demo data.

## What you are given

A folder with these files (already validated: no empty cells in required columns, no layout shared between splits):

- `dataset/m2_candidates_{train,val,test}.csv` - one row per candidate, with the label `issue_date`, `valid_to`, `cert_no`, `issuer` or `none`. Columns: `doc_id, split, doc_type, layout_id, noisy, cand_id, kind (date|number|issuer), label, text, value, ambiguous, fmt, page, n_pages, word_idx, line_idx, n_lines_page, x0, y0, x1, y1, ocr_conf, ctx_left, ctx_right, ctx_above, line_text, n_tokens, text_len, digit_frac, has_slash, has_hyphen, has_letters, year, date_rank, n_dates, is_earliest_date, is_latest_date, page_frac`. `ctx_left`, `ctx_right` and `ctx_above` may legitimately be empty strings (nothing is written before the value); read the CSV with `keep_default_na=False`; in the documents CSV, `NONE` is a real value.
- `dataset/m2_documents_{train,val,test}.csv` (one row per document: true `issue_date`, `valid_to`, `cert_no`, `issuer`, `has_valid_to`, `has_ambiguous_target`, `expected_blank_fields`, `noisy`, `layout_id`, `doc_type`; `NONE` means not present) and `dataset/m2_words_{train,val,test}.csv` (one row per OCR word with box, confidence and `role`). Use them for evaluation, span-F1 and stress tests.
- `ocr/m2_common.py` - the shared candidate finder, `ROLES`, `KIND_ROLES`, `NUMERIC_FEATURES`, `TEXT_FEATURES`, `zone_for()`. **Training and inference must both call `find_candidates()` from this file. Do not edit it.**
- `ocr/m2_extract.py` - the OCR wrapper. It already calls `m2_predict.predict_fields(candidates, doc_type)` if that module exists. You will write `m2_predict.py`.
- `dataset/m2_dataset_report.json` - counts and checks.

## Hard rules (do not break)

1. Do **not** modify `ocr_extract.py`, `m1_text.py`, `m2_common.py`, `m2_extract.py` or anything of M1. M1 is used by another part of the project.
2. Do **not** use `normalize_for_m1()`. It replaces digits with 0 and would destroy dates and numbers. M2 uses `normalize_m2()` from `m2_common.py`.
3. Never use `doc_id`, `layout_id`, `split`, `label`, `value`, `word_idx` or `cand_id` as model features. `value` is the parsed date and is allowed only for the derived features already in the CSV and for the deterministic checks.
4. Fit all preprocessing on train only. Tune on val only. Touch test **once**, at the end.
5. No foundation model and no external AI service. scikit-learn only (LightGBM is allowed only if it is already installed). Everything runs locally and fast on CPU.
6. No AI output may start a clock or change routing. Keep the safeguard text in the model card.

## Model design

Three small candidate classifiers, one per kind, each choosing among that kind's roles: `date` -> {issue_date, valid_to, none}; `number` -> {cert_no, none}; `issuer` -> {issuer, none}.

Features: TF-IDF word 1-2 grams (and a character 2-4 gram variant to compare) on `ctx_left`, `ctx_above`, `ctx_right` and `line_text`, each in its own vectoriser so the model knows where the word was; `doc_type` and `fmt` one-hot; the numeric columns in `NUMERIC_FEATURES` scaled. Compare logistic regression and a gradient-boosting model (`HistGradientBoostingClassifier`) per kind, choose by **layout-grouped** validation macro-F1, and calibrate probabilities (isotonic or Platt, fitted on the validation layouts, or inside `GroupKFold` by `layout_id`).

Selection per document: for each role take the candidate with the highest calibrated probability for that role. Then run deterministic checks:

- `valid_to` must be after `issue_date`. If it is not, keep the higher-confidence one and blank the other with reason `date_order_check_failed`.
- A date candidate with `ambiguous = 1` (for example 04/05/2027) is **flagged and left blank**: return `value = ""`, `ambiguous = true`, `zone = "red"`, reason `ambiguous_date`. Never parse it silently.
- If the best probability for a role is below 0.60, return it blank (`red`). Many documents legitimately have no `valid_to` (audited accounts, some "other" documents). The model must leave `valid_to` blank for them and must not invent one.
- Confidence = calibrated probability of the chosen candidate. If the runner-up for the same role is within 0.15, cap the confidence at 0.89 (amber, "please check").
- Zones come from `zone_for()`: green >= 0.90 (pre-filled), amber 0.60 to 0.89 ("please check"), red < 0.60 (left blank).

## Deliverables

1. `m2_train.py` - reproducible (fixed seeds), trains from the CSV files, saves `m2_model.joblib` (all three classifiers, vectorisers, calibrators, feature lists, `model_version` such as `m2-1.0.0`, training date, dataset report hash).
2. `m2_predict.py` - exposes `predict_fields(candidates, doc_type) -> dict` that takes the list from `find_candidates()` and returns, for each of `issue_date`, `valid_to`, `cert_no`, `issuer`, exactly this object (no nulls, no missing keys):
   `{"value": str, "display": str, "confidence": float, "zone": "green|amber|red", "page": int, "bbox": [x0,y0,x1,y1], "ambiguous": bool, "needs_confirmation": true, "ai_suggested": bool, "candidate_id": int, "model_version": str, "blank_reason": str}`
   For dates, `value` is ISO `YYYY-MM-DD` and `display` is the text as printed. A blank field uses `value = ""`, `confidence = 0.0`, `page = 0`, `bbox = [0,0,0,0]`, `candidate_id = -1`, `ai_suggested = false`, and a plain-words `blank_reason`. `needs_confirmation` is always true. Add a `why` string for the "this date won because it sits next to 'valid until'" explanation, built from the top weighted context words (add the key `why` to every field, empty string when blank). Load the joblib once and cache it. It must also run as `python m2_extract.py file.pdf --doc-type fire`.
3. `m2_evaluate.py` and `metrics.json` - see below.
4. `tests/test_m2_predict.py` (pytest) - schema always complete, ambiguous date left blank, `valid_to` blank on an audited-accounts example, valid_to after issue_date, zone thresholds, same output twice, a document with no candidates returns four blank fields, and a prediction failure never raises out of `m2_extract.run()`.
5. `MODEL_CARD.md` - data, features, metrics with sizes and confidence intervals, limits, and the caveat paragraph below.

## How to evaluate (report on the TEST split, which has layouts never seen in training)

- Per field: exact-match accuracy on documents that contain the field; span-F1 on the highlighted word set (compare the chosen candidate's page and `word_idx` with the words CSV rows whose `role` is that field); a 95 % bootstrap interval resampled by **layout and document**, not by candidate.
- `valid_to` false-fill rate: on documents with `has_valid_to = 0`, how often the model fills `valid_to` with confidence >= 0.60. Target: below 2 %.
- Ambiguity: recall and precision of the `ambiguous` flag on `expected_blank_fields`; recall must be 100 %, because it is rule-based.
- Calibration: ECE and a reliability table for each kind. Accuracy inside the green zone, amber zone and red zone, and the share of documents falling in each zone (coverage).
- Breakdown by `doc_type`, by `noisy`, by `fmt`, and by layout (list the worst three layouts).
- 5-fold `GroupKFold` by `layout_id` on train+val for stability, as was done for M1.
- Ablation: drop `ctx_above`, drop `doc_type`, drop the position features, and drop `is_earliest_date` / `is_latest_date`; report the loss for each.
- Stress tests (build them from the test docs by editing words, do not retrain): shuffle the word list order; remove all punctuation; add stray tokens such as `_` and `|` inside lines; drop 5 % of the label words ("valid", "until", "issue"); lower `ocr_conf`; split a long document over two pages; rewrite a label into a synonym the training set never used. Report the drop for each.
- End to end: run `python m2_extract.py` on the sample PDFs and the scanned PNG in `samples/` and print the fields.

## Honest reporting (copy this into MODEL_CARD.md)

The data is synthetic and the layouts are generated from templates, so the scores will be high and prove only that M2 works on synthetic data and on unseen synthetic layouts. They are **not** production accuracy. To claim more, test on 50 to 100 real public documents per class (real approval letters, fire certificates, leases) that were never used in training, report span-F1 with intervals, and fix what breaks. Alerts and automation support the process; they never replace statutory scrutiny, verification, inspection or the decision of the competent authority.

If any score is suspiciously perfect, say so and investigate leakage (layout reuse, label words copied into `value`, near duplicate documents) before reporting it. Report failures as clearly as successes.
