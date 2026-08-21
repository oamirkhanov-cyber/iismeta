# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
import json
import os
import threading
import time

_LOCK = threading.Lock()
_MAX_VAL = 2000


def _base_dir():
    env = os.environ.get("PROJECT_STORE")
    if env:
        d = env
    elif os.path.isdir("/data"):
        d = "/data/projects"
    else:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_projects")
    return os.path.join(d, "_journal")


def _path():
    d = _base_dir()
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "edits-%s.jsonl" % time.strftime("%Y-%m"))


def _cut(v):
    s = "" if v is None else str(v)
    return s[:_MAX_VAL]


def log(entry):
    """IISMETA cost-estimation engine module."""
    if not isinstance(entry, dict):
        return False
    was, now = _cut(entry.get("was")), _cut(entry.get("now"))
    if was == now:
        return False
    rec = {
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        "operator": _cut(entry.get("operator"))[:80],
        "kind": _cut(entry.get("kind"))[:40] or "cell",   # cell | split | add | delete | type | unit
        "field": _cut(entry.get("field"))[:40],
        "was": was,
        "now": now,
        "raw": _cut(entry.get("raw")),
        "project_n": entry.get("project_n"),
        "file_id": _cut(entry.get("file_id"))[:40],
        "sub_id": _cut(entry.get("sub_id"))[:60],
        "discipline": _cut(entry.get("discipline"))[:80],
        "pos": _cut(entry.get("pos"))[:40],
        "row": entry.get("row"),
        "unit": _cut(entry.get("unit"))[:40],
        "qty": entry.get("qty"),
    }
    try:
        with _LOCK:
            with open(_path(), "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def stats():
    """IISMETA cost-estimation engine module."""
    d = _base_dir()
    out = {"files": 0, "entries": 0, "by_kind": {}, "by_field": {}, "first": "", "last": ""}
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".jsonl"):
            continue
        out["files"] += 1
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    out["entries"] += 1
                    k, fl = r.get("kind", "?"), r.get("field", "?")
                    out["by_kind"][k] = out["by_kind"].get(k, 0) + 1
                    out["by_field"][fl] = out["by_field"].get(fl, 0) + 1
                    ts = r.get("ts", "")
                    if ts and (not out["first"] or ts < out["first"]):
                        out["first"] = ts
                    if ts > out["last"]:
                        out["last"] = ts
        except Exception:
            continue
    return out


def export(limit=5000):
    """IISMETA cost-estimation engine module."""
    d = _base_dir()
    rows = []
    if not os.path.isdir(d):
        return rows
    for fn in sorted(os.listdir(d), reverse=True):
        if not fn.endswith(".jsonl"):
            continue
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                lines = f.readlines()
        except Exception:
            continue
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
            if len(rows) >= limit:
                return rows
    return rows
