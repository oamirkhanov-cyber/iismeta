# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import json
import os
import re
import sys
import threading

_MODEL = os.environ.get("LLM_FALLBACK_MODEL", "claude-haiku-4-5-20251001")
_MAX_CANDIDATES = 15

_PROMPT = """Ты — сметчик по ШНҚ (Узбекистан). Даны строки ВОР, которые детерминированный \
словарь движка НЕ опознал, и для каждой — шорт-лист кандидат-таблиц ШНК из базы \
(код: имя таблицы (измеритель), иногда примеры норм-вариантов внутри таблицы).
Задача на КАЖДУЮ строку: выбери ОДНУ таблицу, в которой лежит норма для этой РАБОТЫ, \
либо ответь null, если ни одна не подходит.
Правила СТРОГО:
1. "suggestion" — код таблицы, СКОПИРОВАННЫЙ из списка кандидатов этой строки. Кода нет в списке → null. \
НЕ выдумывай и НЕ исправляй коды.
2. Если подходящей таблицы в списке НЕТ — верни null. НЕ выбирай «ближайшую похожую» ради ответа: \
шорт-лист собран поиском по словам и правильной таблицы в нём может просто не быть — это нормальный \
случай (null уйдёт оператору), а ложный код испортит смету.
3. "confidence": "high" ТОЛЬКО если и ОПЕРАЦИЯ, и ОБЪЕКТ строки дословно соответствуют имени \
таблицы или её варианта; любое допущение/натяжка → "low". Порядок кандидатов в списке НЕ важен — \
выбирай по смыслу.
4. "basis" — краткое обоснование по-русски (≤15 слов): почему эта таблица / почему нет подходящей.
5. Строка-изделие/материал без операции (просто марка, прокат, изделие) — НЕ работа: suggestion=null, basis "материал". \
Строка-заголовок раздела (нет ни операции с объектом, ни объёма) — suggestion=null.
6. Учитывай РАЗДЕЛ как контекст (штукатурка в «Стены» ≠ «Фасад»; плитка в «Полы» ≠ облицовка стен).
Ответ — СТРОГО валидный JSON-массив без markdown: \
[{{"i":0,"suggestion":"15-02-019","confidence":"high","basis":"…"}}, {{"i":1,"suggestion":null,"confidence":"low","basis":"…"}}]
"i" — СКОПИРУЙ номер строки из входа КАК ЕСТЬ (НЕ пересчитывай); ответь на КАЖДУЮ строку.

СТРОКИ:
{items}"""

_IDX_LOCK = threading.Lock()
_KW_INDEX = None          # stem -> set(shnk_table)
_TBL_META = None          # shnk_table -> {"name", "izm", "series"}

_TOKEN_RE = re.compile(r"[а-яёa-z]{4,}")
_MARK_RE = re.compile(r"\b([а-яёa-z]{1,3})\s*[-–]?\s*(\d{2,4})\b")
_HYPH_WRAP = re.compile(r"([а-яёa-z])-\s+([а-яёa-z0-9])", re.I)
_STOP = set("""
работ работы работа устройство устройства слой слоя слоев основе основа основание
для при из под над без марки типа класс класса гост серия толщиной шириной
""".split())


def _stem(tok: str) -> str:
    """IISMETA cost-estimation engine module."""
    t = re.sub(r"[аяыиеоюуьй]$", "", tok)
    return t[:4]


def _tokens(text: str) -> list:
    s = _HYPH_WRAP.sub(r"\1\2", (text or "").lower().replace("ё", "е"))
    out = []
    for t in _TOKEN_RE.findall(s):
        if t in _STOP:
            continue
        t = t.replace("шпакл", "шпатл")
        t = re.sub(r"^оштукатур", "штукатур", t)
        st = _stem(t)
        if st not in out:
            out.append(st)
    for m in _MARK_RE.finditer(s):
        mk = m.group(1) + m.group(2)
        if mk not in out:
            out.append(mk)
    return out


def _build_kw_index():
    """IISMETA cost-estimation engine module."""
    import kb_engine as KB
    kw, meta = {}, {}
    for w in KB._index().values():
        tab = w.get("shnk_table") or ""
        if not re.match(r"^\d{2}-\d{2}-\d{3}$", tab):
            continue
        vnames = [v.get("name") or "" for v in w.get("varianty") or []]
        prev = meta.get(tab)
        if prev is None or (prev["series"] != "Е" and w.get("series") == "Е"):
            meta[tab] = {"name": w.get("vid") or "", "izm": w.get("izmeritel") or "",
                         "series": w.get("series") or "", "vars": vnames[:40]}
        for st in _tokens(" ".join([w.get("vid") or ""] + vnames)):
            kw.setdefault(st, set()).add(tab)
    return kw, meta


def _kw_index():
    global _KW_INDEX, _TBL_META
    if _KW_INDEX is None:
        with _IDX_LOCK:
            if _KW_INDEX is None:
                _KW_INDEX, _TBL_META = _build_kw_index()
    return _KW_INDEX, _TBL_META


def kb_candidates(name: str, section_title: str = "", limit: int = _MAX_CANDIDATES) -> list:
    """IISMETA cost-estimation engine module."""
    kw, meta = _kw_index()
    qstems = set(_tokens(name))
    scores = {}
    for st in qstems:
        for tab in kw.get(st, ()):
            scores[tab] = scores.get(tab, 0.0) + 1.0
    for st in _tokens(section_title or ""):
        for tab in kw.get(st, ()):
            if tab in scores:
                scores[tab] += 0.5
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    out = []
    for t, _s in ranked[:limit]:
        m = meta[t]
        hints = []
        for v in m.get("vars") or []:
            ov = len(qstems & set(_tokens(v)))
            if ov > 0:
                hints.append((ov, v))
        hints.sort(key=lambda x: -x[0])
        out.append({"table": t, "name": m["name"], "izm": m["izm"],
                    "hint": [h[1][:80] for h in hints[:2]]})
    return out


def _llm():
    import llm_normalize as LN
    return LN


def available() -> bool:
    """IISMETA cost-estimation engine module."""
    if os.environ.get("LLM_FALLBACK") == "0":
        return False
    return bool(_llm()._api_key())


def _call_api_pinned(prompt: str, timeout: int = 0) -> str:
    """IISMETA cost-estimation engine module."""
    import urllib.request
    import urllib.error
    LN = _llm()
    timeout = timeout or int(os.environ.get("LLM_TIMEOUT", "240"))
    body = json.dumps({
        "model": _MODEL,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": LN._api_key() or "", "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            ed = json.loads(e.read().decode()).get("error", {})
            raise RuntimeError("FALLBACK HTTP %d %s: %s"
                               % (e.code, ed.get("type", "?"), (ed.get("message") or "")[:160]))
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError("FALLBACK HTTP %d (тело нечитаемо)" % e.code)
    except urllib.error.URLError as e:
        raise RuntimeError("FALLBACK сеть недоступна: %s" % str(e.reason)[:120])
    out = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    if not out:
        raise RuntimeError("FALLBACK пустой ответ (stop_reason=%s)" % data.get("stop_reason"))
    return out


def _build_prompt(items):
    lines = []
    for it in items:
        cparts = []
        for c in it["cands"]:
            s = "%s: %s (%s)" % (c["table"], c["name"][:80], c["izm"])
            if c.get("hint"):
                s += " [напр.: %s]" % "; ".join(c["hint"])
            cparts.append(s)
        sec = (' раздел:"%s"' % it["section"][:60]) if it.get("section") else ""
        unit = (" ед:%s" % it["unit"]) if it.get("unit") else ""
        lines.append('%d) "%s"%s%s\n   кандидаты: %s'
                     % (it["i"], it["raw"][:160], unit, sec, "; ".join(cparts) or "—"))
    return _PROMPT.format(items="\n".join(lines))


def _validate(res: dict, cand_tables: set) -> dict:
    """IISMETA cost-estimation engine module."""
    sug = res.get("suggestion")
    conf = res.get("confidence") if res.get("confidence") in ("high", "low") else "low"
    basis = str(res.get("basis") or "")[:200]
    if sug is not None:
        sug = str(sug).strip()
        if sug not in cand_tables:
            basis = ("отклонено: «%s» не из шорт-листа; " % sug) + basis
            sug, conf = None, "low"
    return {"suggestion": sug, "confidence": conf, "basis": basis}


def _chunk(part):
    """IISMETA cost-estimation engine module."""
    LN = _llm()
    try:
        data = LN._parse_json(_call_api_pinned(_build_prompt(part)))
        by_i = LN._remap(data, part)
        out = {}
        for it in part:
            r = by_i.get(it["i"])
            if isinstance(r, dict):
                out[it["i"]] = _validate(r, {c["table"] for c in it["cands"]})
        return out
    except Exception as e:
        print("llm_fallback: чанк упал (%d строк): %s" % (len(part), str(e)[:120]), file=sys.stderr)
        return {}


def suggest_batch(rows: list) -> dict:
    """IISMETA cost-estimation engine module."""
    if not rows:
        return {}
    LN = _llm()
    items, out = [], {}
    for k, r in enumerate(rows):
        i = r.get("i", k)
        cands = kb_candidates(r.get("name") or "", r.get("section_title") or "")
        if not cands:
            out[i] = {"suggestion": None, "confidence": "low",
                      "basis": "keyword-сужение не нашло кандидатов в БД", "candidates": []}
            continue
        items.append({"i": i, "raw": r.get("name") or "", "unit": r.get("unit") or "",
                      "section": r.get("section_title") or "", "cands": cands})
    if items:
        if not available():
            for it in items:
                out[it["i"]] = {"suggestion": None, "confidence": "low",
                                "basis": "нет ANTHROPIC_API_KEY — фолбэк офлайн",
                                "candidates": it["cands"]}
        else:
            got = LN._with_cache(
                "fallback", _PROMPT, items,
                lambda it: {"raw": it["raw"], "unit": it["unit"], "section": it["section"],
                            "cands": [c["table"] for c in it["cands"]], "model": _MODEL},
                lambda misses: LN._run_chunked(_chunk, misses))
            for it in items:
                r = got.get(it["i"]) or {"suggestion": None, "confidence": "low",
                                         "basis": "LLM не ответил (таймаут/сбой чанка)"}
                out[it["i"]] = dict(r, candidates=it["cands"])
    return out


def suggest(name: str, unit: str = "", qty=None, section_title: str = "") -> dict:
    """IISMETA cost-estimation engine module."""
    return suggest_batch([{"i": 0, "name": name, "unit": unit, "qty": qty,
                           "section_title": section_title}])[0]


_VERB_STEMS = ("устройств", "окраск", "покраск", "окрашив", "укладк", "установк", "монтаж",
               "демонтаж", "затирк", "штукатурк", "тукатурк", "шпаклевк", "шпатлевк", "отделк",
               "облицовк", "проливк", "антисептир", "грунтовк", "шлифовк", "заделк", "утеплени",
               "покрыти", "кладк", "разработк", "засыпк", "пропитк")


def is_verb_work(name: str) -> bool:
    """IISMETA cost-estimation engine module."""
    s = _HYPH_WRAP.sub(r"\1\2", (name or "").lower())
    head = " ".join(re.split(r"\s+", s)[:5])
    return any(re.search(r"\b" + st, head) for st in _VERB_STEMS)

