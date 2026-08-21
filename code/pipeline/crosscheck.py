"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import re
from .parsing import parse_number

EXACT_EXTRACTORS = {"textlayer_bbox", "camelot_lattice", "textword_anchor"}
_NUMTOK = re.compile(r"\d[\d\s .,]*\d|\d")


def _page_numbers(pdf_path: str, page_no: int) -> set:
    """IISMETA cost-estimation engine module."""
    import pdfplumber
    out = set()
    try:
        with pdfplumber.open(pdf_path) as pdf:
            words = [w["text"] for w in pdf.pages[page_no].extract_words()]
    except Exception:
        return out
    for w in words:
        v = parse_number(w)
        if v is not None:
            out.add(round(v, 2))
    for i in range(len(words) - 1):
        a, b = words[i], words[i + 1]
        if re.fullmatch(r"[\d.,]+", a) and re.fullmatch(r"[\d.,]+", b):
            v = parse_number(a + b)
            if v is not None:
                out.add(round(v, 2))
    return out


def _present(v: float, pool: set, tol: float = 0.02) -> bool:
    vr = round(v, 2)
    return any(abs(vr - p) <= max(tol, abs(vr) * 0.001) for p in pool)


def crosscheck_classA(pdf_path: str, page_no: int, results: list) -> int:
    """IISMETA cost-estimation engine module."""
    pool = _page_numbers(pdf_path, page_no)
    if not pool:
        return 0
    n = 0
    for res in results:
        for r in getattr(res, "rows", []):
            if r.row_kind != "data" or r.qty is None:
                continue
            if not _present(r.qty, pool):
                r.extra["_xcheck"] = (f"кол-во {r.qty:g} не найдено в тексте оригинала — "
                                      f"проверить привязку строки")
                n += 1
    return n


def crosscheck_classB(pdf_path: str, page_no: int, results: list, alt_dpi: int = 300) -> int:
    """IISMETA cost-estimation engine module."""
    try:
        from .extractors import cadvector_grid as cg
        alt = cg.extract_all(pdf_path, page_no, dpi=alt_dpi)
    except Exception:
        return 0
    pool = set()
    for ares in alt:
        for r in ares.rows:
            if r.row_kind == "data" and r.qty is not None:
                pool.add(round(r.qty, 2))
    if not pool:
        return 0
    n = 0
    for res in results:
        for r in res.rows:
            if r.row_kind != "data" or r.qty is None:
                continue
            if not _present(r.qty, pool):
                r.extra["_xcheck"] = (f"кол-во {r.qty:g} не подтверждено 2-м OCR-проходом "
                                      f"({alt_dpi}dpi) — сверить с оригиналом")
                n += 1
    return n


def crosscheck(pdf_path: str, page_no: int, extractor_used: str, results: list) -> int:
    """IISMETA cost-estimation engine module."""
    try:
        if extractor_used in EXACT_EXTRACTORS:
            return crosscheck_classA(pdf_path, page_no, results)
        if extractor_used == "cadvector_grid":
            return crosscheck_classB(pdf_path, page_no, results)
    except Exception:
        return 0
    return 0
