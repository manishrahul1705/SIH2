"""Shared text normaliser for M1. Training and inference MUST both call normalize_for_m1()."""
import re, unicodedata

def normalize_for_m1(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or unicodedata.category(ch)[0] != "C")
    text = text.lower()
    text = re.sub(r"\d", "0", text)          # mask digits: types never depend on exact numbers or dates
    return re.sub(r"\s+", " ", text).strip()

def document_text_for_m1(doc: dict, max_chars: int = 20000) -> str:
    """Join the pages returned by ocr_extract.extract_document() into one string for M1."""
    return " \n ".join(p["text"] for p in doc.get("pages", []))[:max_chars]
