"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import os
import json
import re
from typing import Optional

UNIT_CANON = {
    "м": "м", "м.": "м",
    "мп": "мп", "м п": "мп", "м.п.": "мп", "пог.м": "мп", "п.м": "мп", "м/п": "мп",
    "м2": "м²", "м²": "м²", "кв.м": "м²", "м.кв": "м²", "м.кв.": "м²", "м кв": "м²",
    "м3": "м³", "м³": "м³", "куб.м": "м³", "м.куб": "м³", "м.куб.": "м³", "м куб": "м³",
    "т": "т", "тн": "т", "тонн": "т", "т.": "т",
    "кг": "кг", "г": "г",
    "шт": "шт", "шт.": "шт", "штук": "шт",
    "компл": "компл", "компл.": "компл", "комплект": "компл",
    "100 м2": "100 м²", "100 м²": "100 м²", "100м2": "100 м²",
    "1000 м3": "1000 м³",
    "га": "га", "пм": "мп", "п.м.": "мп", "м.п": "мп",
    "мз": "м³", "м.з": "м³", "мз.": "м³",
    "м2/м3": "м²", "м2/мз": "м²", "мз/м2": "м³",
    "2 м": "м²", "2м": "м²", "м 2": "м²",
    "3 м": "м³", "3м": "м³", "м 3": "м³",
}

_NUM_RE = re.compile(r"[-+]?\d[\d\s\u00a0]*[.,]?\d*")


def parse_number(s: Optional[str]) -> Optional[float]:
    if s is None:
        return None
    t = str(s).strip().replace("\u00a0", " ")
    if not t:
        return None
    m = _NUM_RE.search(t)
    if not m:
        return None
    raw = m.group(0).replace(" ", "").replace(",", ".")
    if raw.count(".") > 1:
        head, _, tail = raw.rpartition(".")
        raw = head.replace(".", "") + "." + tail
    try:
        return float(raw)
    except ValueError:
        return None


def _norm_unit_text(s: Optional[str]) -> str:
    t = str(s or "").strip().lower().replace("\u00a0", " ")
    return re.sub(r"\s+", " ", t)


def canon_unit(s: Optional[str]) -> Optional[str]:
    t = _norm_unit_text(s)
    if not t:
        return None
    return UNIT_CANON.get(t, t)


def is_known_unit(s: Optional[str]) -> bool:
    t = _norm_unit_text(s)
    if not t:
        return False
    return t in UNIT_CANON or t in set(UNIT_CANON.values())


_UNIT_CLASS = {
    "м": "length", "мп": "length",
    "м²": "area", "100 м²": "area", "га": "area",
    "м³": "volume", "1000 м³": "volume",
    "т": "mass", "кг": "mass", "г": "mass",
    "шт": "count", "компл": "count",
}


def unit_class(s: Optional[str]) -> Optional[str]:
    cu = canon_unit(s)
    return _UNIT_CLASS.get(cu) if cu else None


_FRAG_DIM = re.compile(r"^[A-Za-zА-ЯЁа-яё][A-Za-zА-ЯЁа-яё.]{0,4}\s*[=±]")
_FRAG_WEIGHT = re.compile(r"^вес[-–\s]?\d", re.I)
_CYR_LOWER_WORD = re.compile(r"[а-яё]{3,}")
_FRAG_DASH_LEAD = re.compile(r"^\s*[-–—•·]")


def fragment_kind(name: Optional[str]) -> Optional[str]:
    """IISMETA cost-estimation engine module."""
    nm = (name or "").strip()
    if not nm or _FRAG_DASH_LEAD.match(nm):
        return None
    if _FRAG_DIM.match(nm):
        return "dim"
    if _FRAG_WEIGHT.match(nm):
        return "weight"
    if (not _CYR_LOWER_WORD.search(nm) and any(c.isdigit() for c in nm)
            and len(nm.split()) <= 3):
        return "mark"
    return None


_ENDS_CYR_LETTER = re.compile(r"[а-яёА-ЯЁ]$")


def _mark_glue_ok(prev_name: Optional[str]) -> bool:
    """IISMETA cost-estimation engine module."""
    return bool(_ENDS_CYR_LETTER.search((prev_name or "").rstrip()))



_WORDLEX_PATH = os.path.join(os.path.dirname(__file__), "data", "shnk_wordlex.json")
_wordlex_cache = None


def _load_wordlex() -> set:
    global _wordlex_cache
    if _wordlex_cache is None:
        try:
            with open(_WORDLEX_PATH, encoding="utf-8") as f:
                _wordlex_cache = set(json.load(f).get("stems") or [])
        except (OSError, ValueError):
            _wordlex_cache = set()
    return _wordlex_cache


_STEM_ENDINGS = (
    "ыми", "ими", "ого", "его", "ому", "ему", "ами", "ями",
    "ая", "яя", "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ей", "ым", "им", "ом", "ем",
    "ых", "их", "ую", "юю", "ья", "ье", "ью", "ов", "ев", "ах", "ях", "ам", "ям",
    "а", "я", "о", "е", "ы", "и", "ь", "й", "у", "ю",
)


def _stem_word(w: str) -> str:
    w = (w or "").lower().replace("ё", "е")
    for e in _STEM_ENDINGS:
        if len(e) <= len(w) - 4 and w.endswith(e):
            return w[:-len(e)]
    return w


def _is_known_word(w: str, minlen: int = 5) -> bool:
    """IISMETA cost-estimation engine module."""
    if len(w) < minlen:
        return False
    st = _stem_word(w)
    return len(st) >= 4 and st in _load_wordlex()


_ADJ_TAIL = re.compile(r"(ый|ой|ая|ое|ее|ые|ым|им|ом|ых|их|ого|ому|ыми|ими|ую|юю|анная|енная|аный|яный)$", re.I)

_MIDWORD_HYPHEN = re.compile(r"(?:(?<=\s)|^)([А-Яа-яЁё][А-Яа-яЁё.]*)[-‐][  \t]+([а-яё]\S*)")


def _dehyph_repl(m) -> str:
    f1 = m.group(1)
    cont = m.group(2)
    f2m = re.match(r"[а-яё]+", cont)
    f2 = f2m.group(0) if f2m else ""
    f1core = f1.rstrip(".,:;")
    keep = (
        f1 != f1core
        or (bool(f1core) and f1core[-1] in "ое" and len(f1core) >= 4
            and bool(_ADJ_TAIL.search(f2)))
        or (_is_known_word(f1core, 4) and _is_known_word(f2, 5))
    )
    if keep:
        return f1 + "-" + cont
    return f1core + cont


def dehyphenate_midword(text: Optional[str]) -> Optional[str]:
    """IISMETA cost-estimation engine module."""
    if not text or ("-" not in text and "‐" not in text):
        return text
    return _MIDWORD_HYPHEN.sub(_dehyph_repl, text)


def _has_unit(row) -> bool:
    return bool((row.unit or "").strip())


def stitch_fragment_rows(rows: list) -> list:
    """IISMETA cost-estimation engine module."""
    out = []
    pending_pair = None
    for r in rows:
        nm = (r.name or "").strip()
        if pending_pair is not None:
            un, qraw, qn = pending_pair
            pending_pair = None
            if (r.row_kind in ("data", "section") and nm and r.qty is None and not _has_unit(r)
                    and r.pos is None and fragment_kind(nm) is None):
                r.unit, r.qty_raw, r.qty = canon_unit(un), qraw, qn
                r.row_kind = "data"
                r.extra["_pair_from_prev_tail"] = "%s %s" % (un, qraw)
            elif out:
                out[-1].extra["_frag_pair_dropped"] = "%s %s" % (un, qraw)
        frag = fragment_kind(nm)
        prev = out[-1] if out else None
        glue = (frag is not None and prev is not None and r.pos is None
                and prev.row_kind in ("data", "section") and bool((prev.name or "").strip()))
        if glue and frag == "mark":
            glue = (prev.row_kind == "data"
                    and (_has_unit(prev) != (prev.qty is not None))
                    and _mark_glue_ok(prev.name))
        if not glue:
            out.append(r)
            continue
        prev.name = (prev.name or "").rstrip() + " " + nm
        prev.extra["_stitched_fragment"] = (prev.extra.get("_stitched_fragment", "") + " | " + nm).strip(" |")
        fu, fq = _has_unit(r), r.qty is not None
        if prev.qty is None and not _has_unit(prev):
            if fu or fq:
                prev.unit = r.unit if fu else prev.unit
                prev.qty_raw, prev.qty = r.qty_raw, r.qty
                if prev.row_kind == "section" and prev.qty is not None:
                    prev.row_kind = "data"
        elif prev.qty is not None and not _has_unit(prev) and fu and fq:
            prev.extra["_qty_displaced"] = prev.qty_raw or str(prev.qty)
            prev.unit, prev.qty_raw, prev.qty = r.unit, r.qty_raw, r.qty
        elif prev.qty is None and _has_unit(prev) and fq:
            prev.qty_raw, prev.qty = r.qty_raw, r.qty
        elif prev.qty is not None and _has_unit(prev) and fu and fq:
            pending_pair = (r.unit, r.qty_raw, r.qty)
        elif fu or fq:
            prev.extra["_frag_scrap_dropped"] = "%s %s" % (r.unit or "", r.qty_raw or "")
    if pending_pair is not None and out:
        out[-1].extra["_frag_pair_dropped"] = "%s %s" % (pending_pair[0], pending_pair[1])
    for r in out:
        if r.name:
            nn = dehyphenate_midword(r.name)
            if nn != r.name:
                r.extra["_dehyphenated"] = r.name
                r.name = nn
    return out
