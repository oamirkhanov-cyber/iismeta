# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import json
import os
import re

import floor_decompose as FD
import wall_decompose as WD
import krovlya_decompose as KD
import metal_decompose as MD
import aux_decompose as AD

_AUX_KEYS = ("06_beton", "10_derevo", "13_zaschita", "tail_misc")

REGISTRY = {
    "11_poly":     (FD.lookup, lambda rows, section=None: FD.decompose(rows)),
    "15_otdelka":  (WD.lookup, WD.decompose),
    "12_krovlya":  (KD.lookup, KD.decompose),
    "09_metal":    (MD.lookup, MD.decompose),
    "06_beton":    (lambda nm: AD.lookup(nm, "06_beton"), lambda rows, section=None: AD.decompose(rows, "06_beton", section)),
    "10_derevo":   (lambda nm: AD.lookup(nm, "10_derevo"), lambda rows, section=None: AD.decompose(rows, "10_derevo", section)),
    "13_zaschita": (lambda nm: AD.lookup(nm, "13_zaschita"), lambda rows, section=None: AD.decompose(rows, "13_zaschita", section)),
    "tail_misc":   (lambda nm: AD.lookup(nm, "tail_misc"), lambda rows, section=None: AD.decompose(rows, "tail_misc", section)),
}

CATALOG_ORDER = ["11_poly", "15_otdelka", "12_krovlya", "09_metal",
                  "06_beton", "10_derevo", "13_zaschita", "tail_misc"]

SECTION_HINTS = [
    (r"кровл|водосточ|желоб|козырьк|накладн\w*.*планк|огражден\w*.*кровл", "12_krovlya"),
    (r"пол\w*\b|плинтус", "11_poly"),
    (r"двер|ворот|окн\w*\b|витраж|огражден\w*.*крыльц|лестниц|люк", "09_metal"),
    (r"крыльц|ступен|стен|потолок|откос|фасад|цоколь|отделк", "15_otdelka"),
    (r"защит\w*.*коррози|коррози", "13_zaschita"),
    (r"дерев", "10_derevo"),
    (r"бетон", "06_beton"),
]


def _low(s):
    return ("" if s is None else str(s)).lower().replace("ё", "е")


_MASS_UNIT_RE = re.compile(r"^\s*(кг|т|тн|тонн)\b", re.I)
_CONC_CTX_RE = re.compile(r"бетон|бет\.|железобетон|ж/б|ж\.б", re.I)
_REBAR_SIG_RE = re.compile(r"армир|сетк|арматур|каркас", re.I)
_TWO_MESH_RE = re.compile(r"дв(ум|ух|е)\w*\s+сетк|2\s*-?\s*мя\s+сетк|двойн\w*\s+сетк|каркас", re.I)


def rebar_by_unit(name, unit):
    """IISMETA cost-estimation engine module."""
    if not _MASS_UNIT_RE.match(str(unit or "")):
        return False
    low = _low(name)
    return bool(_REBAR_SIG_RE.search(low) and _CONC_CTX_RE.search(low))


# _tests_kpp_raw_vor.py).
ABSORB_HINTS = [
    (r"^цементно\s*.?клеев|^клеев\w*\s+раствор|^цементн\w*\s+клеев\w*\s+раствор|^клей\b", "клей — в составе нормы облицовки/покрытия"),
    (r"^слой\s+влагостойк\w*\s+плиточн\w*\s+кле", "плиточный клей — в составе нормы облицовки"),
    (r"^шлифовк", "шлифовка — операция в составе нормы отделки"),
    (r"^грунтовк\w*\s+под\s+окраску", "грунтовка под окраску — в составе нормы окраски"),
    (r"^кронштейн", "крепёж водосточной системы — в составе нормы желобов"),
    (r"^(?:[а-яё]+\s+)?хомут", "крепёж водосточной трубы — в составе нормы навески труб"),
    (r"^ерш\w*\b", "ерши крепления водосточных труб — «поковки оцинкованные» в составе Е1201-008 (0,095 т на 100 м)"),
    (r"^колен\w*\b", "колено водосточной трубы — в составе Е1201-008: норма закладывает 113 м трубы на 100 м навески"),
    (r"^угол\s+желоб", "угол жёлоба — фасонный добор в составе Е1201-009 (сталь листовая оцинкованная 0,33 т на 100 м)"),
    (r"^держател\w*\s+труб", "крепёж водосточной трубы — в составе нормы навески труб"),
    (r"^фасонн\w*\s+элемент", "доборный элемент кровли — материал по проекту"),
    (r"^гайк\w*\b", "крепёж — в составе монтажной нормы"),
    (r"^шайб\w*\b", "крепёж — в составе монтажной нормы"),
    (r"^шпильк\w*\b", "крепёж — в составе монтажной нормы"),
    (r"^болт\w*\b", "крепёж — в составе монтажной нормы узла"),
    (r"^анкер\w*\b", "анкерный крепёж — в составе монтажной нормы узла ограждения/стойки"),
    (r"^заглушк\w*\b|^металлическ\w*\s+заглушк", "заглушка торцевая трубы/стойки — в составе монтажной нормы узла"),
    (r"^металлическ\w*\s+пластин", "пластина — крепёжный элемент узла ограждения/козырька, не самостоятельная норма"),
    (r"^труб\w*\s+(квадратн|бесшовн)\w*\b", "труба (заготовка) — сырьё узла ограждения/декоративного элемента, не самостоятельная норма"),
    (r"^сталь\w*\s+квадратн", "сталь квадратная — сырьё узла металлоконструкции"),
    (r"^круг\s+стальн", "круг стальной — сырьё/крепёж узла ограждения"),
    (r"^полос\w*\s+стальн", "полоса стальная — сырьё узла решётки/ограждения"),
    (r"^арматур\w*\b", "арматура/сетка армирования — расход в составе нормы бетона/узла"),
    (r"^проволок\w*\b", "проволока — крепёжное сырьё узла решётки"),
    (r"^петл\w*\s*\(", "петли дверные/решётки — в составе монтажной нормы узла"),
    (r"^крепеж\w*\s+для\s+стойк", "крепёж стойки в составе (фланец/накрывка/анкер) — единый узел, не отдельные позиции"),
    (r"^костыл\w*\b", "костыль — крепёж кровельного узла (снегодержатель/обшивка), в составе монтажной нормы"),
    (r"^прокат\s+стальн", "прокат стальной — сырьё узла ограждения кровли"),
    (r"^дюбел\w*[-\s]?шуруп", "дюбель-шуруп — крепёж в составе монтажной нормы"),
    (r"^саморез\w*\b", "саморезы — крепёж в составе монтажной нормы"),
    (r"^винт\s+самосверл", "винт самосверлящий — крепёж в составе монтажной нормы"),
    (r"^заклепк\w*\b", "заклёпка — крепёж в составе монтажной нормы"),
    (r"^ажурн\w*\s+элемент", "ажурные элементы (расход на 1 шт) — заголовок BOM узла, не самостоятельная позиция"),
    (r"^акрилатн\w*.*кле", "акрилатный клей — в составе нормы облицовки (тот же класс, что цементный клей выше)"),
    (r"^прослойк\w*|^заполнен\w*\s+шв", "прослойка/заполнение швов — в составе нормы покрытия (свёртка по площади)"),
    (r"^подложк\w*\b", "подложка — в составе нормы покрытия (свёртка по площади)"),
    (r"^грунтовочн\w*\s+пропитк", "грунтовочная пропитка (бетон-контакт) — в составе нормы облицовки/окраски"),
    (r"^(влагостойк\w*\s+)?шпаклевк\w*\s+на\s+(гипсов|цементн)", "шпаклёвка — ресурс внутри нормы окраски/отделки, не отдельная строка (см. 15-04-027 сноску: задваивать нельзя)"),
    (r"^уголок\b|^сталь\w*\s+угловая|^угол\w*\s+стальн", "уголок (сортовой прокат) — сырьё узла металлоконструкции, своей нормы нет"),
    (r"^швеллер\b|^двутавр\w*\b|^балк\w*\s+двутавр", "швеллер/двутавр (фасонный прокат) — сырьё узла металлоконструкции, своей нормы нет"),
    (r"^труб\w*\s+профильн|^профильн\w*\s+труб|^труб\w*\s+\d+\s*[хx×]\s*\d+\s*[хx×]\s*\d+",
     "труба профильная (прокат) — сырьё узла ограждения/каркаса, своей нормы нет"),
    (r"^лист\w*\s+стал|^сталь\w*\s+листов|^лист\w*\s+оцинков", "листовой прокат — сырьё узла металлоконструкции, своей нормы нет"),
    (r"^шестигранник\b|^квадрат\s+стальн", "сортовой прокат — сырьё узла металлоконструкции, своей нормы нет"),
]


_ABSORB_NORM_PATS = frozenset([
    r"^цементно\s*.?клеев|^клеев\w*\s+раствор|^цементн\w*\s+клеев\w*\s+раствор|^клей\b",
    r"^слой\s+влагостойк\w*\s+плиточн\w*\s+кле",
    r"^шлифовк",
    r"^грунтовк\w*\s+под\s+окраску",
    r"^кронштейн",
    r"^(?:[а-яё]+\s+)?хомут",
    r"^ерш\w*\b",
    r"^колен\w*\b",
    r"^угол\s+желоб",
    r"^держател\w*\s+труб",
    r"^фасонн\w*\s+элемент",
    r"^акрилатн\w*.*кле",
    r"^прослойк\w*|^заполнен\w*\s+шв",
    r"^подложк\w*\b",
    r"^грунтовочн\w*\s+пропитк",
    r"^(влагостойк\w*\s+)?шпаклевк\w*\s+на\s+(гипсов|цементн)",
])
assert _ABSORB_NORM_PATS <= {p for p, _r in ABSORB_HINTS}, \
    "класс поглощения ссылается на паттерн, которого нет в ABSORB_HINTS — правило осиротело"


def _absorb_hit(name):
    low = _low(name)
    for pat, reason in ABSORB_HINTS:
        if re.search(pat, low):
            return pat, reason
    return None, None


def absorb_check(name):
    """IISMETA cost-estimation engine module."""
    return _absorb_hit(name)[1]


def absorb_kind(name):
    """IISMETA cost-estimation engine module."""
    pat, _reason = _absorb_hit(name)
    if pat is None:
        return None
    return "норма" if pat in _ABSORB_NORM_PATS else "узел"


#

_MD_GUARD = re.compile(
    r"установк|монтаж|устройств|окраск|покраск|штукатур|облицовк|демонтаж|разборк|укладк"
    r"|заделк|затирк|проливк|пропитк|грунтовк|шлифовк|кладк")

_MD_GLAZING_CODE = re.compile(r"(^|[\s,:])оп\s*в\s*\d")
_MD_GLAZING_FORMULA = re.compile(r"\(\s*\d+\s*[мm]\d+-\d+-[кмkm]\d+")

_MD_PO_PROEKTU = "по проект"

_MD_IZDELIE = [
    (re.compile(r"^систем\w*\s+для\s+креплен"),
     "изделие по типовой серии"),
    (re.compile(r"^снегодержател"),
     "кровельное изделие"),
    (re.compile(r"^воронк\w*\s+проходн"),
     "водосточное изделие"),
]

_MD_NODE_COUNTER = re.compile(r"\d+\s*шт")
_PM_RATE_PREFIX = re.compile(r"(?:\bпо|\bна)\s*$", re.I)


def _is_nested_node(nm):
    """IISMETA cost-estimation engine module."""
    for m in re.finditer(r"\d+\s*шт", nm or ""):
        if _PM_RATE_PREFIX.search((nm or "")[:m.start()]):
            continue
        return True
    return False


def material_direct_check(name, section_title=None):
    """IISMETA cost-estimation engine module."""
    low = _low(name)
    if _MD_PO_PROEKTU in low:
        return "явное «по проекту» в тексте — материал/изделие по проектной документации"
    if _MD_GUARD.search(low):
        return None
    if _MD_GLAZING_CODE.search(low) or _MD_GLAZING_FORMULA.search(low):
        return ("оконная спецификация-изделие «ОП В…»/стеклопакет-формула — материал по проекту "
                "")
    for rx, reason in _MD_IZDELIE:
        if rx.search(low):
            return reason
    return None


def material_direct_node_check(name, section_title=None):
    """IISMETA cost-estimation engine module."""
    low = _low(name)
    st_low = _low(section_title)
    if not st_low or not _MD_NODE_COUNTER.search(st_low):
        return None
    if _MD_NODE_COUNTER.search(low):
        return None
    if _MD_GUARD.search(low):
        return None
    return ("компонент узловой ведомости «%s» — расход материала на узел "
            ""
            % (section_title or "")[:60])


_PM_TRIGGER_DEFAULT = r"(\d+)\s*шт.*?расход\s+(?:дан[оа]?\s+)?на\s*1(?!\d)"
_PM_GROUND_DEFAULT = r"отмостк|щебен"


def _pm_config():
    """IISMETA cost-estimation engine module."""
    trig, guard = _PM_TRIGGER_DEFAULT, _PM_GROUND_DEFAULT
    try:
        import json as _j
        _p = os.path.join(os.path.dirname(__file__), "data", "techchasti.json")
        _d = _j.load(open(_p, encoding="utf-8")).get("множитель_дитя_мать", {})
        trig = _d.get("триггер_regex") or trig
        guard = _d.get("контаминация_гард_regex") or guard
    except Exception:
        pass
    return re.compile(trig, re.I | re.S), re.compile(guard, re.I)


_PARENT_MULT_RE, _PM_GROUND_GUARD = _pm_config()


def _pm_qnum(v):
    if v is None:
        return None
    s = str(v).strip().replace(" ", "").replace(" ", "").replace(",", ".")
    m = re.match(r"^-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


_PM_TRIGGER_ALT = re.compile(r"дан[оа]?\s+(?:на\s+)?1\s*шт.*?общ\w*\.?\s*(\d+)\s*шт", re.I | re.S)
_PM_NODE_ROW = re.compile(r"дан[оа]?\s+(?:на\s+)?1\s*шт", re.I)


def _pm_node_counts(rows):
    """IISMETA cost-estimation engine module."""
    out, cur, cur_sec = {}, None, object()
    for i, r in enumerate(rows):
        sec = r.get("section_title")
        if sec != cur_sec:
            cur, cur_sec = None, sec
        nm = r.get("name") or ""
        q = _pm_qnum(r.get("qty"))
        is_node = (_PM_NODE_ROW.search(nm) and not (r.get("unit") or "").strip()
                   and q is not None and q == int(q) and 1 < q <= 9999)
        if is_node:
            cur = int(q)
            continue
        if cur and q is not None:
            out[i] = cur
    return out


_PM_TOTAL_RX = re.compile(r"общ\w*\.?\s*(?:вес\s*)?[-:—=]?\s*(\d+(?:[.,]\d+)?)\s*(кг|т|м\s*[2²])\b", re.I)
_PM_PER_AREA = re.compile(r"(\d+(?:[.,]\d+)?)\s*м\s*[2²]\b", re.I)
_PM_PER_KG = re.compile(r"вес[\s.\-:=]*(\d+(?:[.,]\d+)?)\s*кг", re.I)


def _pm_ready_total(r):
    """IISMETA cost-estimation engine module."""
    m = _PM_TOTAL_RX.search("%s %s" % (r.get("doc_note") or "", r.get("note") or ""))
    if not m:
        return None
    dim = re.sub(r"\s+", "", m.group(2)).lower()
    tot = float(m.group(1).replace(",", "."))
    if dim in ("кг", "т"):
        p = _PM_PER_KG.search(r.get("name") or "")
        if dim == "т":
            tot *= 1000.0
    else:
        p = _PM_PER_AREA.search(r.get("name") or "")
    if not p:
        return None
    per = float(p.group(1).replace(",", "."))
    return (tot, per) if (tot > 0 and per > 0) else None


def _pm_near(a, b):
    return abs(a - b) <= max(0.01, 0.01 * abs(b))


def apply_parent_multiplier(rows):
    """IISMETA cost-estimation engine module."""
    n_applied = 0
    node_counts = _pm_node_counts(rows)
    for i, r in enumerate(rows):
        if r.get("_pm_applied"):
            continue
        st = r.get("section_title") or ""
        nm0 = r.get("name") or ""
        if i not in node_counts and (r.get("unit") or "").strip():
            self_m = _PARENT_MULT_RE.search(nm0) or _PM_TRIGGER_ALT.search(nm0)
            if self_m:
                n_self = int(self_m.group(1))
                if 1 < n_self <= 9999 and not _PM_GROUND_GUARD.search(_low(nm0)):
                    q0 = _pm_qnum(r.get("qty"))
                    rt0 = _pm_ready_total(r)
                    if q0 is not None and not (rt0 and _pm_near(q0 * rt0[1], rt0[0])):
                        ambig0 = bool(rt0) and not _pm_near(q0 * n_self * rt0[1], rt0[0])
                        r["qty"] = round(q0 * n_self, 4)
                        r["_pm_applied"] = n_self
                        r["_pm_note"] = "× %d шт (расход на 1 шт, множитель в самой строке): %g × %d = %g%s" % (
                            n_self, q0, n_self, r["qty"],
                            (" · ⚠ примечание ВОРа не сходится ни с умноженным, ни с исходным — сверить" if ambig0 else ""))
                        n_applied += 1
                        continue
        m = _PARENT_MULT_RE.search(st) or _PM_TRIGGER_ALT.search(st)
        n = int(m.group(1)) if m else node_counts.get(i)
        if not n or not (1 < n <= 9999):
            continue
        nm = r.get("name") or ""
        if _is_nested_node(nm) and i not in node_counts:
            continue
        if _PM_GROUND_GUARD.search(_low(nm)):
            r["_pm_note"] = ("× %d НЕ применён: самостоятельная площадная/земляная работа под узловым "
                             "заголовком — объём независим, оператору проверить" % n)
            continue
        q = _pm_qnum(r.get("qty"))
        if q is None:
            continue
        rt = _pm_ready_total(r)
        if rt and _pm_near(q * rt[1], rt[0]):
            r["_pm_note"] = ("× %d НЕ применён: итог задан в примечании ВОРа (%g = %g × %g) — "
                             "объём строки уже итоговый" % (n, q * rt[1], q, rt[1]))
            continue
        ambig = bool(rt) and not _pm_near(q * n * rt[1], rt[0])
        r["qty"] = round(q * n, 4)
        r["_pm_applied"] = n
        r["_pm_note"] = "× %d шт (%s): %g × %d = %g%s" % (
            n, ("счётчик узла в строке ВОР" if i in node_counts and not m else "расход дан на 1 шт"),
            q, n, r["qty"],
            (" · ⚠ примечание ВОРа не сходится ни с умноженным, ни с исходным — сверить" if ambig else ""))
        n_applied += 1
    return rows, n_applied


#
def _graph_companion_stacks():
    """IISMETA cost-estimation engine module."""
    try:
        import json as _j
        _p = os.path.join(os.path.dirname(__file__), "data", "tech_graph.json")
        edges = _j.load(open(_p, encoding="utf-8")).get("edges", []) or []
    except Exception:
        return []
    by_fin = {}
    for e in edges:
        if not (e.get("expand") and e.get("type") == "precedes" and e.get("from") and e.get("to")):
            continue
        by_fin.setdefault(e["from"], []).append(e)
    out = []
    for fin, es in by_fin.items():
        out.append({
            "when_table": [fin],
            "add": [{"table": e["to"], "role": e.get("role", "?"),
                     "note": e.get("method") or e.get("op") or "прип-передел"} for e in es],
            "source": "tech_graph:" + (es[0]["provenance"][0] if es[0].get("provenance") else "НТД"),
        })
    return out


def _load_decomp_templates():
    """IISMETA cost-estimation engine module."""
    stacks = _graph_companion_stacks()
    try:
        import json as _j
        _p = os.path.join(os.path.dirname(__file__), "data", "decompose_templates.json")
        stacks = stacks + (_j.load(open(_p, encoding="utf-8")).get("companion_stacks", []) or [])
    except Exception:
        pass
    return stacks


_DECOMP_TEMPLATES = _load_decomp_templates()


def _area_key(q):
    """IISMETA cost-estimation engine module."""
    try:
        return round(float(q), 1)
    except (TypeError, ValueError):
        return None


_CMP_STEMS = (r"штукатур|окрас|покрас|краск|шпатл|шпакл|грунтов|облицов|отделк|побелк|"
              r"затирк|шлифов|пропитк|стяжк|гидроизол|утеплен|плитк")
_CMP_OPS = (r"Облицовк|Окраск|Покраск|Оштукатурив|Штукатурк|Шпаклевк|Шпатлевк|Грунтовк|Затирк|"
            r"Побелк|Отделк|Устройств|Укладк|Монтаж|Гидроизоляц|Утеплен|Шлифов|Стяжк")
_CMP_SEP = re.compile(r"\s*[;·•]\s*|\s*\n\s*"
                      r"|(?<=[а-яё0-9\)])\.\s+(?=[А-ЯЁ])"
                      r"|(?<=[а-яё])\s+(?=(?:%s)\w*\s)"
                      r"|\s+[Сс]\s+последующ\w*\s+" % _CMP_OPS)
_CMP_HYP = re.compile(r"(?<=[а-яё])-(?=[а-яё]{2,})")
_CMP_WORK = re.compile(_CMP_STEMS, re.I)
_CMP_MAX = 3


def _cmp_name_section(work_text):
    """IISMETA cost-estimation engine module."""
    m = re.match(r"^(.*)\s\((.*)\)$", work_text or "", re.S)
    return (m.group(1), m.group(2)) if m else ((work_text or ""), None)


def compound_parts(name):
    """IISMETA cost-estimation engine module."""
    parts = [p.strip(" .,-–—:") for p in _CMP_SEP.split(_CMP_HYP.sub("", name or ""))]
    parts = [p for p in parts if len(p) >= 5 and _CMP_WORK.search(p)]
    return parts if len(parts) >= 2 else []


def apply_compound_split(works):
    """IISMETA cost-estimation engine module."""
    present = set()
    for w in works:
        a = _area_key(w.get("qty"))
        if a is None:
            continue
        if w.get("table"):
            present.add((a, w["table"]))
        for c in (w.get("companions") or []):
            if c.get("table"):
                present.add((a, c["table"]))
    n_added = 0
    for w in works:
        a = _area_key(w.get("qty"))
        if a is None:
            continue
        nm, sec = _cmp_name_section(w.get("work") or "")
        parts = compound_parts(nm)
        if not parts:
            continue
        added_here = 0
        _low_nm = _low(nm)
        _paint_here = bool(re.search(r"окрас|покрас|краск", _low_nm))
        for p in parts:
            if added_here >= _CMP_MAX:
                break
            if absorb_check(p):
                continue
            if _paint_here and re.search(r"грунтов", _low(p)) and not re.search(r"адгезион|бетонконтакт", _low(p)):
                continue
            got = route_row(p, sec)
            if not got:
                continue
            atab = got[1]
            if not atab or (a, atab) in present:
                continue
            w.setdefault("companions", []).append({
                "table": atab, "work": "%s — слой: %s" % (nm[:40], p[:60]),
                "qty": w.get("qty"), "unit": w.get("unit") or "м2", "params": {},
                "rule": "компаунд-строка←%s" % (w.get("table") or "?"), "children": [],
                "role": "слой", "_derived": True, "_compound": True, "alt_tables": []})
            present.add((a, atab))
            n_added += 1
            added_here += 1
    return works, n_added


_FIN_TABS = {
    "15-02-039": re.compile(r"окрас|покрас|краск|облицов\w*\s+плитк|плитк\w*\s+керамическ"),
}


#
#
#
#
_BLK_AREA_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*м\s*[2²]")
_BLK_BINS = ((2.0, "01"), (3.0, "02"), (5.0, "03"), (10.0, "04"))
_BLK_TABLE, _BLK_TABLE_TWIN = "10-01-036", "10-01-034"


def _blk_variant(area_one):
    for lim, v in _BLK_BINS:
        if area_one <= lim:
            return v
    return None


def derive_block_installation(material_direct, rows):
    """IISMETA cost-estimation engine module."""
    buckets = {}
    pvh = False
    for md in material_direct:
        nm = md.get("name") or ""
        if not (_MD_GLAZING_CODE.search(_low(nm)) or _MD_GLAZING_FORMULA.search(_low(nm))):
            continue
        i = md.get("i")
        r = rows[i] if (isinstance(i, int) and 0 <= i < len(rows)) else {}
        q = _pm_qnum(r.get("qty"))
        m = _BLK_AREA_RE.search(nm)
        if not m or not q or q <= 0:
            continue
        area_one = float(m.group(1).replace(",", "."))
        v = _blk_variant(area_one) if area_one > 0 else None
        if not v:
            continue
        pvh = pvh or ("пвх" in _low(nm))
        b = buckets.setdefault(v, {"area": 0.0, "n": 0, "one": area_one,
                                   "sec": md.get("section_title"), "host": md})
        b["area"] += area_one * q
        b["n"] += int(q)
    table = _BLK_TABLE_TWIN if pvh else _BLK_TABLE

    out = []
    for v, b in sorted(buckets.items()):
        lim = next(l for l, vv in _BLK_BINS if vv == v)
        out.append({
            "table": table,
            "work": ("Установка оконных блоков (на 1шт-%g м2, %d бл., %s м2) — derived-позиция "
                     "от блоков-материалов, полоса «до %g м2»"
                     % (b["one"], b["n"], ("%.4f" % b["area"]).rstrip("0").rstrip("."), lim)),
            "qty": round(b["area"], 4), "unit": "м2", "params": {},
            "rule": "derived-block-install", "children": [], "role": "установка",
            "_derived": True,
            "section_title": b["sec"],
            "_host_md": b["host"]})
    return out


def apply_companion_stacks(works):
    """IISMETA cost-estimation engine module."""
    if not _DECOMP_TEMPLATES:
        return works, 0
    present = set()
    for w in works:
        a = _area_key(w.get("qty"))
        if a is not None and w.get("table"):
            present.add((a, w["table"]))
        for c in (w.get("companions") or []):
            if a is not None and c.get("table"):
                present.add((a, c["table"]))
    n_added = 0
    for w in works:
        a = _area_key(w.get("qty"))
        if a is None:
            continue
        tab, role = w.get("table"), w.get("role")
        for tpl in _DECOMP_TEMPLATES:
            if tab not in tpl.get("when_table", []) and role not in tpl.get("when_role", []):
                continue
            wt = tpl.get("when_text")
            if wt and not re.search(wt, _low(w.get("work") or "")):
                continue
            for add in tpl.get("add", []):
                atab = add.get("table")
                if not atab or (a, atab) in present:
                    continue
                if _FIN_TABS.get(atab) and _FIN_TABS[atab].search(_low(w.get("work") or "")):
                    continue
                w.setdefault("companions", []).append({
                    "table": atab,
                    "work": "%s — %s" % (w.get("work", ""), add.get("note") or add.get("role") or "доп.слой"),
                    "qty": w.get("qty"), "unit": w.get("unit") or "м2", "params": {},
                    "rule": "decompose-stack←%s" % (tab or role), "children": [],
                    "role": add.get("role", "?"), "_derived": True,
                    "alt_tables": list(add.get("alt_tables") or [])})
                present.add((a, atab))
                n_added += 1
    return works, n_added


_SYN_PATH = os.path.join(os.path.dirname(__file__), "data", "material_synonyms.json")
_SYN_CACHE = None


def _material_synonyms():
    """IISMETA cost-estimation engine module."""
    global _SYN_CACHE
    if _SYN_CACHE is None:
        out = []
        try:
            with open(_SYN_PATH, encoding="utf-8") as fh:
                for s in (json.load(fh).get("synonyms") or []):
                    pat, rep = s.get("pattern"), s.get("replace")
                    if pat and rep:
                        out.append((re.compile(pat, re.I), rep))
        except Exception:
            out = []
        _SYN_CACHE = out
    return _SYN_CACHE


def _apply_synonyms(text):
    """IISMETA cost-estimation engine module."""
    out = text or ""
    for rx, rep in _material_synonyms():
        out = rx.sub(rep, out)
    return out


_PIE_LABEL = re.compile(r"(?:^|[;.·•]\s*)([А-ЯЁ][а-яё]{4,})\s*:")


_LOST_HEAD_WORDS = {"кровля", "кровли", "отмостка"}


def _lost_section_head(name):
    """IISMETA cost-estimation engine module."""
    toks = (name or "").split()
    if len(toks) < 2:
        return None
    w = toks[0].strip(".,;:-–—").lower().replace("ё", "е")
    return w if w in _LOST_HEAD_WORDS else None


def _pie_head(name):
    """IISMETA cost-estimation engine module."""
    s = name or ""
    labs = _PIE_LABEL.findall(s)
    if len(labs) < 2:
        return None
    head = _PIE_LABEL.split(s)[0].strip(" ;.,·•-–")
    return head if len(head) >= 12 else None


_RX_FINISH_OP = re.compile(r"окрас|покрас|штукатур|облицовк|грунтовк|шпа[тк]л|затирк|шлифовк")


def _route_plain(text):
    """IISMETA cost-estimation engine module."""
    for key in CATALOG_ORDER:
        lookup_fn, _ = REGISTRY[key]
        tab = lookup_fn(text)
        if tab:
            return key, tab
    return None


def route_row(name, section_title=None):
    """IISMETA cost-estimation engine module."""
    name = _pie_head(name) or name
    lost = _lost_section_head(name)
    if lost:
        section_title = lost
    combined = ("%s (%s)" % (name, section_title)) if section_title else name
    if section_title:
        st_low = _low(section_title)
        for pat, key in SECTION_HINTS:
            if re.search(pat, st_low):
                lookup_fn, _ = REGISTRY[key]
                tab = lookup_fn(combined)
                if tab:
                    if _sec_is_really_row(section_title) and not lookup_fn(name):
                        own = _route_plain(name)
                        if own and own[0] != key:
                            return own
                    return key, tab
                syn_c = _apply_synonyms(combined)
                if syn_c != combined:
                    tab = lookup_fn(syn_c)
                    if tab:
                        return key, tab
                if _RX_FINISH_OP.search(_low(name)):
                    hit = _route_plain(name)
                    if hit:
                        return hit
                break
    for key in CATALOG_ORDER:
        lookup_fn, _ = REGISTRY[key]
        tab = lookup_fn(combined)
        if tab:
            return key, tab
    syn = _apply_synonyms(combined)
    if syn != combined:
        for key in CATALOG_ORDER:
            lookup_fn, _ = REGISTRY[key]
            tab = lookup_fn(syn)
            if tab:
                return key, tab
    return None


_RX_SEC_GABARIT = re.compile(r"\d\s*[хx]\s*\d")
_RX_NODE_DOC_TOTAL = re.compile(r"общ[\w.]*\s*(?:вес)?\s*[-:—]?\s*\d", re.I)

#
_RX_OGRAZH_WORD = re.compile(r"тонколист|профнастил|профилирован\w*\s+лист|алюкобонд|"
                             r"металлочерепиц|сэндвич[-\s]?панел")
_RX_SHEET_THICK = re.compile(r"(?:толщ[а-я.]*|[tтδб]\s*=)\s*(\d+(?:[.,]\d+)?)\s*(?:мм)?"
                             r"|[-–]\s*(\d+(?:[.,]\d+)?)\s*мм")
_RX_SHEET_WORD = re.compile(r"лист|сталь|оцинков")


def _is_ograzhdayushchaya(name):
    """IISMETA cost-estimation engine module."""
    low = _low(name)
    if re.search(r"водосточн|лоток|лотк|желоб|жёлоб|\bтруб", low):
        return False
    if _RX_OGRAZH_WORD.search(low):
        return True
    m = _RX_SHEET_THICK.search(low)
    if not m or not _RX_SHEET_WORD.search(low):
        return False
    try:
        v = m.group(1) or m.group(2)
        return float(v.replace(",", ".")) <= 1.0
    except (ValueError, AttributeError):
        return False


def _sec_is_really_row(section_title):
    """IISMETA cost-estimation engine module."""
    return bool(_RX_SEC_GABARIT.search(_low(section_title)))


def _restore_lost_sections(rows):
    """IISMETA cost-estimation engine module."""
    cur = None
    for r in rows:
        st = r.get("section_title")
        nm = r.get("name") or ""
        lost = _lost_section_head(nm)
        if lost:
            hit = route_row(nm, lost)
            cur = (lost, st, hit[0]) if hit else None
            if cur:
                r["section_title"] = lost
            continue
        if not cur:
            continue
        if st != cur[1]:
            cur = None
            continue
        hit = route_row(nm, cur[0])
        if not hit or hit[0] != cur[2]:
            cur = None
            continue
        r["section_title"] = cur[0]
    return rows


def route_rows(rows):
    """IISMETA cost-estimation engine module."""
    routed = []   # (orig_i, sbornik_key, row)
    unrouted = []
    absorbed = []
    material_direct = []
    _restore_lost_sections(rows)
    for r in rows:
        head = _pie_head(r.get("name") or "")
        if head:
            r["_pie_full"], r["name"] = r["name"], head
            if (r.get("raw") or "").strip():
                r["_pie_full_raw"] = r["raw"]
                r["raw"] = _pie_head(r["raw"]) or head
    for i, r in enumerate(rows):
        nm = r.get("name", "")
        if not nm.strip():
            continue
        if rebar_by_unit(nm, r.get("unit")):
            absorbed.append({"i": i, "name": nm,
                             "reason": "армирование бетона по весу стали (кг/т) — расход арматуры в "
                                       "составе плиты/каркаса; отдельная норма армирования в тоннах по "
                                       "проекту/спецификации, не объём бетонной подготовки",
                             "section_title": r.get("section_title"), "parent": None,
                             "_rebar_dedup": bool(_TWO_MESH_RE.search(_low(nm)))})
            continue
        reason = absorb_check(nm)
        if reason:
            absorbed.append({"i": i, "name": nm, "reason": reason,
                             "section_title": r.get("section_title"), "parent": None,
                             "kind": absorb_kind(nm)})
            continue
        md_reason = material_direct_check(nm, r.get("section_title"))
        if md_reason:
            material_direct.append({"i": i, "name": nm, "reason": md_reason,
                                    "section_title": r.get("section_title")})
            continue
        raw = (r.get("raw") or "").strip()
        used_raw = False
        hit = None
        if raw and raw != nm:
            hit = route_row(raw, r.get("section_title"))
            used_raw = hit is not None
        if hit is None:
            hit = route_row(nm, r.get("section_title"))
        if hit is None:
            md_reason = material_direct_node_check(nm, r.get("section_title"))
            if md_reason:
                material_direct.append({"i": i, "name": nm, "reason": md_reason,
                                        "section_title": r.get("section_title")})
            else:
                unrouted.append({"i": i, "name": nm, "section_title": r.get("section_title")})
            continue
        key, _tab = hit
        row_eff = dict(r, name=raw) if used_raw else r
        eff_name = row_eff.get("name", "")
        syn_name = _apply_synonyms(eff_name)
        if syn_name != eff_name:
            lookup_fn, _ = REGISTRY[key]
            st = row_eff.get("section_title")
            _c = ("%s (%s)" % (eff_name, st)) if st else eff_name
            _s = ("%s (%s)" % (syn_name, st)) if st else syn_name
            if not lookup_fn(_c) and lookup_fn(_s):
                row_eff = dict(row_eff, name=syn_name)
        routed.append((i, key, row_eff))

    for a in absorbed:
        prev = next((r for ri, _k, r in reversed(routed)
                     if ri < a["i"] and r.get("section_title") == a["section_title"]), None)
        nxt = next((r for ri, _k, r in routed
                    if ri > a["i"] and r.get("section_title") == a["section_title"]), None)
        parent = prev or nxt
        if parent is not None:
            a["parent"] = parent.get("name")

    _node_secs = {r.get("section_title") for r in rows
                  if r.get("section_title") and (_PARENT_MULT_RE.search(r["section_title"])
                                                 or _PM_TRIGGER_ALT.search(r["section_title"]))}
    for r in rows:
        st = r.get("section_title")
        if not st or st in _node_secs:
            continue
        _sib = [x for x in rows if x.get("section_title") == st]
        _mass = [x for x in _sib
                 if _pm_qnum(x.get("qty")) is not None and _low(x.get("unit") or "").startswith("кг")]
        if len(_mass) < 2:
            continue
        _kinds = [absorb_kind(x.get("name") or "") for x in _mass]
        if "узел" not in _kinds:
            continue
        if "норма" in _kinds:
            continue
        if any(_RX_NODE_DOC_TOTAL.search(str(x.get("doc_note") or "")) for x in _sib):
            continue
        _node_secs.add(st)
    for st in _node_secs:
        idxs = [i for i, r in enumerate(rows) if r.get("section_title") == st]
        mass = []
        for i in idxs:
            r = rows[i]
            u = _low(r.get("unit") or "")
            q = _pm_qnum(r.get("qty"))
            if q is None or not u.startswith("кг"):
                continue
            if _is_ograzhdayushchaya(r.get("name") or ""):
                if not any(a["i"] == i for a in absorbed):
                    absorbed.append({
                        "i": i, "name": r.get("name") or "",
                        "reason": "ограждающая конструкция (покрытие) — в объём монтажа "
                                  "каркаса не входит, ШНК 4.02.09-04 п.2.3; учитывается своей "
                                  "нормой покрытия по площади",
                        "section_title": st, "parent": None, "kind": "норма"})
                routed[:] = [t for t in routed if t[0] != i]
                material_direct[:] = [m for m in material_direct if m["i"] != i]
                continue
            mass.append((i, q))
        if len(mass) < 2:
            continue
        host_i = next((i for i, _k, r in routed
                       if i in {m[0] for m in mass}), None)
        if host_i is None:
            continue
        total = sum(q for _i, q in mass)
        own = rows[host_i].get("_qty_own")
        if own is None:
            rows[host_i]["_qty_own"] = _pm_qnum(rows[host_i].get("qty"))
        rows[host_i]["qty"] = round(total, 4)
        rows[host_i]["_node_sum"] = "узел «%s»: %s = %g кг" % (
            st[:40], " + ".join("%g" % q for _i, q in mass), total)
        for i, q in mass:
            if i == host_i:
                continue
            _prev_abs = next((a for a in absorbed if a["i"] == i), None)
            if _prev_abs is not None:
                _prev_abs["node_absorbed"] = True
            else:
                absorbed.append({"i": i, "name": rows[i].get("name") or "",
                                 "reason": "масса учтена в узле «%s» (сумма дочек = %g кг)" % (st[:36], total),
                                 "section_title": st, "parent": rows[host_i].get("name"),
                                 "node_absorbed": True})
            routed[:] = [t for t in routed if t[0] != i]
            material_direct[:] = [m for m in material_direct if m["i"] != i]

    works = []
    groups = []
    gi = 0
    while gi < len(routed):
        key = routed[gi][1]
        gj = gi
        while gj < len(routed) and routed[gj][1] == key:
            gj += 1
        chunk_rows = [
            (dict(r, name="%s (%s)" % (r.get("name", ""), r["section_title"]))
             if r.get("section_title") else r)
            for r in (routed[k][2] for k in range(gi, gj))
        ]
        _lookup_fn, decompose_fn = REGISTRY[key]
        chunk_works = decompose_fn(chunk_rows)
        for w in chunk_works:
            w["sbornik"] = key
        works.extend(chunk_works)
        groups.append((key, len(chunk_rows)))
        gi = gj

    rebar_secs = {a.get("section_title") for a in absorbed
                  if a.get("_rebar_dedup") and a.get("section_title")}
    if rebar_secs:
        for w in works:
            comps = w.get("companions")
            if not comps:
                continue
            wname = w.get("work", "")
            if any(wname.endswith("(%s)" % s) for s in rebar_secs):
                w["companions"] = [c for c in comps if c.get("table") != "06-01-015"]
                if not w["companions"]:
                    w.pop("companions", None)

    apply_compound_split(works)

    apply_companion_stacks(works)

    #
    for md in material_direct:
        md.pop("companions", None)
    for w in derive_block_installation(material_direct, rows):
        host = w.pop("_host_md", None)
        if host is not None:
            host.setdefault("companions", []).append(w)

    for r in rows:
        full = r.get("_pie_full")
        if not full:
            continue
        head_txt = (r.get("name") or "")[:40]
        host = next((w for w in works if (w.get("work") or "").startswith(head_txt)), None)
        if host is None:
            continue
        seen = {host.get("table")}
        marks = list(_PIE_LABEL.finditer(full))
        for k, m in enumerate(marks):
            end = marks[k + 1].start() if k + 1 < len(marks) else len(full)
            seg = full[m.start():end].strip(" ;.,:·•-–")
            if len(seg) < 6:
                continue
            hit = route_row(seg, r.get("section_title"))
            if not hit or hit[1] in seen:
                continue
            seen.add(hit[1])
            host.setdefault("companions", []).append(
                {"table": hit[1], "work": seg[:80], "qty": host.get("qty"),
                 "unit": host.get("unit"), "params": {},
                 "rule": "слой пирога-строки (та же площадь, что у ведущей работы)"})

    for r in rows:
        if r.get("_pie_full"):
            r["name"] = r.pop("_pie_full")
        if r.get("_pie_full_raw"):
            r["raw"] = r.pop("_pie_full_raw")

    return {"works": works, "unrouted": unrouted, "absorbed": absorbed,
            "material_direct": material_direct, "groups": groups}


def match_rows(rows):
    """IISMETA cost-estimation engine module."""
    res = route_rows(rows)
    absorbed_by_i = {a["i"]: a for a in res["absorbed"]}
    unrouted_by_i = {u["i"]: u for u in res["unrouted"]}
    md_by_i = {m["i"]: m for m in res["material_direct"]}
    works_pool = list(res["works"])
    consumed_children = {}
    for w in res["works"]:
        for ch in (w.get("children") or []):
            consumed_children[ch] = w

    out = []
    for i, r in enumerate(rows):
        nm = (r.get("name") or "").strip()
        if not nm:
            out.append({"status": "empty", "work": None, "reason": None})
            continue
        if i in absorbed_by_i:
            a = absorbed_by_i[i]
            out.append({"status": "absorbed", "work": None,
                        "reason": a["reason"], "parent": a.get("parent"),
                        "node_absorbed": bool(a.get("node_absorbed")),
                        "absorb_kind": a.get("kind")})
            continue
        if i in md_by_i:
            out.append({"status": "material_direct", "work": None,
                        "reason": md_by_i[i]["reason"],
                        "companions": md_by_i[i].get("companions") or []})
            continue
        if i in unrouted_by_i:
            out.append({"status": "unrouted", "work": None,
                        "reason": "не опознана словарём сборников — оператору"})
            continue
        nm_key = _pie_head(nm) or nm
        combined = ("%s (%s)" % (nm_key, r["section_title"])) if r.get("section_title") else nm_key
        w = next((w for w in works_pool if w.get("work") == combined), None)
        if w is None:
            raw = (r.get("raw") or "").strip()
            if raw and raw != nm:
                combined_raw = ("%s (%s)" % (raw, r["section_title"])) if r.get("section_title") else raw
                w = next((w for w in works_pool if w.get("work") == combined_raw), None)
            if w is None:
                for base in (nm, raw):
                    if not base:
                        continue
                    syn = _apply_synonyms(base)
                    if syn == base:
                        continue
                    combined_syn = ("%s (%s)" % (syn, r["section_title"])) if r.get("section_title") else syn
                    w = next((w for w in works_pool if w.get("work") == combined_syn), None)
                    if w is not None:
                        break
        if w is not None:
            works_pool.remove(w)
            out.append({"status": "work", "work": w, "reason": None})
        elif combined in consumed_children:
            par = consumed_children[combined]
            out.append({"status": "consumed", "work": None,
                        "reason": "в составе работы по БД ШНК (свёртка)", "parent": par.get("work")})
        else:
            out.append({"status": "unrouted", "work": None,
                        "reason": "каталог опознал, decompose не разложил — оператору"})
    return out
