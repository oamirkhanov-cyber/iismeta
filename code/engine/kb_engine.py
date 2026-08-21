# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
import os
import re
import sqlite3
import threading

HERE = os.path.dirname(os.path.abspath(__file__))


def _db_path():
    p = os.environ.get("KB_DB_PATH")
    if p and os.path.exists(p):
        return p
    for cand in (
        os.path.join(HERE, "..", "0_БД_расценок", "smeta_kb.sqlite"),
        "/tmp/etalon/db/smeta_kb.sqlite",
    ):
        if os.path.exists(cand):
            return cand
    raise FileNotFoundError("smeta_kb.sqlite не найден (задай KB_DB_PATH)")


SBORNIK_LABEL = "Полная база расценок · все виды работ (Е/Ц/У)"

_TCH = None
_re_sb = re.compile(r"Сборник\s+(\d+)")


def _techchasti():
    global _TCH
    if _TCH is None:
        import json as _j
        try:
            _TCH = _j.load(open(os.path.join(HERE, "..", "0_БД_расценок", "techchasti.json"),
                                encoding="utf-8")).get("техчасти", {})
        except Exception:
            _TCH = {}
    return _TCH


_TDOCS = None


def _techdocs():
    global _TDOCS
    if _TDOCS is None:
        import json as _j
        try:
            _TDOCS = _j.load(open(os.path.join(HERE, "..", "0_БД_расценок", "techdocs",
                                               "techdocs_index.json"), encoding="utf-8"))
        except Exception:
            _TDOCS = {}
    return _TDOCS


def _tch_chapter_key(vid_name):
    n = (vid_name or "")
    if n.startswith("Строит"):
        return "стр"
    if "монтаж" in n:
        return "монт"
    if n.startswith("Ремонт"):
        return "рем"
    if n.startswith("Пускон"):
        return "пнр"
    if n.startswith("Рестав"):
        return "рест"
    return ""

_local = threading.local()


def _conn():
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect("file:%s?mode=ro" % _db_path(), uri=True, check_same_thread=False)
        _local.conn = c
    return c


def nunit(u):
    u = re.sub(r"\s+", " ", str(u or "")).strip().lower()
    return u.replace("м3", "м³").replace("м2", "м²")


def _num(s):
    m = re.search(r"\d+(?:[.,]\d+)?", str(s or ""))
    return float(m.group(0).replace(",", ".")) if m else 0.0


def _sentence(s):
    s = str(s or "").strip()
    return (s[0] + s[1:].lower()) if s.isupper() else s


def _res_name(rtype, subtype, name):
    if rtype == "труд":
        nm = _sentence(name)
        if nm:
            return nm
        if "машин" in (subtype or "").lower():
            return "Затраты труда машинистов"
        return "Затраты труда рабочих-строителей"
    return _sentence(name)


_INDEX = None
_INDEX_LOCK = threading.Lock()


def _build_index():
    """IISMETA cost-estimation engine module."""
    cur = _conn().cursor()
    sbor = {}
    for code, name in cur.execute("SELECT code,name FROM tree WHERE level=3"):
        s = code.split("-")
        if len(s) >= 3:
            sbor[(s[1], s[2])] = name.strip()
    razd = {}
    for code, name in cur.execute("SELECT code,name FROM tree WHERE level=5"):
        s = code.split("-")
        if len(s) >= 5:
            razd[(s[1], s[2], s[3], s[4])] = name.strip()
    tbl_name = {}
    for code, shnk, name in cur.execute("SELECT code,shnk_table,name FROM tree WHERE level=7"):
        if shnk and code:
            prefix = code[0]
            key = (prefix, shnk)
            if key not in tbl_name:
                tbl_name[key] = re.sub(r"^Таблица\s+[\d-]+\s*", "", name or "").strip()

    ncols = [r[1] for r in cur.execute("PRAGMA table_info(norms)")]
    has_popr = "popr_raw" in ncols
    has_ref = "izmeritel_norm" in ncols and "variant" in ncols
    cols = "code,name,unit,base,tcode,shnk_table" + (",popr_raw" if has_popr else "") + (",izmeritel_norm,variant" if has_ref else "")
    works = {}
    for row in cur.execute("SELECT %s FROM norms WHERE tcode!=''" % cols):
        code, name, unit, base, tcode, shnk = row[:6]
        popr = (row[6] if has_popr else "") or ""
        izm_norm = (row[7 if has_popr else 6] if has_ref else "") or ""
        variant = (row[8 if has_popr else 7] if has_ref else "") or ""
        s = tcode.split("-")
        if len(s) < 8:
            continue
        g, sb, pg, rz = s[1], s[2], s[3], s[4]
        tkey = "-".join(s[:7])
        prefix = code[0] if code else "Е"
        w = works.get(tkey)
        if w is None:
            w = {"work_code": tkey, "vid": tbl_name.get((prefix, shnk), "") or (name or "").strip(),
                 "izmeritel": "", "shnk_table": shnk, "series": prefix,
                 "razdel": sbor.get((g, sb), "Сборник %s" % sb),
                 "podrazdel": razd.get((g, sb, pg, rz), "—"), "n_var": 0, "varianty": []}
            works[tkey] = w
        u = nunit(unit)
        w["varianty"].append({"code": code, "shifr": (base or code).replace(" СРН", "").strip(),
                              "base": (base or code).strip(), "popr_raw": popr or "",
                              "name": (name or "").strip(), "unit": u,
                              "izm_norm": izm_norm, "variant": variant})
        if not w["izmeritel"] and u:
            w["izmeritel"] = u
        if not w["shnk_table"] and shnk:
            w["shnk_table"] = shnk

    out = {}
    for wc, w in works.items():
        if not w["varianty"]:
            continue
        canon = w["izmeritel"] or next((v["unit"] for v in w["varianty"] if v["unit"]), "1")
        w["izmeritel"] = canon
        for v in w["varianty"]:
            if not v["unit"]:
                v["unit"] = canon
        w["n_var"] = len(w["varianty"])
        out[wc] = w
    try:
        import perevozka_kb as _pvz
        out.update(_pvz.works())
    except Exception:
        pass
    return out


def _index():
    global _INDEX
    if _INDEX is None:
        with _INDEX_LOCK:
            if _INDEX is None:
                _INDEX = _build_index()
    return _INDEX


def _load():
    return _index()


_TREE_NESTED = None
_TREE_LOCK = threading.Lock()


def _build_tree_nested():
    cur = _conn().cursor()
    nm = {2: {}, 3: {}, 4: {}, 5: {}, 6: {}}
    for lv in (2, 3, 4, 5, 6):
        for code, name in cur.execute("SELECT code,name FROM tree WHERE level=?", (lv,)):
            nm[lv][code] = (name or "").strip()
    from collections import OrderedDict
    roots = OrderedDict()
    for wc, w in sorted(_index().items(), key=lambda kv: kv[1]["work_code"]):
        s = w["work_code"].split("-")
        if len(s) < 7:
            continue
        g, sb, pg, rz, pr = s[1], s[2], s[3], s[4], s[5]
        vid_code = "01-%s-00-00-00-00-000-00" % g
        path = [
            ("Вид", vid_code),
            ("Сборник", "01-%s-%s-00-00-00-000-00" % (g, sb)),
        ]
        if pg != "00":
            path.append(("Подгруппа", "01-%s-%s-%s-00-00-000-00" % (g, sb, pg)))
        if rz != "00":
            path.append(("Раздел", "01-%s-%s-%s-%s-00-000-00" % (g, sb, pg, rz)))
        if pr != "00":
            path.append(("Подраздел", "01-%s-%s-%s-%s-%s-000-00" % (g, sb, pg, rz, pr)))
        cur_children = roots
        for kind, code in path:
            lv = {"Вид": 2, "Сборник": 3, "Подгруппа": 4, "Раздел": 5, "Подраздел": 6}[kind]
            grp = cur_children.get(code)
            if grp is None:
                grp = {"kind": kind, "name": nm[lv].get(code, kind), "_ch": OrderedDict()}
                cur_children[code] = grp
            cur_children = grp["_ch"]
        cur_children[wc] = {"leaf": True, "code": wc, "name": w["vid"], "shnk": w.get("shnk_table", ""),
                            "izm": w["izmeritel"], "n": w["n_var"]}

    def to_list(d, chk=""):
        out = []
        for v in d.values():
            if v.get("leaf"):
                out.append({"code": v["code"], "name": v["name"], "shnk": v.get("shnk", ""),
                            "izm": v["izm"], "n": v["n"], "leaf": True})
            else:
                chk2 = _tch_chapter_key(v["name"]) if v["kind"] == "Вид" else chk
                ch = to_list(v["_ch"], chk2)
                if v["kind"] == "Сборник":
                    m = _re_sb.search(v["name"] or "")
                    key = ("%s|%s" % (chk2, m.group(1).zfill(2))) if (m and chk2) else ""
                    docs = _techdocs().get(key) if key else None
                    if docs:
                        tps = [{"kind": "ТехЧасть", "name": d["title"], "techpart": True, "leaf": True,
                                "doc": d["file"], "dk": d["kind"], "text": ""} for d in docs]
                    elif key and key in _techchasti():
                        tps = [{"kind": "ТехЧасть", "name": "Техническая часть", "techpart": True,
                                "leaf": True, "tp": key, "text": ""}]
                    else:
                        tps = [{"kind": "ТехЧасть", "name": "Техническая часть", "techpart": True, "leaf": True,
                                "text": "Техническая часть сборника «%s» (ШНК). Текст будет добавлен." % v["name"]}]
                    ch = tps + ch
                out.append({"kind": v["kind"], "name": v["name"], "children": ch})
        return out
    result = to_list(roots)
    try:
        import perevozka_kb as _pvz
        node = _pvz.tree_node()
        if node and "стр|00" in _techchasti():
            for c in node.get("children", []):
                if c.get("techpart"):
                    c["tp"] = "стр|00"; c["text"] = ""
                    break
        if node:
            for item in result:
                if item.get("kind") == "Вид" and "01-01-" in item.get("name", "").lower() or \
                   item.get("kind") == "Вид" and "Строит" in item.get("name", ""):
                    item["children"].insert(0, node)
                    break
            else:
                result.insert(0, node)
    except Exception:
        pass
    return result


def tree_nested():
    global _TREE_NESTED
    if _TREE_NESTED is None:
        with _TREE_LOCK:
            if _TREE_NESTED is None:
                _TREE_NESTED = _build_tree_nested()
    return _TREE_NESTED


# ══════════════════════════════════════════════════════════════════════════════
#
# ══════════════════════════════════════════════════════════════════════════════

_AX = [
    ("kovsh",  "Ёмкость ковша, м³",     r"ковш\w*\s+(?:вместимость\w*|емкость\w*)\s+(до\s+)?([\d.,]+(?:\s*[-–]\s*[\d.,]+)?)", "list"),
    ("moshch", "Мощность",              r"мощност\w*[\s:]+([\d]+(?:\s*[\[\(]\s*[\d]+\s*[\]\)])?)\s*(?:кВт|л\.?\s?с)", "list"),
    ("obem",   "Объём",                 r"объ[её]м\w*\s+((?:до|от|свыше)\s+[\d ]+(?:\s*до\s*[\d ]+)?\s*м3)", "list"),
    ("shir",   "Ширина",                r"ширин\w*[^,]*?([\d.,]+\s*(?:[-–]\s*[\d.,]+\s*)?м)\b", "list"),
    ("glubina","Глубина",               r"глубин\w*[^,]*?([\d.,]+\s*(?:[-–]\s*[\d.,]+\s*)?м)\b", "list"),
    ("vys",    "Высота",                r"высот\w*[^,]*?([\d.,]+\s*(?:[-–]\s*[\d.,]+\s*)?м)\b", "list"),
    ("tolsh",  "Толщина",               r"толщин\w*(?:\s+слоя|\s+покрытия)?\s+(?:до\s+)?([\d.,]+\s*(?:мм|см|м)\b)", "list"),
    ("diam",   "Диаметр",               r"диаметр\w*\s+(?:до\s+)?([\d.,]+(?:\s*[-–]\s*[\d.,]+)?\s*(?:мм|см|м)\b)", "list"),
    ("sech",   "Сечение / площадь",     r"сечени\w*[^,]*?([\d.,]+(?:\s*[хx×*]\s*[\d.,]+)?\s*(?:мм2|см2|мм|м)\b)", "list"),
    ("razmer", "Размер",                r"размер\w*[^,]*?([\d.,]+\s*[хx×*]\s*[\d.,]+(?:\s*[хx×*]\s*[\d.,]+)?\s*(?:мм|см|м)?)", "list"),
    ("massa",  "Масса / грузоподъёмность", r"(?:масс\w*|грузоподъ[её]мност\w*)[^,]*?(до\s+)?([\d.,]+(?:\s*[-–]\s*[\d.,]+)?\s*(?:кг|т)\b)", "list"),
    ("rasst",  "Расстояние",            r"(?:на\s+расстояни\w*|перемещени\w*(?:\s+грунта)?\s+(?:до|на))[^,;]*?(\d+)\s*м\b", "list"),
    ("gruppa", "Группа грунтов",         r"групп[аеыу]?\s+грунтов?\s*(\d(?:\s*[-–]\s*\d)?)", "list"),
    ("kachestvo", "Качество отделки",    r"\b(простая|улучшенная|высококачественная)\b", "list"),
    ("osnovanie", "Основание",           r"по\s+(штукатурке(?:\s+и\s+сборным\s+конструкциям)?|сборным\s+конструкциям|камню|бетону|дереву|металл\w*|кирпич\w*)", "list"),
    ("element",   "Элемент",             r"\b(стен|потолк|колонн|пилястр|откос\w*|карниз\w*|фасад\w*|цокол\w*|бал(?:ок|к)\w*)", "list"),
]
_AX_GROUP_RE = [
    re.compile(r"групп\w*\s+грунтов?\s*:?\s*(\d(?:\s*[-–]\s*\d)?)", re.I),
    re.compile(r"(\d(?:\s*[-–]\s*\d)?)\s*групп\w*\s+грунт", re.I),
    re.compile(r"грунт\w*\s+(\d(?:\s*[-–]\s*\d)?)\s*групп", re.I),
]


def _ax_params(name):
    """IISMETA cost-estimation engine module."""
    nm = name or ""
    out = {}
    for key, _lab, pat, _kind in _AX:
        if key == "gruppa" or pat is None:
            continue
        m = re.search(pat, nm, re.I)
        if not m:
            continue
        if key in ("kovsh", "massa"):
            g1, g2 = m.group(1), m.group(2)
            out[key] = (("до " if g1 else "") + re.sub(r"\s+", " ", g2)).strip()
        else:
            out[key] = re.sub(r"\s+", " ", m.group(1)).strip()
    for rx in _AX_GROUP_RE:
        mg = rx.search(nm)
        if mg:
            out["gruppa"] = re.sub(r"\s+", "", mg.group(1))
            break
    return out


def _variant_labels_kb(varianty):
    """IISMETA cost-estimation engine module."""
    names = [x.get("name", "") or "" for x in varianty]
    pref = os.path.commonprefix(names)
    pref = pref[:pref.rfind(" ") + 1] if " " in pref else ""
    labels, seen = [], {}
    for x, nm in zip(varianty, names):
        lab = nm[len(pref):].strip(" ,.;") or (x.get("shifr") or "")
        if lab in seen:
            lab = "%s [%s]" % (lab, (x.get("shifr") or "")[-2:])
        seen[lab] = True
        labels.append(lab)
    return labels


def _residual_kb(name, varianty):
    """IISMETA cost-estimation engine module."""
    names = [x.get("name", "") or "" for x in varianty]
    pref = os.path.commonprefix(names)
    pref = pref[:pref.rfind(" ") + 1] if " " in pref else ""
    s = (name or "")[len(pref):]
    for _key, _lab, pat, _kind in _AX:
        if pat:
            s = re.sub(pat, " ", s, flags=re.I)
    for rx in _AX_GROUP_RE:
        s = rx.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" ,.;:-—()")
    return s


_DASH = "—"


def _build_axes(w):
    """IISMETA cost-estimation engine module."""
    poss = w["varianty"]
    pmaps = [_ax_params(x.get("name", "")) for x in poss]
    axes = []
    for key, lab, _pat, kind in _AX:
        vals, has_none = [], False
        for pm in pmaps:
            v = pm.get(key)
            if v:
                if v not in vals:
                    vals.append(v)
            else:
                has_none = True
        if len(vals) >= 2 or (len(vals) == 1 and has_none):
            opts = vals + ([_DASH] if has_none else [])
            axes.append({"key": key, "label": lab, "options": opts, "kind": kind})
    axkeys = [a["key"] for a in axes]
    sigs = [tuple(pm.get(k) for k in axkeys) for pm in pmaps]
    if axkeys and len(set(sigs)) == len(poss):
        return "structured", axes, sigs
    resd = [_residual_kb(x.get("name", ""), poss) for x in poss]
    sigs2 = [s + (r,) for s, r in zip(sigs, resd)]
    if axkeys and len(set(sigs2)) == len(poss) and len(set(resd)) > 1:
        rvals = []
        for r in resd:
            if r and r not in rvals:
                rvals.append(r)
        if rvals:
            axes = axes + [{"key": "_residual", "label": "Исполнение / вариант",
                            "options": rvals, "kind": "list"}]
            return "structured", axes, sigs2
    return "variant", None, None


def analyze(wc):
    w = _index().get(str(wc))
    if not w:
        return None
    base = {"work_code": wc, "vid": w["vid"], "izmeritel": _pretty_unit(w["izmeritel"]),
            "razdel": w["razdel"], "podrazdel": w["podrazdel"], "n_pos": w["n_var"], "способы": []}
    if w["n_var"] <= 1:
        base["axes"] = []
        base["mode"] = "single"
        return base
    mode, axes, _sigs = _build_axes(w)
    if mode == "structured":
        base["mode"] = "structured"
        base["axes"] = axes
        return base
    labels = _variant_labels_kb(w["varianty"])
    base["mode"] = "variant"
    base["axes"] = [{"key": "_variant", "label": "Вариант (позиция)", "options": labels, "kind": "list"}]
    base["_labels"] = labels
    return base


def positions(wc):
    w = _index().get(str(wc))
    return [dict(v) for v in (w["varianty"] if w else [])]


def wcs_by_table(table, series=None):
    """IISMETA cost-estimation engine module."""
    t = str(table).strip()
    return sorted(wc for wc, w in _index().items()
                  if w.get("shnk_table") == t and (series is None or w.get("series") == series))


def wc_by_table(table, series="Е", razdel=None):
    """IISMETA cost-estimation engine module."""
    cands = wcs_by_table(table, series=series)
    if razdel:
        rl = str(razdel).casefold()
        narrowed = [wc for wc in cands if rl in (_index()[wc].get("razdel") or "").casefold()]
        cands = narrowed or cands
    return cands[0] if cands else None


def resolve(wc, choices=None):
    """IISMETA cost-estimation engine module."""
    w = _index().get(str(wc))
    if not w or not w["varianty"]:
        return None
    varianty = w["varianty"]
    choices = choices or {}
    if choices:
        if "_variant" in choices:
            labels = _variant_labels_kb(varianty)
            tgt = choices["_variant"]
            for x, lab in zip(varianty, labels):
                if lab == tgt:
                    return dict(x)
        else:
            for x in varianty:
                pm = _ax_params(x.get("name", ""))
                ok = True
                for k, val in choices.items():
                    if val is None or val == "":
                        continue
                    if k == "_residual":
                        if _residual_kb(x.get("name", ""), varianty) != val:
                            ok = False; break
                        continue
                    got = pm.get(k)
                    if val == _DASH:
                        if got:
                            ok = False; break
                    elif got != val:
                        ok = False; break
                if ok:
                    return dict(x)
    return dict(varianty[0])


CONCRETE_GENERIC = {"45027", "45014"}

_BETON_LIB = None
_BETON_BY_CODE = None
_BETON_LOCK = threading.Lock()


def _cls_norm(c):
    return re.sub(r"[\s-]", "", str(c or "")).strip()


def _cls_key(c):
    m = re.search(r"[\d,.]+", c or "")
    return float(m.group(0).replace(",", ".")) if m else 9e9


def _beton_build():
    cur = _conn().cursor()
    by_code, marks = {}, []
    for code, cls, mark, frost, frac, name, unit in cur.execute(
            'SELECT "С-код","Класс","Марка","Морозост.","Фракция, мм","Наименование","Ед." FROM beton'):
        code = (code or "").strip()
        if not code:
            continue
        rec = {"code": code, "класс": _cls_norm(cls), "марка": (mark or "").strip(),
               "морозост": (frost or "").strip(), "фракция": (frac or "").strip(),
               "наим": (name or "").strip(), "ед": nunit(unit) or "м³"}
        by_code[code] = rec
        if not re.search(r"по\s+п\w*оекту", rec["наим"], re.I):
            marks.append(rec)
    marks.sort(key=lambda r: (r["наим"], r["code"]))
    quick = sorted({m["класс"] for m in marks
                    if re.match(r"Бетон тяжелый класса", m["наим"]) and m["класс"]}, key=_cls_key)
    return by_code, marks, quick


def _beton():
    global _BETON_LIB, _BETON_BY_CODE
    if _BETON_LIB is None:
        with _BETON_LOCK:
            if _BETON_LIB is None:
                _BETON_BY_CODE, _marks, _quick = _beton_build()
                _BETON_LIB = {"марки": _marks, "классы": _quick}
    return _BETON_LIB, _BETON_BY_CODE


def beton_library():
    """IISMETA cost-estimation engine module."""
    lib, _ = _beton()
    return {"марки": [{"code": m["code"], "класс": m["класс"], "марка": m["марка"],
                       "фракция": m["фракция"], "морозост": m["морозост"], "наим": m["наим"]}
                      for m in lib["марки"]],
            "классы": lib["классы"]}


def _beton_by_code(code):
    if not code:
        return None
    _, by = _beton()
    return by.get(str(code).strip())


def _is_po_proektu(name):
    low = (name or "").lower()
    return any(s in low for s in ("проекту", "проэкту", "поекту",
                                  "проектн", "проектом", "проекта", "проекте"))


_MAT_CAT = None
_MAT_BY_CODE = None
_MAT_LOCK = threading.Lock()


def _mat_build():
    cur = _conn().cursor()
    by, cat = {}, []
    for code, name, unit, _c in cur.execute(
            "SELECT res_code,name,res_unit,COUNT(*) c FROM resources "
            "WHERE rtype='материал' AND res_code!='' GROUP BY res_code,name ORDER BY res_code,c DESC"):
        code = (code or "").strip()
        if code in by:
            continue
        rec = {"code": code, "наим": _sentence((name or "").strip()), "ед": nunit(unit)}
        by[code] = rec
        cat.append(rec)
    cat.sort(key=lambda r: r["наим"])
    return cat, by


def _mat():
    global _MAT_CAT, _MAT_BY_CODE
    if _MAT_CAT is None:
        with _MAT_LOCK:
            if _MAT_CAT is None:
                _MAT_CAT, _MAT_BY_CODE = _mat_build()
    return _MAT_CAT, _MAT_BY_CODE


def material_catalog():
    """IISMETA cost-estimation engine module."""
    cat, _ = _mat()
    return {"материалы": cat}


def _material_by_code(code):
    if not code:
        return None
    _, by = _mat()
    return by.get(str(code).strip())


_MATCH_STOP = {"из", "с", "для", "на", "до", "по", "под", "над", "во", "или", "при", "без",
               "толщиной", "толщины", "мм", "см", "проект", "проекту", "проекта"}
_MATCH_TOK_RE = re.compile(r"[а-яёa-z]{3,}|\d+")


def _match_tokens(text):
    """IISMETA cost-estimation engine module."""
    low = (text or "").lower()
    alpha = {w for w in re.findall(r"[а-яёa-z]{3,}", low) if w not in _MATCH_STOP}
    num = set(re.findall(r"\d+", low))
    return alpha, num


def _match_stem(tok):
    return tok[:5]


def match_material(name, top_k=5):
    """IISMETA cost-estimation engine module."""
    cat, _ = _mat()
    qa, qn = _match_tokens(name)
    qas = {_match_stem(t) for t in qa}
    if not qas:
        return []
    scored = []
    for r in cat:
        ca, cn = _match_tokens(r["наим"])
        cas = {_match_stem(t) for t in ca}
        inter_a = len(qas & cas)
        if inter_a == 0:
            continue
        inter_n = len(qn & cn)
        extra_a = len(cas - qas)
        scored.append(((inter_a, inter_n, extra_a), r, inter_a))
    scored.sort(key=lambda x: (-x[0][0], -x[0][1], x[0][2]))
    out = []
    for (inter_a, inter_n, extra_a), r, _ in scored[:top_k]:
        conf = round(inter_a / max(1, len(qas)), 2)
        out.append({"code": r["code"], "наим": r["наим"], "ед": r["ед"], "confidence": conf})
    return out


def _swap_target(code):
    """IISMETA cost-estimation engine module."""
    mk = _beton_by_code(code)
    if mk:
        info = "класс %s · %s · фр.%s%s" % (mk["класс"], mk["марка"], mk["фракция"],
                                            (" · F" + mk["морозост"]) if mk["морозост"] else "")
        return {"наим": mk["наим"], "ед": mk["ед"], "инфо": re.sub(r"^класс\s+·\s+", "", info.strip())}
    m = _material_by_code(code)
    if m:
        return {"наим": m["наим"], "ед": m["ед"], "инфо": ""}
    try:
        import user_resources as _ur
        u = _ur.by_code(code)
        if u:
            return {"наим": u["name"], "ед": u.get("unit", ""), "инфо": "данные пользователя", "польз": True}
    except Exception:
        pass
    return None


def _resources(code, swaps=None, qtys=None, drops=None):
    swaps = swaps or {}
    qtys = qtys or {}
    try:
        import perevozka_kb as _pvz
        if _pvz.is_perevozka(code):
            rows = _pvz.resources(code, drops)
            if rows is not None:
                for row in rows:
                    if row.get("тип") == "материал":
                        row["замена"] = "ресурс"
                return rows
    except Exception:
        pass
    drops = set(str(d) for d in (drops or []))
    cur = _conn().cursor()
    out = []
    for rtype, subtype, res_code, name, res_unit, rate, role in cur.execute(
            "SELECT rtype,subtype,res_code,name,res_unit,rate,role FROM resources WHERE norm_code=? ORDER BY id",
            (code,)):
        rc = (res_code or "").strip()
        row = {"шифр": rc, "наименование": _res_name(rtype, subtype, name),
               "ед": nunit(res_unit), "норма": str(rate or "0").replace(".", ","), "тип": rtype,
               "можно_исключить": True,
               "исключён": rc in drops}
        po_proektu = (role or "").strip() == "П"
        if po_proektu:
            row["по_проекту"] = True
        if rtype == "материал":
            if rc in CONCRETE_GENERIC:
                row["замена"] = "бетон"
            else:
                row["замена"] = "ресурс"
            user_swap = False
            if row.get("замена") and swaps.get(rc):
                tgt = _swap_target(swaps[rc])
                if tgt:
                    row["шифр_orig"], row["наим_orig"] = rc, row["наименование"]
                    row["шифр"], row["наименование"], row["ед"] = swaps[rc], tgt["наим"], tgt["ед"]
                    row["заменён"] = swaps[rc]
                    user_swap = bool(tgt.get("польз"))
                    if tgt["инфо"]:
                        row["марка_инфо"] = tgt["инфо"]
            if _num(rate) == 0 or user_swap:
                row["ввод_кол"] = True
                qv = qtys.get(rc)
                if qv is not None and str(qv).strip() != "":
                    row["норма"] = str(qv).replace(".", ",")
                    row["кол_задан"] = True
                elif user_swap:
                    row["норма"] = "0"
            elif po_proektu:
                qv = qtys.get(rc)
                if qv is not None and str(qv).strip() != "":
                    row["норма"] = str(qv).replace(".", ",")
                    row["кол_задан"] = True
        out.append(row)
    return out


_CORR_OPS = None


def _corr_ops_all():
    """IISMETA cost-estimation engine module."""
    global _CORR_OPS
    if _CORR_OPS is None:
        cur = _conn().cursor()
        _CORR_OPS = {}
        if cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='correction_ops'").fetchone():
            for p_code, kind, res_code, coef in cur.execute(
                    "SELECT p_code,kind,res_code,coef FROM correction_ops"):
                d = _CORR_OPS.setdefault(p_code, {"res": {}, "excl": []})
                if kind == "res":
                    d["res"][str(res_code)] = coef
                else:
                    d["excl"].append(str(res_code))
    return _CORR_OPS


def _corrections_menu_raw(code):
    """IISMETA cost-estimation engine module."""
    out = {}
    for p_code, kztr, kem, kmr, vid in _conn().cursor().execute(
            "SELECT cm.p_code,c.kztr,c.kem,c.kmr,c.vid FROM corrections_menu cm "
            "JOIN corrections c ON cm.p_code=c.p_code WHERE cm.norm_code=?", (code,)):
        out[p_code] = {"vid": vid, "kztr": kztr, "kem": kem, "kmr": kmr}
    return out


def _height_auto(code, criteria):
    """IISMETA cost-estimation engine module."""
    try:
        import tch_height_correction as THC
        return THC.height_correction(code, criteria, _corrections_menu_raw)
    except Exception:
        return None


def _techchasti_ops_auto(table, name):
    """IISMETA cost-estimation engine module."""
    try:
        import techchasti_ops as TO
        return TO.suggest(table, name)
    except Exception:
        return []


def _seismic_auto(table, code, criteria):
    """IISMETA cost-estimation engine module."""
    try:
        import techchasti_seismic as TS
        return TS.seismic_note(table, code, criteria)
    except Exception:
        return None


def _popravki(code):
    cur = _conn().cursor()
    ops = _corr_ops_all()
    out = []
    for p_code, kztr, kem, kmr, vid in cur.execute(
            "SELECT cm.p_code,c.kztr,c.kem,c.kmr,c.vid FROM corrections_menu cm "
            "JOIN corrections c ON cm.p_code=c.p_code WHERE cm.norm_code=? ORDER BY cm.p_code", (code,)):
        op = ops.get(p_code, {"res": {}, "excl": []})
        out.append({"пункт": p_code, "коэф_труд": (kztr or "-").strip() or "-",
                    "коэф_маш": (kem or "-").strip() or "-", "коэф_мат": (kmr or "-").strip() or "-",
                    "усл": (vid or "").strip(),
                    "ресурс_коэф": op["res"], "исключить": op["excl"]})
    return out


def _pretty_unit(u):
    return re.sub(r"^(\d+(?:[.,]\d+)?)\s*", r"\1 ", str(u or "")).strip()


_NS_OK = None


def _norm_sostav(code):
    """IISMETA cost-estimation engine module."""
    global _NS_OK
    cur = _conn().cursor()
    if _NS_OK is None:
        _NS_OK = bool(cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='norm_sostav'").fetchone())
    if not _NS_OK:
        return ""
    rows = cur.execute("SELECT text FROM norm_sostav WHERE norm_code=? ORDER BY idx", (code,)).fetchall()
    return " ".join(r[0] for r in rows if r and r[0])


_ECODE_RE = re.compile(r"^([А-Яа-яA-Za-z]+)(\d+)-(\d+)-(\d+)(?!\d)")


def _norm_ecode(code):
    """IISMETA cost-estimation engine module."""
    if not code:
        return code
    head = str(code).strip().split()[0]
    m = _ECODE_RE.match(head)
    if not m:
        return head
    letter, a, b, c = m.groups()
    return "%s%s-%s-%s" % (letter, a.zfill(4), b.zfill(3), c.zfill(2))


def compute_code(wc, objem, code, swaps=None, qtys=None, drops=None, criteria=None):
    w = _index().get(str(wc))
    if not w:
        return {"error": "Работа не найдена"}
    def _basecode(x):
        return (str(x.get("base") or "").split() or [""])[0]
    nc = _norm_ecode(code)
    v = next((x for x in w["varianty"]
              if x["code"] == code or x.get("shifr") == code or _basecode(x) == code
              or x["code"] == nc or x.get("shifr") == nc), None)
    if v is None:
        return {"error": "Позиция %s не найдена" % code}
    code = v["code"]
    izm = v["unit"] or w["izmeritel"]
    hdr = ("Таблица СРН %s %s" % (w.get("shnk_table") or "", w["vid"])).strip()
    sostav = _norm_sostav(code) or SOSTAV.get(wc)
    har = [
        ["Шифр", v.get("base") or v["shifr"]],
        ["Поправки", v.get("popr_raw") or "—"],
        ["Наименование", v["name"]],
        ["Измеритель", _pretty_unit(izm)],
        ["Название таблицы", hdr],
    ]
    ax_lab = {k: l for k, l, _p, _kind in _AX}
    oси = {ax_lab.get(k, k): val for k, val in _ax_params(v["name"]).items()}
    return {"наименование": v["name"], "shifr": v["shifr"], "измеритель": izm,
            "измеритель_норм": v.get("izm_norm") or "", "вариант": v.get("variant") or "",
            "объём": objem, "ресурсы": _resources(code, swaps, qtys, drops), "поправки": _popravki(code),
            "поправка_высота_авто": _height_auto(code, criteria),
            "поправка_сейсмика_авто": _seismic_auto(w.get("shnk_table"), code, criteria),
            "техчасти_ops": _techchasti_ops_auto(w.get("shnk_table"), v["name"]),
            "характеристики_список": har, "состав": sostav, "оси": oси, "status": "🟢"}


def compute(wc, objem, choices=None, swaps=None, qtys=None, drops=None, criteria=None):
    v = resolve(wc, choices)
    if not v:
        return {"error": "Работа не найдена"}
    return compute_code(wc, objem, v["code"], swaps, qtys, drops, criteria)


class _SostavProxy:
    _cache = {}

    def get(self, wc, default=""):
        w = _index().get(str(wc))
        if not w:
            return default
        s = str(wc).split("-")
        if len(s) < 2 or s[1] != "01":
            return default
        shnk = w.get("shnk_table") or ""
        if shnk in self._cache:
            return self._cache[shnk]
        row = _conn().cursor().execute("SELECT text FROM sostav WHERE shnk_table=?", (shnk,)).fetchone()
        txt = (row[0] if row else "") or default
        self._cache[shnk] = txt
        return txt


SOSTAV = _SostavProxy()


if __name__ == "__main__":
    idx = _index()
    print("работ:", len(idx))
    wc = next(iter(idx))
    print("пример wc:", wc, idx[wc]["vid"][:50], "| позиций:", idx[wc]["n_var"])
    earth = next((k for k, v in idx.items() if v["shnk_table"] == "01-01-001"), None)
    if earth:
        print("\nземля 01-01-001 wc:", earth)
        a = analyze(earth); print("analyze:", a["vid"][:40], a["izmeritel"], "n_pos", a["n_pos"])
        ps = positions(earth); print("позиций:", len(ps), ps[0])
        r = compute_code(earth, 100, ps[0]["code"])
        print("ресурсы:", r["ресурсы"])
        print("поправки:", r["поправки"][:3])
        print("состав:", SOSTAV.get(earth)[:80])
