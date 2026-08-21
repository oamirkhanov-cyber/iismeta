"""IISMETA cost-estimation engine module."""
from __future__ import annotations
import os
from dataclasses import asdict
from .schema import Route
from .triage import triage
from .validator import validate
from .extractors import (camelot_lattice, textlayer_bbox, textword_anchor,
                         cadvector_grid, ppstructure_ocr, claude_vision)
from .stamp import parse_stamp
from .crosscheck import crosscheck
from .reconcile import reconcile
from .trash_filter import filter_trash
from .doctype import classify_doc_type
from .extractors.base import ExtractorUnavailable


def _vision_dual_enabled() -> bool:
    """IISMETA cost-estimation engine module."""
    return os.environ.get("VISION_DUAL", "1") != "0"


def _short(mod):
    return mod.__name__.split(".")[-1]


def _score(results) -> int:
    """IISMETA cost-estimation engine module."""
    n = 0
    for res in results or []:
        for r in getattr(res, "rows", []):
            if r.row_kind == "data" and (r.name or "").strip() and r.qty is not None:
                n += 1
    return n


def digitize(pdf_path: str, page_no: int = 0, cross_check: bool = False, do_ocr: bool = True) -> dict:
    verdict = triage(pdf_path, page_no)

    doc_type = classify_doc_type(pdf_path, page_no)
    if not doc_type.get("is_vor", True):
        return {"ok": True, "triage": asdict(verdict), "extractor_used": None,
                "doc_type": doc_type, "document": parse_stamp(pdf_path),
                "fallback_notes": [], "n_tables": 0, "n_xcheck": 0, "dual_stats": None,
                "trash_log": [{"name": "(страница целиком)", "unit": None, "qty": None,
                               "reason": "doc_type=%s (маркер=%s, scope=%s) — не ВОР работ, извлечение пропущено"
                                         % (doc_type.get("doc_type"), doc_type.get("marker"), doc_type.get("scope"))}],
                "tables": [], "normalized_all": [], "cross_check": None}

    results, tried, extractor_used = [], [], None
    dual_stats = None

    if verdict.route in (Route.NATIVE_RULED, Route.NATIVE_BORDERLESS):
        text_broken = getattr(verdict, "text_broken", False)
        if text_broken:
            tried.append("cid-гейт (§2.2): текст-слой битый (cid_ratio=%.3f/word_ratio=%.3f) — "
                         "текст-экстракторы пропущены, решает vision" %
                         (getattr(verdict, "cid_ratio", 0.0), getattr(verdict, "word_ratio", 1.0)))
        else:
            for name, fn in (("textlayer_bbox", textlayer_bbox.extract_all),
                             ("textword_anchor", textword_anchor.extract_all)):
                try:
                    rs = fn(pdf_path, page_no)
                    if _score(rs) >= 3:
                        results, extractor_used = rs, name
                        break
                except ExtractorUnavailable as e:
                    tried.append(f"{name}: {e}")
            if not results:
                try:
                    results = [camelot_lattice.extract(pdf_path, page_no)]
                    extractor_used = "camelot_lattice"
                except ExtractorUnavailable as e:
                    tried.append(f"camelot_lattice: {e}")

        vision_dual_done = False
        if do_ocr and _vision_dual_enabled():
            vision_dual_done = True
            try:
                vision_results = claude_vision.extract_all(pdf_path, page_no)
            except ExtractorUnavailable as e:
                vision_results = []
                tried.append(f"claude_vision(dual): {e}")
            if vision_results:
                if results:
                    results, dual_stats = reconcile(results, vision_results)
                    extractor_used = f"{extractor_used}+vision_dual"
                else:
                    results, extractor_used = vision_results, "claude_vision"

        if not results and do_ocr:
            if not vision_dual_done:
                try:
                    results = claude_vision.extract_all(pdf_path, page_no)
                    extractor_used = "claude_vision"
                except ExtractorUnavailable as e:
                    tried.append(f"claude_vision(native→ocr): {e}")
            if not results:
                try:
                    results = cadvector_grid.extract_all(pdf_path, page_no)
                    extractor_used = "cadvector_grid"
                except ExtractorUnavailable as e:
                    tried.append(f"cadvec(native→ocr): {e}")
            if not results:
                try:
                    results = textword_anchor.extract_all_ocr(pdf_path, page_no)
                    extractor_used = "textword_ocr"
                except ExtractorUnavailable as e:
                    tried.append(f"textword_ocr(native→ocr): {e}")
            if not results:
                try:
                    results = [ppstructure_ocr.extract(pdf_path, page_no)]
                    extractor_used = "ppstructure_ocr"
                except ExtractorUnavailable as e:
                    tried.append(f"ocr(native→ocr): {e}")
    elif do_ocr:
        try:
            results = claude_vision.extract_all(pdf_path, page_no)
            extractor_used = "claude_vision"
        except ExtractorUnavailable as e:
            tried.append(f"claude_vision: {e}")
        if not results and verdict.scan_kind == "cad_vector":
            try:
                results = cadvector_grid.extract_all(pdf_path, page_no)
                extractor_used = "cadvector_grid"
            except ExtractorUnavailable as e:
                tried.append(f"cadvector_grid: {e}")
        if not results:
            try:
                results = textword_anchor.extract_all_ocr(pdf_path, page_no)
                extractor_used = "textword_ocr"
            except ExtractorUnavailable as e:
                tried.append(f"textword_ocr: {e}")
        if not results:
            try:
                results = [ppstructure_ocr.extract(pdf_path, page_no)]
                extractor_used = "ppstructure_ocr"
            except ExtractorUnavailable as e:
                tried.append(f"ppstructure_ocr: {e}")
    else:
        tried.append("OCR пропущен (--no-ocr)")

    if not results:
        return {"ok": False, "triage": asdict(verdict),
                "error": "ни один экстрактор не отработал", "tried": tried}

    n_xcheck = crosscheck(pdf_path, page_no, extractor_used, results)

    trash_log = []
    for res in results:
        res.rows, tr = filter_trash(res.rows)
        trash_log.extend(tr)
        trash_log.extend(res.meta.pop("_dual_dup_dropped", []))
        for r in res.rows:
            if r.row_kind == "section" and r.extra.get("_demoted_work"):
                trash_log.append({"name": r.name, "unit": None, "qty": None,
                                  "reason": r.extra["_demoted_work"]})

    tables, normalized_all = [], []
    for res in results:
        rep = validate(res)
        norm = [_norm(r) for r in res.rows if r.row_kind == "data"]
        title = res.meta.get("title")
        tables.append({
            "title": title, "params": res.meta.get("params", {}), "header": res.header,
            "n_data": rep.stats["n_data_rows"],
            "validation": asdict(rep),
            "rows": [_row_out(r) for r in res.rows],
            "normalized": norm,
        })
        for n in norm:
            normalized_all.append({"well": title, **n})

    cross = None
    if cross_check and len(results) == 1 and verdict.route in (Route.NATIVE_RULED, Route.NATIVE_BORDERLESS):
        cross = _cross_check(pdf_path, page_no, results[0])

    return {"ok": True, "triage": asdict(verdict), "extractor_used": extractor_used,
            "doc_type": doc_type, "document": parse_stamp(pdf_path),
            "fallback_notes": tried, "n_tables": len(results),
            "n_xcheck": n_xcheck, "dual_stats": dual_stats, "trash_log": trash_log,
            "tables": tables, "normalized_all": normalized_all, "cross_check": cross}


def _cross_check(pdf_path, page_no, primary):
    other = camelot_lattice if primary.extractor == "textlayer_bbox" else textlayer_bbox
    try:
        second = other.extract(pdf_path, page_no)
    except ExtractorUnavailable as e:
        return {"available": False, "reason": str(e)}
    da = [r for r in primary.rows if r.row_kind == "data"]
    db = [r for r in second.rows if r.row_kind == "data"]
    diffs = []
    for i in range(min(len(da), len(db))):
        a, b = da[i], db[i]
        if a.qty != b.qty or (a.name or "").strip() != (b.name or "").strip():
            diffs.append({"row": i, "qty_a": a.qty, "qty_b": b.qty, "name_a": a.name, "name_b": b.name})
    if len(da) != len(db):
        diffs.append({"row_count": {"a": len(da), "b": len(db)}})
    return {"available": True, "against": second.extractor, "n_diffs": len(diffs), "diffs": diffs[:50]}


def _row_out(r):
    return {"pos": r.pos, "code_src": r.code_src, "name": r.name, "unit": r.unit,
            "qty_raw": r.qty_raw, "qty": r.qty, "kind": r.row_kind, "section": r.section,
            "extractor": r.source_extractor, "confidence": r.confidence, "extra": r.extra}


def _norm(r):
    ref = r.extra.get("_ref") or {}
    return {"pos": r.pos, "code_src": r.code_src, "name": r.name, "unit": r.unit,
            "qty": r.qty, "section": r.section,
            "unit2": ref.get("unit"), "qty2": ref.get("qty")}
