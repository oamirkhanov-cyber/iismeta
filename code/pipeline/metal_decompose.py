# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import re

import floor_decompose as FD

CATALOG, ROLE, _CH, _CP = FD._load_sbornik("09_metal")


def _low(s):
    return (s or "").lower().replace("ё", "е")


def lookup(name):
    low = _low(name)
    for pat, tab in CATALOG:
        if re.search(pat, low):
            return tab
    return None


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
        out.append({"table": tab, "work": work,
                    "qty": qty, "unit": r.get("unit") or "т", "params": r.get("params") or {},
                    "rule": "1:1", "children": [], "role": ROLE.get(tab, "?")})
    return out


def validate(works):
    """IISMETA cost-estimation engine module."""
    flags = [
        "БЕЗ ОБЪЁМА: [%s] qty=%s" % (w["table"], w.get("qty"))
        for w in works if not (w.get("qty") or 0) > 0
    ]
    return {"ok": not flags, "flags": flags,
            "works": [(w["table"], w.get("role"), w["qty"]) for w in works]}
