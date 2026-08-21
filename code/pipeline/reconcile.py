# -*- coding: utf-8 -*-
"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import re
import difflib
from dataclasses import replace as _dc_replace
from .schema import ExtractionResult, RawRow

_QTY_TOL_REL = 0.01
_QTY_TOL_ABS = 0.05


def _norm_key(name: str) -> str:
    s = (name or "").lower().replace("ё", "е")
    s = re.sub(r"[^a-zа-я0-9]+", "", s)
    return s[:60]


def _qty_close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= max(_QTY_TOL_ABS, abs(b) * _QTY_TOL_REL)


def _merge_row(t: RawRow, v: RawRow):
    """IISMETA cost-estimation engine module."""
    if t.row_kind != v.row_kind:
        return None
    name = t.name if len((t.name or "")) >= len((v.name or "")) else v.name
    unit = t.unit if t.unit is not None else v.unit
    qty = t.qty if t.qty is not None else v.qty
    qty_raw = t.qty_raw if t.qty_raw is not None else v.qty_raw
    tag = "both" if _qty_close(t.qty, v.qty) and (t.unit or v.unit) == (unit) else "both_qty_diff"
    extra = dict(t.extra); extra["_dual"] = tag
    if tag == "both_qty_diff":
        extra["_dual_vision_qty"] = v.qty
    if v.extra.get("note") and not extra.get("note"):
        extra["note"] = v.extra["note"]
    if v.extra.get("section_name") and not extra.get("section_name"):
        extra["section_name"] = v.extra["section_name"]
    return _dc_replace(t, name=name, unit=unit, qty=qty, qty_raw=qty_raw, extra=extra)


def _vision_only_row(v: RawRow) -> RawRow:
    extra = dict(v.extra); extra["_dual"] = "vision_only"
    return _dc_replace(v, extra=extra)


def _text_only_row(t: RawRow) -> RawRow:
    extra = dict(t.extra); extra["_dual"] = "text_only"
    return _dc_replace(t, extra=extra)


def reconcile_rows(text_rows: list, vision_rows: list) -> tuple:
    """IISMETA cost-estimation engine module."""
    tk = [_norm_key(r.name) for r in text_rows]
    vk = [_norm_key(r.name) for r in vision_rows]
    sm = difflib.SequenceMatcher(a=tk, b=vk, autojunk=False)
    merged, dropped = [], []
    stats = {"both": 0, "both_qty_diff": 0, "vision_only": 0, "text_only": 0, "replaced_by_vision": 0}
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for i, j in zip(range(i1, i2), range(j1, j2)):
                m = _merge_row(text_rows[i], vision_rows[j])
                if m is None:
                    merged.append(_vision_only_row(vision_rows[j])); stats["vision_only"] += 1
                    merged.append(_text_only_row(text_rows[i])); stats["text_only"] += 1
                    continue
                stats[m.extra["_dual"]] += 1
                merged.append(m)
        elif op == "delete":
            for i in range(i1, i2):
                merged.append(_text_only_row(text_rows[i]))
                stats["text_only"] += 1
        elif op == "insert":
            for j in range(j1, j2):
                merged.append(_vision_only_row(vision_rows[j]))
                stats["vision_only"] += 1
        else:
            if (i2 - i1) == (j2 - j1):
                for i, j in zip(range(i1, i2), range(j1, j2)):
                    m = _merge_row(text_rows[i], vision_rows[j])
                    if m is None:
                        merged.append(_vision_only_row(vision_rows[j])); stats["vision_only"] += 1
                        merged.append(_text_only_row(text_rows[i])); stats["text_only"] += 1
                        continue
                    m.extra["_dual"] = "replaced_pair"
                    stats["both"] += 1
                    merged.append(m)
            else:
                vision_keys = {_norm_key(vision_rows[j].name) for j in range(j1, j2)}
                vision_qtys = [vision_rows[j].qty for j in range(j1, j2) if vision_rows[j].qty is not None]
                for i in range(i1, i2):
                    if text_rows[i].row_kind == "section" and _norm_key(text_rows[i].name) not in vision_keys:
                        row = _text_only_row(text_rows[i])
                        row.extra["_dual"] = "text_only_section_kept"
                        merged.append(row)
                        stats["text_only"] += 1
                    elif text_rows[i].row_kind == "data" and _norm_key(text_rows[i].name) not in vision_keys:
                        t = text_rows[i]
                        if t.qty is not None and any(_qty_close(t.qty, vq) for vq in vision_qtys):
                            dropped.append(t)
                        else:
                            row = _text_only_row(t)
                            row.extra["_dual"] = "text_only_data_rescued"
                            merged.append(row)
                            stats["text_only"] += 1
                for j in range(j1, j2):
                    row = _vision_only_row(vision_rows[j])
                    row.extra["_dual"] = "replaced_by_vision"
                    row.extra["_dual_text_alt"] = [text_rows[i].name for i in range(i1, i2)]
                    merged.append(row)
                    stats["replaced_by_vision"] += 1
    stats["text_data_dropped"] = len(dropped)
    return merged, stats, dropped


def collapse_section_echo(rows: list) -> "tuple[list, list]":
    """IISMETA cost-estimation engine module."""
    out, dropped = [], []
    i = 0
    while i < len(rows):
        r = rows[i]
        if r.row_kind == "data" and r.qty is None and not (r.unit or "").strip():
            k = _norm_key(r.name)
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            prv = out[-1] if out else None
            twin = None
            if nxt is not None and nxt.row_kind == "section" and _norm_key(nxt.name) == k:
                twin = nxt
            elif prv is not None and prv.row_kind == "section" and _norm_key(prv.name) == k:
                twin = prv
            if twin is not None and k:
                twin.extra["_dual_dup_collapsed"] = True
                dropped.append(r)
                i += 1
                continue
        out.append(r)
        i += 1
    return out, dropped


def _renumber_sections(rows: list) -> list:
    """IISMETA cost-estimation engine module."""
    out, sec = [], -1
    for r in rows:
        if r.row_kind == "section":
            sec += 1
        out.append(_dc_replace(r, section=max(sec, 0)))
    return out


def reconcile(text_results: list, vision_results: list) -> "tuple[list, dict]":
    """IISMETA cost-estimation engine module."""
    if not text_results:
        return text_results, {"skipped": "no_text_results"}
    if not vision_results:
        return text_results, {"skipped": "no_vision_results"}
    multi = len(text_results) > 1 or len(vision_results) > 1
    tres = text_results[0]
    text_rows = [r for tr in text_results for r in tr.rows]
    vision_rows = [r for vr in vision_results for r in vr.rows]
    merged_rows, stats, replace_dropped = reconcile_rows(text_rows, vision_rows)
    merged_rows, dup_dropped = collapse_section_echo(merged_rows)
    stats["dup_collapsed"] = len(dup_dropped)
    stats["multi_table"] = ({"n_text": len(text_results), "n_vision": len(vision_results)}
                            if multi else None)
    merged_rows = _renumber_sections(merged_rows)
    title = tres.meta.get("title")
    params = dict(tres.meta.get("params", {}) or {})
    if multi:
        titles = [str(tr.meta.get("title") or "").strip() for tr in text_results
                  if (tr.meta.get("title") or "").strip()]
        if titles:
            title = " | ".join(dict.fromkeys(titles))
        for tr in text_results[1:]:
            params.update(tr.meta.get("params", {}) or {})
    out = ExtractionResult(
        page=tres.page, extractor=tres.extractor + "+vision_dual", route=tres.route,
        header=tres.header, rows=merged_rows, table_bbox=tres.table_bbox,
        n_struct_rows=len(merged_rows), meta=dict(tres.meta))
    out.meta["title"] = title
    out.meta["params"] = params
    out.meta["_dual_stats"] = stats
    out.meta["_dual_dup_dropped"] = [{"name": r.name, "unit": r.unit, "qty": r.qty,
                                      "reason": "dual_dup_section_echo"} for r in dup_dropped] + \
        [{"name": r.name, "unit": r.unit, "qty": r.qty,
          "reason": "dual_replace_data_dropped"} for r in replace_dropped]
    return [out], stats
