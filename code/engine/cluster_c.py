# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
import json
import os
import re

import kb_engine as kb

HERE = os.path.dirname(os.path.abspath(__file__))


# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
def _load_anchors():
    with open(os.path.join(HERE, "data", "cluster_c_anchors.json"), encoding="utf-8") as f:
        return json.load(f)


_ANCHOR_DATA = _load_anchors()
FLOOR_ANCHOR = _ANCHOR_DATA["floor"]
WALL_ANCHOR = _ANCHOR_DATA["wall"]
AR_ANCHOR = _ANCHOR_DATA["ar"]
ROOF_ANCHOR = _ANCHOR_DATA["roof"]
KPP_ANCHOR = _ANCHOR_DATA["kpp"]

_ANCHOR = {**FLOOR_ANCHOR, **WALL_ANCHOR, **AR_ANCHOR, **ROOF_ANCHOR, **KPP_ANCHOR}

_STOP = {"устройство", "устройства", "покрытий", "покрытие", "покрытия", "работ", "прочих",
         "готовому", "основанию", "способом", "площади", "изменения", "изменение", "каждые",
         "каждый", "толщиной", "толщины", "добавлять", "добавить", "исключать", "исключить",
         "или", "при", "для", "под", "над", "без", "из", "на", "по", "во", "мм", "см"}

_DOBOR_RE = re.compile(r"на\s+кажд\w+\s+(\d+)\s*мм", re.I)
_BASE_RE = re.compile(r"толщин\w+\s+(\d+)\s*мм", re.I)


def _kw_match(kw, low):
    """IISMETA cost-estimation engine module."""
    if isinstance(kw, (tuple, list)):
        return all((k[1:] not in low) if k.startswith("!") else (k in low) for k in kw)
    return kw in low


_SURFACE_WORDS = ("стен", "потолк", "потолок", "откос", "фасад", "пол")


def _surface_stem(text):
    """IISMETA cost-estimation engine module."""
    low = (text or "").lower()
    return {w[:5] for w in _SURFACE_WORDS if w in low}


_SECTION_SUFFIX_RE = re.compile(r"\(([^()]+)\)\s*$")


def _section_from_work(work):
    """IISMETA cost-estimation engine module."""
    m = _SECTION_SUFFIX_RE.search(work or "")
    return m.group(1) if m else None


def _guarded_off(anchor, work):
    """IISMETA cost-estimation engine module."""
    low = (work or "").lower()
    return any(kw in low for kw in anchor.get("unless", []))


def _wc_for_table(table, series="Е"):
    """IISMETA cost-estimation engine module."""
    idx = kb._index()
    hits = [wc for wc, w in idx.items()
            if w.get("shnk_table") == table and w.get("series") == series]
    return hits[0] if hits else None


def _tokens(text):
    return {w for w in re.findall(r"[а-яёa-z]{3,}|\d+", (text or "").lower()) if w not in _STOP}


def _stem(tok):
    return tok[:5]


def _is_dobor(name):
    """IISMETA cost-estimation engine module."""
    return bool(_DOBOR_RE.search(name or "")) or "добав" in (name or "").lower()


def _num(s):
    m = re.search(r"\d+(?:[.,]\d+)?", str(s or ""))
    return float(m.group(0).replace(",", ".")) if m else None


# ─────────────────────────────────────────────────────────────────────────────
def _razvorot(varianty, material_kw, thickness):
    """IISMETA cost-estimation engine module."""
    mk = (material_kw or "").lower()
    fam = [v for v in varianty if mk in (v["name"] or "").lower()]
    base = next((v for v in fam if _BASE_RE.search(v["name"]) and not _is_dobor(v["name"])), None)
    dobor = next((v for v in fam if _is_dobor(v["name"])), None)
    if not base:
        return None
    comps = [{"shifr": base["code"], "qty_factor": 1.0}]
    variant = base["name"]
    dflt = False
    H = _num(thickness)
    if dobor:
        base_mm = _num(_BASE_RE.search(base["name"]).group(0))
        step_mm = _num(_DOBOR_RE.search(dobor["name"]).group(0)) or None
        if H is None:
            dflt = True
        elif step_mm and H > base_mm:
            factor = round((H - base_mm) / float(step_mm), 4)
            comps.append({"shifr": dobor["code"], "qty_factor": factor})
            variant = "%s + добор ×%g (H=%gмм, база %gмм, шаг %gмм)" % (
                base["name"][:40], factor, H, base_mm, step_mm)
        elif H < base_mm:
            dflt = True
    return {"components": comps, "variant": variant, "variant_default": dflt,
            "operator_flag": dflt,
            "candidates": [{"shifr": v["code"], "name": v["name"]} for v in fam[:6]]}


def _score_pick(varianty, work, params):
    """IISMETA cost-estimation engine module."""
    q = _tokens(work)
    for val in (params or {}).values():
        q |= _tokens(str(val))
    qs = {_stem(t) for t in q}
    scored = []
    for v in varianty:
        vs = {_stem(t) for t in _tokens(v["name"])}
        inter = len(qs & vs)
        extra = len(vs - qs)
        scored.append(((inter, -extra), v))
    scored.sort(key=lambda x: (-x[0][0], -x[0][1]))
    top = scored[0][0]
    cands = [{"shifr": v["code"], "name": v["name"]} for s, v in scored[:6]]
    winners = [v for s, v in scored if s == top and top[0] > 0]
    if len(winners) == 1:
        v = winners[0]
        return {"components": [{"shifr": v["code"], "qty_factor": 1.0}], "variant": v["name"],
                "variant_default": False, "operator_flag": False, "candidates": cands}
    simplest = next((v for v in varianty if not _is_dobor(v["name"])), varianty[0])
    return {"components": [{"shifr": simplest["code"], "qty_factor": 1.0}], "variant": simplest["name"],
            "variant_default": True, "operator_flag": True, "candidates": cands}


_WH_RE = re.compile(r"(\d{3,4})\s*[xхX×]\s*(\d{3,4})")
_PROEM_WH_RE = re.compile(r"(\d{3,4})\s*[xхX×]\s*(\d{3,4})\s*(?:h\s*)?\)?\s*проем", re.I)
_STATED_AREA_RE = re.compile(r"на\s*1\s*шт\.?\s*[-—:=]?\s*(\d+(?:[.,]\d+)?)\s*м\s*[2²]", re.I)


def _door_area_m2(text):
    """IISMETA cost-estimation engine module."""
    m = _STATED_AREA_RE.search(text or "")
    if m:
        return float(m.group(1).replace(",", "."))
    m = _PROEM_WH_RE.search(text or "") or _WH_RE.search(text or "")
    if not m:
        return None
    return (float(m.group(1)) / 1000.0) * (float(m.group(2)) / 1000.0)


_LEN_TOTAL_RE = re.compile(r"l\s*об[щш]\.?\s*=\s*(\d+(?:[.,]\d+)?)", re.I)
_LEN_VAL_RE = re.compile(r"(?<![a-zа-яё])l\s*=\s*(\d+(?:[.,]\d+)?)\s*(мм|м)?\b", re.I)


def _length_m(text):
    """IISMETA cost-estimation engine module."""
    m = _LEN_TOTAL_RE.search(text or "")
    if m:
        return float(m.group(1).replace(",", "."))
    m = _LEN_VAL_RE.search(text or "")
    if m:
        val = float(m.group(1).replace(",", "."))
        suf = (m.group(2) or "").lower()
        if suf == "м":
            return val
        return val / 1000.0
        return float(m.group(1).replace(",", ".")) / 1000.0
    return None


_RAZV_RE = re.compile(r"(?<![a-zа-яё])[вbи]\s*=\s*(\d+(?:[.,]\d+)?)\s*мм", re.I)
_PC_AREA_RE = re.compile(r"(?<![=×x*])\s(\d+(?:[.,]\d+)?)\s*м\s*[2²]\s*$", re.I)


def _area_per_pc_m2(text):
    """IISMETA cost-estimation engine module."""
    m = _PC_AREA_RE.search(text or "")
    if not m:
        return None
    v = float(m.group(1).replace(",", "."))
    return v if 0 < v < 100 else None


def _razvertka_m(text):
    """IISMETA cost-estimation engine module."""
    if _LEN_TOTAL_RE.search(text or ""):
        return None
    m = _RAZV_RE.search(text or "")
    return float(m.group(1).replace(",", ".")) / 1000.0 if m else None


def _okno_pick(varianty, work):
    """IISMETA cost-estimation engine module."""
    low = (work or "").lower()
    gluh = "глух" in low and not re.search(r"поворот|откидн|раздвижн|створк", low)
    fam = [v for v in varianty if ("глухих" in (v["name"] or "").lower()) == gluh] or varianty
    if any("створчат" in (v["name"] or "").lower() for v in fam):
        stv = ("двухстворчат" if re.search(r"двум[яе]|дву[хс]?створ|двустворч", low)
               else "трехстворчат" if re.search(r"тр[её]м[яе]|тр[её]х\s?створ|три\s?створ", low)
               else "одностворчат")
        fam2 = [v for v in fam if stv in (v["name"] or "").lower().replace("ё", "е")]
        if fam2:
            fam = fam2
    area = _door_area_m2(work)
    if area is None:
        return {"components": [{"shifr": fam[0]["code"], "qty_factor": 1.0}],
                "variant": fam[0]["name"], "variant_default": True,
                "operator_flag": "площадь окна (WxH) не найдена в строке — выбрать вариант",
                "candidates": [{"shifr": v["code"], "name": v["name"]} for v in fam[:6]]}
    best = best_thr = big_v = big_thr = more_v = None
    for v in fam:
        nl = (v["name"] or "").lower()
        m_do = re.search(r"\bдо\s+([\d,.]+)\s*м2", nl)
        m_bo = re.search(r"\bболее\s+([\d,.]+)\s*м2", nl)
        if m_do:
            thr = float(m_do.group(1).replace(",", "."))
            if area <= thr and (best_thr is None or thr < best_thr):
                best, best_thr = v, thr
            if big_thr is None or thr > big_thr:
                big_v, big_thr = v, thr
        elif m_bo and more_v is None:
            more_v = v
    v = best or more_v or big_v or fam[0]
    return {"components": [{"shifr": v["code"], "qty_factor": 1.0}], "variant": v["name"],
            "variant_default": False, "operator_flag": False,
            "candidates": [{"shifr": x["code"], "name": x["name"]}
                           for x in ([v] + [x for x in fam if x is not v])[:6]]}


def _area_split_pick(varianty, work):
    """IISMETA cost-estimation engine module."""
    area = _door_area_m2(work)
    thresh, below, above, other = None, [], [], []
    for v in varianty:
        low = (v["name"] or "").lower()
        m_do = re.search(r"\bдо\s+([\d,.]+)\s*м2", low)
        m_bo = re.search(r"\bболее\s+([\d,.]+)\s*м2", low)
        if m_do:
            if thresh is None:
                thresh = float(m_do.group(1).replace(",", "."))
            below.append(v)
        elif m_bo:
            if thresh is None:
                thresh = float(m_bo.group(1).replace(",", "."))
            above.append(v)
        else:
            other.append(v)
    if area is not None and thresh is not None:
        matched, rest = (below, above) if area <= thresh else (above, below)
        ordered = matched + rest + other
    else:
        ordered = below + above + other
    simplest = ordered[0]
    cands = [{"shifr": v["code"], "name": v["name"]} for v in ordered[:6]]
    return {"components": [{"shifr": simplest["code"], "qty_factor": 1.0}], "variant": simplest["name"],
            "variant_default": True, "operator_flag": True, "candidates": cands}


_WALL_DISCR = ("каменн", "панельн", "перегородк")
_BASE_DISCR = ("деревянн", "бетонн")

_H_LIMIT_RE = re.compile(r"высот\w*\s+(до|более|свыше|св\.?)\s+(\d+(?:[.,]\d+)?)\s*м", re.I)


def _h_limit(name):
    m = _H_LIMIT_RE.search(name or "")
    if not m:
        return None
    v = float(m.group(2).replace(",", "."))
    return v if m.group(1).lower().startswith("до") else float("inf")


def _height_narrow(varianty, obj_type):
    """IISMETA cost-estimation engine module."""
    t = (obj_type or "").strip().lower()
    if not t or not varianty:
        return varianty, None
    lim = 6.0 if any(k in t for k in ("производствен", "складск", "инженерн")) else 3.0
    hs = {}
    for v in varianty:
        x = _h_limit(v.get("name"))
        if x is not None:
            hs[v["code"]] = x
    if len(set(hs.values())) < 2:
        return varianty, None
    fit = [x for x in set(hs.values()) if x >= lim]
    if not fit:
        return varianty, None
    best = min(fit)
    keep = [v for v in varianty if hs.get(v["code"], best) == best]
    return (keep, "высота≤%g" % best) if keep else (varianty, None)


_QUAL = ((3, r"высококачествен"), (2, r"улучшен"), (1, r"\bпрост(ое|ая|ой|ым|ые|ых)\b"))
_METH = ((2, r"механизирован"), (1, r"ручн"))


def _rank_of(text, table):
    low = (text or "").lower()
    for rank, pat in table:
        if re.search(pat, low):
            return rank
    return None




def _axis_narrow(varianty, work, card_rank, table, axis_name):
    """IISMETA cost-estimation engine module."""
    ranks = {}
    for v in varianty:
        r = _rank_of(v.get("name"), table)
        if r is not None:
            ranks[v["code"]] = r
    if len(set(ranks.values())) < 2:
        return varianty, None, None
    line_rank = _rank_of(work, table)
    target = line_rank if line_rank is not None else card_rank
    if target is None or target not in set(ranks.values()):
        return varianty, None, None
    conflict = None
    if line_rank is not None and card_rank is not None and line_rank != card_rank:
        conflict = ("%s: в строке ВОР одно, в карточке Проекта другое — взято из строки "
                    "(документ сильнее умолчания), проверьте" % axis_name)
    keep = [v for v in varianty if ranks.get(v["code"], target) == target]
    return (keep, "%s=%d" % (axis_name, target), conflict) if keep else (varianty, None, conflict)


def _structure_narrow(varianty, structure):
    """IISMETA cost-estimation engine module."""
    s = (structure or "").strip().lower()
    if not s or not varianty:
        return varianty, None
    wall = ("каменн" if s in ("кирпичная кладка", "монолитный железобетон")
            else "панельн" if s == "сборный железобетон (панельный)" else None)
    base = ("деревянн" if s == "каркасный (дерево)"
            else "бетонн" if s in ("кирпичная кладка", "монолитный железобетон",
                                   "сборный железобетон (панельный)", "каркасный (металл)") else None)

    def has(v, kw):
        return kw in (v.get("name") or "").lower()

    for key, discr in ((wall, _WALL_DISCR), (base, _BASE_DISCR)):
        if not key or not any(has(v, d) for v in varianty for d in discr):
            continue
        narrowed = [v for v in varianty if has(v, key) or not any(has(v, d) for d in discr)]
        if any(has(v, key) for v in narrowed):
            return narrowed, key
    return varianty, None


def variant_pick(w):
    """IISMETA cost-estimation engine module."""
    table = w.get("table")
    work = w.get("work")
    params = w.get("params") or {}
    series = w.get("series") or "Е"
    _a = _ANCHOR.get(table) or {}
    if _a.get("okno") and str(w.get("unit") or "").strip().lower().rstrip(".") == "шт":
        _area = _door_area_m2(work or "")
        try:
            _q = float(str(w.get("qty")).replace(",", "."))
        except (TypeError, ValueError):
            _q = None
        if _area and _q and _q > 0:
            w["qty"] = round(_q * _area, 4)
            w["unit"] = "м2"
            _f = "окно шт→м²: %g шт × %.2f м² = %g м²" % (_q, _area, w["qty"])
            w["rule"] = _f if (not w.get("rule") or w["rule"] == "1:1") else (w["rule"] + " · " + _f)
    _razv_done = False
    if _a.get("razvertka") and str(w.get("unit") or "").strip().lower().rstrip(".") == "шт":
        try:
            _q = float(str(w.get("qty")).replace(",", "."))
        except (TypeError, ValueError):
            _q = None
        _pc = _area_per_pc_m2(work or "")
        _b = None if _pc else _razvertka_m(work or "")
        _l = None if _pc else _length_m(work or "")
        if _q and _q > 0 and (_pc or (_b and _l)):
            _area = _pc if _pc else (_l * _b)
            w["qty"] = round(_q * _area, 4)
            w["unit"] = "м2"
            _f = ("площадь штуки из строки: %g шт × %g м² = %g м²" % (_q, _pc, w["qty"])
                  if _pc else
                  "развёртка шт→м²: %g шт × %g м × %g м = %g м²" % (_q, _l, _b, w["qty"]))
            w["rule"] = _f if (not w.get("rule") or w["rule"] == "1:1") else (w["rule"] + " · " + _f)
            _razv_done = True
    if (_a.get("length_conv") and not _razv_done
            and str(w.get("unit") or "").strip().lower().rstrip(".") not in ("м", "мп", "пм", "м.п")):
        _len = _length_m(work or "")
        if _len and _len > 0:
            _old_q, _old_u = w.get("qty"), w.get("unit") or "?"
            w["qty"] = round(_len, 4)
            w["unit"] = "м"
            _f = "длина из текста (не %s %s): %g м" % (_old_q, _old_u, w["qty"])
            w["rule"] = _f if (not w.get("rule") or w["rule"] == "1:1") else (w["rule"] + " · " + _f)
    return _pick(table, work, params, series, w.get("structure"), w.get("obj_type"),
                 w.get("finish_quality"), w.get("decor_method"))


def _pick(table, work, params, series, structure=None, obj_type=None,
          finish_quality=None, decor_method=None):
    wc = _wc_for_table(table, series)
    if not wc:
        return {"components": [], "variant": None, "variant_default": False,
                "operator_flag": True, "auto_assign": False, "candidates": [], "table": table, "wc": None,
                "error": "таблица %s (серия %s) не найдена в базе расценок" % (table, series)}
    varianty = kb._index()[wc]["varianty"]
    varianty, _struct_key = _structure_narrow(varianty, structure)
    varianty, _h_key = _height_narrow(varianty, obj_type)
    _conf = []
    varianty, _q_key, _c1 = _axis_narrow(varianty, work,
                                         _rank_of(finish_quality, _QUAL),
                                         _QUAL, "качество отделки")
    varianty, _m_key, _c2 = _axis_narrow(varianty, work,
                                         _rank_of(decor_method, _METH),
                                         _METH, "способ нанесения")
    _conf = [c for c in (_c1, _c2) if c]
    anchor = _ANCHOR.get(table)
    if anchor and "razvorot" in anchor:
        res = _razvorot(varianty, anchor["razvorot"], params.get("толщина"))
        if res is None:
            res = _score_pick(varianty, work, params)
    elif anchor and anchor.get("okno"):
        res = _okno_pick(varianty, work)
    elif anchor and anchor.get("area_split"):
        res = _area_split_pick(varianty, work)
    elif anchor and ("code" in anchor or "ambiguous" in anchor) and not _guarded_off(anchor, work):
        target = anchor.get("code")
        amb = anchor.get("ambiguous")
        k = float(anchor.get("k", 1.0))
        low = (work or "").lower()
        _ctx_hit = False
        for kw, override in anchor.get("context", []):
            if _kw_match(kw, low):
                _ctx_hit = True
                if "ambiguous" in override:
                    target, amb = None, override["ambiguous"]
                else:
                    target = override.get("code", target)
                    k = float(override.get("k", k))
                    amb = None
                break
        _sec_override = False
        if not _ctx_hit:
            sec_st = _surface_stem(_section_from_work(work))
            if sec_st:
                sec_vs = [v for v in varianty if _surface_stem(v["name"]) & sec_st]
                cur_code = target if target is not None else None
                cur_v = next((x for x in varianty if x["code"] == cur_code), None) if cur_code else None
                cur_matches = bool(cur_v and _surface_stem(cur_v["name"]) & sec_st)
                if sec_vs and not cur_matches:
                    pick = next((v for v in sec_vs if not _is_dobor(v["name"])), sec_vs[0])
                    target, amb, _sec_override = pick["code"], None, True
        if target is not None:
            v = next((x for x in varianty if x["code"] == target or x.get("shifr") == target), None)
            if v:
                res = {"components": [{"shifr": v["code"], "qty_factor": k}], "variant": v["name"],
                       "variant_default": _sec_override, "operator_flag": _sec_override,
                       "candidates": [{"shifr": v["code"], "name": v["name"]}]}
                if _sec_override:
                    res["candidates"][0]["default"] = True
                    res["why"] = "раздел ВОР задаёт поверхность — вариант подобран по разделу, не по анкеру"
            else:
                res = _score_pick(varianty, work, params)
                res["operator_flag"] = True
        else:
            cand_vs = [v for c in (amb or [])
                       for v in varianty if v["code"] == c]
            if cand_vs:
                res = {"components": [{"shifr": cand_vs[0]["code"], "qty_factor": 1.0}],
                       "variant": cand_vs[0]["name"], "variant_default": True, "operator_flag": True,
                       "candidates": [{"shifr": v["code"], "name": v["name"]} for v in cand_vs]}
            else:
                res = _score_pick(varianty, work, params)
                res["operator_flag"] = True
    else:
        res = _score_pick(varianty, work, params)

    res["auto_assign"] = not res["operator_flag"]
    if not res["auto_assign"]:
        res["components"] = []
        if res.get("candidates"):
            res["candidates"][0] = dict(res["candidates"][0], default=True)

    if anchor:
        res["anchored"] = True
    res["all_variants"] = [{"shifr": v["code"], "name": v.get("name") or ""} for v in varianty][:40]
    if _conf:
        res["axis_conflict"] = " · ".join(_conf)
        res["operator_flag"] = res.get("operator_flag") or _conf[0]
    res["table"] = table
    res["wc"] = wc
    return res


# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
