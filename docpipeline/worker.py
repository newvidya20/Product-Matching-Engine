"""Per-page processing, run inside worker processes. One page is rasterized / read at a time."""
from __future__ import annotations

import os
import time
import traceback

import pymupdf as fitz

import config
import intake
import ocr_engines as oe
import preprocess as pp
import tables as tb

_docs: dict[str, "fitz.Document"] = {}


def _doc(path: str):
    d = _docs.get(path)
    if d is None:
        if len(_docs) >= 2:  # keep at most two open documents per worker
            _docs.pop(next(iter(_docs))).close()
        d = _docs[path] = fitz.open(path)
        if d.needs_pass:
            raise RuntimeError("encrypted")
    return d


def _text_layer_page(page, page_no: int) -> dict:
    blocks = []
    for b in page.get_text("dict", sort=True)["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b["lines"]:
            t = "".join(s["text"] for s in ln["spans"]).strip()
            if t:
                blocks.append({"text": t, "bbox": [round(v, 1) for v in ln["bbox"]], "conf": 100.0, "engine": "text_layer"})
    return {"source": "text_layer", "confidence": 100.0, "text": page.get_text("text", sort=True).strip(),
            "blocks": blocks, "tables": tb.tables_from_pdf_page(page), "unit": "pt", "engines_tried": ["text_layer"]}


def _ocr_once(bgr, task: dict, dpi: int) -> dict:
    prep = pp.preprocess(bgr, config.find_tesseract(), str(config.TESSDATA))
    tried, errors = [], []
    pad, tess = [], []
    thr = task["conf_threshold"]
    if task.get("paddle", True):
        try:
            pad = oe.paddle_lines(prep["clean"])
            tried.append("paddle")
        except Exception as e:
            errors.append(f"paddle: {type(e).__name__}: {str(e)[:160]}")
    # Tesseract always runs: it is the only engine here that reads Devanagari (hin/mar), and it supplies a
    # second opinion for the merge. Extra psm modes are only tried while the page is under the threshold.
    try:
        tess, modes = oe.tesseract_best(prep["clean"], task["lang"], thr if not pad else 101)
        tried += modes
    except Exception as e:
        errors.append(f"tesseract: {type(e).__name__}: {str(e)[:160]}")
    lines = oe.merge_lines(pad, tess) if pad and tess else (pad or tess)
    lines = oe.drop_noise(lines)  # merge_lines already ran the region merge and duplicate-word cleanup
    conf = oe.page_conf(lines)
    source = "ocr_merged" if pad and tess else ("ocr_paddle" if pad else "ocr_tesseract")
    return {"prep": prep, "lines": lines, "conf": conf, "source": source, "tried": tried, "errors": errors, "dpi": dpi}


def _read_max(bgr, task: dict, page) -> dict:
    """Max profile: maxread does the readings + escalation ladder; this adapts its result to the page format."""
    import maxread
    render = (lambda dpi: pp.render_page(page, dpi)) if page is not None else None
    if page is not None:
        bgr = pp.render_page(page, task["dpi"])
    t = dict(task, quality_threshold=task.get("quality_threshold", config.QUALITY_THRESHOLD))
    r = maxread.read_page_max(bgr, t, render)
    names = " ".join(r["readings"])
    has_paddle = "paddle" in names and not any("paddle" in e for e in r["errors"] if e.startswith("paddle:"))
    r["source"] = "ocr_merged" if has_paddle else "ocr_tesseract"
    r["tried"] = sorted({x.split(":")[0] + ("-" + x.split(":")[-1] if x.startswith("tess") else "") for x in r["readings"]}) + \
        [f"ladder-L{e['level']}" for e in r["log"] if e["level"] > 0 and "error" not in e]
    return r


def process_page(task: dict) -> dict:
    t0 = time.time()
    page_no = task["page_no"]
    res: dict = {"page": page_no, "file": task["rel"], "status": "ok", "errors": []}
    if task["kind"] == "image":
        bgr = pp.load_image_file(task["path"])
        page = None
    else:
        page = _doc(task["path"])[task["local_page"]]
        if not task.get("force_ocr"):
            ok, _ = intake.page_has_text_layer(page)
            if ok:
                res.update(_text_layer_page(page, page_no))
                res["seconds"] = round(time.time() - t0, 2)
                return res
        bgr = None

    extra: dict = {}
    if task.get("profile") == "max":
        best = _read_max(bgr, task, page)
        extra = {"profile": "max", "escalation_level": best["level"], "quality": best["quality"], "ladder_log": best["log"],
                 "text_height_px": best["text_height_px"], "readings_level0": len(best["readings"])}
    else:
        best = None
        for dpi in (task["dpi"], config.DPI_SMALL_FONT):
            if best is not None and best["conf"] >= task["conf_threshold"]:
                break
            if page is not None:
                bgr = pp.render_page(page, dpi)
            attempt = _ocr_once(bgr, task, dpi)
            if best is None or attempt["conf"] > best["conf"]:
                best = attempt
            if task["kind"] == "image":  # an image has no higher resolution to re-render at
                break
            del attempt
        extra = {"profile": "fast", "escalation_level": 0}
    lines = best["lines"]
    text_lines = oe.mark_illegible(lines, page_no)
    text = oe.rows_to_text(text_lines)
    source = best["source"]
    tried = best["tried"]
    notes = list(best["errors"])

    if best.get("vision_text"):  # max profile ladder level 3 (only ever set when --vision was given)
        res["ocr_text_before_vision"] = text
        text, source = best["vision_text"], "vision_fallback"
        tried = tried + ["vision"]
    v = task.get("vision")
    if v and task.get("profile") != "max" and best["conf"] < task["conf_threshold"]:
        try:
            vt = oe.vision_transcribe(best["prep"]["original"], v["key"], v["model"])
            if vt.strip():
                res["ocr_text_before_vision"] = text
                text, source = vt, "vision_fallback"
                tried = tried + ["vision"]
                extra["escalation_level"] = 3
        except Exception as e:
            notes.append(f"vision: {type(e).__name__}: {str(e)[:160]}")

    tables = tb.tables_from_image(best["prep"]["binary"], lines) or tb.tables_from_text(text)
    if not text.strip() and not lines:
        source = "blank_or_unreadable"
    res.update({
        "source": source, "confidence": best["conf"], "text": text, "blocks": text_lines, "tables": tables,
        "unit": "px", "dpi": best["dpi"], "rotation": best["prep"]["rotation"], "skew": best["prep"]["skew"],
        "engines_tried": tried, "errors": notes,
        "illegible_lines": sum(1 for l in text_lines if l.get("illegible")),
        **extra,
    })
    res["seconds"] = round(time.time() - t0, 2)
    return res


def worker_main(conn, env: dict) -> None:
    os.environ.update(env)
    while True:
        try:
            task = conn.recv()
        except EOFError:
            return
        if task is None:
            return
        try:
            conn.send(("ok", process_page(task)))
        except Exception as e:
            conn.send(("err", f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=3)}"[:900]))
