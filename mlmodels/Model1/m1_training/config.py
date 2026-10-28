"""Reproducible paths and settings for the ApprovalTrack M1 model."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "m1_dataset"
OCR_DIR = ROOT / "ocr"
SAMPLES_DIR = ROOT / "samples"
TRAIN_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = TRAIN_DIR / "artifacts"
REPORT_DIR = TRAIN_DIR / "reports"
ARTIFACT_PATH = ARTIFACT_DIR / "m1_v1.joblib"

SEED = 20261026
GREEN = 0.90
AMBER = 0.60
MODEL_VERSION = "m1-v1.0.0"
CLASSES = (
    "lease",
    "fire",
    "structural",
    "occupancy_or_building",
    "nba_letter",
    "audited_accounts",
    "aicte_approval_letter",
    "other",
)

# Small validation-only grid; test data is never involved in model selection.
PARAMETER_GRID = (
    {"word_ngram_range": (1, 2), "char_ngram_range": (3, 5), "C": 0.5},
    {"word_ngram_range": (1, 2), "char_ngram_range": (3, 5), "C": 1.0},
    {"word_ngram_range": (1, 2), "char_ngram_range": (3, 5), "C": 2.0},
    {"word_ngram_range": (1, 2), "char_ngram_range": (2, 5), "C": 1.0},
    {"word_ngram_range": (1, 3), "char_ngram_range": (3, 5), "C": 1.0},
    {"word_ngram_range": (1, 2), "char_ngram_range": (3, 6), "C": 1.0},
)

