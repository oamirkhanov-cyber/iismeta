# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
import os
import re
import io
from collections import OrderedDict

from fastapi import FastAPI, Header, HTTPException, Request, UploadFile, File, Form, Body
from typing import List
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

KB = bool(os.environ.get("KB_MODE"))
if KB:
    import kb_engine as WZ
else:
    import wizard_ref as WZ
import lrv_build as L
import norma_engine as NORMA
import info_engine as INFO
import unit_convert as UC

import secrets as _secrets
APP_PASSWORD = os.environ.get("APP_PASSWORD") or _secrets.token_urlsafe(24)
if not os.environ.get("APP_PASSWORD"):
    print("⚠ APP_PASSWORD не задан в env — сгенерирован случайный (вход закрыт). Задайте его в Render.")
ADMIN_KEY = os.environ.get("ADMIN_KEY") or _secrets.token_urlsafe(24)
if not os.environ.get("ADMIN_KEY"):
    print("⚠ ADMIN_KEY не задан в env — сгенерирован случайный (админ-API закрыт). Задайте его в Render.")
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "web_static")

import json as _json
if os.environ.get("KB_MODE"):
    SOSTAV = WZ.SOSTAV
else:
    _SOSTAV_PATH = os.path.join(HERE, "..", "0_БД_расценок", "sostav_rabot_sb01.json")
    try:
        SOSTAV = _json.load(open(_SOSTAV_PATH, encoding="utf-8"))
    except Exception:
        SOSTAV = {}

_USLOVIYA = None


def _load_usloviya():
    global _USLOVIYA
    if _USLOVIYA is None:
        p = os.path.join(HERE, "..", "0_БД_расценок", "usloviya_db.json")
        try:
            _USLOVIYA = _json.load(open(p, encoding="utf-8"))
        except Exception:
            _USLOVIYA = {"разделы": []}
    return _USLOVIYA


_METOD = None


def _load_metod():
    global _METOD
    if _METOD is None:
        p = os.path.join(HERE, "..", "0_БД_расценок", "metodologiya_manifest.json")
        try:
            _METOD = _json.load(open(p, encoding="utf-8"))
        except Exception:
            _METOD = {"документы": []}
    return _METOD


def _metod_dir():
    d = os.environ.get("METODOLOGIYA_DIR")
    if d:
        return d
    if os.path.isdir("/data"):
        return "/data/metodologiya"
    return os.path.join(HERE, "..", "0_БД_расценок", "_metodologiya")


import unicodedata as _ud


def _metod_path(fname):
    """IISMETA cost-estimation engine module."""
    fn = _ud.normalize("NFC", os.path.basename(str(fname or "")))
    if not fn or fn.startswith("."):
        return None
    return os.path.join(_metod_dir(), fn)

app = FastAPI(title="SmetaAI · Движок")
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.on_event("startup")
def _warm_caches():
    """IISMETA cost-estimation engine module."""
    import threading

    def go():
        try:
            if hasattr(WZ, "_index"):
                WZ._index()
            if hasattr(WZ, "tree_nested"):
                WZ.tree_nested()
            try:
                import tg_bot
                tg_bot._search_index()
            except Exception:
                pass
        except Exception:
            pass
    threading.Thread(target=go, daemon=True).start()


# ── SESSIONS ────────────────────────────────────────────────────────────────────
# Login issues a random server-side token with a TTL; the password is never stored
# in the browser. Sessions persist on disk so a redeploy does not log the operator
# out in the middle of an estimate.
import sqlite3 as _sess_sqlite3
import time as _sess_time
_SESS_DB_PATH = ("/data/sessions.db" if os.path.isdir("/data")
                 else os.path.join(HERE, "0_БД_расценок", "sessions_local.db"))
_SESS_TTL_SEC = 7 * 24 * 3600


def _sess_con():
    con = _sess_sqlite3.connect(_SESS_DB_PATH)
    con.execute("CREATE TABLE IF NOT EXISTS sessions("
                "token TEXT PRIMARY KEY, operator TEXT, created INTEGER, expires INTEGER)")
    con.commit()
    return con


def _sess_new(operator):
    tok = _secrets.token_urlsafe(32)
    now = int(_sess_time.time())
    con = _sess_con()
    try:
        con.execute("INSERT INTO sessions(token,operator,created,expires) VALUES (?,?,?,?)",
                    (tok, operator, now, now + _SESS_TTL_SEC))
        con.execute("DELETE FROM sessions WHERE expires < ?", (now,))
        con.commit()
    finally:
        con.close()
    return tok


def _sess_valid(tok):
    if not tok:
        return False
    con = _sess_con()
    try:
        row = con.execute("SELECT 1 FROM sessions WHERE token=? AND expires > ?",
                          (tok, int(_sess_time.time()))).fetchone()
    finally:
        con.close()
    return bool(row)


def _sess_drop(tok):
    if not tok:
        return
    con = _sess_con()
    try:
        con.execute("DELETE FROM sessions WHERE token=?", (tok,))
        con.commit()
    finally:
        con.close()


def _eq_const(a, b):
    """IISMETA cost-estimation engine module."""
    try:
        return _secrets.compare_digest(str(a or "").encode("utf-8"), str(b or "").encode("utf-8"))
    except Exception:
        return False


def _auth(x_auth):
    if x_auth and _eq_const(x_auth, APP_PASSWORD):
        return
    if _sess_valid(x_auth):
        return
    raise HTTPException(status_code=401, detail="Не авторизовано")


def _admin(x_auth):
    if x_auth != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Не авторизовано (нужен ADMIN_KEY)")


import time as _time
from collections import deque as _deque
_RL = {}                                                # key → deque(timestamps)
_RL_WINDOW = 60.0
_RL_MAX_DATA = 240
_RL_MAX_LOGIN = 10


def _rl_hit(key, limit):
    now = _time.time()
    dq = _RL.get(key)
    if dq is None:
        dq = _RL[key] = _deque()
    while dq and now - dq[0] > _RL_WINDOW:
        dq.popleft()
    if len(dq) >= limit:
        return False
    dq.append(now)
    return True


@app.middleware("http")
async def _ratelimit(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/"):
        ip = (request.client.host if request.client else "?")
        if path == "/api/login":
            ok = _rl_hit("login:" + ip, _RL_MAX_LOGIN)
        else:
            tok = request.headers.get("x-auth") or ip
            ok = _rl_hit("tok:" + tok, _RL_MAX_DATA) and _day_hit(tok, _RL_MAX_DAY)
        if not ok:
            return JSONResponse(status_code=429, content={"error": "Слишком много запросов — попробуйте позже."})
    return await call_next(request)


_CSP = ("default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
_WIZARD_FRAME_OK = re.compile(r"^/wizard_[\w-]+\.html$")
_CSP_FRAME_SELF = _CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'")


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    same_origin_frame = bool(_WIZARD_FRAME_OK.match(request.url.path))
    resp.headers["X-Frame-Options"] = "SAMEORIGIN" if same_origin_frame else "DENY"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["Content-Security-Policy"] = _CSP_FRAME_SELF if same_origin_frame else _CSP
    return resp


_RL_MAX_DAY = 5000
_DAY = {}                                # token -> [day_bucket, count]
_SCRAPE_WINDOW = 3600.0
_SCRAPE_MAX_CODES = 400
_SCRAPE = {}                             # token -> {"t0", "codes": set, "alerted"}
_ALERTS = _deque(maxlen=50)


def _day_hit(token, limit):
    day = int(_time.time() // 86400)
    d = _DAY.get(token)
    if not d or d[0] != day:
        d = _DAY[token] = [day, 0]
    d[1] += 1
    return d[1] <= limit


def _security_alert(msg):
    _ALERTS.append({"ts": int(_time.time()), "msg": msg})
    print("[SECURITY]", msg)
    cid = os.environ.get("ADMIN_CHAT_ID")
    if cid:
        try:
            import tg_bot
            tg_bot._tg("sendMessage", chat_id=cid, text=msg)
        except Exception:
            pass


def _track(token, key):
    if not token or not key:
        return
    now = _time.time()
    s = _SCRAPE.get(token)
    if not s or now - s["t0"] > _SCRAPE_WINDOW:
        s = _SCRAPE[token] = {"t0": now, "codes": set(), "alerted": False}
    s["codes"].add(str(key))
    if len(s["codes"]) > _SCRAPE_MAX_CODES and not s["alerted"]:
        s["alerted"] = True
        _security_alert("⚠️ Возможный скрейпинг базы: токен …%s обратился к %d разным расценкам за час."
                        % (str(token)[-4:], len(s["codes"])))


def _num(s):
    m = re.search(r"\d+(?:[.,]\d+)?", str(s or ""))
    return float(m.group(0).replace(",", ".")) if m else 0.0


class LoginIn(BaseModel):
    password: str


class ComputeIn(BaseModel):
    wc: str
    objem: float = 100.0
    choices: dict = {}
    swaps: dict = {}
    qtys: dict = {}


class RowIn(BaseModel):
    wc: str
    objem: float
    choices: dict = {}
    picks: list = []
    code: str = None
    swaps: dict = {}
    qtys: dict = {}
    drops: list = []
    krat: int = 1
    krat_text: str = ""


class ComputePosIn(BaseModel):
    wc: str
    objem: float = 100.0
    code: str
    swaps: dict = {}
    qtys: dict = {}
    drops: list = []


class SmetaIn(BaseModel):
    rows: list = []
    kind: str = "lrv"
    glob: dict = {}


class PerevozkaDistIn(BaseModel):
    text: str = ""
    L_km: float
    tonnes: float = 100.0


class ExtraResIn(BaseModel):
    name: str
    unit: str = ""
    qty: float
    code: str = ""
    cost: float = 0.0


def _make_resolved(wc, objem, choices, pick_points, code=None, swaps=None, qtys=None, drops=None,
                   krat=1, krat_text=""):
    info = WZ.analyze(wc)
    swaps = swaps or {}
    qtys = qtys or {}
    drops = drops or []
    try:
        krat = max(1, int(krat or 1))
    except (TypeError, ValueError):
        krat = 1
    if KB:
        r = WZ.compute_code(wc, objem, code, swaps, qtys, drops) if code else WZ.compute(wc, objem, choices, swaps, qtys, drops)
    else:
        r = WZ.compute_code(wc, objem, code) if code else WZ.compute(wc, objem, choices)
    if r.get("error"):
        return None
    picks = [c for c in r["поправки"] if c["пункт"] in set(pick_points or [])]
    kt = km = kmat = 1.0
    rescoef = {}
    excl = set()
    for c in picks:
        if str(c["коэф_труд"]).strip() not in ("-", ""):
            kt *= (_num(c["коэф_труд"]) or 1.0)
        if str(c["коэф_маш"]).strip() not in ("-", ""):
            km *= (_num(c["коэф_маш"]) or 1.0)
        if str(c.get("коэф_мат", "")).strip() not in ("-", ""):
            kmat *= (_num(c["коэф_мат"]) or 1.0)
        for rc, cf in (c.get("ресурс_коэф") or {}).items():
            rescoef[str(rc)] = rescoef.get(str(rc), 1.0) * (_num(cf) or 1.0)
        excl |= set(str(x) for x in (c.get("исключить") or []))

    def bake(lst):
        out = []
        for x in lst:
            rc = str(x["шифр"])
            if x.get("исключён"):
                continue
            if rc in excl:
                continue
            u = (x["ед"] or "").lower()
            if rc in rescoef:
                mult = rescoef[rc]
            else:
                mult = kt if "чел" in u else (km if "маш" in u else kmat)
            baked = {"res": x["шифр"], "name": x["наименование"], "unit": x["ед"],
                     "val": round(_num(x["норма"]) * mult * krat, 5)}
            if x.get("по_проекту") and not x.get("кол_задан") and not x.get("заменён"):
                baked["ppro"] = True
            out.append(baked)
        return out

    res = bake(r["ресурсы"])
    dops = []
    if r.get("n_dob") and r.get("добор_ресурсы"):
        dops.append({"_dobor": True, "код": r.get("добор_shifr") or "—",
                     "наим": (r.get("добор_наим") or "Добор по расстоянию"),
                     "ресурсы": bake(r["добор_ресурсы"]), "n": r["n_dob"],
                     "примечание": r.get("добор", "")})
    pos = (next((x for x in WZ._load()[wc]["varianty"] if x["code"] == code), None) if code
           else WZ.resolve(wc, choices))
    vidy = WZ._load()
    kr_suffix = ""
    if krat > 1:
        kr_suffix = " · К=%d%s" % (krat, (" (%s)" % krat_text) if krat_text else "")
    name_kr = r["наименование"] + kr_suffix
    return {"вход": name_kr, "объём": objem, "статус": "🟢", "кратность": krat,
            "вид": {"work_code": wc, "имя": info["vid"]},
            "вариант": {"code": (pos.get("code") if pos else (code or wc)), "имя": name_kr},
            "коэффициенты": [{"пункт": c["пункт"], "кзт": c["коэф_труд"], "кэм": c["коэф_маш"],
                              "усл": c.get("усл", "")} for c in picks],
            "_baked": True, "ресурсы": res,
            "измеритель": r.get("измеритель_норм") or info["izmeritel"],
            "вариант_доп": r.get("вариант", "") or "",
            "состав": r.get("состав", "") or "",
            "доп_позиции": dops, "перевозка_расценка": None,
            "раздел": vidy[wc].get("razdel") or "Земляные работы",
            "_shifr": r["shifr"], "_поправки": ["п.%s" % c["пункт"] for c in picks]}


def _perevozka_dist_row(text, L_km, tonnes):
    """IISMETA cost-estimation engine module."""
    try:
        import perevozka_resolver as pr
        n = pr.transport_norm(int(round(float(L_km))), 1)
    except Exception:
        n = None
    if not n:
        return None
    res = [{"res": x["res"], "name": x["name"], "unit": x["unit"], "val": _num(x["val"])}
           for x in n["resources"]]
    nm = ("Перевозка груза «%s» на %s км (класс 1)" % (text, n["расстояние_км"])) if text \
        else n["наим"]
    shifr = "С" + str(n["code"])
    return {"вход": nm, "объём": float(tonnes or 0), "статус": "🟢", "кратность": 1,
            "вид": {"work_code": shifr, "имя": nm}, "вариант": {"code": shifr, "имя": nm},
            "коэффициенты": [], "_baked": True, "ресурсы": res,
            "измеритель": "1 т", "вариант_доп": "", "состав": "",
            "доп_позиции": [], "перевозка_расценка": None,
            "раздел": "Перевозка грузов автотранспортом", "_shifr": shifr, "_поправки": []}


class SmetaSaveIn(BaseModel):
    rows: list = []
    title: str = ""
    titul: dict = {}
    n: int = 0
    proj: dict = {}


class SmetaDelIn(BaseModel):
    n: int


class ProjectSaveIn(BaseModel):
    n: int = None
    name: str = None
    object: str = None
    vors: list = None
    smetas: list = None
    passport: dict = None
    objects: list = None
    project_type: str = None


class ProjectVorIn(BaseModel):
    n: int
    vor: dict


class ProjectVorParentIn(BaseModel):
    n: int
    file_id: str
    sub_id: str


class EditLogIn(BaseModel):
    """IISMETA cost-estimation engine module."""
    edits: list = []


class ProjectDelIn(BaseModel):
    n: int


class ProjectRecognizeIn(BaseModel):
    n: int
    cap: int = 25


class ProjectVorUpdateIn(BaseModel):
    n: int
    vor_index: int = 0
    rows: list


class VorMatchIn(BaseModel):
    rows: list
    top_k: int = 5
    criteria: dict = {}


class WbsInstantiateIn(BaseModel):
    criteria: dict = {}


class ProjectCompletenessIn(BaseModel):
    n: int


class ProjectFileIn(BaseModel):
    n: int
    file_id: str
    klass: str = None


class InferCriteriaIn(BaseModel):
    n: int
    object_id: str


# ── API ──
@app.get("/api/smeta_next")
def smeta_next(x_auth: str = Header(None)):
    _auth(x_auth)
    import smeta_store as ST
    return {"n": ST.peek_next()}


@app.post("/api/smeta_save")
def smeta_save(body: SmetaSaveIn, x_auth: str = Header(None)):
    _auth(x_auth)
    import smeta_store as ST
    return ST.save(body.rows, body.title, body.titul, body.n or None, body.proj)


@app.get("/api/smeta_list")
def smeta_list(x_auth: str = Header(None)):
    _auth(x_auth)
    import smeta_store as ST
    return {"smetas": ST.listing()}


@app.get("/api/smeta_load")
def smeta_load(n: int, x_auth: str = Header(None)):
    _auth(x_auth)
    import smeta_store as ST
    rec = ST.load(n)
    if not rec:
        raise HTTPException(status_code=404, detail="Смета не найдена")
    return rec


@app.post("/api/smeta_delete")
def smeta_delete(body: SmetaDelIn, x_auth: str = Header(None)):
    _auth(x_auth)
    import smeta_store as ST
    return {"ok": ST.delete(body.n)}


@app.post("/api/project/save")
def project_save(body: ProjectSaveIn, x_auth: str = Header(None)):
    _auth(x_auth)
    import project_store as PS
    res = PS.save(body.n, body.name, body.object, body.vors, body.smetas, body.passport, body.objects, body.project_type)
    if res is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return res


@app.post("/api/project/vor_parent")
def project_vor_parent(body: ProjectVorParentIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rec = PS.set_vor_parent(body.n, body.file_id, body.sub_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Проект или подобъект не найден")
    return rec


@app.get("/api/project/list")
def project_list(x_auth: str = Header(None)):
    _auth(x_auth)
    import project_store as PS
    return {"projects": PS.listing()}


@app.post("/api/vor/edit_log")
def vor_edit_log(body: EditLogIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import edit_journal as EJ
    n = 0
    for e in (body.edits or [])[:200]:
        if isinstance(e, dict) and EJ.log(e):
            n += 1
    return {"ok": True, "logged": n}


@app.get("/api/vor/edit_stats")
def vor_edit_stats(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import edit_journal as EJ
    return EJ.stats()


@app.get("/api/vor/rules")
def vor_rules(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import rules_mine as RM
    return RM.mine()


class VorStage1In(BaseModel):
    rows: list
    criteria: dict = {}


@app.post("/api/vor/stage1")
def vor_stage1(body: VorStage1In, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import stage1_rules as S1
    return S1.propose(body.rows or [], body.criteria or {})


@app.get("/api/lim_zatraty")
def lim_zatraty(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "shnk_lim_zatraty.json")
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="Справочник лимитированных затрат не найден")
    with open(p, encoding="utf-8") as f:
        return _json.load(f)


@app.get("/api/project/subs")
def project_subs(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    return {"subs": PS.subs_index()}


@app.get("/api/project/load")
def project_load(n: int, x_auth: str = Header(None)):
    _auth(x_auth)
    import project_store as PS
    rec = PS.load(n)
    if not rec:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return rec


@app.post("/api/project/add_vor")
def project_add_vor(body: ProjectVorIn, x_auth: str = Header(None)):
    _auth(x_auth)
    import project_store as PS
    rec = PS.add_vor(body.n, body.vor)
    if rec is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return {"ok": True, "n": rec["n"], "n_vors": len(rec.get("vors", []))}


@app.post("/api/project/update_vor")
def project_update_vor(body: ProjectVorUpdateIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rec = PS.update_vor_rows(body.n, body.vor_index, body.rows)
    if rec is None:
        raise HTTPException(status_code=404, detail="Проект или ВОР не найден")
    return {"ok": True, "n": rec["n"], "n_rows": len(body.rows)}


@app.post("/api/vor/compound_preview")
def vor_compound_preview(body: dict = Body(...), x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import vor_router as VR
    out = []
    for i, r in enumerate(body.get("rows") or []):
        nm = (r.get("name") or "").strip()
        parts = VR.compound_parts(nm) if nm else []
        out.append({"i": r.get("i", i), "parts": parts if len(parts) >= 2 else []})
    return {"ok": True, "results": out, "n": sum(1 for x in out if x["parts"])}


@app.get("/api/project/vor_revisions")
def project_vor_revisions(n: int, vor_index: int = 0, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    return {"ok": True, "revisions": PS.revisions(n, vor_index)}


@app.get("/api/project/vor_revision")
def project_vor_revision(n: int, k: int, vor_index: int = 0, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rows = PS.revision_rows(n, vor_index, k)
    if rows is None:
        raise HTTPException(status_code=404, detail="Версия не найдена")
    return {"ok": True, "rows": rows, "n_rows": len(rows)}


@app.post("/api/wbs/instantiate")
def wbs_instantiate_ep(body: WbsInstantiateIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import wbs_instantiate as WI
    return WI.instantiate(body.criteria)


_CRITERIA_OPTS = {
    "type": ["Жилой дом (многоквартирный)", "Индивидуальный жилой дом", "Общественное здание",
             "Административное здание", "Производственное здание", "Складское здание", "Инженерное сооружение"],
    "scenario": ["Новое строительство", "Реконструкция", "Техперевооружение", "Расширение",
                 "Капитальный ремонт", "Реставрация"],
    "structure": ["Монолитный железобетон", "Сборный железобетон (панельный)", "Кирпичная кладка",
                  "Каркасный (металл)", "Каркасный (дерево)", "Смешанный"],
    "floors": ["1 этаж", "2–3 этажа", "4–5 этажей", "6–9 этажей", "10–16 этажей", "17+ этажей"],
    "finish_quality": ["Простая", "Улучшенная", "Высококачественная"],
    "decor_method": ["Ручное", "Механизированное"],
}
_CRITERIA_REQUIRED = ("type", "scenario", "structure", "floors")


def _criteria_prompt(stamp: dict, obj_name: str, names: list) -> str:
    """IISMETA cost-estimation engine module."""
    labels = {"type": "Тип объекта", "scenario": "Сценарий (характер работ)",
              "structure": "Конструктив НЕСУЩИХ СТЕН И КАРКАСА здания (не кровли, не фасада, не обшивки)",
              "floors": "Этажность",
              "finish_quality": "Качество отделки (по формулировкам работ: «улучшенная штукатурка», "
                                "«высококачественная окраска»)",
              "decor_method": "Нанесение декоративных покрытий (ручное / механизированное) — "
                              "ВОР называет это редко, пустой ответ нормален"}
    opts = "\n".join("- %s — строго один из: %s" % (labels[k], " | ".join(v)) for k, v in _CRITERIA_OPTS.items())
    stamp_txt = "\n".join("%s: %s" % (k, v) for k, v in (stamp or {}).items() if v) or "(штамп пуст)"
    rows_txt = "\n".join("- " + n for n in names)
    return (
        "Ты — сметчик. Тебе дано СОДЕРЖИМОЕ загруженной ведомости объёмов работ (ВОР) строительного объекта.\n"
        "ЗАДАЧА: определить характеристики объекта СТРОГО по этому содержимому.\n"
        "ЖЁСТКИЕ ПРАВИЛА:\n"
        "1. Опирайся ТОЛЬКО на приведённые ниже данные (штамп + наименования работ). Внешние знания, "
        "домыслы и предположения вне документа ЗАПРЕЩЕНЫ.\n"
        "2. Если поле нельзя обоснованно вывести из содержимого — верни пустую строку \"\" для него.\n"
        "3. Значения — СТРОГО из списков ниже, дословно. Ничего своего.\n"
        "4. Ответ — ТОЛЬКО JSON-объект, без пояснений.\n"
        "5. КОНСТРУКТИВ — ОСОБО СТРОГО. Это материал НЕСУЩИХ СТЕН/КАРКАСА здания. НЕ выводи его из:\n"
        "   • кровли и её покрытия (профлист, профнастил, металлочерепица, сэндвич-панели кровли);\n"
        "   • фасадной обшивки и облицовки (алюкобонд, алюпан, вентфасад, сайдинг);\n"
        "   • подвесных потолков, перегородок, витражей, окон, дверей, ограждений.\n"
        "   Металлический профлист на КРОВЛЕ кирпичного здания — это НЕ металлокаркас.\n"
        "   Ставь конструктив, ТОЛЬКО если в ВОР есть прямая работа по несущим стенам/каркасу\n"
        "   (кладка стен, монтаж стеновых панелей, монтаж каркаса/колонн/ферм здания, монолитные\n"
        "   стены). Отделочный ВОР (АР) обычно такого НЕ содержит — тогда верни \"\" (пусто).\n\n"
        "ПОЛЯ И ДОПУСТИМЫЕ ЗНАЧЕНИЯ:\n" + opts + "\n\n"
        "ШТАМП ОБЪЕКТА:\nимя: %s\n%s\n\n" % (obj_name or "", stamp_txt) +
        "НАИМЕНОВАНИЯ РАБОТ ИЗ ВОР (выборка):\n" + rows_txt + "\n\n"
        "Верни JSON вида: {\"type\":\"\",\"scenario\":\"\",\"structure\":\"\",\"floors\":\"\","
        "\"finish_quality\":\"\",\"decor_method\":\"\"}"
    )


def _parse_criteria(raw: str) -> dict:
    """IISMETA cost-estimation engine module."""
    import re as _re
    m = _re.search(r"\{.*\}", raw or "", _re.S)
    if not m:
        return {}
    try:
        d = _json.loads(m.group(0))
    except Exception:
        return {}
    out = {}
    for k, allowed in _CRITERIA_OPTS.items():
        v = (d.get(k) or "").strip()
        if v in allowed:
            out[k] = v
    return out


@app.post("/api/project/infer_criteria")
def project_infer_criteria(body: InferCriteriaIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rec = PS.load(body.n)
    if not rec:
        raise HTTPException(status_code=404, detail="Проект не найден")
    _o, obj = PS.find_sub(rec, body.object_id)
    if not obj:
        parent = next((o for o in rec.get("objects", []) if o.get("id") == body.object_id), None)
        subs = (parent or {}).get("subs") or []
        obj = subs[0] if len(subs) == 1 else None
    if not obj:
        raise HTTPException(status_code=404, detail="Подобъект не найден")
    fids = set(obj.get("vor_file_ids") or [])
    names, stamp = [], {}
    for v in rec.get("vors", []):
        if fids and v.get("file_id") not in fids:
            continue
        doc = v.get("document") or {}
        for k in ("project", "area", "doc_no", "customer", "contractor", "designer"):
            if doc.get(k) and not stamp.get(k):
                stamp[k] = doc.get(k)
        for r in v.get("rows", []):
            nm = (r.get("name") or "").strip()
            if nm:
                names.append(nm)
    if not names:
        return {"ok": False, "note": "нет распознанных строк ВОР для этого объекта — сначала распознайте"}
    try:
        import llm_normalize as LN
        if not LN.llm_available():
            return {"ok": False, "note": "AI офлайн (нет ANTHROPIC_API_KEY на сервере)"}
        raw = LN._call_claude(_criteria_prompt(stamp, obj.get("name"), names[:80]), timeout=60)
        crit = _parse_criteria(raw)
    except Exception as e:
        return {"ok": False, "note": "AI: %s" % str(e)[:200]}
    return {"ok": True, "criteria": crit, "n_filled": len(crit), "n_rows_seen": len(names)}


@app.post("/api/project/remove_file")
def project_remove_file(body: ProjectFileIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rec = PS.remove_file(body.n, body.file_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return {"ok": True, "n": rec["n"], "n_files": len(rec.get("files", []))}


@app.post("/api/project/reclassify_file")
def project_reclassify_file(body: ProjectFileIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rec = PS.reclassify_file(body.n, body.file_id, body.klass or "vor")
    if rec is None:
        raise HTTPException(status_code=404, detail="Проект или файл не найден")
    return {"ok": True, "n": rec["n"]}


@app.post("/api/project/completeness")
def project_completeness(body: ProjectCompletenessIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    import wbs_instantiate as WI
    rec = PS.load(body.n)
    if not rec:
        raise HTTPException(status_code=404, detail="Проект не найден")

    expected = set()
    for _o, sub in PS.subs_of(rec):
        try:
            tree = WI.instantiate(sub.get("criteria") or {})
        except Exception:
            continue
        for s in tree.get("stages", []):
            if s.get("n_primary", 0) > 0:
                expected.add(s["key"])

    covered = {}          # stage_key → n_rows
    n_rows = n_unmapped = 0
    try:
        import discipline_funnel as DF
        import vor_router as VR
        import kb_engine as KBE
        funnel_ok = True
    except Exception:
        funnel_ok = False
    if funnel_ok:
        for v in rec.get("vors", []):
            for r in (v.get("rows", []))[:4000]:
                name = (r.get("name") or "").strip()
                if not name:
                    continue
                n_rows += 1
                sec = r.get("section")
                sec = sec if isinstance(sec, str) else ""
                hit = VR.route_row(name, sec or None)
                if hit:
                    wc = KBE.wc_by_table(hit[1])
                    canon = DF.canon_of_wc(wc) if wc else None
                    st = canon.get("stage") if canon else None
                    if st:
                        covered[st["key"]] = covered.get(st["key"], 0) + 1
                        continue
                n_unmapped += 1

    stages_meta = {s["key"]: s for s in WI.all_stages()}
    keys = sorted(set(expected) | set(covered), key=lambda k: stages_meta.get(k, {}).get("order", 99))
    stages = []
    for k in keys:
        m = stages_meta.get(k, {"key": k, "title": k, "order": 99})
        exp = k in expected
        nr = covered.get(k, 0)
        stages.append({"key": k, "title": m["title"], "order": m["order"],
                       "expected": exp, "n_rows": nr,
                       "status": ("covered" if nr else ("missing" if exp else "extra")) if exp or nr else "none"})
    n_missing = sum(1 for s in stages if s["status"] == "missing")
    return {"ok": True, "n": body.n, "n_objects": len(rec.get("objects", [])),
            "n_vors": len(rec.get("vors", [])), "n_rows": n_rows, "n_unmapped": n_unmapped,
            "funnel_ok": funnel_ok, "stages": stages,
            "summary": {"n_expected": len(expected), "n_covered": sum(1 for s in stages if s["n_rows"]),
                        "n_missing": n_missing}}


@app.post("/api/project/delete")
def project_delete(body: ProjectDelIn, x_auth: str = Header(None)):
    _auth(x_auth)
    import project_store as PS
    return {"ok": PS.delete(body.n)}


@app.post("/api/project/intake")
async def project_intake(n: int = Form(...), files: List[UploadFile] = File(...), x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    if not PS.load(n):
        raise HTTPException(status_code=404, detail="Проект не найден")
    try:
        import project_intake as PI
    except Exception as e:
        raise HTTPException(status_code=503, detail="Классификатор недоступен: %s" % e)

    CAP = 80
    flat = []
    for uf in files:
        data = await uf.read()
        if not data:
            continue
        if (uf.filename or "").lower().endswith(".zip"):
            flat.extend(PI.unpack_zip(data))
        else:
            flat.append((uf.filename or "file", data))

    truncated = max(0, len(flat) - CAP)
    flat = flat[:CAP]

    classified, counts = [], {}
    obj_pick, proj_pick, stamp_pick = None, None, None
    for name, data in flat:
        try:
            c = PI.classify(name, data)
        except Exception as e:
            c = {"filename": name, "ext": "", "klass": "other", "confidence": 0.0,
                 "discipline": None, "doctype": None, "meta": {}, "signals": ["ошибка: %s" % e]}
        path = PS.save_file_bytes(n, name, data)
        rec = {"id": "f%d" % (len(classified) + 1), "filename": c["filename"], "ext": c["ext"],
               "klass": c["klass"], "confidence": c["confidence"], "discipline": c.get("discipline"),
               "doctype": c.get("doctype"), "meta": c.get("meta", {}), "signals": c.get("signals", []),
               "size": len(data), "path": path, "vor_recognized": False}
        PS.add_file(n, rec)
        classified.append(rec)
        counts[c["klass"]] = counts.get(c["klass"], 0) + 1
        if c["klass"] == "vor":
            m = c.get("meta", {})
            if not obj_pick and m.get("object"):
                obj_pick = m.get("object")
            if not proj_pick and m.get("project"):
                proj_pick = m.get("project")
            if stamp_pick is None and (m.get("customer") or m.get("contractor") or m.get("designer")):
                stamp_pick = m

    if proj_pick or obj_pick:
        PS.set_fields(n, name=proj_pick, obj=obj_pick)
    if stamp_pick:
        PS.set_passport(n, {"customer": stamp_pick.get("customer"),
                            "contractor": stamp_pick.get("contractor"),
                            "designer": stamp_pick.get("designer"),
                            "shifr": stamp_pick.get("doc_no") or stamp_pick.get("project")}, only_if_empty=True)

    return {"ok": True, "n": n, "n_files": len(classified), "truncated": truncated,
            "counts": counts, "files": classified,
            "autofill": {"object": obj_pick, "project": proj_pick}}


_RX_NODE_HEAD = re.compile(r"\d{1,4}\s*шт[^)]{0,40}расход|расход[^)]{0,40}\d{1,4}\s*шт"
                           r"|\(\s*\d{1,4}\s*шт\s*\)", re.I)


def _sec_name_of(r, cur_sec_name):
    """IISMETA cost-estimation engine module."""
    rs = ((r.get("extra") or {}).get("section_name") or "").strip()
    if rs and _RX_NODE_HEAD.search(rs):
        rs = ""
    return rs or cur_sec_name or ""


def _sec_head_row(r, cur_sec_name, page):
    """IISMETA cost-estimation engine module."""
    hn = (r.get("name") or "").strip()
    parent = cur_sec_name if _RX_NODE_HEAD.search(hn) else hn
    return hn, {"page": page, "pos": r.get("pos"), "name": hn,
                "unit": None, "qty": None, "qty_raw": None,
                "section": parent or "",
                "confidence": r.get("confidence"),
                "note": (r.get("extra") or {}).get("note"),
                "doc_note": (r.get("extra") or {}).get("doc_note"),
                "code_src": r.get("code_src")}


@app.post("/api/project/recognize_vors")
def project_recognize_vors(body: ProjectRecognizeIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import project_store as PS
    rec = PS.load(body.n)
    if not rec:
        raise HTTPException(status_code=404, detail="Проект не найден")
    try:
        from vor_engine.router import digitize as _digitize
        import pdfplumber as _pp
    except Exception as e:
        raise HTTPException(status_code=503, detail="Движок распознавания недоступен: %s" % e)

    pending = [f for f in rec.get("files", [])
               if f.get("klass") == "vor" and not f.get("vor_recognized") and f.get("path")
               and os.path.exists(f["path"])]
    cap = max(1, min(int(body.cap or 25), 40))
    done, total_rows, details = 0, 0, []
    for f in pending[:cap]:
        fext = (os.path.splitext(f["path"])[1] or "").lower().lstrip(".")
        rows, document, extractor, err = [], None, None, None
        cur_sec_name = None
        st = {"rows": 0, "autocommit": 0, "review": 0, "errors": 0, "warnings": 0}
        if fext and fext != "pdf":
            try:
                import office_vor as OV
                res = OV.ingest(f["path"], f.get("filename") or f["path"])
                document = res.get("document")
                extractor = res.get("extractor")
                for r in res.get("rows", []):
                    rows.append({"page": r.get("page", 1), "pos": r.get("pos"), "name": r.get("name"),
                                 "unit": r.get("unit"), "qty": r.get("qty"), "qty_raw": r.get("qty_raw"),
                                 "section": r.get("section"), "confidence": r.get("confidence")})
            except Exception as e:
                err = "office-ингест: %s" % e
        else:
            try:
                with _pp.open(f["path"]) as pdf:
                    n_pages = min(len(pdf.pages), 40)
            except Exception:
                n_pages = 1
            for p in range(n_pages):
                try:
                    res = _digitize(f["path"], p, cross_check=False)
                except Exception:
                    continue
                if not res.get("ok"):
                    continue
                if document is None:
                    document = res.get("document")
                extractor = res.get("extractor_used") or extractor
                for tbl in res.get("tables", []):
                    s = tbl["validation"]["stats"]
                    st["autocommit"] += s.get("n_autocommit", 0); st["review"] += s.get("n_review", 0)
                    st["errors"] += s.get("errors", 0); st["warnings"] += s.get("warnings", 0)
                    for r in tbl.get("rows", []):
                        if r.get("kind") == "section" and (r.get("name") or "").strip():
                            _hn, _par = _sec_head_row(r, cur_sec_name, p + 1)
                            rows.append(_par)
                            if not _RX_NODE_HEAD.search(_hn):
                                cur_sec_name = _hn
                            continue
                        if r.get("kind") != "data":
                            continue
                        _rs = _sec_name_of(r, cur_sec_name)
                        rows.append({"page": p + 1, "pos": r.get("pos"), "name": r.get("name"),
                                     "unit": r.get("unit"), "qty": r.get("qty"), "qty_raw": r.get("qty_raw"),
                                     "section": _rs,
                                     "note": (r.get("extra") or {}).get("note"),
                                     "doc_note": (r.get("extra") or {}).get("doc_note"),
                                     "confidence": r.get("confidence")})
        st["rows"] = len(rows)
        total_rows += len(rows)
        if not rows and not err:
            err = "0 строк-работ (файл не похож на ведомость — проверьте, что это ВОР с таблицей)"
        details.append({"filename": f["filename"], "rows": len(rows), "extractor": extractor, "error": err})
        vor = {"filename": f["filename"], "ts": _time.strftime("%Y-%m-%d %H:%M:%S"),
               "document": document, "stats": st, "extractor": extractor, "rows": rows,
               "discipline": f.get("discipline"), "file_id": f.get("id")}
        cur = PS.load(body.n)
        cur.setdefault("vors", []).append(vor)
        for ff in cur.get("files", []):
            if ff.get("id") == f.get("id"):
                ff["vor_recognized"] = True
        PS.replace(body.n, cur)
        done += 1

    PS.ensure_objects_from_vors(body.n)
    PS.autofill_from_stamps(body.n)
    pending_left = max(0, len(pending) - done)
    return {"ok": True, "n": body.n, "recognized": done, "rows": total_rows,
            "pending_left": pending_left, "details": details}


@app.post("/api/extra_resource")
def extra_resource(body: ExtraResIn, x_auth: str = Header(None)):
    _auth(x_auth)
    nm = (body.name or "").strip()
    if not nm or not (body.qty and body.qty > 0):
        return {"error": "Нужно наименование ресурса и количество."}
    shifr = (body.code or "").strip() or "—"
    res = [{"res": shifr, "name": nm, "unit": (body.unit or "").strip(), "val": 1.0,
            "стоимость": float(body.cost or 0.0)}]
    nm_full = nm + " (ресурс вне расценки)"
    row = {"вход": nm_full, "объём": float(body.qty), "статус": "🟢", "кратность": 1,
           "вид": {"work_code": "ВНЕ", "имя": nm_full}, "вариант": {"code": "ВНЕ", "имя": nm_full},
           "коэффициенты": [], "_baked": True, "ресурсы": res,
           "измеритель": (body.unit or "ед").strip() or "ед", "вариант_доп": "", "состав": "",
           "доп_позиции": [], "перевозка_расценка": None,
           "раздел": "Ресурсы вне расценок", "_shifr": shifr, "_поправки": []}
    return {"ok": True, "shifr": shifr, "name": nm_full, "izm": (body.unit or "ед"),
            "objem": body.qty, "nres": 1, "resolved": row}


@app.post("/api/perevozka_dist")
def perevozka_dist(body: PerevozkaDistIn, x_auth: str = Header(None)):
    _auth(x_auth)
    row = _perevozka_dist_row(body.text, body.L_km, body.tonnes)
    if not row:
        return {"error": "Нет нормы перевозки на это расстояние (доступно по таблице р.4)."}
    return {"ok": True, "shifr": row["_shifr"], "name": row["вход"], "izm": "т",
            "objem": body.tonnes, "nres": len(row["ресурсы"]), "resolved": row}


@app.post("/api/login")
def login(body: LoginIn):
    if not _eq_const(body.password, APP_PASSWORD):
        raise HTTPException(status_code=401, detail="Неверный пароль")
    return {"ok": True, "token": _sess_new("Каримова З."), "operator": "Каримова З."}


@app.post("/api/logout")
def logout(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _sess_drop(x_auth)
    return {"ok": True}


@app.get("/api/tree")
def tree(x_auth: str = Header(None)):
    _auth(x_auth)
    if hasattr(WZ, "tree_nested"):
        nodes = WZ.tree_nested()
        nworks = len(WZ._load())
    else:
        vidy = WZ._load()
        tr = OrderedDict()
        for wc, t in vidy.items():
            r = t.get("razdel") or "Прочее"
            p = t.get("podrazdel") or "—"
            tr.setdefault(r, OrderedDict()).setdefault(p, []).append(
                {"code": wc, "name": t["vid"], "izm": t.get("izmeritel", ""), "n": t.get("n_var", 0), "leaf": True})
        nodes = []
        for razdel, subs in tr.items():
            children = []
            for p, works in subs.items():
                if p and p != "—":
                    children.append({"kind": "Подраздел", "name": p, "children": works})
                else:
                    children.extend(works)
            nodes.append({"kind": "Раздел", "name": razdel, "children": children})
        nworks = len(vidy)
    try:
        import canary
        nodes = list(nodes) + [canary.tree_node()]
    except Exception:
        pass
    return {"sbornik": getattr(WZ, "SBORNIK_LABEL", "Сб.01 ШНК 4.02.01-04 «Земляные работы»"),
            "tree": nodes, "n_works": nworks}


@app.get("/api/analyze")
def analyze(wc: str, x_auth: str = Header(None)):
    _auth(x_auth)
    _track(x_auth, wc)
    a = WZ.analyze(wc)
    if not a:
        raise HTTPException(status_code=404, detail="Работа не найдена")
    a["состав_работ"] = SOSTAV.get(wc, "")
    return a


@app.post("/api/compute")
def compute(body: ComputeIn, x_auth: str = Header(None)):
    _auth(x_auth)
    _track(x_auth, body.wc)
    if KB:
        return WZ.compute(body.wc, body.objem, body.choices, body.swaps or {}, body.qtys or {})
    return WZ.compute(body.wc, body.objem, body.choices)


@app.get("/api/beton_marks")
def beton_marks(x_auth: str = Header(None)):
    _auth(x_auth)
    return WZ.beton_library() if hasattr(WZ, "beton_library") else {}


@app.get("/api/material_catalog")
def material_catalog(x_auth: str = Header(None)):
    _auth(x_auth)
    return WZ.material_catalog() if hasattr(WZ, "material_catalog") else {"материалы": []}


@app.get("/api/user_resources")
def user_resources_list(x_auth: str = Header(None)):
    _auth(x_auth)
    import user_resources as UR
    return {"items": UR.list_all()}


@app.post("/api/user_resource_add")
async def user_resource_add(request: Request, x_auth: str = Header(None)):
    _auth(x_auth)
    import user_resources as UR
    b = await request.json()
    item = UR.add(b.get("name", ""), b.get("unit", ""), b.get("cost", ""), b.get("kind", "материал"))
    if item.get("error"):
        return item
    return {"ok": True, "item": item}


@app.get("/api/positions")
def positions(wc: str, x_auth: str = Header(None)):
    _auth(x_auth)
    _track(x_auth, wc)
    return {"positions": WZ.positions(wc)}


@app.post("/api/compute_pos")
def compute_pos(body: ComputePosIn, x_auth: str = Header(None)):
    _auth(x_auth)
    _track(x_auth, body.code or body.wc)
    if KB:
        return WZ.compute_code(body.wc, body.objem, body.code, body.swaps or {}, body.qtys or {}, body.drops or [])
    return WZ.compute_code(body.wc, body.objem, body.code)


class ComputeByCodeIn(BaseModel):
    code: str
    objem: float = 100.0


@app.post("/api/compute_by_code")
def compute_by_code(body: ComputeByCodeIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    code = (body.code or "").strip()
    if len(code) <= 8:
        raise HTTPException(status_code=400, detail="Не похоже на шифр нормы: %r" % code)
    table = "%s-%s-%s" % (code[1:3], code[3:5], code[6:9])
    wc = _wc_by_table(WZ._index(), table)
    if not wc:
        raise HTTPException(status_code=404, detail="Таблица %s не найдена в базе расценок" % table)
    _track(x_auth, code)
    comp = WZ.compute_code(wc, body.objem, code)
    if comp.get("error"):
        raise HTTPException(status_code=404, detail=comp["error"])
    return {"wc": wc, "code": code, "objem": body.objem, "shifr": comp["shifr"],
            "name": comp["наименование"], "izm": comp["измеритель"],
            "nres": len(comp.get("ресурсы") or [])}


@app.get("/api/security_status")
def security_status(x_auth: str = Header(None)):
    _admin(x_auth)
    top = sorted(((len(s["codes"]), str(t)[-4:]) for t, s in _SCRAPE.items()), reverse=True)[:5]
    return {"alerts": list(_ALERTS),
            "top_tokens_by_codes_1h": [{"codes": n, "token_tail": tt} for n, tt in top],
            "day_counts": {str(t)[-4:]: d[1] for t, d in _DAY.items()},
            "limits": {"per_min": _RL_MAX_DATA, "per_day": _RL_MAX_DAY, "scrape_codes_1h": _SCRAPE_MAX_CODES}}


@app.get("/api/usloviya")
def usloviya(x_auth: str = Header(None)):
    _auth(x_auth)
    return _load_usloviya()


@app.get("/api/techpart")
def techpart(key: str, x_auth: str = Header(None)):
    _auth(x_auth)
    t = WZ._techchasti().get(key) if hasattr(WZ, "_techchasti") else None
    if not t:
        raise HTTPException(status_code=404, detail="Текст техчасти не найден")
    return {"key": key, "src": t.get("src", ""), "text": t.get("text", "")}


@app.get("/api/techdoc")
def techdoc(file: str, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    idx = WZ._techdocs() if hasattr(WZ, "_techdocs") else {}
    allowed = {d["file"] for docs in idx.values() for d in docs}
    if file not in allowed:
        raise HTTPException(status_code=404, detail="Документ тех.части не найден")
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "0_БД_расценок", "techdocs", file)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="Файл документа отсутствует на сервере")
    return {"file": file, "html": open(p, encoding="utf-8", errors="replace").read()}


_METOD_MIME = {".pdf": "application/pdf", ".doc": "application/msword",
               ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


@app.get("/api/metodologiya")
def metodologiya(x_auth: str = Header(None)):
    _auth(x_auth)
    m = _load_metod()
    out = []
    for it in m.get("документы", []):
        row = dict(it)
        for k in ("doc", "pdf"):
            if k in row:
                p = _metod_path(row[k])
                row[k + "_avail"] = bool(p and os.path.exists(p))
        out.append(row)
    return {"заголовок": m.get("заголовок", "Методология"), "документы": out}


@app.get("/api/metodologiya_doc")
def metodologiya_doc(n: int, fmt: str = "pdf", x_auth: str = Header(None)):
    _auth(x_auth)
    fmt = "doc" if fmt == "doc" else "pdf"
    it = next((d for d in _load_metod().get("документы", []) if d.get("n") == n), None)
    if not it or fmt not in it:
        raise HTTPException(status_code=404, detail="Документ не найден в оглавлении")
    p = _metod_path(it[fmt])
    if not p or not os.path.exists(p):
        raise HTTPException(status_code=404, detail="Файл ещё не загружен на диск")
    ext = os.path.splitext(p)[1].lower()
    return FileResponse(p, media_type=_METOD_MIME.get(ext, "application/octet-stream"),
                        content_disposition_type="inline")


@app.post("/api/admin/metod_upload")
async def metod_upload(request: Request, name: str, x_auth: str = Header(None)):
    _admin(x_auth)
    p = _metod_path(name)
    if not p:
        return {"error": "Некорректное имя файла"}
    body = await request.body()
    if not body:
        return {"error": "Пустое тело запроса"}
    if len(body) > 64 * 1024 * 1024:
        return {"error": "Файл больше 64МБ"}
    os.makedirs(_metod_dir(), exist_ok=True)
    with open(p, "wb") as f:
        f.write(body)
    return {"ok": True, "name": os.path.basename(p), "size": len(body)}


@app.get("/api/admin/metod_status")
def metod_status(x_auth: str = Header(None)):
    _admin(x_auth)
    d = _metod_dir()
    on_disk = {}
    if os.path.isdir(d):
        for f in os.listdir(d):
            if not f.startswith("."):
                on_disk[_ud.normalize("NFC", f)] = os.path.getsize(os.path.join(d, f))
    need = {}
    for it in _load_metod().get("документы", []):
        for k in ("doc", "pdf"):
            if k in it:
                need[_ud.normalize("NFC", it[k])] = it.get(k + "_size", 0)
    missing = sorted(set(need) - set(on_disk))
    size_mismatch = sorted(f for f in set(need) & set(on_disk) if need[f] and need[f] != on_disk[f])
    return {"dir": d, "on_disk": len(on_disk), "total_bytes": sum(on_disk.values()),
            "need": len(need), "missing": missing, "size_mismatch": size_mismatch}


def _resolve_rows(rows):
    """IISMETA cost-estimation engine module."""
    resolved = []
    for row in rows:
        if row.get("sec"):
            resolved.append({"sec": True, "kind": row.get("kind", ""), "name": row.get("name", ""),
                             "num": row.get("num", "")}); continue
        if row.get("cond"):
            resolved.append({"cond": True, "kzt": row.get("kzt", 1), "kem": row.get("kem", 1),
                             "num": row.get("num", ""), "usl": row.get("usl", ""),
                             "text": row.get("text", ""), "section": row.get("section", ""),
                             "group": row.get("group", "MAIN")}); continue
        if row.get("prebuilt"):
            resolved.append(row["prebuilt"]); continue
        if row.get("material"):
            nm = (row.get("name") or "").strip()
            unit = (row.get("izm") or "").strip() or "ед"
            qty = float(row.get("objem") or 0)
            mat_code = (row.get("mat_code") or "").strip()
            cand = None
            res_code, res_name, res_unit = "—", nm, unit
            if mat_code and hasattr(WZ, "_swap_target"):
                try:
                    tgt = WZ._swap_target(mat_code)
                except Exception:
                    tgt = None
                if tgt:
                    res_code, res_name = mat_code, tgt.get("наим") or nm
                    res_unit = tgt.get("ед") or unit
            elif hasattr(WZ, "match_material"):
                try:
                    cand = WZ.match_material(nm, top_k=5)
                except Exception:
                    cand = None
            resolved.append({
                "вход": nm, "объём": qty, "статус": "🟢", "кратность": 1,
                "вид": {"work_code": "ВНЕ", "имя": nm}, "вариант": {"code": "ВНЕ", "имя": nm},
                "коэффициенты": [], "_baked": True,
                "ресурсы": [{"res": res_code, "name": res_name, "unit": res_unit, "val": 1.0, "стоимость": 0.0}],
                "измеритель": unit, "вариант_доп": "", "состав": "", "доп_позиции": [],
                "перевозка_расценка": None, "раздел": "Материалы по проекту",
                "_matcand": cand, "_shifr": res_code, "_поправки": [],
            })
            continue
        rr = _make_resolved(row.get("wc"), row.get("objem", 100.0),
                            row.get("choices", {}), row.get("picks", []), row.get("code"),
                            row.get("swaps", {}), row.get("qtys", {}), row.get("drops", []),
                            row.get("krat", 1), row.get("krat_text", ""))
        if rr:
            if row.get("objem_base") is not None and row.get("k"):
                rr["_disp_objem"] = row.get("objem_base")
                rr["_disp_k"] = row.get("k")
            resolved.append(rr)
        else:
            resolved.append({"err": True,
                             "name": row.get("code") or row.get("wc") or "расценка",
                             "wc": row.get("wc") or "", "code": row.get("code") or ""})
    return resolved


@app.post("/api/smeta")
def smeta(body: SmetaIn, x_auth: str = Header(None)):
    _auth(x_auth)
    works = L.apply_usloviya(L.build_lrv(_resolve_rows(body.rows)))
    svod = []
    for title, items in L.res_vedomost(works):
        svod.append({"title": title,
                     "items": [{"шифр": it["шифр"], "наим": it["наим"], "ед": it["ед"], "кол": it["кол"]}
                               for it in items]})
    works_out = []
    for w in works:
        if w.get("sec"):
            works_out.append({"sec": True, "kind": w.get("kind", ""), "наим": w.get("наим", ""),
                              "num": w.get("num", "")}); continue
        if w.get("cond"):
            works_out.append({"cond": True, "kzt": w.get("kzt"), "kem": w.get("kem"), "num": w.get("num", ""),
                              "usl": w.get("usl", ""), "text": w.get("text", ""),
                              "section": w.get("section", ""), "scope": w.get("_scope", "вся смета"),
                              "group": w.get("group", "MAIN"), "warn": w.get("_warn", "")}); continue
        if w.get("err"):
            works_out.append({"err": True, "наим": w.get("наим", ""), "код": w.get("код", "")}); continue
        works_out.append({"код": w["код"], "наим": w["наим"], "попр": w.get("попр", ""), "измеритель": w["измеритель"],
                          "объём": w["объём"], "Кр": w["Кр"], "статус": w["статус"], "доп": bool(w.get("доп", False)),
                          "состав": w.get("состав", ""), "ресурсы": w["ресурсы"]})
    _real = [w for w in works if not w.get("sec") and not w.get("cond") and not w.get("err")]
    return {"works": works_out, "svod": svod,
            "n_works": len(_real), "n_res": sum(len(w["ресурсы"]) for w in _real)}


@app.post("/api/excel")
def excel(body: SmetaIn, x_auth: str = Header(None)):
    _auth(x_auth)
    works = L.apply_usloviya(L.build_lrv(_resolve_rows(body.rows)))
    bg = body.glob or {}
    g = {"тип": "", "грунт": "", "состояние": "", "обводнённость": "", "способы": [], "особые": [],
         "стройка": bg.get("стройка", ""), "объект": bg.get("объект", ""),
         "основание": bg.get("основание", ""), "номер": bg.get("номер", "")}
    data = L.to_excel_res(works, g) if body.kind == "res" else L.to_excel(works, g)
    fname = "Smeta_RES.xlsx" if body.kind == "res" else "Smeta_LRV.xlsx"
    n_err = sum(1 for r in (_resolve_rows(body.rows) or []) if isinstance(r, dict) and r.get("err"))
    hdrs = {"Content-Disposition": "attachment; filename=%s" % fname,
            "X-Skipped-Rows": str(n_err), "Access-Control-Expose-Headers": "X-Skipped-Rows"}
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=hdrs)


@app.post("/api/vor/digitize")
async def vor_digitize(file: UploadFile = File(...), x_auth: str = Header(None)):
    _auth(x_auth)
    import tempfile
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Пустой файл")
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Файл слишком большой (> 30 МБ)")

    fname = file.filename or "file"
    ext = (os.path.splitext(fname)[1] or "").lower().lstrip(".")
    if ext and ext != "pdf":
        try:
            import office_vor as OV
        except Exception as e:
            raise HTTPException(status_code=503, detail="Ингест документов недоступен: %s" % e)
        suffix = "." + ext
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        try:
            tmp.write(data); tmp.close()
            try:
                return OV.ingest(tmp.name, fname)
            except Exception as e:
                raise HTTPException(status_code=400, detail="Не удалось разобрать документ (%s): %s" % (ext, e))
        finally:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass

    try:
        from vor_engine.router import digitize as _digitize
        import pdfplumber as _pp
    except Exception as e:
        raise HTTPException(status_code=503, detail="Движок распознавания ВОР недоступен: %s" % e)

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tmp.write(data); tmp.close()
        try:
            with _pp.open(tmp.name) as pdf:
                n_pages = len(pdf.pages)
        except Exception:
            raise HTTPException(status_code=400, detail="Не удалось открыть PDF")
        n_pages = min(n_pages, 40)

        rows, issues = [], []
        document, extractor = None, None
        cur_sec_name = None
        st = {"rows": 0, "autocommit": 0, "review": 0, "errors": 0, "warnings": 0}
        for p in range(n_pages):
            try:
                res = _digitize(tmp.name, p, cross_check=False)
            except Exception as e:
                issues.append({"severity": "error", "code": "ENGINE",
                               "message": "стр.%d: %s" % (p + 1, e)})
                continue
            if not res.get("ok"):
                continue
            if document is None:
                document = res.get("document")
            extractor = res.get("extractor_used") or extractor
            for tbl in res.get("tables", []):
                s = tbl["validation"]["stats"]
                st["autocommit"] += s.get("n_autocommit", 0)
                st["review"] += s.get("n_review", 0)
                st["errors"] += s.get("errors", 0)
                st["warnings"] += s.get("warnings", 0)
                for it in tbl["validation"]["issues"]:
                    if it.get("severity") != "info":
                        issues.append({"severity": it.get("severity"), "code": it.get("code"),
                                       "message": it.get("message")})
                for r in tbl.get("rows", []):
                    if r.get("kind") != "data":
                        if r.get("kind") == "section" and (r.get("name") or "").strip():
                            _hn, _hrow = _sec_head_row(r, cur_sec_name, p + 1)
                            rows.append(_hrow)
                            if not _RX_NODE_HEAD.search(_hn):
                                cur_sec_name = _hn
                        continue
                    sec_val = _sec_name_of(r, cur_sec_name)
                    rows.append({"page": p + 1, "pos": r.get("pos"), "name": r.get("name"),
                                 "unit": r.get("unit"), "qty": r.get("qty"), "qty_raw": r.get("qty_raw"),
                                 "section": sec_val,
                                 "confidence": r.get("confidence"),
                                 "note": (r.get("extra") or {}).get("note"),
                                 "doc_note": (r.get("extra") or {}).get("doc_note"),
                                 "code_src": r.get("code_src")})
        st["rows"] = len(rows)
        return {"ok": True, "filename": file.filename, "pages": n_pages,
                "document": document, "extractor": extractor,
                "stats": st, "rows": rows, "issues": issues[:80]}
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _vor_match_b2c(body, idx, DF):
    """IISMETA cost-estimation engine module."""
    import vor_router as VR
    import cluster_c as CC

    _UNCONFIRMED = [
        ("12-01-010", re.compile(r"кон[её]к", re.I),
         "конёк→12-01-010: best-guess по семейству «мелкие листовые доборные элементы кровли», "
         "БЕЗ прямого совпадения в БД (kb_engine keyword-поиск дал 0 хитов) — сверить со специалистом"),
        ("15-01-019", re.compile(r"фартук", re.I),
         "фартук→15-01-019 (плитка): best-guess, эвристика, требует проверки — "
         "подтвердить таблицу"),
    ]

    rows_in = (body.rows or [])[:4000]
    vr_rows = [{"name": (r.get("name") or "").strip(), "raw": (r.get("raw") or "").strip(),
                "unit": r.get("unit") or "",
                "qty": r.get("qty"), "params": (r.get("params") if isinstance(r.get("params"), dict) else {}),
                "section_title": (r.get("section") or "") if isinstance(r.get("section"), str) else "",
                "_pm_applied": r.get("_pm_applied") or 0,
                "doc_note": r.get("doc_note") or "", "note": r.get("note") or ""}
               for r in rows_in]
    VR.apply_parent_multiplier(vr_rows)
    per = VR.match_rows(vr_rows)

    out = []

    def _companions_payload(cw_list):
        """IISMETA cost-estimation engine module."""
        companions = []
        for cw in (cw_list or []):
            cw["structure"] = (body.criteria or {}).get("structure")
            cw["obj_type"] = (body.criteria or {}).get("type")
            cw["finish_quality"] = (body.criteria or {}).get("finish_quality")
            cw["decor_method"] = (body.criteria or {}).get("decor_method")
            crc = CC.variant_pick(cw)
            if crc.get("error") or not crc.get("wc"):
                continue
            ccomps = crc.get("components") or []
            cbase_qty = cw.get("qty") or 0
            ccomp_list = [{"shifr": c["shifr"], "objem": (round(cbase_qty * c.get("qty_factor", 1.0), 4) if cbase_qty else None)}
                          for c in ccomps]
            cand_list = list(crc.get("candidates") or [])
            op_flag = bool(crc.get("operator_flag"))
            auto = bool(crc.get("auto_assign"))
            for alt_t in (cw.get("alt_tables") or []):
                arc = CC.variant_pick(dict(cw, table=alt_t))
                if arc.get("error") or not arc.get("wc"):
                    continue
                alts = [c for c in (arc.get("candidates") or [])
                        if c.get("shifr") not in {x.get("shifr") for x in cand_list}]
                if not alts:
                    continue
                cand_list = cand_list[:1] + alts[:1] + cand_list[1:] + alts[1:]
                op_flag, auto = True, False
            cand_list = cand_list[:6]
            companions.append({"wc": crc["wc"], "table": cw.get("table"),
                                "shifr": (ccomps[0]["shifr"] if ccomps else None),
                                "variant_name": crc.get("variant"), "objem": cw.get("qty"),
                                "unit_calc": cw.get("unit"), "components": ccomp_list,
                                "candidates": cand_list,
                                "operator_flag": op_flag,
                                "auto_assign": auto,
                                "compound": bool(cw.get("_compound")),
                                "note": ("слой компаунд-строки ВОР (работа перечислена в тексте, "
                                         "выделена разбором — проверить)" if cw.get("_compound") else None),
                                "flag": (cw.get("params") or {}).get("flag")})
        return companions

    for r, vrr, p in zip(rows_in, vr_rows, per):
        st = p["status"]
        if st == "empty":
            out.append({"disc": None, "covered": True, "candidates": []})
            continue
        if st in ("absorbed", "consumed"):
            parent = p.get("parent") or ""
            out.append({"disc": None, "covered": True, "candidates": [], "absorbed": True,
                        "node_absorbed": bool(p.get("node_absorbed")),
                        "absorb_kind": p.get("absorb_kind"),
                        "note": "%s%s" % (p["reason"], (" → «%s»" % parent[:80]) if parent else "")})
            continue
        if st == "material_direct":
            md_res = {"disc": None, "covered": True, "candidates": [], "material_direct": True,
                      "note": "материал по проекту — указать марку/кол-во · %s" % p["reason"]}
            md_comps = _companions_payload(p.get("companions"))
            if md_comps:
                md_res["companions"] = md_comps
            out.append(md_res)
            continue
        if st == "unrouted":
            out.append({"disc": None, "covered": True, "candidates": [], "note": p["reason"]})
            continue
        w = p["work"]
        w["structure"] = (body.criteria or {}).get("structure")
        w["obj_type"] = (body.criteria or {}).get("type")
        w["finish_quality"] = (body.criteria or {}).get("finish_quality")
        w["decor_method"] = (body.criteria or {}).get("decor_method")
        #
        rc = CC.variant_pick(w)
        if rc.get("error") or not rc.get("wc"):
            out.append({"disc": None, "covered": True, "candidates": [],
                        "note": "C: %s" % (rc.get("error") or "вариант не разрешён")})
            continue
        comps = rc.get("components") or []
        wv = idx.get(rc["wc"]) or {}
        base_qty = w.get("qty") or 0
        comp_list = []
        for c in comps:
            _kf = c.get("qty_factor", 1.0) or 1.0
            _cc = {"shifr": c["shifr"], "objem": round(base_qty * _kf, 4)}
            if _kf != 1.0:
                _cc["objem_base"] = round(base_qty, 4)
                _cc["k"] = _kf
            comp_list.append(_cc)
        default_cand = (rc.get("candidates") or [None])[0] if not comps else None
        nd = {"wc": rc["wc"], "sbornik": wv.get("razdel", ""), "vid": wv.get("vid", ""),
              "shifr": (comps[0]["shifr"] if comps else (default_cand or {}).get("shifr")),
              "variant_name": rc.get("variant") or (default_cand or {}).get("name"),
              "var_status": ("уточнить" if rc.get("operator_flag") else "ok"),
              "anchored": bool(rc.get("anchored")),
              "score": 1.0,
              "engine": "b2c", "sb_map": w.get("sbornik"),
              "objem": w.get("qty"), "unit_calc": w.get("unit"), "components": comp_list}
        if default_cand is not None:
            nd["default_suggestion"] = True
        canon = DF.canon_of_wc(rc["wc"])
        if canon:
            nd["sb_key"] = canon["sb_key"]
            nd["disc_canon"] = canon["disciplines"]
            if canon.get("stage"):
                nd["stage"] = canon["stage"]
        if vrr.get("_node_sum"):
            nd["node_sum"] = True
        notes = []
        if vrr.get("_node_sum"):
            notes.append(vrr["_node_sum"])
        if vrr.get("_pm_note"):
            notes.append(vrr["_pm_note"])
        if len(comps) > 1:
            notes.append("разворот: +%d строк (добор/компоненты %s) — полный разворот в components[], выгружается всеми строками" %
                         (len(comps) - 1, ", ".join(c["shifr"] for c in comps[1:])))
        def _why(v, default):
            return default if isinstance(v, bool) or not str(v).strip() else str(v)
        if rc.get("axis_conflict"):
            nd["var_status"] = "уточнить"
            notes.append(_why(rc["axis_conflict"],
                              "признаки строки указывают на разные варианты нормы — выберите"))
        elif rc.get("operator_flag"):
            notes.append(_why(rc["operator_flag"],
                              "вариант нормы выбран движком по умолчанию — проверьте"))
        if w.get("rule") and w["rule"] != "1:1":
            notes.append(w["rule"])
        for tab, kw_rx, reason in _UNCONFIRMED:
            if w.get("table") == tab and kw_rx.search(w.get("work") or ""):
                nd["var_status"] = "уточнить"
                notes.append(reason)
                break
        if str(w.get("rule") or "").startswith("конструктив Проекта=металлокаркас"):
            nd["var_status"] = "уточнить"
            notes.append("профлист: взята сб.09 (монтаж кровельного покрытия по стальным "
                         "конструкциям) — по полю «Конструктив» = металлокаркас в карточке "
                         "Проекта. Если покрытие укладывается по готовому основанию, верна "
                         "сб.12 (Е1203-004). Признака в строке ВОР нет, решает оператор")
        _vlist = [{"shifr": c.get("shifr"), "name": c.get("name") or ""}
                  for c in (rc.get("candidates") or []) if c.get("shifr")]
        if len(_vlist) < 2:
            _vlist = rc.get("all_variants") or _vlist
        nd["variants"] = _vlist[:40]
        _why = []
        if rc.get("axis_conflict"):
            _why.append(str(rc["axis_conflict"]))
        if w.get("rule") and w["rule"] != "1:1":
            _why.append(str(w["rule"]))
        if rc.get("anchored"):
            _why.append("вариант выбран ручным якорем каталога")
        if nd.get("default_suggestion"):
            _why.append("ось из строки не извлеклась — это подсказка, а не подтверждённый выбор")
        if _why:
            nd["why"] = " · ".join(_why)
        res = {"disc": None, "covered": True, "candidates": [nd]}
        companions = _companions_payload(w.get("companions"))
        if companions:
            res["companions"] = companions
        if notes:
            res["note"] = " · ".join(notes)
        out.append(res)

    _fork_pairs(out, idx)

    _SCORE_BY_STATUS = {"ok": 1.0, "уточнить": 0.6, "ask": 0.3, "alt": 0.4}
    for _r in out:
        for _c in (_r.get("candidates") or []):
            if _c.get("engine") == "b2c":
                _c["score"] = _SCORE_BY_STATUS.get(_c.get("var_status"), 0.3)

    n_work = sum(1 for p in per if p["status"] == "work")
    n_abs = sum(1 for p in per if p["status"] in ("absorbed", "consumed"))
    n_unr = sum(1 for p in per if p["status"] == "unrouted")
    n_md = sum(1 for p in per if p["status"] == "material_direct")
    return {"ok": True, "mode": "deterministic", "engine": "b2c", "llm": False,
            "stats": {"works": n_work, "absorbed": n_abs, "unrouted": n_unr,
                      "material_direct": n_md}, "results": out}


@app.post("/api/vor/match")
def vor_match(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        import kb_engine
        import discipline_funnel as DF
    except Exception as e:
        raise HTTPException(status_code=503, detail="Движок подбора недоступен: %s" % e)
    idx = kb_engine._index()
    if (os.environ.get("ENGINE") or "").lower() == "v2":
        out = _vor_match_v2(body, idx, DF)
    else:
        out = _vor_match_b2c(body, idx, DF)
    _unify_tbl_labels(out)
    _attach_izm_norm(out, idx)
    _apply_param_volume(out, body.rows, idx)
    return out


_TBL_NUM_RX = re.compile(r"^\d{2}-\d{2}-\d{3}$")


def _tbl_from_shifr(sh):
    """IISMETA cost-estimation engine module."""
    sh = str(sh or "")
    return "%s-%s-%s" % (sh[1:3], sh[3:5], sh[6:9]) if len(sh) > 8 else ""


def _unify_tbl_labels(out):
    """IISMETA cost-estimation engine module."""
    for r in (out.get("results") or []):
        if not isinstance(r, dict):
            continue
        for c in (r.get("candidates") or []):
            sb = c.get("sb_map") or ""
            if sb and _TBL_NUM_RX.match(sb):
                c["sb_tbl"] = sb
                continue
            t = _tbl_from_shifr(c.get("shifr"))
            if t:
                c["sb_tbl"] = t


def _attach_izm_norm(out, idx):
    """IISMETA cost-estimation engine module."""
    for r in (out.get("results") or []):
        if not isinstance(r, dict):
            continue
        for c in (r.get("candidates") or []) + list(r.get("companions") or []):
            v = (idx or {}).get(c.get("wc")) or {}
            izm = str(v.get("izmeritel") or v.get("unit") or "").strip()
            if izm:
                c["izm_norm"] = izm


_THICK_RE = re.compile(r"толщ\w*[.\s\-:=]*(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*мм", re.I)


def _thickness_from_text(name):
    m = _THICK_RE.search(name or "")
    if not m:
        return None
    a = float(m.group(1).replace(",", "."))
    if m.group(2):
        return round((a + float(m.group(2).replace(",", "."))) / 2.0, 2)
    return a


def _apply_param_volume(out, rows, idx):
    """IISMETA cost-estimation engine module."""
    try:
        import unit_convert as UC
    except Exception:
        return
    for i, r in enumerate(out.get("results") or []):
        if not isinstance(r, dict) or i >= len(rows):
            continue
        src = rows[i]
        prm = dict(src.get("params")) if isinstance(src.get("params"), dict) else {}
        if "толщина" not in prm and "высота" not in prm:
            _th = _thickness_from_text(src.get("name") or "")
            if _th is not None:
                prm["толщина"] = _th
        if not prm:
            continue
        vor_unit = (src.get("unit") or "").strip()
        qty = src.get("qty")
        for c in (r.get("candidates") or []) + list(r.get("companions") or []):
            wc = c.get("wc")
            _v = (idx or {}).get(wc) or {}
            izm = str(_v.get("izmeritel") or _v.get("unit") or "")
            izm_unit = re.sub(r"^\s*\d+(?:[.,]\d+)?\s*", "", izm).strip()
            if not izm_unit:
                continue
            have = c.get("objem")
            cur_unit = (c.get("unit_calc") or vor_unit or "").strip()
            same = cur_unit and UC.norm_unit(cur_unit) == UC.norm_unit(izm_unit)
            if have is not None and same:
                continue
            base_qty = have if have is not None else qty
            base_unit = cur_unit if have is not None else vor_unit
            if UC.norm_unit(izm_unit) in ("т", "кг"):
                s = prm.get("площадь") or prm.get("s") or prm.get("S")
                sv = UC._num(s) if s is not None else None
                if sv:
                    base_qty, base_unit = sv, "м2"
            if base_qty is None or not base_unit:
                continue
            if UC.norm_unit(base_unit) == UC.norm_unit(izm_unit):
                continue
            val, why = UC.convert(base_qty, base_unit, izm_unit, prm)
            if val is None:
                continue
            c["objem"] = val
            c["unit_calc"] = izm_unit
            c["objem_why"] = why
            for cc in (c.get("components") or []):
                if cc.get("objem") is None or len(c.get("components") or []) == 1:
                    cc["objem"] = val


_V2_WC_BY_TABLE = None


_FORK_TWINS = {
    "10-01-034": ("10-01-036", "оконные блоки: ПВХ-профиль ↔ дерево-алюминий/алюминий/металлопластик"),
    "10-01-036": ("10-01-034", "оконные блоки: дерево-алюминий/алюминий/металлопластик ↔ ПВХ-профиль"),
}


_FORK_VARIANTS_CACHE = {}


def _table_variants(tbl):
    """IISMETA cost-estimation engine module."""
    if tbl in _FORK_VARIANTS_CACHE:
        return _FORK_VARIANTS_CACHE[tbl]
    out = []
    try:
        from engine_v2 import router as RT
        import sqlite3
        con = sqlite3.connect("file:%s?mode=ro" % RT.DB, uri=True)
        rows = con.execute(
            "SELECT code, name FROM norms WHERE shnk_table=? "
            "AND (excluded IS NULL OR excluded=0) ORDER BY code", (tbl,)).fetchall()
        con.close()
        out = [{"shifr": c, "name": n or ""} for c, n in rows if c]
    except Exception:
        out = []
    _FORK_VARIANTS_CACHE[tbl] = out
    return out


def _fork_pairs(out, idx):
    """IISMETA cost-estimation engine module."""
    if not idx:
        return 0
    n = 0
    for r in out:
        cands = (r or {}).get("candidates") or []
        if not cands:
            continue
        if (r or {}).get("fork"):
            seen, uniq = set(), []
            for c in cands:
                k = (c.get("sb_map") or "", c.get("shifr") or "")
                if k in seen:
                    continue
                seen.add(k); uniq.append(c)
            r["candidates"] = uniq
            continue
        c0 = cands[0]
        sh = str(c0.get("shifr") or "")
        tbl = "%s-%s-%s" % (sh[1:3], sh[3:5], sh[6:9]) if len(sh) > 8 else (c0.get("sb_map") or "")
        tw = _FORK_TWINS.get(tbl)
        if not tw:
            continue
        tbl2, why = tw
        if not any((c.get("sb_map") or "") == tbl2 for c in cands):
            wc2 = _wc_by_table(idx, tbl2)
            if wc2:
                v2 = idx.get(wc2) or {}
                vlist = _table_variants(tbl2)
                d0 = vlist[0] if vlist else {}
                fc = {"wc": wc2, "sbornik": v2.get("razdel", ""), "vid": v2.get("vid", ""),
                      "shifr": d0.get("shifr", ""), "variant_name": d0.get("name", ""),
                      "variants": vlist, "sb_map": tbl2, "var_status": "fork",
                      "score": 0.0, "engine": "fork-twin"}
                for kk in ("objem", "unit_calc"):
                    if c0.get(kk) is not None:
                        fc[kk] = c0.get(kk)
                cands.append(fc)
        r["fork"] = tbl2
        r["note"] = ((r.get("note") or "") + " · " if r.get("note") else "") + \
            "🔀 развилка %s: признака в строке ВОР нет — сверьте таблицу" % why
        n += 1
    return n


def _wc_by_table(idx, shnk_table):
    """IISMETA cost-estimation engine module."""
    global _V2_WC_BY_TABLE
    if _V2_WC_BY_TABLE is None:
        m = {}
        for k, v in idx.items():
            t = v.get("shnk_table")
            if t and t not in m:
                m[t] = k
        _V2_WC_BY_TABLE = m
    return _V2_WC_BY_TABLE.get(shnk_table)


def _vor_match_v2(body, idx, DF):
    """IISMETA cost-estimation engine module."""
    b2c = _vor_match_b2c(body, idx, DF)
    try:
        from engine_v2 import api as EV2
        if not EV2.available():
            b2c["engine"] = "b2c (v2: индекс не собран)"
            return b2c
    except Exception as e:
        b2c["engine"] = "b2c (v2 недоступен: %s)" % type(e).__name__
        return b2c

    from engine_v2 import smeta as SM
    rows = [r if isinstance(r, dict) else dict(r) for r in (body.rows or [])]
    import vor_router as _VRm
    rows = [dict(r, section_title=(r.get("section") or "")) for r in rows]
    _VRm.apply_parent_multiplier(rows)
    res = b2c.get("results") or []
    try:
        built = SM.build(rows)
    except Exception as e:
        b2c["engine"] = "b2c (конвейер v2 упал: %s)" % type(e).__name__
        return b2c
    by_id = {p["id"]: p for p in built["positions"]}
    n_v2 = 0
    for i, row in enumerate(rows):
        if i >= len(res):
            break
        name = (row.get("name") or "").strip()
        if not name:
            continue
        p = by_id.get(row.get("id", str(i)))
        if not p or p.get("line_type") != "работа":
            continue
        if (res[i] or {}).get("absorbed") or (res[i] or {}).get("material_direct"):
            continue
        code = p.get("code")
        if not code:
            continue
        if (res[i] or {}).get("companions"):
            continue
        b2c_c0 = ((res[i] or {}).get("candidates") or [{}])[0]
        by_s = str(p.get("by") or "")
        _trace_before_leaf = by_s[len("фрагмент:"):].split("→ leaf")[0].strip(" →") \
            if by_s.startswith("фрагмент:") else "x"
        blind = by_s.startswith("фрагмент:") and (
            ("≈деф" in by_s and "=" not in by_s.replace("≈деф", "")) or not _trace_before_leaf)
        b2c_asked = bool(b2c_c0.get("default_suggestion"))
        if b2c_asked and blind:
            continue
        if b2c_c0.get("anchored") and not b2c_asked:
            continue
        if blind and b2c_c0.get("shifr"):
            continue
        norm = {"name": "", "by": p.get("by") or p.get("layer") or ""}
        table = p.get("table") or ("%s-%s-%s" % (code[1:3], code[3:5], code[6:9]) if len(code) > 8 else None)
        wc = _wc_by_table(idx, table)
        if not wc:
            continue
        wv = idx.get(wc) or {}
        qty = row.get("qty")
        try:
            qty = float(str(qty).replace(",", ".")) if qty not in (None, "") else None
        except ValueError:
            qty = None
        nd = {"wc": wc, "sbornik": wv.get("razdel", ""), "vid": wv.get("vid", ""),
              "shifr": code, "variant_name": norm.get("name") or "",
              "var_status": ("уточнить" if (blind or b2c_asked) else "ok"), "score": 1.0, "engine": "v2",
              "sb_map": table, "objem": qty, "unit_calc": row.get("unit"),
              "components": [{"shifr": code, "objem": qty}] if qty is not None else [],
              "v2_by": norm.get("by") or ""}
        canon = DF.canon_of_wc(wc)
        if canon:
            nd["sb_key"] = canon["sb_key"]
            nd["disc_canon"] = canon["disciplines"]
            if canon.get("stage"):
                nd["stage"] = canon["stage"]
        cands = [nd]
        if b2c_asked:
            seen = {nd.get("shifr")}
            for c in ((res[i] or {}).get("candidates") or []):
                if c.get("shifr") and c["shifr"] not in seen:
                    seen.add(c["shifr"])
                    cands.append(dict(c, default_suggestion=False))
            cands = cands[:6]
        res[i] = {"disc": None, "covered": True, "candidates": cands,
                  "note": ("движок v2 · %s%s%s"
                           % (norm.get("by") or "",
                              " · ⚠ признаки из строки не извлеклись (все оси в дефолт) — "
                              "проверьте таблицу" if blind else "",
                              " · вариант извлечён из строки/раздела; альтернативы каталога "
                              "оставлены ниже — проверить" if b2c_asked else ""))}
        n_v2 += 1
    b2c["engine"] = "v2"
    st = b2c.get("stats") or {}
    st["v2_rows"] = n_v2
    st["fallback_b2c_rows"] = max(0, len(rows) - n_v2)
    b2c["stats"] = st
    idx_of = {row.get("id", str(i)): i for i, row in enumerate(rows)}
    n_sput = 0
    last_work_i = None
    for p in built["positions"]:
        pid = str(p.get("id") or "")
        if pid in idx_of and p.get("line_type") == "работа":
            last_work_i = idx_of[pid]
            continue
        if "↳" not in pid or not p.get("code"):
            continue
        host = idx_of.get(str(p.get("parent") or "")) if p.get("parent") \
            else (idx_of.get(pid.split("↳")[0]) if pid.split("↳")[0] in idx_of
                  else None)
        if host is None and p.get("src_ids"):
            host = idx_of.get(str(p["src_ids"][0]))
        if host is None:
            sp_ws = {w[:6] for w in (p.get("name") or "").lower().split()
                     if len(w) >= 6}
            best, best_ov = last_work_i, 0
            for j, rw in enumerate(rows):
                ov = len(sp_ws & {w[:6] for w in (rw.get("name") or "").lower().split()
                                  if len(w) >= 6})
                if ov > best_ov:
                    best, best_ov = j, ov
            host = best
        if host is None or host >= len(res):
            continue
        r0 = res[host] or {}
        sp = {"shifr": str(p["code"]), "name": (p.get("name") or "")[:90],
              "kind": p.get("kind") or "спутник"}
        for kk in ("k", "qty_t", "qty_m3"):
            if p.get(kk) is not None:
                sp[kk] = p[kk]
        r0.setdefault("sputniki", []).append(sp)
        r0["note"] = (r0.get("note") or "") + \
            " · ⚙ спутник: %s%s" % (sp["shifr"],
                                    (" ×%s" % sp["k"]) if sp.get("k") else "")
        res[host] = r0
        n_sput += 1
    if n_sput:
        st["sputnik_rows"] = n_sput
    excl = set()
    crit = getattr(body, "criteria", None) or {}
    if crit:
        try:
            from engine_v2 import validator as VD
            excl = VD.card_exclude({"flags": crit.get("flags") or {},
                                    "scenario": crit.get("scenario") or "new"})
            st["passport_excluded_tables"] = len(excl)
        except Exception:
            excl = set()
    _router_ask_pass(rows, res, built, idx, DF, st, excl, crit)
    return b2c


def _router_ask_pass(rows, res, built, idx, DF, st, excl=None, crit=None):
    """IISMETA cost-estimation engine module."""
    if (os.environ.get("IISMETA_ROUTER_ASK") or "1") == "0":
        return
    try:
        from engine_v2 import router as RT
    except Exception as e:
        st["router_ask"] = "недоступен: %s" % type(e).__name__
        return
    excl = excl or set()
    crit = crit or {}
    n_ask = n_leaf = 0
    by_id = {p["id"]: p for p in built["positions"]}
    for i, row in enumerate(rows):
        if i >= len(res):
            break
        name = (row.get("name") or "").strip()
        qty = str(row.get("qty") or "").strip()
        if not name or not qty:
            continue
        r0 = res[i] or {}
        if r0.get("absorbed") or r0.get("material_direct"):
            continue
        cands = r0.get("candidates") or []
        if cands and cands[0].get("engine") == "v2" and cands[0].get("sb_map"):
            anchor = cands[0]["sb_map"]
            try:
                chk = RT.leaf_uncertain(anchor, name)
            except Exception:
                chk = None
            if chk:
                cands[0]["var_status"] = "ask_leaf"
                cands[0]["leaf_status"] = "вопрос"
                r0["note"] = (r0.get("note") or "") + \
                    " · 🟡 вариант не подтверждён текстом (%s)" % (chk.get("axis") or "ось")
                n_leaf += 1
                st["leaf_ask"] = st.get("leaf_ask", 0) + 1
                gg = crit.get("gruppa_gruntov")
                if gg and str(chk.get("axis") or "").upper().startswith("ГРУППА"):
                    try:
                        lg = RT._leaf(anchor, name, row.get("unit"),
                                      {"ГРУППАГР": gg}, RT._data(), [], "passport")
                    except Exception:
                        lg = {}
                    if lg.get("status") == "ok" and lg.get("code") and \
                            str(lg["code"]) != str(cands[0].get("shifr") or ""):
                        wv_g = idx.get(cands[0].get("wc")) or {}
                        cands.insert(1, {
                            "wc": cands[0].get("wc"), "sbornik": wv_g.get("razdel", ""),
                            "vid": wv_g.get("vid", ""), "shifr": str(lg["code"]),
                            "variant_name": "по геологии паспорта (группа %s)" % gg,
                            "var_status": "alt", "score": 0.45, "engine": "router",
                            "sb_map": anchor})
                        r0["note"] = (r0.get("note") or "") + \
                            " · группа грунтов %s из паспорта (▾)" % gg
                        st["passport_gruppa_alt"] = st.get("passport_gruppa_alt", 0) + 1
            else:
                cands[0]["leaf_status"] = "распознан"
                st["leaf_text"] = st.get("leaf_text", 0) + 1
            try:
                sloi = RT.pirog_tk(anchor, row.get("section")) + RT.pirog(anchor, name)
            except Exception:
                sloi = []
            pir, seen_p = [], set()
            for sl in sloi:
                for t in (sl.get("tables") or [])[:1]:
                    if t in seen_p or t in excl:
                        continue
                    seen_p.add(t)
                    wc = _wc_by_table(idx, t)
                    if wc:
                        e = {"tbl": t, "wc": wc, "head": sl.get("head") or "",
                             "name": (idx.get(wc) or {}).get("vid") or ""}
                        try:
                            if not RT._units_ok(t, row.get("unit"), RT._data()):
                                e["unit_warn"] = True
                                e["name"] = (e["name"] + " ⚠ объём уточнить "
                                             "(другая ед.изм)").strip()
                        except Exception:
                            pass
                        pir.append(e)
                if len(pir) >= 8:
                    break
            if pir:
                r0["pirog"] = pir
            if (os.environ.get("IISMETA_ROUTER_V2SKEPTIC") or "1") != "0":
                try:
                    rr2 = RT.route(name, row.get("unit"), qty, row.get("section"), disc=row.get("disc"),
                             params=row.get("params"))
                except Exception:
                    rr2 = {}
                q2 = rr2.get("question") or {}
                r_tbls2, seen2 = [], set()
                for t in [rr2.get("tbl"), q2.get("tbl")] + \
                        [o.get("tbl") for o in (q2.get("options") or [])
                         if isinstance(o, dict)]:
                    if t and t not in seen2:
                        seen2.add(t)
                        r_tbls2.append(t)
                leaf_flagged = cands[0].get("var_status") == "ask_leaf"
                if r_tbls2 and (leaf_flagged or anchor not in r_tbls2):
                    alt2 = []
                    for t in r_tbls2:
                        if t == anchor or t in seen_p or t in excl:
                            continue
                        wc = _wc_by_table(idx, t)
                        if not wc:
                            continue
                        wv = idx.get(wc) or {}
                        nd = {"wc": wc, "sbornik": wv.get("razdel", ""),
                              "vid": wv.get("vid", ""), "shifr": "",
                              "variant_name": wv.get("vid") or "", "var_status": "alt",
                              "score": 0.4, "engine": "router", "sb_map": t}
                        canon = DF.canon_of_wc(wc)
                        if canon:
                            nd["sb_key"] = canon["sb_key"]
                            nd["disc_canon"] = canon["disciplines"]
                        alt2.append(nd)
                        if len(alt2) >= 4:
                            break
                    if alt2:
                        cands.extend(alt2)
                        st["router_v2skeptic_rows"] = \
                            st.get("router_v2skeptic_rows", 0) + 1
                        if rr2.get("tbl") and rr2["tbl"] != anchor:
                            r0["note"] = (r0.get("note") or "") + \
                                " · 🟡 движок сомневается в таблице — альтернативы (▾)"
            continue
        if cands:
            b2c_tbl = None
            sh = str(cands[0].get("shifr") or "")
            if re.match(r"[ЕЦУ]\d", sh) and len(sh) > 8:
                b2c_tbl = cands[0].get("sb_map") or "%s-%s-%s" % (sh[1:3], sh[3:5], sh[6:9])
            if not b2c_tbl:
                continue
            demote = None
            if (os.environ.get("IISMETA_ROUTER_DEMOTE") or "1") != "0":
                try:
                    demote = RT.code_suspect(b2c_tbl, name, row.get("unit"))
                except Exception:
                    demote = None
            try:
                rr = RT.route(name, row.get("unit"), qty, row.get("section"), disc=row.get("disc"),
                             params=row.get("params"))
            except Exception:
                continue
            q = rr.get("question") or {}
            r_tbls = [t for t in [rr.get("tbl"), q.get("tbl")] +
                      [o.get("tbl") for o in (q.get("options") or [])
                       if isinstance(o, dict)] if t]
            _weak = set(q.get("weak") or ())
            if _weak and not demote:
                r_tbls = [t for t in r_tbls if t not in _weak]
            if demote:
                cands[0]["var_status"] = "ask"
                cands[0]["score"] = 0.5
                r0["note"] = (r0.get("note") or "") + \
                    " · вопрос движка: код не подтверждён (%s)" % demote
                st["router_demote_rows"] = st.get("router_demote_rows", 0) + 1
                r_tbls = [t for t in r_tbls if t != b2c_tbl]
            elif not r_tbls or b2c_tbl in r_tbls:
                continue
            alt, seen_t = [], set()
            for t in r_tbls:
                if t in seen_t or t in excl:
                    continue
                seen_t.add(t)
                wc = _wc_by_table(idx, t)
                if not wc:
                    continue
                wv = idx.get(wc) or {}
                nd = {"wc": wc, "sbornik": wv.get("razdel", ""), "vid": wv.get("vid", ""),
                      "shifr": "", "variant_name": wv.get("vid") or "",
                      "var_status": "alt", "score": 0.4, "engine": "router", "sb_map": t}
                canon = DF.canon_of_wc(wc)
                if canon:
                    nd["sb_key"] = canon["sb_key"]
                    nd["disc_canon"] = canon["disciplines"]
                alt.append(nd)
                if len(alt) >= 4:
                    break
            if alt:
                cands.extend(alt)
                if (rr.get("tbl") or q.get("tbl")) and not demote:
                    r0["note"] = (r0.get("note") or "") + \
                        " · 🟡 движок сомневается в таблице — есть альтернативы (▾)"
                    n_leaf += 1
            continue
        p = by_id.get(row.get("id", str(i)))
        if p is not None and p.get("line_type") not in (None, "работа"):
            continue
        try:
            rr = RT.route(name, row.get("unit"), qty, row.get("section"), disc=row.get("disc"),
                             params=row.get("params"))
        except Exception:
            continue
        q = rr.get("question") or {}
        tbls, seen = [], set()
        for t in [rr.get("tbl"), q.get("tbl")] + \
                [o.get("tbl") for o in (q.get("options") or []) if isinstance(o, dict)]:
            if t and t not in seen and t not in excl:
                seen.add(t)
                tbls.append((t, next((o.get("name") for o in (q.get("options") or [])
                                      if isinstance(o, dict) and o.get("tbl") == t), "")))
        opts = []
        for t, tname in tbls[:6]:
            wc = _wc_by_table(idx, t)
            if not wc:
                continue
            wv = idx.get(wc) or {}
            nd = {"wc": wc, "sbornik": wv.get("razdel", ""), "vid": wv.get("vid", ""),
                  "shifr": "", "variant_name": tname or wv.get("vid") or "",
                  "var_status": "ask", "score": 0.33, "engine": "router", "sb_map": t}
            canon = DF.canon_of_wc(wc)
            if canon:
                nd["sb_key"] = canon["sb_key"]
                nd["disc_canon"] = canon["disciplines"]
                if canon.get("stage"):
                    nd["stage"] = canon["stage"]
            opts.append(nd)
        if opts:
            res[i] = {"disc": None, "covered": True, "candidates": opts,
                      "note": "вопрос движка · выберите работу (%s)" %
                              (rr.get("why") or "уточнение")}
            n_ask += 1
    n_chain = 0
    try:
        from engine_v2 import chain as CHN
    except Exception:
        CHN = None
    if CHN is not None:
        for i, row in enumerate(rows):
            if i >= len(res):
                break
            name = (row.get("name") or "").strip()
            if not name or not str(row.get("qty") or "").strip():
                continue
            r0 = res[i] or {}
            c0 = (r0.get("candidates") or [{}])[0]
            if not c0.get("shifr"):
                continue
            try:
                d = CHN.decompose(name, row.get("unit"), row.get("qty"),
                                  row.get("section"), params=row.get("params"))
            except Exception:
                continue
            if not d.get("composite"):
                continue
            links = []
            sput_blob = " ".join((sp.get("name") or "") for sp in
                                 (r0.get("sputniki") or [])).lower()
            for c in d["chain"]:
                if c["role"] != "звено" or not c.get("tbl") or c["tbl"] in excl:
                    continue
                seg_ws = {w[:6] for w in (c.get("seg") or "").lower().split()
                          if len(w) >= 6}
                if sput_blob and any(w in sput_blob for w in seg_ws):
                    continue
                wc = _wc_by_table(idx, c["tbl"])
                if not wc:
                    continue
                links.append({"seg": c["seg"][:80], "tbl": c["tbl"], "wc": wc,
                              "code": c.get("code") or "",
                              "vid": (idx.get(wc) or {}).get("vid") or "",
                              "k": c.get("k")})
            if links:
                r0["chain"] = links
                r0["note"] = (r0.get("note") or "") + \
                    " · ⛓ составная: +%d звеньев цепочки" % len(links)
                res[i] = r0
                n_chain += 1
    n_nv = 0
    try:
        if (os.environ.get("IISMETA_NAME_VERIFY") or "0") != "1":
            raise StopIteration
        from engine_v2 import morph as MO
        import sqlite3 as _sq
        con_nv = _sq.connect("file:%s?mode=ro" % RT.DB, uri=True)
        by_id_nv = {p["id"]: p for p in built["positions"]}
        for i, row in enumerate(rows):
            if i >= len(res):
                break
            name = (row.get("name") or "").strip()
            if not name:
                continue
            p_nv = by_id_nv.get(row.get("id", str(i)))
            if p_nv is not None and p_nv.get("line_type") not in \
                    (None, "работа", "пирог"):
                continue
            r0 = res[i] or {}
            c0 = (r0.get("candidates") or [{}])[0]
            sh = str(c0.get("shifr") or "")
            if not re.match(r"[ЕЦУ]\d", sh) or c0.get("var_status") in ("ask", "alt"):
                continue
            nm_row = con_nv.execute("SELECT name FROM norms WHERE code=?",
                                    (sh,)).fetchone()
            if not nm_row:
                continue
            st_norm = {t[:5] for t in MO.toks(nm_row[0]) if len(t) >= 4}
            st_line = {t[:5] for t in MO.toks(name) if len(t) >= 4}
            if len(st_line) >= 2 and st_norm and not (st_norm & st_line):
                c0["name_verify"] = "нет пересечения"
                r0["note"] = (r0.get("note") or "") + \
                    " · 🟡 имя расценки не похоже на строку — проверьте"
                n_nv += 1
        con_nv.close()
    except Exception:
        pass
    if n_nv:
        st["name_verify_flags"] = n_nv
    n_split = 0
    for i, row in enumerate(rows):
        if i >= len(res):
            break
        name = (row.get("name") or "").strip()
        if not name or not str(row.get("qty") or "").strip():
            continue
        if (res[i] or {}).get("chain"):
            continue
        parts = []
        try:
            subs = RT.split_composite(name)
            if len(subs) > 1:
                parts = [{"name": s} for s in subs]
            else:
                g = RT.split_glued(name)
                if g:
                    parts = [{"name": g[1], "section": g[0]}, {"name": g[0]}]
        except Exception:
            parts = []
        if len(parts) < 2:
            continue
        sp = []
        for pt in parts[:4]:
            try:
                rr2 = RT.route(pt["name"], row.get("unit"), row.get("qty"),
                               pt.get("section") or row.get("section"),
                               params=row.get("params"))
            except Exception:
                continue
            q2 = rr2.get("question") or {}
            tb2 = [t for t in [rr2.get("tbl"), q2.get("tbl")] +
                   [o.get("tbl") for o in (q2.get("options") or [])
                    if isinstance(o, dict)] if t][:3]
            ent = {"name": pt["name"][:90], "tbls": []}
            for t in tb2:
                wc = _wc_by_table(idx, t)
                if wc:
                    ent["tbls"].append({"tbl": t, "wc": wc,
                                        "vid": (idx.get(wc) or {}).get("vid") or ""})
            sp.append(ent)
        if len(sp) > 1:
            r0 = res[i] or {}
            r0["split"] = sp
            r0["note"] = (r0.get("note") or "") + \
                " · 🧩 в строке %d работ — можно разнести" % len(sp)
            res[i] = r0
            n_split += 1
    agg_by_src = {}
    for p in built.get("positions") or []:
        if p.get("kind") == "агрегат-раздела":
            for rid in p.get("src_ids") or []:
                agg_by_src[rid] = p
    n_agg = n_hdr = 0
    _agg_totals = {}
    for _i, _row in enumerate(rows):
        _p = by_id.get(_row.get("id", str(_i)))
        _a = agg_by_src.get(_row.get("id", str(_i)))
        if _a is None or not _p or _p.get("line_type") not in ("арматура", "сталь"):
            continue
        _t = _doc_total(_row.get("doc_note") or "")
        if _t:
            _agg_totals.setdefault(_a.get("id"), set()).add(_t[0])
    _agg_seen = set()
    for i, row in enumerate(rows):
        if i >= len(res):
            break
        p = by_id.get(row.get("id", str(i)))
        if not p or p.get("line_type") == "работа":
            continue
        r0 = res[i] or {}
        if r0.get("candidates"):
            continue
        if r0.get("node_absorbed"):
            continue
        if r0.get("absorb_kind") == "норма":
            continue
        lt = p.get("line_type")
        rid = row.get("id", str(i))
        agg = agg_by_src.get(rid)
        if lt in ("арматура", "сталь") and agg:
            _tot = _doc_total(row.get("doc_note") or "")
            _agg_key = (agg.get("id"), _tot[0] if _tot else None)
            if _tot is None and _agg_totals.get(agg.get("id")):
                _prev = (r0.get("note") or "").strip()
                res[i] = {"disc": None, "covered": True, "candidates": [],
                          "absorbed": r0.get("absorbed"), "material_direct": r0.get("material_direct"),
                          "note": (_prev + " · " if _prev else "")
                                  + "→ компонент узла, чей итог задан в примечании ВОРа "
                                    "(«Общ вес») — отдельной позиции не нужно"}
                continue
            if _agg_key[0] is not None and _agg_key in _agg_seen:
                _prev = (r0.get("note") or "").strip()
                res[i] = {"disc": None, "covered": True, "candidates": [],
                          "absorbed": r0.get("absorbed"), "material_direct": r0.get("material_direct"),
                          "note": (_prev + " · " if _prev else "")
                                  + "→ уже учтено в агрегате «%s» (Σ %s т по разделу «%s») — "
                                    "отдельной позиции не нужно"
                                  % ((agg.get("name") or agg.get("code") or "")[:48],
                                     agg.get("qty_t"), (agg.get("section") or "")[:30])}
                continue
            if _agg_key[0] is not None:
                _agg_seen.add(_agg_key)
            code = agg.get("code")
            table = "%s-%s-%s" % (code[1:3], code[3:5], code[6:9]) if len(code) > 8 else None
            wc = _wc_by_table(idx, table) if table else None
            nd = {"wc": wc or "", "sbornik": (idx.get(wc) or {}).get("razdel", "") if wc else "",
                  "vid": (idx.get(wc) or {}).get("vid", "") if wc else "",
                  "shifr": code, "variant_name": agg.get("name") or "",
                  "var_status": "ask" if agg.get("guess") else "aggregated",
                  "score": 0.5 if agg.get("guess") else 0.9, "engine": "v2-agg",
                  "sb_map": table, "objem": agg.get("qty_t"), "unit_calc": "т"}
            _prev = (r0.get("note") or "").strip()
            res[i] = {"disc": None, "covered": True, "candidates": [nd],
                      "absorbed": r0.get("absorbed"), "material_direct": r0.get("material_direct"),
                      "note": (_prev + " · " if _prev else "")
                              + ("⚠ раздел не опознан — целевая норма выбрана по умолчанию, сверьте · "
                                 if agg.get("guess") else "")
                              + "→ агрегируется в «%s» (Σ %s т по разделу «%s»)"
                              % ((agg.get("name") or code)[:48], agg.get("qty_t"),
                                 (agg.get("section") or "")[:30])}
            n_agg += 1
        elif lt == "заголовок":
            res[i] = {"disc": None, "covered": True, "candidates": [],
                      "note": "🗂 заголовок группы — не работа, расценка не нужна"}
            n_hdr += 1
        elif lt in ("арматура", "сталь"):
            res[i] = {"disc": None, "covered": True, "candidates": [],
                      "note": "спутник (%s) — войдёт в работу раздела; объём не "
                              "агрегирован (нет массы) — проверьте" % lt}
    st["router_ask_rows"] = n_ask
    st["router_leaf_flags"] = n_leaf
    st["router_split_rows"] = n_split
    st["router_chain_rows"] = n_chain
    st["agg_status_rows"] = n_agg
    st["header_rows"] = n_hdr
    st["mass_scaled_rows"] = _fix_mass_scale(res, idx)
    st["dim_scaled_rows"] = _fix_dim_scale(res, idx, rows)
    st["fork_rows"] = _fork_pairs(res, idx)


def _sec_txt(v):
    """IISMETA cost-estimation engine module."""
    return "" if v is None else str(v).strip()


def _norm_izm_unit(idx, wc, shifr):
    """IISMETA cost-estimation engine module."""
    v = next((x for x in ((idx.get(str(wc)) or {}).get("varianty") or [])
              if x.get("shifr") == shifr or x.get("code") == shifr), None)
    izm = re.sub(r"^\s*\d+(?:[.,]\d+)?\s*", "", str((v or {}).get("unit") or "")).strip()
    return izm.split()[0] if izm else ""


def _fix_mass_scale(res, idx):
    """IISMETA cost-estimation engine module."""
    _MASS = {"кг", "т", "г"}
    n = 0
    for r in res or []:
        for c in (r.get("candidates") or []):
            u_row = UC.norm_unit(c.get("unit_calc") or "")
            if u_row not in _MASS or c.get("objem") in (None, ""):
                continue
            u_norm = UC.norm_unit(_norm_izm_unit(idx, c.get("wc"), c.get("shifr")))
            if u_norm not in _MASS or u_norm == u_row:
                continue
            conv, why = UC.convert(c["objem"], u_row, u_norm, {})
            if conv is None:
                continue
            old = c["objem"]
            c["objem"] = conv
            c["unit_calc"] = u_norm
            for cc in (c.get("components") or []):
                if cc.get("objem") not in (None, ""):
                    cc["objem"] = UC.convert(cc["objem"], u_row, u_norm, {})[0]
            c["conv_note"] = "%s %s → %s %s (измеритель нормы)" % (old, u_row, conv, u_norm)
            r["note"] = ((r.get("note") or "") + " · ⚖ объём переведён %s→%s" % (u_row, u_norm)).strip(" ·")
            n += 1
    return n


_RX_LEN = re.compile(r"\bL\s*=\s*(\d+(?:[.,]\d+)?)\s*(мм|см|пм|м)\b", re.I)
_RX_THICK = re.compile(r"(?:^|[\s,;(])[тt]\s*\.?\s*=?\s*(\d+(?:[.,]\d+)?)\s*мм", re.I)
_RX_SIZE = re.compile(r"(\d{3,4})\s*[xх]\s*(\d{3,4})")
_RX_T_WORD = re.compile(r"толщ[а-я.]*\s*[-=:]?\s*(?:(\d+(?:[.,]\d+)?)[-–])?(\d+(?:[.,]\d+)?)\s*мм", re.I)
_RX_T_TAIL = re.compile(r"[-–—]\s*(?:(\d+(?:[.,]\d+)?)[-–])?(\d+(?:[.,]\d+)?)\s*мм\s*[;.,)]*\s*$", re.I)
_RX_L_BARE = re.compile(r"\bL\s*=\s*(\d+(?:[.,]\d+)?)(?!\s*[.,]?\d)", re.I)
_RX_L_SIZE = re.compile(r"(\d{3,4})\s*[xх]\s*\d{2,4}\s*мм", re.I)
_RX_L_SHIR = re.compile(r"[-\s](\d{3,4})\s+шир", re.I)


_RX_NOT_THICK = re.compile(r"(шир|шаг|b\s*=|в\s*=|∅|Ø|Ф\s*=)[^,;]{0,4}$", re.I)


def _thick_mm(name):
    """IISMETA cost-estimation engine module."""
    for rx in (_RX_T_WORD, _RX_THICK, _RX_T_TAIL):
        m = rx.search(name or "")
        if not m:
            continue
        if rx is _RX_T_TAIL and _RX_NOT_THICK.search((name or "")[:m.start() + 1]):
            continue
        vals = [float(x.replace(",", ".")) for x in m.groups() if x]
        return (sum(vals) / len(vals) if len(vals) > 1 else vals[0]), m.group(0).strip()
    return None, None


_RX_CNT_NAME = re.compile(r"(\d{1,4})\s*шт", re.I)


def _count_in_name(name):
    """IISMETA cost-estimation engine module."""
    m = _RX_CNT_NAME.search(name or "")
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 < n <= 9999 else None


def _len_one_m(name):
    """IISMETA cost-estimation engine module."""
    m = _RX_LEN.search(name or "")
    if m:
        k = {"мм": .001, "см": .01, "м": 1., "пм": 1.}[m.group(2).lower()]
        return float(m.group(1).replace(",", ".")) * k, m.group(0).strip()
    for rx in (_RX_L_BARE, _RX_L_SIZE, _RX_L_SHIR):
        m = rx.search(name or "")
        if m:
            v = float(m.group(1).replace(",", "."))
            return (v / 1000.0 if v >= 100 else v), m.group(0).strip()
    return None, None
_RX_AREA1 = re.compile(r"(\d+(?:[.,]\d+)?)\s*м\s*[2²]\b", re.I)
_RX_BL_MM = re.compile(
    r"\b[bBвВ]\s*=\s*(\d+(?:[.,]\d+)?)\s*(мм|м)?\s*[;,]?\s*[Ll]\s*=\s*(\d+(?:[.,]\d+)?)\s*(мм|м)?\b")
_RX_LOBSHCH = re.compile(r"l\s*об[щш]", re.I)


def _bl_area_m2(m):
    """IISMETA cost-estimation engine module."""
    def _val(num, unit):
        v = float(num.replace(",", "."))
        return v if (unit or "").lower() == "м" else v / 1000.0
    return _val(m.group(1), m.group(2)) * _val(m.group(3), m.group(4))


def _dim_of(u):
    """IISMETA cost-estimation engine module."""
    s = (u or "").lower().replace("²", "2").replace("³", "3").strip()
    s = re.sub(r"^\d+(?:[.,]\d+)?\s*", "", s)
    if re.match(r"^м2\b|^м2$", s):
        return "м2"
    if re.match(r"^м3\b|^м3$", s):
        return "м3"
    if re.match(r"^(м|мп|пм|м\.?п)\b|^(м|мп|пм)$", s):
        return "м"
    if re.match(r"^(шт|компл)", s):
        return "шт"
    if re.match(r"^(т|тонн)\b|^т$", s):
        return "т"
    if re.match(r"^кг\b", s):
        return "кг"
    return s or None


_RX_DOC_TOTAL = re.compile(r"общ[\w.]*\s*(?:вес)?\s*[-:—]?\s*(\d+(?:[.,]\d+)?)\s*"
                           r"(кг|т|м\s*[2²]|м\s*[3³]|м)\b", re.I)


def _doc_total(dn):
    """IISMETA cost-estimation engine module."""
    m = _RX_DOC_TOTAL.search(dn or "")
    if not m:
        return None
    return float(m.group(1).replace(",", ".")), m.group(2).replace(" ", "").lower()


def _fix_dim_scale(res, idx, rows=None):
    """IISMETA cost-estimation engine module."""
    n = 0
    for i, r in enumerate(res or []):
        src = (rows[i] if (rows and i < len(rows)) else None) or {}
        base_name = (src.get("name") if isinstance(src, dict) else None) or r.get("name") or ""
        for c in (r.get("candidates") or []):
            objem = c.get("objem")
            name = base_name or c.get("work") or ""
            if objem in (None, ""):
                continue
            a = _dim_of(c.get("unit_calc") or "")
            b = _dim_of(_norm_izm_unit(idx, c.get("wc"), c.get("shifr")))
            dn = (src.get("doc_note") if isinstance(src, dict) else "") or ""
            if dn and b:
                m_tot = re.search(r"общ[\w.]*\s*(?:вес)?\s*[-:—]?\s*(\d+(?:[.,]\d+)?)\s*"
                                  r"(кг|т|м\s*[2²]|м\s*[3³]|м)\b", dn, re.I)
                if m_tot:
                    v = float(m_tot.group(1).replace(",", "."))
                    u_tot = _dim_of(m_tot.group(2).replace(" ", ""))
                    new_v = wh = None
                    if u_tot == b:
                        new_v, wh = v, "итог из примечания ВОР «%s»" % dn[:40]
                    elif u_tot == "кг" and b == "т":
                        new_v, wh = round(v / 1000.0, 6), "итог из примечания ВОР «%s» (кг→т)" % dn[:34]
                    if new_v is not None and new_v != objem:
                        c["objem"], c["unit_calc"] = new_v, b
                        c["conv_note"] = "%s → %s %s (%s)" % (objem, new_v, b, wh)
                        r["note"] = ((r.get("note") or "") + " · ⚖ объём: %s" % wh).strip(" ·")
                        n += 1
                        continue
            if not a and b == "т" and objem not in (None, ""):
                r["note"] = ((r.get("note") or "") +
                             " · ⚠ ед.изм строки не указана, норма в ТОННАХ — проверьте: "
                             "если это килограммы, объём завышен в 1000 раз").strip(" ·")
                continue
            a_src = _dim_of(src.get("unit") if isinstance(src, dict) else "")
            try:
                q_src = float(src.get("qty")) if isinstance(src, dict) and src.get("qty") not in (None, "") else None
            except (TypeError, ValueError):
                q_src = None
            if a_src and a_src != a and q_src is not None and objem == q_src:
                a = a_src
            if a in ("т", "кг") and b not in ("т", "кг") and not a_src and objem == q_src:
                a = "шт"
            if b == "шт" and a in ("т", "кг"):
                n_sec = _count_in_name(src.get("section") if isinstance(src, dict) else "")
                if n_sec:
                    c["objem"], c["unit_calc"] = float(n_sec), "шт"
                    for cc in (c.get("components") or []):
                        cc["objem"] = float(n_sec)
                        cc.pop("objem_base", None)
                        cc.pop("k", None)
                    c["conv_note"] = "%s %s → %s шт (счётчик узла в заголовке)" % (objem, a, n_sec)
                    r["note"] = ((r.get("note") or "") +
                                 " · ⚖ объём: норма считается штуками, взят счётчик узла "
                                 "из заголовка «%s»" % str(src.get("section") or "")[:40]).strip(" ·")
                    n += 1
                    continue
            if b == "м" and a != "шт":
                n_cnt = _count_in_name(name)
                L_one, src_l = _len_one_m(name)
                if n_cnt and L_one:
                    new_v = round(n_cnt * L_one, 4)
                    k_conv = (new_v / float(objem)) if objem else 1.0
                    c["objem"], c["unit_calc"] = new_v, b
                    for cc in (c.get("components") or []):
                        if cc.get("objem") not in (None, ""):
                            try:
                                cc["objem"] = round(float(cc["objem"]) * k_conv, 4)
                            except (TypeError, ValueError):
                                pass
                    c["conv_note"] = "%s %s → %s м (%g шт × %g м, из текста строки)" % (
                        objem, a, new_v, n_cnt, L_one)
                    r["note"] = ((r.get("note") or "") + " · ⚖ объём %s→м: %g шт × %g м (%s)"
                                 % (a, n_cnt, L_one, src_l)).strip(" ·")
                    n += 1
                    continue
            if not a or not b or a == b or "кг" in (a, b) or "т" in (a, b):
                continue
            try:
                q = float(objem)
            except (TypeError, ValueError):
                continue
            new = why = None
            if a == "шт" and b == "м":
                L, src_l = _len_one_m(name)
                if L:
                    new, why = round(q * L, 4), "%g шт × %g м (%s)" % (q, L, src_l)
            elif a == "шт" and b == "м2":
                m = _RX_SIZE.search(name)
                m1 = _RX_AREA1.search(name)
                m_dn = _RX_AREA1.search(dn) if (dn and not re.search(r"общ", dn, re.I)) else None
                if m_dn:
                    s = float(m_dn.group(1).replace(",", "."))
                    if 0 < s < 100:
                        new, why = round(q * s, 4), "%g шт × %g м² (площадь из примечания ВОР)" % (q, s)
                if new is not None:
                    pass
                elif m:
                    s = int(m.group(1)) / 1000.0 * int(m.group(2)) / 1000.0
                    new, why = round(q * s, 4), "%g шт × %g м²" % (q, s)
                elif m1:
                    s = float(m1.group(1).replace(",", "."))
                    if 0 < s < 100:
                        new, why = round(q * s, 4), "%g шт × %g м² (площадь из текста)" % (q, s)
                elif not _RX_LOBSHCH.search(name):
                    m2 = _RX_BL_MM.search(name)
                    if m2:
                        s = _bl_area_m2(m2)
                        if 0 < s < 100:
                            new, why = round(q * s, 4), "%g шт × %g м² (В×L из текста)" % (q, s)
            elif a == "м3" and b == "м2":
                t_mm, src_t = _thick_mm(name)
                if t_mm and t_mm > 0:
                    new, why = round(q / (t_mm / 1000.0), 4), "%g м³ ÷ %g мм (%s)" % (q, t_mm, src_t)
            elif a == "м2" and b == "м3":
                t_mm, src_t = _thick_mm(name)
                if t_mm and t_mm > 0:
                    new, why = round(q * (t_mm / 1000.0), 4), "%g м² × %g мм (%s)" % (q, t_mm, src_t)
            if new is None:
                r["note"] = ((r.get("note") or "") +
                             " · ⚠ ед.изм строки (%s) ≠ измерителя нормы (%s) — проверьте объём"
                             % (a, b)).strip(" ·")
                continue
            k = (new / q) if q else 1
            c["objem"] = new
            c["unit_calc"] = b
            for cc in (c.get("components") or []):
                if cc.get("objem") not in (None, ""):
                    try:
                        cc["objem"] = round(float(cc["objem"]) * k, 4)
                    except (TypeError, ValueError):
                        pass
            c["conv_note"] = "%s %s → %s %s (%s, измеритель нормы)" % (objem, a, new, b, why)
            r["note"] = ((r.get("note") or "") + " · ⚖ объём %s→%s: %s" % (a, b, why)).strip(" ·")
            n += 1
    return n


@app.get("/api/engine_v2/health")
def engine_v2_health():
    """IISMETA cost-estimation engine module."""
    out = {"git": (os.environ.get("RENDER_GIT_COMMIT") or "")[:9] or "локально",
           "engine_default": (os.environ.get("ENGINE") or "b2c(не задан)"),
           "slots_built": False, "pack_present": False, "import_ok": False,
           "pipeline_ok": False, "error": None,
           "router_ask": (os.environ.get("IISMETA_ROUTER_ASK") or "1") != "0",
           "router_present": False}
    try:
        _here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine_v2")
        out["slots_built"] = os.path.exists(os.path.join(_here, "kb_slots.json"))
        out["pack_present"] = os.path.exists(os.path.join(_here, "fragments_pack.json.gz"))
        out["router_present"] = os.path.exists(os.path.join(_here, "router.py")) and \
            os.path.exists(os.path.join(_here, "data_router", "subject_canon.json.gz"))
        from engine_v2 import smeta as SM
        out["import_ok"] = True
        r = SM.build([{"name": "Устройство крыльцо из бетона кл. В20 W6", "unit": "м3", "qty": "1,23"}])
        out["pipeline_ok"] = bool((r.get("positions") or [{}])[0].get("code"))
        rp = SM.build([{"name": "Устройство грунтовой подушки из местного грунта "
                        "с послойным уплотнением пневмотрамбовками",
                        "unit": "м3", "qty": 905.4},
                       {"name": "Арматура АIII d=12", "unit": "кг", "qty": 120.5}])
        out["earth_probe"] = (rp.get("positions") or [{}])[0].get("code") or "нет кода"
        try:
            from engine_v2 import router as RT
            out["router_gost"] = "30245" in (RT._data().get("gost") or {})
            out["syn0_keys"] = len(RT._data().get("syn0") or {})
        except Exception as re:
            out["router_gost"] = "err:%s" % type(re).__name__
        try:
            from engine_v2 import leaf_ladder as LL
            lt = LL.thickness("11-01-011", "стяжка цементная 55 мм")
            out["ladder_probe"] = "%s+%s×%s" % (
                lt.get("code"), (lt.get("extra") or {}).get("code", "-"),
                (lt.get("extra") or {}).get("k", "-"))
        except Exception as le:
            out["ladder_probe"] = "err:%s" % type(le).__name__
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, str(e)[:180])
    return out


@app.get("/api/engine_v2/status")
def engine_v2_status(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        from engine_v2 import api as EV2
    except Exception as e:
        raise HTTPException(status_code=503, detail="Движок v2 недоступен: %s" % e)
    return EV2.status()


class EngineV2In(BaseModel):
    line: str
    title: str = ""
    ctx: list = []
    passport: dict = None


@app.post("/api/engine_v2/route")
def engine_v2_route(body: EngineV2In, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        from engine_v2 import api as EV2
    except Exception as e:
        raise HTTPException(status_code=503, detail="Движок v2 недоступен: %s" % e)
    if not EV2.available():
        raise HTTPException(status_code=503,
                            detail="Индекс kb_slots не собран (шаг сборки образа) — движок v2 не готов")
    return EV2.route(body.line, body.title, body.ctx, body.passport)


@app.post("/api/engine_v2/smeta")
def engine_v2_smeta(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        from engine_v2 import smeta as SM
    except Exception as e:
        raise HTTPException(status_code=503, detail="Конвейер v2 недоступен: %s" % e)
    return SM.build([r if isinstance(r, dict) else dict(r) for r in (body.rows or [])])


@app.post("/api/vor/clean")
def vor_clean(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        import llm_normalize as NORM
    except Exception as e:
        raise HTTPException(status_code=503, detail="Очистка недоступна: %s" % e)
    items = [{"i": n, "raw": (r.get("name") or "").strip()}
             for n, r in enumerate((body.rows or [])[:600]) if (r.get("name") or "").strip()]
    cleaned = NORM.clean_batch(items)
    out = []
    for it in items:
        c = cleaned.get(it["i"]) or {}
        out.append({"i": it["i"], "clean": c.get("c") or it["raw"], "params": c.get("p") or {},
                    "fb": bool(c.get("fb"))})
    return {"ok": True, "llm": NORM.llm_available(), "results": out}


@app.post("/api/vor/match_material")
def vor_match_material(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    if not hasattr(WZ, "match_material"):
        return {"ok": True, "results": []}
    out = []
    for n, r in enumerate((body.rows or [])[:600]):
        nm = (r.get("name") or "").strip()
        if not nm:
            continue
        out.append({"i": n, "candidates": WZ.match_material(nm, top_k=body.top_k or 5)})
    return {"ok": True, "results": out}


@app.get("/api/vor/ai_status")
def vor_ai_status(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        import llm_normalize as NORM
    except Exception as e:
        raise HTTPException(status_code=503, detail="Модуль недоступен: %s" % e)
    st = NORM.selftest()
    st["key_present"] = bool(NORM._api_key())
    st["cli_present"] = bool(NORM._claude_bin())
    return st


@app.post("/api/vor/disciplines")
def vor_disciplines(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import discipline_funnel as DF
    from collections import Counter, defaultdict
    import llm_normalize as NORM
    rows = (body.rows or [])[:600]
    covered = [(d["key"], d.get("name") or d["key"]) for d in DF._load_map()["disciplines"] if d.get("covered")]
    covered_keys = {c[0] for c in covered}

    kw = [DF.guess_discipline_conf((r.get("name") or "").strip(), r.get("section") or "") if (r.get("name") or "").strip() else (None, None) for r in rows]
    guess = [g for g, _ in kw]
    conf = [c for _, c in kw]
    src = ["kw" if g else None for g in guess]

    if NORM.llm_available():
        items = [{"i": n, "name": (r.get("name") or "").strip(), "section": _sec_txt(r.get("section"))}
                 for n, r in enumerate(rows) if (r.get("name") or "").strip()]
        try:
            llm = NORM._with_cache("vor_disc", NORM._DISC_PROMPT, items,
                                   lambda it: (it["name"], it["section"]),
                                   lambda part: NORM.disciplines_llm(part, covered))
        except Exception:
            llm = {}
        for n in range(len(rows)):
            k = llm.get(n)
            if k in covered_keys:
                conf[n] = "high" if guess[n] == k else "medium"
                guess[n] = k; src[n] = "llm"

    children = defaultdict(list)
    for r, g in zip(rows, guess):
        sec = _sec_txt(r.get("section"))
        if sec and g:
            children[sec].append(g)
    sec_disc = {}
    for sec in {_sec_txt(r.get("section")) for r in rows if _sec_txt(r.get("section"))}:
        byname, byname_conf = DF.guess_discipline_conf("", sec)
        if byname:
            sec_disc[sec] = (byname, byname_conf)
        elif children.get(sec):
            top, cnt = Counter(children[sec]).most_common(1)[0]
            sec_disc[sec] = (top, "medium" if cnt == len(children[sec]) else "low")
    for n, r in enumerate(rows):
        if not guess[n]:
            inh = sec_disc.get(_sec_txt(r.get("section")))
            if inh:
                guess[n], conf[n] = inh; src[n] = "sec"

    present = [g for g in guess if g]
    if present:
        dominant = Counter(present).most_common(1)[0][0]
        for n, r in enumerate(rows):
            if not guess[n] and (r.get("name") or "").strip():
                guess[n] = dominant; src[n] = "doc"; conf[n] = "low"

    out = [{"i": n, "disc": guess[n], "src": src[n], "conf": conf[n]} for n in range(len(rows))]
    return {"ok": True, "results": out}


def _pf(s):
    try:
        return float(str(s).replace(",", ".").replace(" ", ""))
    except Exception:
        return None


@app.post("/api/vor/resources")
def vor_resources(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    _index_fn = getattr(WZ, "_index", None)
    idx = _index_fn() if callable(_index_fn) else {}
    out = []
    errors = 0
    for n, r in enumerate((body.rows or [])[:400]):
        wc = r.get("wc"); shifr = r.get("shifr") or r.get("code"); objem = r.get("objem") or 0
        res = []
        conv_note = None
        err = False
        hcorr = None
        scorr = None
        try:
            w = idx.get(str(wc)) or {}
            v = next((x for x in w.get("varianty", [])
                      if x.get("shifr") == shifr or x.get("code") == shifr), None)
            code = (v or {}).get("code")
            if code:
                izm = str((v or {}).get("unit") or "")
                m = re.match(r"\s*(\d+(?:[.,]\d+)?)", izm)
                factor = _pf(m.group(1)) if m else 1.0
                izm_unit = re.sub(r"^\s*\d+(?:[.,]\d+)?\s*", "", izm).strip()
                vor_unit = (r.get("unit") or "").strip()
                objem_use = objem
                if izm_unit and vor_unit and UC.norm_unit(vor_unit) != UC.norm_unit(izm_unit):
                    cu, why = UC.convert(objem, vor_unit, izm_unit, r.get("params") or {})
                    if cu is not None:
                        objem_use, conv_note = cu, why
                if KB:
                    comp = WZ.compute_code(wc, objem_use, code, r.get("swaps") or {},
                                           r.get("qtys") or {}, list(r.get("drops") or []),
                                           body.criteria)
                else:
                    comp = WZ.compute_code(wc, objem_use, code)
                hcorr = comp.get("поправка_высота_авто")
                scorr = comp.get("поправка_сейсмика_авто")
                for x in (comp.get("ресурсы") or []):
                    excl = bool(x.get("исключён"))
                    nv = _pf(x.get("норма"))
                    kol = (nv * (objem_use or 0) / factor) if (nv is not None and factor) else None
                    rc = str(x.get("шифр") or "")
                    row = {"name": x.get("наименование") or "", "type": x.get("тип") or "",
                           "unit": x.get("ед") or "", "norma": x.get("норма"),
                           "kol": (round(kol, 3) if kol is not None else None),
                           "code": rc, "key": str(x.get("шифр_orig") or rc)}
                    if excl:
                        row["excl"] = True
                    if x.get("ввод_кол"):
                        row["ed"] = True
                    if x.get("кол_задан"):
                        row["qset"] = True
                    if x.get("по_проекту"):
                        row["ppro"] = True
                    if x.get("замена"):
                        row["swapkind"] = x.get("замена")
                    if x.get("заменён"):
                        row["swapped"] = x.get("заменён")
                        row["orig_name"] = x.get("наим_orig") or ""
                    res.append(row)
        except Exception as e:
            err = True; errors += 1
            print("[vor/resources] строка %s (wc=%s, shifr=%s) — сбой ресурсов: %s" % (n, wc, shifr, e))
        out.append({"i": n, "res": res, "conv": conv_note, "err": err, "height_correction": hcorr, "seismic_correction": scorr})
    return {"ok": True, "results": out, "errors": errors, "kb": bool(callable(_index_fn))}


@app.post("/api/vor/decompose")
def vor_decompose(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import llm_normalize as NORM
    items = [{"i": n, "name": (r.get("name") or ""),
              "rawunit": r.get("unit_raw") or r.get("unit") or "", "rawqty": r.get("qty_multi") or ""}
             for n, r in enumerate((body.rows or [])[:200]) if (r.get("name") or "").strip()]
    parts = NORM.decompose_batch(items)
    out = [{"i": it["i"], "parts": parts.get(it["i"]) or []} for it in items]
    return {"ok": True, "llm": NORM.llm_available(), "results": out}


@app.post("/api/vor/floor_pipeline")
def vor_floor_pipeline(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import floor_decompose as FD
    import cluster_c as CC
    rows = [{"name": r.get("name") or "", "unit": r.get("unit") or "",
              "qty": r.get("qty"), "params": r.get("params") or {}}
             for r in (body.rows or [])[:200]]
    works = FD.decompose(rows)
    validation = FD.validate(works)
    lrv = []
    for w in works:
        r = CC.variant_pick(w)
        for comp in (r.get("components") or []):
            objem = round((w.get("qty") or 0) * comp.get("qty_factor", 1.0), 4)
            row = WZ.compute_code(r["wc"], objem, comp["shifr"]) if r.get("wc") else {"error": r.get("error")}
            lrv.append({"table": w["table"], "role": w.get("role"), "shifr": comp["shifr"],
                        "objem": objem, "unit": w.get("unit"), "variant": r.get("variant"),
                        "operator_flag": r.get("operator_flag"), "row": row})
    return {"ok": True, "works": works, "validate": validation, "lrv": lrv}


@app.post("/api/vor/wall_pipeline")
def vor_wall_pipeline(body: VorMatchIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    import wall_decompose as WD
    import cluster_c as CC
    section = (body.criteria or {}).get("section")
    rows = [{"name": r.get("name") or "", "unit": r.get("unit") or "",
              "qty": r.get("qty"), "params": r.get("params") or {}}
             for r in (body.rows or [])[:200]]
    works = WD.decompose(rows, section=section)
    validation = WD.validate(works)
    lrv = []
    for w in works:
        r = CC.variant_pick(w)
        for comp in (r.get("components") or []):
            objem = round((w.get("qty") or 0) * comp.get("qty_factor", 1.0), 4)
            row = WZ.compute_code(r["wc"], objem, comp["shifr"]) if r.get("wc") else {"error": r.get("error")}
            lrv.append({"table": w["table"], "role": w.get("role"), "shifr": comp["shifr"],
                        "objem": objem, "unit": w.get("unit"), "variant": r.get("variant"),
                        "operator_flag": r.get("operator_flag"), "row": row})
    return {"ok": True, "works": works, "validate": validation, "lrv": lrv}


@app.on_event("startup")
def _warm_norma():
    import threading
    def _build():
        try:
            NORMA.ensure_fts()
            print("norma: FTS готов")
        except Exception as e:
            print("norma: FTS не прогрет (%s)" % e)
    threading.Thread(target=_build, daemon=True).start()


@app.get("/api/norma/tree")
def norma_tree(parent: int = -1, x_auth: str = Header(None)):
    _auth(x_auth)
    try:
        return {"label": NORMA.SBORNIK_LABEL, "nodes": NORMA.children(parent)}
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="База НОРМА не загружена")


@app.get("/api/norma/node")
def norma_node(pos: int, x_auth: str = Header(None)):
    _auth(x_auth)
    return {"pos": pos, "docs": NORMA.node_documents(pos)}


@app.get("/api/norma/doc")
def norma_doc(doc: int, x_auth: str = Header(None)):
    _auth(x_auth)
    d = NORMA.document(doc)
    if not d:
        raise HTTPException(status_code=404, detail="Документ не найден")
    return d


@app.get("/api/norma/search")
def norma_search(q: str, x_auth: str = Header(None)):
    _auth(x_auth)
    return {"q": q, "results": NORMA.search(q)}


@app.on_event("startup")
def _warm_info():
    import threading
    def _build():
        try:
            INFO.ensure_fts()
            print("info: FTS готов")
        except Exception as e:
            print("info: FTS не прогрет (%s)" % e)
    threading.Thread(target=_build, daemon=True).start()


@app.get("/api/info/tree")
def info_tree(parent: int = -1, x_auth: str = Header(None)):
    _auth(x_auth)
    try:
        return {"label": INFO.LABEL, "nodes": INFO.children(parent)}
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="База ИНФО не загружена")


@app.get("/api/info/node")
def info_node(pos: int, x_auth: str = Header(None)):
    _auth(x_auth)
    return {"pos": pos, "docs": INFO.node_documents(pos)}


@app.get("/api/info/doc")
def info_doc(doc: int, x_auth: str = Header(None)):
    _auth(x_auth)
    d = INFO.document(doc)
    if not d:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    return d


@app.get("/api/info/search")
def info_search(q: str, x_auth: str = Header(None)):
    _auth(x_auth)
    return {"q": q, "results": INFO.search(q)}


# ═══════════════════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════════════════
import sqlite3 as _val_sqlite3
import csv as _val_csv
import json as _val_json2

_VAL_DB_PATH = ("/data/validator.db" if os.path.isdir("/data")
               else os.path.join(HERE, "0_БД_расценок", "validator_local.db"))


def _val_con():
    con = _val_sqlite3.connect(_VAL_DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, line TEXT, title TEXT, unit TEXT,
        qty TEXT, route_json TEXT, verdict TEXT, comment TEXT)""")
    return con


class ValidatorRouteIn(BaseModel):
    line: str
    unit: str = ""
    qty: str = ""
    title: str = ""
    card: dict = None
    kaskad_answer: str = ""
    kaskad_answers: list = []
    kaskad_axis_answers: dict = {}
    kaskad_leaf_pick: str = ""


@app.post("/api/validator/route")
def validator_route(body: ValidatorRouteIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    try:
        from engine_v2 import validator as VAL
    except Exception as e:
        raise HTTPException(status_code=503, detail="Валидатор недоступен: %s" % e)
    return VAL.route_line(body.line, unit=body.unit, qty=body.qty, title=body.title,
                          card=body.card, kaskad_answer=body.kaskad_answer or None,
                          kaskad_answers=body.kaskad_answers or [],
                          kaskad_axis_answers=body.kaskad_axis_answers or {},
                          kaskad_leaf_pick=body.kaskad_leaf_pick or None)


class ValidatorLogIn(BaseModel):
    line: str = ""
    title: str = ""
    unit: str = ""
    qty: str = ""
    route: dict = None
    verdict: str = ""                 # "ok" | "no" | "question"
    comment: str = ""


@app.post("/api/validator/log")
def validator_log(body: ValidatorLogIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    con = _val_con()
    cur = con.execute(
        "INSERT INTO log(ts,line,title,unit,qty,route_json,verdict,comment) VALUES (?,?,?,?,?,?,?,?)",
        (_time.strftime("%Y-%m-%d %H:%M:%S"), body.line, body.title, body.unit, body.qty,
         _val_json2.dumps(body.route or {}, ensure_ascii=False), body.verdict, body.comment))
    con.commit()
    new_id = cur.lastrowid
    con.close()
    return {"ok": True, "id": new_id}


class ValidatorCommentIn(BaseModel):
    id: int
    comment: str = None
    verdict: str = None


@app.post("/api/validator/comment")
def validator_comment(body: ValidatorCommentIn, x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    con = _val_con()
    if body.comment is not None:
        con.execute("UPDATE log SET comment=? WHERE id=?", (body.comment, body.id))
    if body.verdict is not None:
        con.execute("UPDATE log SET verdict=? WHERE id=?", (body.verdict, body.id))
    con.commit()
    ok = con.total_changes > 0
    con.close()
    return {"ok": ok}


@app.get("/api/validator/log")
def validator_log_list(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    con = _val_con()
    rows = con.execute(
        "SELECT id,ts,line,title,unit,qty,route_json,verdict,comment FROM log "
        "ORDER BY id DESC LIMIT 300").fetchall()
    con.close()
    out = []
    for r in rows:
        try:
            route = _val_json2.loads(r[6] or "{}")
        except ValueError:
            route = {}
        out.append({"id": r[0], "ts": r[1], "line": r[2], "title": r[3], "unit": r[4],
                    "qty": r[5], "route": route, "verdict": r[7], "comment": r[8]})
    return {"rows": out}


@app.get("/api/validator/export")
def validator_export(x_auth: str = Header(None)):
    """IISMETA cost-estimation engine module."""
    _auth(x_auth)
    con = _val_con()
    rows = con.execute(
        "SELECT id,ts,line,title,unit,qty,verdict,comment FROM log ORDER BY id DESC").fetchall()
    con.close()
    buf = io.StringIO()
    w = _val_csv.writer(buf, delimiter=";")
    w.writerow(["id", "время", "строка", "раздел", "ед.изм", "кол-во", "вердикт", "комментарий"])
    for r in rows:
        w.writerow(r)
    data = "﻿" + buf.getvalue()
    return StreamingResponse(io.BytesIO(data.encode("utf-8")), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=validator_log.csv"})


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"),
                        headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


from tg_bot import router as tg_router
app.include_router(tg_router)

app.mount("/", StaticFiles(directory=STATIC), name="static")
