# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
import re

_CANON = {
    "м2": "м2", "м²": "м2", "кв.м": "м2", "кв.м.": "м2", "м.кв": "м2", "м.кв.": "м2", "квм": "м2", "m2": "м2",
    "м3": "м3", "м³": "м3", "куб.м": "м3", "куб.м.": "м3", "м.куб": "м3", "м.куб.": "м3", "кубм": "м3", "m3": "м3",
    "м": "м", "пог.м": "м", "пог.м.": "м", "п.м": "м", "п.м.": "м", "пм": "м", "м.п": "м", "м.п.": "м", "п/м": "м",
    "т": "т", "тн": "т", "тонн": "т", "тн.": "т", "кг": "кг", "кг.": "кг", "г": "г",
    "шт": "шт", "шт.": "шт", "штук": "шт", "компл": "компл", "компл.": "компл", "к-т": "компл",
    "мм": "мм", "см": "см", "км": "км", "%": "%", "м2/т": "м2",
}


def norm_unit(u):
    if not u:
        return ""
    s = str(u).strip().lower().replace("ё", "е")
    s = s.split("\n")[0].strip()
    s = s.split("/")[0].strip() if "/" in s and s.split("/")[0].strip() in _CANON else s
    key = s.replace(" ", "")
    return _CANON.get(key, str(u).strip().split("\n")[0].strip())


def _mm(v):
    if v is None:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(мм|см|м)?", str(v).lower())
    if not m:
        return None
    x = float(m.group(1).replace(",", "."))
    return x * {"мм": 1.0, "см": 10.0, "м": 1000.0, None: 1.0}[m.group(2)]


_SCALE = {("т", "кг"): 1000.0, ("кг", "т"): 0.001, ("кг", "г"): 1000.0, ("г", "кг"): 0.001,
          ("м", "мм"): 1000.0, ("мм", "м"): 0.001, ("м", "см"): 100.0, ("см", "м"): 0.01,
          ("км", "м"): 1000.0, ("м", "км"): 0.001, ("м2", "дм2"): 100.0}


def _num(v):
    """IISMETA cost-estimation engine module."""
    if v is None:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(v).replace(" ", ""))
    return float(m.group(1).replace(",", ".")) if m else None


_W_KEYS = ("вес 1 м2", "вес 1м2", "вес 1 м²", "вес 1м²", "вес м2", "вес сетки", "масса 1 м2", "масса 1м2")
_L_KEYS = ("вес 1 м", "вес 1м", "вес пог.м", "вес погонного метра", "масса 1 м", "масса 1м")


def _by_area(params):
    for k in _W_KEYS:
        v = _num((params or {}).get(k))
        if v:
            return v, k
    return None, None


def _by_len(params):
    for k in _L_KEYS:
        v = _num((params or {}).get(k))
        if v:
            return v, k
    return None, None


def convert(qty, frm, to, params=None):
    """IISMETA cost-estimation engine module."""
    if qty is None:
        return None, None
    frm, to = norm_unit(frm), norm_unit(to)
    if not frm or not to or frm == to:
        return qty, "="
    if (frm, to) in _SCALE:
        k = _SCALE[(frm, to)]
        return round(qty * k, 4), "×%g" % k
    th = _mm((params or {}).get("толщина") or (params or {}).get("высота"))
    if frm == "м2" and to == "м3" and th:
        return round(qty * th / 1000.0, 4), "объём = площадь × толщина %gмм" % th
    if frm == "м3" and to == "м2" and th:
        return round(qty / (th / 1000.0), 4), "площадь = объём ÷ толщина %gмм" % th
    if to in ("т", "кг"):
        w, key = (_by_area(params) if frm == "м2" else (_by_len(params) if frm == "м" else (None, None)))
        if w:
            kg = qty * w
            base = "%g %s × %g кг (%s)" % (qty, frm, w, key)
            return (round(kg / 1000.0, 4), "масса = %s ÷ 1000" % base) if to == "т" \
                else (round(kg, 4), "масса = %s" % base)
    if frm in ("т", "кг") and to in ("м2", "м"):
        w, key = (_by_area(params) if to == "м2" else _by_len(params))
        if w:
            kg = qty * (1000.0 if frm == "т" else 1.0)
            return round(kg / w, 4), "%s = %g кг ÷ %g кг (%s)" % (to, kg, w, key)
    return None, None
