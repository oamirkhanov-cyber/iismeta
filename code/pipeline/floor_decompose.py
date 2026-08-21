# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import collections
import json
import os
import re

_MAP_PATH = os.path.join(os.path.dirname(__file__), "data", "materials_map.json")


def _load_sbornik(key="11_poly"):
    """IISMETA cost-estimation engine module."""
    with open(_MAP_PATH, encoding="utf-8") as f:
        sb = json.load(f)["sborniki"][key]
    catalog = [(c["pat"], c["table"]) for c in sb["catalog"]]
    return catalog, sb["role"], sb["child_hints"], sb["child_parent"]


CATALOG, ROLE, CHILD_HINTS, CHILD_PARENT = _load_sbornik("11_poly")


def _low(s):
    return (s or "").lower().replace("ё", "е")


def lookup(name):
    """IISMETA cost-estimation engine module."""
    low = _low(name)
    for pat, tab in CATALOG:
        if re.search(pat, low):
            return tab
    return None


def is_child_role(name):
    """IISMETA cost-estimation engine module."""
    low = _low(name)
    return any(re.search(p, low) for p in CHILD_HINTS)


def _sostav(code):
    import kb_engine
    row = kb_engine._conn().cursor().execute(
        "SELECT text FROM sostav WHERE shnk_table=? LIMIT 1", (code,)).fetchone()
    return _low(row[0]) if row and row[0] else ""


def _table(code):
    """IISMETA cost-estimation engine module."""
    import kb_engine
    wc = kb_engine.wc_by_table(code)
    return kb_engine._index().get(wc) if wc else None


_UNIT_RX = re.compile(r"м3|м³|м2|м²|\bм\b|шт|т\b|кг")


def unit_of(code):
    """IISMETA cost-estimation engine module."""
    w = _table(code) or {}
    izm = _low(w.get("izmeritel", ""))
    mult = 1.0
    m = re.search(r"(\d+)", izm)
    if m:
        mult = float(m.group(1))
    if "м3" in izm or "м³" in izm:
        u = "м3"
    elif "м2" in izm or "м²" in izm:
        u = "м2"
    elif re.search(r"\bм\b", izm):
        u = "м"
    else:
        u = izm.strip() or "?"
    return u, mult


def _num(x):
    try:
        return float(str(x).replace(",", ".").split()[0])
    except Exception:
        return None


_SIZE_PAIR_RX = re.compile(r"\d+[.,]?\d*\s*[хx×]\s*\d+[.,]?\d*\s*мм")


_THICK_LABELED_RX = re.compile(
    r"(?:толщ\w*|толш\w*|\bт\s*[.=]|\bh\s*=|δ)\s*[.\s\-:=]*(\d+(?:[.,]\d+)?)"
    r"(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*мм", re.I)
_WIDTH_LABELED_RX = re.compile(
    r"(?:шир\w*)\s*[.\s\-:=]*\d+(?:[.,]\d+)?\s*мм", re.I)
_DIAM_LABELED_RX = re.compile(r"(?:[Ффdd]|∅|ø|Ø)\s*=?\s*\d+(?:[.,]\d+)?\s*мм", re.I)
_THICK_TAIL_RX = re.compile(
    r"[-–—]\s*(?:(\d+(?:[.,]\d+)?)[-–])?(\d+(?:[.,]\d+)?)\s*мм\s*[;.,)]*\s*$", re.I)
_NOT_THICK_RX = re.compile(r"(шир|шаг|b\s*=|в\s*=|∅|ø|Ø|Ф\s*=)[^,;]{0,4}$", re.I)


def _thickness_mm(params, name):
    """IISMETA cost-estimation engine module."""
    if isinstance(params, dict) and params.get("толщина"):
        v = _num(params["толщина"])
        if v is not None:
            return v
    low = _low(name)
    m = _THICK_LABELED_RX.search(low)
    if m:
        a, b = _num(m.group(1)), _num(m.group(2))
        if a is not None and b is not None:
            return (a + b) / 2.0
        if a is not None:
            return a
    m = _THICK_TAIL_RX.search(low)
    if m and _NOT_THICK_RX.search(low[:m.start() + 1]):
        m = None
    if m:
        a, b = _num(m.group(1)), _num(m.group(2))
        if a is not None and b is not None:
            return (a + b) / 2.0
        if b is not None:
            return b
    masked = _SIZE_PAIR_RX.sub(" ", low)
    masked = _WIDTH_LABELED_RX.sub(" ", masked)
    masked = _DIAM_LABELED_RX.sub(" ", masked)
    m = re.search(r"(\d+[.,]?\d*)\s*мм", masked)
    return _num(m.group(1)) if m else None


_COVER_RX = re.compile(
    r"плитк|керамогранит|линолеум|ламинат|паркет|ковролин|ковров|наливн|"
    r"мрамор|гранит|брусчатк|доща\w*\s*покрыти|релин|топпинг", re.I)
_BARE_CONCRETE_RX = re.compile(
    r"^(?!.*(подготовк|фундамент|отмостк|стяжк|подстилающ|покрыти)).*\bбетон\w*\s*(кл\.?\s*)?[вbм]\s*\d", re.I)


def _floor_concrete_fork(items):
    """IISMETA cost-estimation engine module."""
    bare = [it for it in items if it.get("tab") == "11-01-015" and _BARE_CONCRETE_RX.search(_low(it["name"]))]
    if not bare:
        return
    has_cover = any(_COVER_RX.search(_low(it["name"])) for it in items if it not in bare)
    for it in bare:
        if has_cover:
            it["tab"] = "11-01-002"
            it["_fork_note"] = ("подстилающий слой: в разделе есть покрытие поверх бетона "
                                "(правило пирога) — не бетонная подготовка")
        else:
            it["_fork_note"] = "бетонное покрытие: покрытия поверх бетона в разделе нет (пол финишный)"


def decompose(rows):
    """IISMETA cost-estimation engine module."""
    items = []
    for r in rows:
        nm = r.get("name", "")
        tab = lookup(nm)
        items.append({"name": nm, "tab": tab, "qty": _num(r.get("qty")),
                      "area": _num(r.get("qty")), "unit_vor": r.get("unit"),
                      "params": r.get("params") or {}, "child": is_child_role(nm)})

    _floor_concrete_fork(items)

    consumed = set()
    for i, it in enumerate(items):
        if not it["child"] or it["tab"]:
            if not it["child"]:
                continue
        low = _low(it["name"])
        key = "прослойк" if re.search(r"прослойк|шв", low) else "подложк" if "подложк" in low else None
        explicit_par = next((tab for h, tab in CHILD_PARENT.items() if h in low), None)
        for j, par in enumerate(items):
            if j == i or not par["tab"] or par["child"]:
                continue
            same_area = it["area"] and par["area"] and abs(it["area"] - par["area"]) < 0.05 * max(par["area"], 1)
            if not same_area:
                continue
            sost = _sostav(par["tab"])
            in_sostav = key and (key in sost or ("шв" in low and "шв" in sost))
            by_hint = explicit_par and par["tab"] == explicit_par
            if in_sostav or by_hint:
                consumed.add(i)
                par.setdefault("children", []).append(it["name"])
                break

    out = []
    for i, it in enumerate(items):
        if i in consumed or not it["tab"]:
            continue
        code = it["tab"]
        u, mult = unit_of(code)
        th = _thickness_mm(it["params"], it["name"])
        qty = it["area"]
        rule = "1:1"
        if u == "м3" and (it["unit_vor"] or "").replace("²", "2").lower() in ("м2", "м²", "m2") and th:
            qty = round(it["area"] * (th / 1000.0), 4)
            rule = "ед.изм м²→м³ (×%s мм)" % (("%g" % th))
        params = dict(it["params"] or {})
        if th is not None and "толщина" not in params:
            params["толщина"] = "%g мм" % th
        out.append({"table": code, "work": it["name"],
                    "qty": qty, "unit": u, "params": params, "rule": rule,
                    "children": it.get("children", []), "role": ROLE.get(code, "?")})
    return out


def validate(works, tol=0.02):
    """IISMETA cost-estimation engine module."""
    by = collections.defaultdict(list)
    for w in works:
        by[w.get("role", "?")].append(w)
    finishes = by["покрытие"]
    styazhki = [w for w in by["стяжка"]]
    base_m2 = max((w["qty"] for w in by["основание"] if w["unit"] == "м2"), default=0.0)
    flags = []

    fin_area = round(sum(w["qty"] for w in finishes), 3)
    if base_m2 and fin_area and abs(fin_area - base_m2) > tol * max(base_m2, 1):
        flags.append("ОБЪЁМ: Σ покрытий %.1f ≠ основание %.1f (пропущен слой/лишнее?)" % (fin_area, base_m2))

    st_areas = [w["qty"] for w in styazhki]
    for w in finishes:
        if not any(abs(w["qty"] - s) < tol * max(w["qty"], 1) for s in st_areas):
            flags.append("ПИРОГ: у покрытия [%s] q=%.1f нет СТЯЖКИ той же площади" % (w["table"], w["qty"]))

    return {"ok": not flags, "flags": flags,
            "pie": {"finishes": [(w["table"], w["qty"]) for w in finishes],
                    "styazhki": [(w["table"], w["qty"]) for w in styazhki],
                    "base_m2": base_m2}}
