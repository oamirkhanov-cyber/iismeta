# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import collections
import re

import floor_decompose as FD

CATALOG, ROLE, _CH, _CP = FD._load_sbornik("15_otdelka")


def _low(s):
    return (s or "").lower().replace("ё", "е")


_GF021_HINT = re.compile(r"гф[\s-]*021|огрунтов")

#
#
_MINWOOL_HINT = re.compile(r"минер\w*\s*ват|минват|камен\w*\s*ват|базальт|\bппж\b|\bпж\s*-?\s*\d")


def lookup(name):
    low = _low(name)
    for pat, tab in CATALOG:
        if re.search(pat, low):
            return tab
    return None


_OP_KEYWORD = re.compile(r"штукатур|шпатл|шпакл|затир|окрас|покрас|побел|грунт|облицов|выравнив|обшивк|шлифов|гидроизол|пропитк|отделк")
_SPLIT_DELIM = re.compile(
    r"\s*[.;:]\s+|\s+[-–—]\s+|\s+и\s+(?=[А-ЯЁ])|\s+с\s+последующ\w*\s+")


_PAINT_RX = re.compile(r"окрас|покрас|краск")
_PRIMER_RX = re.compile(r"грунтов")
_ADHES_RX = re.compile(r"адгезион|бетонконтакт|бетон\s*контакт")


_LOWER_I = re.compile(r"^(.*?)\s+и\s+(.*)$")


def _split_lower_i(frag):
    """IISMETA cost-estimation engine module."""
    m = _LOWER_I.match(frag)
    if not m:
        return [frag]
    left, right = m.group(1), m.group(2)
    if _OP_KEYWORD.search(_low(left)) and _OP_KEYWORD.search(_low(right)):
        return [left.strip(), right.strip()]
    return [frag]


def _compound_extra_tables(name, main_tab):
    """IISMETA cost-estimation engine module."""
    frags = [f.strip(" .-–—;:") for f in _SPLIT_DELIM.split(name) if f.strip(" .-–—;:")]
    frags = [g for f in frags for g in _split_lower_i(f)]
    op_frags = [f for f in frags if _OP_KEYWORD.search(_low(f))]
    if len(op_frags) < 2:
        return []
    paint_here = bool(_PAINT_RX.search(_low(name)))
    seen, extra = {main_tab}, []
    for f in op_frags:
        fl = _low(f)
        if paint_here and _PRIMER_RX.search(fl) and not _ADHES_RX.search(fl):
            continue
        t = lookup(f)
        if t and t not in seen:
            seen.add(t)
            extra.append((t, f))
    return extra


def decompose(rows, section=None):
    """IISMETA cost-estimation engine module."""
    out = []
    for r in rows:
        nm = r.get("name", "")
        tab = lookup(nm)
        if not tab:
            continue
        qty = FD._num(r.get("qty"))
        work = ("%s (%s)" % (nm, section)) if section else nm
        item = {"table": tab, "work": work,
                "qty": qty, "unit": r.get("unit") or "м2", "params": r.get("params") or {},
                "rule": "1:1", "children": [], "role": ROLE.get(tab, "?")}
        if tab == "13-03-004" and _GF021_HINT.search(_low(nm)):
            item["companions"] = [{"table": "13-03-002", "work": ("%s — огрунтовка ГФ-021" % work),
                        "qty": qty, "unit": r.get("unit") or "м2", "params": r.get("params") or {},
                        "rule": "companion-13-03-004", "children": [], "role": "грунтовка"}]
        elif tab == "15-07-020" and _MINWOOL_HINT.search(_low(nm)):
            item["companions"] = [{"table": "34-01-054", "work": ("%s — заполнение каркаса минераловатными плитами" % work),
                        "qty": qty, "unit": r.get("unit") or "м2", "params": r.get("params") or {},
                        "rule": "companion-15-07-020", "children": [], "role": "утепление"}]
        elif tab != "13-03-004":
            extra = _compound_extra_tables(nm, tab)
            if extra:
                item["companions"] = [
                    {"table": t, "work": ("%s — %s" % (work, frag[:34])),
                     "qty": qty, "unit": r.get("unit") or "м2", "params": {},
                     "rule": "compound-split", "children": [], "role": ROLE.get(t, "?"),
                     "_compound": True}
                    for t, frag in extra]
        out.append(item)
    return out


def validate(works, tol=0.02):
    """IISMETA cost-estimation engine module."""
    by = collections.defaultdict(list)
    for w in works:
        by[w.get("role", "?")].append(w)
    okraska = by["окраска"]
    base_areas = [w["qty"] for w in by["штукатурка"]] + [w["qty"] for w in by["шпатлёвка"]]
    flags = []
    for w in okraska:
        if not any(abs(w["qty"] - s) < tol * max(w["qty"], 1) for s in base_areas):
            flags.append("ЦЕПОЧКА: у окраски [%s] q=%.2f нет ШТУКАТУРКИ/ШПАТЛЁВКИ той же площади" % (w["table"], w["qty"]))
    return {"ok": not flags, "flags": flags,
            "chain": {"okraska": [(w["table"], w["qty"]) for w in okraska],
                      "pokrytie": [(w["table"], w["qty"]) for w in by["покрытие"]],
                      "plaster": [(w["table"], w["qty"]) for w in by["штукатурка"]],
                      "grunt": [(w["table"], w["qty"]) for w in by["грунтовка"]],
                      "shpatl": [(w["table"], w["qty"]) for w in by["шпатлёвка"]]}}
