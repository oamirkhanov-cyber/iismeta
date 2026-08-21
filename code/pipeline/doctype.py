# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import os
import re
import json

_MARKERS_PATH = os.path.join(os.path.dirname(__file__), "data", "doc_type_markers.json")
_markers_cache = None
_title_cache: dict = {}
_CID_RE = re.compile(r"\(cid:\d+\)")
_SPACED_RE = re.compile(r"(?<![а-яёa-z])(?:[а-яёa-z]\s){2,}[а-яёa-z](?![а-яёa-z])", re.I)


def _load_markers():
    global _markers_cache
    if _markers_cache is None:
        try:
            with open(_MARKERS_PATH, encoding="utf-8") as f:
                _markers_cache = json.load(f)
        except (OSError, ValueError):
            _markers_cache = {"vor_title_markers": [], "non_vor": []}
    return _markers_cache


def _despace(m):
    return m.group(0).replace(" ", "")


def _norm(s: str) -> str:
    """IISMETA cost-estimation engine module."""
    s = _CID_RE.sub("", s or "")
    s = s.lower().replace("ё", "е")
    s = _SPACED_RE.sub(_despace, s)
    return re.sub(r"[ \t]+", " ", s)


def _page_text(pdf_path: str, page_no: int, limit: int) -> str:
    """IISMETA cost-estimation engine module."""
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            if page_no >= len(pdf.pages):
                return ""
            return (pdf.pages[page_no].extract_text() or "")[:limit]
    except Exception:
        return ""


def _doc_title(pdf_path: str) -> str:
    """IISMETA cost-estimation engine module."""
    try:
        key = (pdf_path, os.path.getmtime(pdf_path))
    except OSError:
        key = (pdf_path, 0)
    if key not in _title_cache:
        if len(_title_cache) > 256:
            _title_cache.clear()
        _title_cache[key] = _norm(_page_text(pdf_path, 0, 1500))
    return _title_cache[key]


def _rule_hits(rule: dict, text: str) -> bool:
    if "regex" in rule:
        if re.search(rule["regex"], text):
            return True
    alls = rule.get("all")
    if alls and all(frag in text for frag in alls):
        return True
    anys = rule.get("any")
    if anys and any(frag in text for frag in anys):
        return True
    return False


def classify_doc_type(pdf_path: str, page_no: int = 0) -> dict:
    """IISMETA cost-estimation engine module."""
    mk = _load_markers()
    doc_title = _doc_title(pdf_path)

    vor_present = any(v in doc_title for v in mk.get("vor_title_markers", []))

    _page_title = None
    def page_title():
        nonlocal _page_title
        if _page_title is None:
            _page_title = doc_title if page_no == 0 else _norm(_page_text(pdf_path, page_no, 700))
        return _page_title

    hit = None
    for rule in mk.get("non_vor", []):
        scope = rule.get("scope", "page")
        text = doc_title if scope == "document" else page_title()
        if _rule_hits(rule, text):
            hit = rule
            break

    if hit is not None and not vor_present:
        return {"is_vor": False, "doc_type": hit["type"],
                "marker": hit.get("regex") or hit.get("all") or hit.get("any"),
                "scope": hit.get("scope", "page")}
    return {"is_vor": True, "doc_type": ("vor" if vor_present else "unknown"),
            "marker": None, "scope": None}
