# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import collections
import re

import floor_decompose as FD

CATALOG, ROLE, _CH, _CP = FD._load_sbornik("12_krovlya")

PIE_ROLES = ("пароизоляция", "утепление", "гидроизоляция", "стяжка")


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
        th = FD._thickness_mm(r.get("params"), nm)
        params = dict(r.get("params") or {})
        if th is not None and "толщина" not in params:
            params["толщина"] = "%g мм" % th
        work = ("%s (%s)" % (nm, section)) if section else nm
        out.append({"table": tab, "work": work,
                    "qty": qty, "unit": r.get("unit") or "м2", "params": params,
                    "rule": "1:1", "children": [], "role": ROLE.get(tab, "?")})
    return out


def validate(works, tol=0.02):
    """IISMETA cost-estimation engine module."""
    by = collections.defaultdict(list)
    for w in works:
        by[w.get("role", "?")].append(w)
    pie = {role: by[role] for role in PIE_ROLES if by[role]}
    areas = {role: [w["qty"] for w in ws] for role, ws in pie.items()}
    flat = [(role, w["qty"]) for role, ws in pie.items() for w in ws]
    flags = []
    if flat:
        base_q = flat[0][1]
        for role, q in flat:
            if not any(abs(q - other[1]) < tol * max(q, 1) for other in flat if other != (role, q)) \
               and not abs(q - base_q) < tol * max(base_q, 1):
                flags.append("ПИРОГ: [%s] q=%.2f не равен остальным шагам пирога (q=%.2f)" % (role, q, base_q))
    return {"ok": not flags, "flags": flags,
            "pie": {role: [(w["table"], w["qty"]) for w in ws] for role, ws in pie.items()},
            "metal": [(w.get("role"), w["table"], w["qty"]) for w in works
                      if w.get("role") in ("кровля-металл", "аксессуар")]}
