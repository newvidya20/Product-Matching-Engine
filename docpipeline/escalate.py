"""Quality scoring and the self-healing escalation ladder.

Level 0  initial max-profile reading
Level 1  re-OCR at a higher DPI with preprocessing variants not tried yet
Level 2  different psm / language sets, and the page cut into overlapping bands that are read separately
Level 3  vision LLM (only with --vision; only for pages still under the threshold; each call is logged)

After each level the new readings join the pool and the pool is merged region by region (merge.py), so a level can
only improve a region, never replace a good region with a worse one. Text that is still unreadable stays
[ILLEGIBLE p<N>]. Nothing is guessed.
"""
from __future__ import annotations

import re
from typing import Callable

import merge
from structured import ACCT, GSTIN, IFSC, PAN

Line = dict

THRESHOLD = 85.0


def garbage_ratio(text: str) -> float:
    """Share of characters that are neither letters/digits/space/usual punctuation nor Devanagari."""
    s = re.sub(r"\s", "", text)
    if not s:
        return 0.0
    bad = sum(1 for c in s if not (c.isalnum() or c in ".,:;-/()&%@'\"#*+=_<>[]|₹!?" or "ऀ" <= c <= "ॿ"))
    return bad / len(s)


def field_completeness(text: str) -> float:
    """If the page names an identifier (GSTIN, PAN, IFSC, A/c no.) it should also show a well-formed one.
    1.0 when nothing is expected. Counts labels with a well-formed value on the same or next line."""
    expected = found = 0
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        win = ln + " " + (lines[i + 1] if i + 1 < len(lines) else "")
        for label, rx in ((r"\bGSTIN\b", GSTIN), (r"\bPAN\b", PAN), (r"\bIFSC\b", IFSC), (r"\b(?:a/c|account)\s*(?:no|number)", ACCT)):
            if re.search(label, ln, re.I):
                expected += 1
                found += bool(rx.search(win.upper() if rx is not ACCT else win))
    return found / expected if expected else 1.0


def quality(lines: list[Line], text: str, conf: float) -> dict:
    vr = merge.valid_ratio(text)
    gr = garbage_ratio(text)
    fc = field_completeness(text)
    if not text.strip():
        return {"score": 0.0, "confidence": conf, "valid_tokens": 0.0, "garbage": 0.0, "fields": fc}
    # valid-token share is only informative when the lexicon is populated; weight it by how much text is checkable
    score = 0.55 * conf + 0.25 * 100 * min(1.0, vr / 0.6) + 0.10 * 100 * max(0.0, 1 - gr * 6) + 0.10 * 100 * fc
    return {"score": round(score, 1), "confidence": round(conf, 1), "valid_tokens": round(vr, 3), "garbage": round(gr, 4), "fields": round(fc, 2)}


def mean_conf(lines: list[Line]) -> float:
    if not lines:
        return 0.0
    w = [max(1, len(re.sub(r"\s", "", l["text"]))) for l in lines]
    return round(sum(l["conf"] * k for l, k in zip(lines, w)) / sum(w), 1)


def finalize(readings: dict[str, list[Line]]) -> tuple[list[Line], float]:
    from ocr_engines import drop_noise
    lines = drop_noise(merge.dedupe_lines(merge.merge_regions(readings)))
    return lines, mean_conf(lines)


def run_ladder(readings: dict[str, list[Line]], page_no: int, threshold: float, steps: dict[int, Callable[[], dict[str, list[Line]]]],
               to_text: Callable[[list[Line]], str], vision: Callable[[], str] | None = None) -> dict:
    """readings: the level-0 pool. steps: {1: fn, 2: fn} each returning NEW readings (unique ids) to add to the pool.
    Returns {lines, text, conf, quality, level, log, vision_text}."""
    pool = dict(readings)
    lines, conf = finalize(pool)
    q = quality(lines, to_text(lines), conf)
    log = [{"level": 0, "readings": len(pool), **q}]
    level = 0
    for lv in (1, 2):
        if q["score"] >= threshold or lv not in steps:
            break
        try:
            new = steps[lv]()
        except Exception as e:  # a failing level must not lose what we have
            log.append({"level": lv, "error": f"{type(e).__name__}: {str(e)[:160]}"})
            continue
        pool.update(new)
        lines, conf = finalize(pool)
        q = quality(lines, to_text(lines), conf)
        level = lv
        log.append({"level": lv, "readings": len(pool), **q})
    vtext = None
    if q["score"] < threshold and vision is not None:
        try:
            vtext = vision()
            level = 3
            log.append({"level": 3, "vision_chars": len(vtext or "")})
        except Exception as e:
            log.append({"level": 3, "error": f"{type(e).__name__}: {str(e)[:160]}"})
    return {"lines": lines, "text": to_text(lines), "conf": conf, "quality": q, "level": level, "log": log, "vision_text": vtext}
