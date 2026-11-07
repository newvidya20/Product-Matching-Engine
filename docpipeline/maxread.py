"""Max-accuracy page reader (profile `max`): 400/500 DPI, several preprocessing variants, both engines on every page,
Tesseract psm 6+4+11, full-resolution Paddle server models, region-level merge, then the escalation ladder."""
from __future__ import annotations

import os

import cv2
import numpy as np

import config
import escalate
import merge
import ocr_engines as oe
import preprocess as pp

Line = dict
PSMS = (6, 4, 11)


# ---------------------------------------------------------------- variants

def text_height(binary: np.ndarray) -> float:
    """Median height (px) of letter-sized connected components; small text needs a higher DPI."""
    inv = 255 - binary
    n, _, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    h = stats[1:, cv2.CC_STAT_HEIGHT]
    a = stats[1:, cv2.CC_STAT_AREA]
    sel = h[(h >= 8) & (h <= 120) & (a >= 25)]
    return float(np.median(sel)) if len(sel) >= 50 else 99.0


def _sharpen(gray: np.ndarray) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (0, 0), 2.0)
    return cv2.addWeighted(gray, 1.6, blur, -0.6, 0)


def make_variants(prep: dict, names: tuple[str, ...]) -> dict[str, tuple[np.ndarray, float]]:
    """name -> (image, scale). scale > 1 means the image is enlarged; boxes are divided by it afterwards."""
    gray = cv2.cvtColor(prep["original"], cv2.COLOR_BGR2GRAY)
    clean = prep["clean"]
    out: dict[str, tuple[np.ndarray, float]] = {}
    for n in names:
        if n == "gray":
            out[n] = (gray, 1.0)
        elif n == "adapt":
            out[n] = (prep["binary"], 1.0)
        elif n == "sharp":
            out[n] = (_sharpen(clean), 1.0)
        elif n == "up15":
            out[n] = (cv2.resize(_sharpen(clean), None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC), 1.5)
        elif n == "up20":
            out[n] = (cv2.resize(_sharpen(clean), None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC), 2.0)
        elif n == "otsu":
            out[n] = (cv2.threshold(cv2.GaussianBlur(clean, (3, 3), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1], 1.0)
        elif n == "stretch":
            lo, hi = np.percentile(gray, (2, 98))
            out[n] = (np.clip((gray.astype(np.float32) - lo) * 255.0 / max(1.0, hi - lo), 0, 255).astype(np.uint8), 1.0)
    return out


def _rescale(lines: list[Line], scale: float, dx: int = 0, dy: int = 0, k: float = 1.0) -> list[Line]:
    """Map boxes back to the level-0 pixel space: divide by the variant scale, add the crop offset, multiply by k (dpi ratio)."""
    out = []
    for l in lines:
        b = l["bbox"]
        nb = [int((b[0] / scale + dx) * k), int((b[1] / scale + dy) * k), int((b[2] / scale + dx) * k), int((b[3] / scale + dy) * k)]
        out.append(dict(l, bbox=nb))
    return out


def _tess(img, lang, psm, scale, rid, errors, **kw) -> dict[str, list[Line]]:
    try:
        return {rid: _rescale(oe.tesseract_lines(img, lang, psm), scale, **kw)}
    except Exception as e:
        errors.append(f"{rid}: {type(e).__name__}: {str(e)[:100]}")
        return {}


def _paddle(img, scale, rid, errors, **kw) -> dict[str, list[Line]]:
    try:
        return {rid: _rescale(oe.paddle_lines(img, full_res=True), scale, **kw)}
    except Exception as e:
        errors.append(f"{rid}: {type(e).__name__}: {str(e)[:100]}")
        return {}


# ---------------------------------------------------------------- readings

def level0(prep: dict, lang: str, errors: list, paddle_variants: tuple[str, ...]) -> dict[str, list[Line]]:
    names = ("gray", "adapt", "sharp", "up15")
    vs = make_variants(prep, names)
    pool: dict[str, list[Line]] = {}
    for n, (img, sc) in vs.items():
        for psm in PSMS:
            pool.update(_tess(img, lang, psm, sc, f"tess:{n}:psm{psm}", errors))
    for n in paddle_variants:
        if n in vs:
            pool.update(_paddle(vs[n][0], vs[n][1], f"paddle:{n}", errors))
    return pool


def level1(bgr_hi: np.ndarray, k: float, tess_cmd, lang: str, errors: list) -> dict[str, list[Line]]:
    """Higher DPI + preprocessing variants not used at level 0. `k` maps the new pixel space back to level 0."""
    prep = pp.preprocess(bgr_hi, tess_cmd, "", robust=True)
    vs = make_variants(prep, ("otsu", "stretch", "up20"))
    pool: dict[str, list[Line]] = {}
    for n, (img, sc) in vs.items():
        for psm in PSMS:
            pool.update(_tess(img, lang, psm, sc, f"L1:tess:{n}:psm{psm}", errors, k=k))
    pool.update(_paddle(vs["up20"][0], vs["up20"][1], "L1:paddle:up20", errors, k=k))
    return pool


def level2(prep: dict, lang: str, errors: list) -> dict[str, list[Line]]:
    """Other psm / language sets, then the page cut into overlapping horizontal bands read on their own."""
    vs = make_variants(prep, ("gray", "adapt", "sharp"))
    pool: dict[str, list[Line]] = {}
    for n in ("gray", "adapt"):
        img, sc = vs[n]
        for lg in ("eng", "eng+hin"):
            for psm in (3, 12):
                pool.update(_tess(img, lg, psm, sc, f"L2:tess:{n}:{lg}:psm{psm}", errors))
    img = vs["sharp"][0]
    h = img.shape[0]
    band, step = max(600, h // 5), max(500, h // 5 - h // 40)
    for i, y0 in enumerate(range(0, max(1, h - band // 2), step)):
        crop = img[y0:min(h, y0 + band)]
        pool.update(_tess(crop, lang, 6, 1.0, f"L2:band{i}:tess6", errors, dy=y0))
        pool.update(_paddle(crop, 1.0, f"L2:band{i}:paddle", errors, dy=y0))
    return pool


def read_page_max(bgr: np.ndarray, task: dict, render) -> dict:
    """Full max-profile reading of one page. `render(dpi)` re-rasterizes the same page (None for image inputs)."""
    tess_cmd = config.find_tesseract()
    lang = task["lang"]
    errors: list[str] = []
    dpi = task["dpi"]
    prep = pp.preprocess(bgr, tess_cmd, "", robust=True)
    th = text_height(prep["binary"])
    if render is not None and th < 24 and dpi < config.DPI_MAX_SMALL:
        dpi = config.DPI_MAX_SMALL
        bgr = render(dpi)
        prep = pp.preprocess(bgr, tess_cmd, "", robust=True)
        th = text_height(prep["binary"])
    pv = tuple(os.environ.get("DOCPIPE_PADDLE_VARIANTS", "sharp").split(","))
    pool0 = level0(prep, lang, errors, pv if task.get("paddle", True) else ())
    state = {"prep": prep}

    def step1():
        if render is None:
            return {}
        hi = min(dpi + 100, 600)
        return level1(render(hi), dpi / hi, tess_cmd, lang, errors)

    vision = None
    v = task.get("vision")
    if v:
        def vision():
            return oe.vision_transcribe(prep["original"], v["key"], v["model"])

    res = escalate.run_ladder(pool0, task["page_no"], task["quality_threshold"], {1: step1, 2: lambda: level2(prep, lang, errors)},
                              oe.rows_to_text, vision)
    res.update({"prep": prep, "dpi": dpi, "text_height_px": round(th, 1), "errors": errors,
                "readings": sorted(pool0) })
    return res
