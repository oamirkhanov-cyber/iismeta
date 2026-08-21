"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import re
from typing import Optional
from .schema import RawRow
from .parsing import parse_number, canon_unit, is_known_unit

ROLE_KEYWORDS = {
    "pos":  [r"^\s*№", r"п/п", r"\bпоз"],
    "code": [r"шифр", r"обоснован", r"расцен", r"\bкод\b", r"\bнорм"],
    "name": [r"наименован", r"\bработ", r"затрат", r"\bописан", r"видов работ"],
    "unit": [r"ед\.?\s*изм", r"единиц", r"изм\.?$"],
    "qty":  [r"кол-?во", r"количеств", r"объ[её]м", r"показател", r"^кол\.?\b"],
}

SECTION_RE = re.compile(r"^\s*(раздел|глава|часть|подраздел)\b", re.I)
_DASH_LEAD = re.compile(r"^\s*[-–—•·]\s*\S")
NUM_SEC_RE = re.compile(r"^\s*\d{1,2}\.\s+\D")
TOTAL_RE = re.compile(r"\b(итого|всего|total)\b", re.I)
QUOTE_RE = re.compile(r'[«"]([^»"]+)[»"]')


def _n(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _clean(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").replace("\n", " ").strip())


def _fix_no(s) -> str:
    """IISMETA cost-estimation engine module."""
    return re.sub(r"\bN\s*[goо°⁰0]\s*(?=\d)", "№", str(s or ""))


def map_columns(header: list) -> dict:
    roles: dict = {}
    norm = [_n(h) for h in header]
    for role, pats in ROLE_KEYWORDS.items():
        for idx, h in enumerate(norm):
            if idx in roles.values():
                continue
            if any(re.search(p, h) for p in pats):
                roles[role] = idx
                break
    return roles


def resolve_roles(header: list, n_cols: int) -> dict:
    """IISMETA cost-estimation engine module."""
    found = map_columns(header)
    used = set(found.values())
    roles = dict(found)
    for role, idx in positional_fallback(n_cols).items():
        if role not in roles and idx not in used:
            roles[role] = idx
            used.add(idx)
    return roles


def positional_fallback(n_cols: int) -> dict:
    if n_cols >= 5:
        return {"pos": 0, "code": 1, "name": 2, "unit": 3, "qty": 4}
    if n_cols == 4:
        return {"pos": 0, "name": 1, "unit": 2, "qty": 3}
    if n_cols == 3:
        return {"name": 0, "unit": 1, "qty": 2}
    return {"name": 0}


def find_works_header(grid: list):
    """IISMETA cost-estimation engine module."""
    for i, r in enumerate(grid):
        if "видов работ" in _n(" ".join(str(c) for c in r if c)):
            return i
    for i, r in enumerate(grid):
        roles = map_columns([_clean(c) for c in r])
        if "name" in roles and "qty" in roles:
            return i
    return None


def _is_legend(cells) -> bool:
    """IISMETA cost-estimation engine module."""
    vals = [_clean(c) for c in cells if _clean(c)]
    return len(vals) >= 2 and all(v.isdigit() and len(v) <= 2 for v in vals) \
        and vals == [str(k) for k in range(1, len(vals) + 1)]


def strip_legend(rows: list) -> list:
    return [r for r in rows if not _is_legend(r)]


def extract_title(grid: list):
    """IISMETA cost-estimation engine module."""
    for r in grid:
        for c in r:
            cc = _clean(c)
            if "ВЕДОМОСТЬ ОБ" in cc.upper():
                m = QUOTE_RE.search(cc)
                return _fix_no(m.group(1)) if m else None
    return None


def classify_row(cells: list, roles: dict) -> str:
    """IISMETA cost-estimation engine module."""
    joined = _clean(" ".join(c for c in cells if c))
    if not joined:
        return "data"
    qty_i = roles.get("qty")
    has_qty = qty_i is not None and qty_i < len(cells) and _clean(cells[qty_i]) != ""
    unit_i = roles.get("unit")
    has_unit = unit_i is not None and unit_i < len(cells) and _clean(cells[unit_i]) != ""
    if TOTAL_RE.search(joined):
        return "subtotal"
    if _DASH_LEAD.match(joined):
        return "data"
    if joined.rstrip().endswith(":"):
        return "data"
    if not has_qty and not has_unit:
        return "section"
    if not has_qty and (SECTION_RE.search(joined) or NUM_SEC_RE.match(joined)):
        return "section"
    return "data"


_POS_MULTI = re.compile(r"^\d{1,3}(?:\.\d{1,3}){0,4}\.?$")


def build_rows(grid: list, roles: dict, header: list, extractor: str) -> list:
    rows, secnum = [], 0
    for raw in grid:
        cells = [_clean(c) for c in raw]
        kind = classify_row(cells, roles)

        def get(role):
            i = roles.get(role)
            return cells[i] if (i is not None and i < len(cells) and cells[i]) else None

        def get_src(role):
            i = roles.get(role)
            return raw[i] if (i is not None and i < len(raw) and raw[i]) else None

        pos, name_c = get("pos"), get("name")
        if not pos:
            name_i = roles.get("name")
            for c in cells[:max(name_i if name_i is not None else 1, 1)]:
                cc = (c or "").strip()
                if cc and _POS_MULTI.match(cc):
                    pos = cc
                    break
        unit_raw, qty_raw = get("unit"), get("qty")

        _unit_mismap = False
        if unit_raw and not is_known_unit(unit_raw) and parse_number(unit_raw) is not None:
            _unit_mismap, unit_raw = True, None

        if kind == "data" and not pos and not name_c and (unit_raw or qty_raw):
            ref = {"unit": canon_unit((unit_raw or "").split("/")[0] or None),
                   "qty": parse_number((qty_raw or "").split("/")[0] or None)}
            if rows and rows[-1].row_kind == "data":
                rows[-1].extra["_secondary"] = f"{unit_raw or ''} {qty_raw or ''}".strip()
                rows[-1].extra["_ref"] = ref
            rows.append(RawRow(
                pos=None, code_src=None, name="", unit=ref["unit"],
                qty_raw=qty_raw, qty=ref["qty"],
                n_cells=len(cells), section=secnum, row_kind="cont",
                source_extractor=extractor))
            continue

        if kind == "section":
            secnum += 1
        name = (name_c or "") if kind == "data" else " ".join(c for c in cells if c).strip()

        unit_src, qty_src = get_src("unit"), get_src("qty")
        _u_nl = [p.strip() for p in str(unit_src or "").split("\n") if p.strip()]
        _q_nl = [p.strip() for p in str(qty_src or "").split("\n") if p.strip()]
        nl_combined = len(_u_nl) > 1 and len(_q_nl) > 1
        combined = bool((unit_raw and "/" in unit_raw) or (qty_raw and "/" in qty_raw)) or nl_combined
        uprimary = unit_raw.split("/")[0] if unit_raw else None
        qprimary = qty_raw.split("/")[0] if qty_raw else None
        used = set(roles.values())
        extra = {(header[i] if i < len(header) and header[i] else f"col{i}"): cells[i]
                 for i in range(len(cells)) if i not in used and cells[i]}
        if combined:
            if nl_combined and "/" not in (unit_raw or "") and "/" not in (qty_raw or ""):
                up, qp = _u_nl, _q_nl
            else:
                up = [x.strip() for x in unit_raw.split("/")] if unit_raw else []
                qp = [x.strip() for x in qty_raw.split("/")] if qty_raw else []
            extra["_combined"] = f"ед='{unit_raw}' кол='{qty_raw}'"
            extra["_ref"] = {"unit": canon_unit(up[1]) if len(up) > 1 else None,
                             "qty": parse_number(qp[1]) if len(qp) > 1 else None}
        if _unit_mismap:
            extra["_unit_mismap"] = True

        if kind == "section" and pos and _POS_MULTI.match(str(pos).strip()) \
                and not (SECTION_RE.search(name) or NUM_SEC_RE.match(name)):
            extra["_demoted_work"] = "section_no_qty_no_unit_had_pos"

        rows.append(RawRow(
            pos=pos, code_src=get("code"), name=name,
            unit=canon_unit(uprimary), qty_raw=qty_raw, qty=parse_number(qprimary),
            n_cells=len(cells), section=secnum, extra=extra, row_kind=kind,
            source_extractor=extractor, confidence=1.0,
        ))
    return rows

def _fix_concrete_weight(rows):
    """IISMETA cost-estimation engine module."""
    data = [r for r in rows if r.row_kind == "data"]
    for i in range(1, len(data)):
        r, p = data[i], data[i - 1]
        nm, pn = (r.name or "").lower(), (p.name or "").lower()
        if r.unit in ("т", "тн") and r.qty and ("арматур" in nm or "стал" in nm):
            if "бетон" in pn and p.unit in ("м3", "м\u00b3") and p.qty:
                ratio = r.qty / p.qty
                if 2.2 <= ratio <= 2.7 and "_ref" not in p.extra:
                    p.extra["_ref"] = {"unit": "т", "qty": r.qty}
                    p.extra["_combined"] = f"бетон: {p.qty} м\u00b3 + {r.qty} т (вес)"
                    own = r.extra.get("_ref")
                    if own and own.get("qty") is not None:
                        r.unit, r.qty, r.qty_raw = own["unit"], own["qty"], str(own["qty"])
                        for k in ("_ref", "_secondary", "_combined"):
                            r.extra.pop(k, None)
                    else:
                        r.extra["_check"] = "т перенесён в бетон (вес); у позиции нет собственного кг — проверить"
    return rows
