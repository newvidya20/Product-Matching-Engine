"""Stage 3: layered OCR. PaddleOCR (primary) + Tesseract 5 (secondary) merged per line by confidence,
then an optional vision-LLM transcription for pages that are still under the confidence threshold.

Every line is {text, bbox:[x0,y0,x1,y1] (px of the OCR image), conf:0-100, engine}.
Nothing is guessed: text the engines cannot read stays low-confidence and is later marked [ILLEGIBLE].
"""
from __future__ import annotations

import base64
import os
import re

import cv2
import numpy as np

import config

Line = dict

_paddle = None
_paddle_failed = ""


# ---------------------------------------------------------------- Tesseract

def tesseract_lines(img: np.ndarray, lang: str, psm: int = 6) -> list[Line]:
    import pytesseract
    cmd = config.find_tesseract()
    if not cmd:
        raise RuntimeError("tesseract not installed")
    pytesseract.pytesseract.tesseract_cmd = cmd
    cfg = f'--oem 1 --psm {psm} -c preserve_interword_spaces=1'
    d = pytesseract.image_to_data(img, lang=lang, config=cfg, output_type=pytesseract.Output.DICT, timeout=180)
    rows: dict[tuple, list[int]] = {}
    for i, t in enumerate(d["text"]):
        if t.strip() and float(d["conf"][i]) >= 0:
            rows.setdefault((d["block_num"][i], d["par_num"][i], d["line_num"][i]), []).append(i)
    out: list[Line] = []
    for idxs in rows.values():
        idxs.sort(key=lambda i: d["left"][i])
        # words further apart than ~1.6 line-heights are a column gap: keep that as a double space
        h = max(d["height"][i] for i in idxs) or 1
        parts, prev_r = [], None
        for i in idxs:
            gap = d["left"][i] - prev_r if prev_r is not None else 0
            parts.append(("  " if gap > 1.6 * h else " ") + d["text"][i] if parts else d["text"][i])
            prev_r = d["left"][i] + d["width"][i]
        confs = [float(d["conf"][i]) for i in idxs]
        w = [len(d["text"][i]) for i in idxs]
        x0 = min(d["left"][i] for i in idxs); y0 = min(d["top"][i] for i in idxs)
        x1 = max(d["left"][i] + d["width"][i] for i in idxs); y1 = max(d["top"][i] + d["height"][i] for i in idxs)
        out.append({"text": "".join(parts), "bbox": [x0, y0, x1, y1],
                    "conf": round(sum(c * k for c, k in zip(confs, w)) / max(1, sum(w)), 1), "engine": "tesseract"})
    return out


def tesseract_best(img: np.ndarray, lang: str, target: float) -> tuple[list[Line], list[str]]:
    """psm 6 first; retry psm 4 and 11 while the page is under `target`. Returns (lines, psm modes tried)."""
    best, tried = [], []
    for psm in (6, 4, 11):
        try:
            lines = tesseract_lines(img, lang, psm)
        except Exception:
            if psm == 6:
                raise
            continue
        tried.append(f"tesseract-psm{psm}")
        if page_conf(lines) > page_conf(best) or not best:
            best = lines
        if page_conf(best) >= target:
            break
    return best, tried


# ---------------------------------------------------------------- PaddleOCR

def _get_paddle():
    global _paddle, _paddle_failed
    if _paddle is not None or _paddle_failed:
        return _paddle
    try:
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        os.environ.setdefault("FLAGS_use_mkldnn", "0")
        from paddleocr import PaddleOCR
        kw = dict(text_det_limit_type="max", text_det_limit_side_len=1920, cpu_threads=2)
        which = os.environ.get("DOCPIPE_PADDLE_MODEL", "mobile")
        if which == "mobile":
            # ~2.5x faster than the medium models on CPU, a few points less confident
            kw.update(text_detection_model_name="PP-OCRv5_mobile_det", text_recognition_model_name="PP-OCRv5_mobile_rec")
        elif which == "server":
            # max profile: PP-OCRv4 server detector + recogniser, downloaded once into ~/.paddlex and reused
            kw.update(text_detection_model_name="PP-OCRv4_server_det", text_recognition_model_name="PP-OCRv4_server_rec_doc")
        _paddle = PaddleOCR(lang="en", use_doc_orientation_classify=False, use_doc_unwarping=False,
                            use_textline_orientation=False, enable_mkldnn=False, **kw)
    except Exception as e:  # keep going with Tesseract only, and say why
        _paddle_failed = f"{type(e).__name__}: {e}"[:300]
    return _paddle


def paddle_status() -> str:
    return "ok" if _paddle is not None else (_paddle_failed or "not loaded")


def paddle_lines(img: np.ndarray, full_res: bool = False) -> list[Line]:
    """full_res: detection runs at the image's own resolution (no size cap) instead of the 1920 px cap."""
    ocr = _get_paddle()
    if ocr is None:
        raise RuntimeError(f"paddle unavailable: {_paddle_failed}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    out: list[Line] = []
    # DOCPIPE_DET_LIMIT: max side in px for detection (default 2560; 0 = truly full resolution). Full resolution is
    # ~2x slower for +0.2 points here, and the server models crash natively above ~2400 px on this machine.
    cap = int(os.environ.get("DOCPIPE_DET_LIMIT", "2560"))
    side = int(max(img.shape[:2]))
    extra = {"text_det_limit_type": "max", "text_det_limit_side_len": side if cap == 0 else min(side, cap)} if full_res else {}
    for res in ocr.predict(img, **extra):
        texts, scores = res["rec_texts"], res["rec_scores"]
        boxes = res.get("rec_boxes")
        polys = res.get("rec_polys")
        for i, (t, s) in enumerate(zip(texts, scores)):
            if not str(t).strip():
                continue
            if boxes is not None and len(boxes) > i:
                x0, y0, x1, y1 = [int(v) for v in boxes[i]]
            else:
                p = np.array(polys[i]); x0, y0 = p.min(0); x1, y1 = p.max(0)
            out.append({"text": str(t), "bbox": [int(x0), int(y0), int(x1), int(y1)],
                        "conf": round(float(s) * 100, 1), "engine": "paddle"})
    return out


# ---------------------------------------------------------------- merge + helpers

def page_conf(lines: list[Line]) -> float:
    if not lines:
        return 0.0
    w = [max(1, len(re.sub(r"\s", "", l["text"]))) for l in lines]
    return round(sum(l["conf"] * k for l, k in zip(lines, w)) / sum(w), 1)


def _overlap(a: list[int], b: list[int]) -> float:
    """Intersection over the smaller box area."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    sm = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) or 1
    return inter / sm


def merge_lines(primary: list[Line], secondary: list[Line]) -> list[Line]:
    """Region-level merge (merge.py): one winner per region, never concatenated, then duplicate-word cleanup."""
    import merge
    return merge.dedupe_lines(merge.merge_regions({"primary": primary, "secondary": secondary}))


def _legacy_merge_lines(primary: list[Line], secondary: list[Line]) -> list[Line]:
    """The pre-fix merge, kept only for reference/benchmarks: it could keep both engines' lines for one region."""
    used: set[int] = set()
    out: list[Line] = []
    for p in primary:
        group = [(j, s) for j, s in enumerate(secondary) if j not in used and _overlap(p["bbox"], s["bbox"]) > 0.5]
        if not group:
            out.append(p)
            continue
        for j, _ in group:
            used.add(j)
        # one engine line may span several lines of the other; compare on the combined span
        sec_text_conf = sum(s["conf"] * len(s["text"]) for _, s in group) / max(1, sum(len(s["text"]) for _, s in group))
        if sec_text_conf > p["conf"] + 2 and len(group) == 1:
            out.append(group[0][1])
        elif sec_text_conf > p["conf"] + 2:
            out.extend(s for _, s in group)
        else:
            out.append(p)
    out.extend(s for j, s in enumerate(secondary) if j not in used)
    return out


def drop_noise(lines: list[Line]) -> list[Line]:
    """Remove specks the engines read from stamps, rules and scanner dust: very short, non-confident,
    or made only of punctuation / stray non-Latin marks. Real short tokens (amounts, 'Rs', 'No') have
    high confidence or digits, so they stay."""
    keep = []
    for l in lines:
        t = l["text"].strip()
        alnum = [c for c in t if c.isalnum()]
        if not alnum:
            continue
        has_digit = any(c.isdigit() for c in t)
        ascii_alpha = sum(c.isascii() and c.isalpha() for c in t)
        if len(alnum) <= 2 and l["conf"] < 80 and not has_digit:
            continue
        if len(alnum) <= 3 and l["conf"] < 55 and not has_digit and ascii_alpha == 0:
            continue
        keep.append(l)
    return keep


def rows_to_text(lines: list[Line]) -> str:
    """Reading order: group by vertical centre into rows, left to right inside a row, wide gaps kept."""
    if not lines:
        return ""
    ls = sorted(lines, key=lambda l: (l["bbox"][1] + l["bbox"][3]) / 2)
    rows: list[list[Line]] = []
    for l in ls:
        cy = (l["bbox"][1] + l["bbox"][3]) / 2
        h = max(1, l["bbox"][3] - l["bbox"][1])
        if rows:
            last = rows[-1]
            lcy = sum((x["bbox"][1] + x["bbox"][3]) / 2 for x in last) / len(last)
            if abs(cy - lcy) < 0.5 * h:
                last.append(l)
                continue
        rows.append([l])
    out = []
    for r in rows:
        r.sort(key=lambda l: l["bbox"][0])
        s = r[0]["text"]
        for a, b in zip(r, r[1:]):
            gap = b["bbox"][0] - a["bbox"][2]
            s += ("  " if gap > 1.2 * max(1, a["bbox"][3] - a["bbox"][1]) else " ") + b["text"]
        out.append(s.rstrip())
    return "\n".join(out)


ILLEGIBLE_BELOW = 30.0


def mark_illegible(lines: list[Line], page: int) -> list[Line]:
    """Lines under ILLEGIBLE_BELOW keep their raw text in `raw_text`; the visible text becomes [ILLEGIBLE p.N]."""
    res = []
    for l in lines:
        if l["conf"] < ILLEGIBLE_BELOW:
            l = dict(l, raw_text=l["text"], text=f"[ILLEGIBLE p.{page}]", illegible=True)
        res.append(l)
    return res


# ---------------------------------------------------------------- vision fallback (opt-in)

def vision_transcribe(img_bgr: np.ndarray, api_key: str, model: str, base_url: str = "https://openrouter.ai/api/v1") -> str:
    """Ask a vision model to transcribe the page. The caller marks the page `vision_fallback`.
    Sends the page image to an external service, so it only runs when --vision is given."""
    import requests
    h, w = img_bgr.shape[:2]
    if max(h, w) > 2200:
        s = 2200 / max(h, w)
        img_bgr = cv2.resize(img_bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64 = base64.b64encode(buf.tobytes()).decode()
    prompt = ("Transcribe ALL text on this page exactly as printed, top to bottom, keeping tables as rows with columns "
              "separated by ' | '. Copy numbers digit for digit. If a part is unreadable write [ILLEGIBLE]. "
              "Do not summarise, translate, correct or add anything. Output only the transcription.")
    r = requests.post(f"{base_url}/chat/completions", timeout=180,
                      headers={"Authorization": f"Bearer {api_key}"},
                      json={"model": model, "temperature": 0, "messages": [{"role": "user", "content": [
                          {"type": "text", "text": prompt},
                          {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}]})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()
