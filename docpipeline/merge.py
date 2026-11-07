"""Engine/variant merge at region level, plus duplicate-word cleanup.

Rules (these are what fix the "Total of Fund Based Limits  Based Limits" bug):
  * Candidate readings (engine x preprocessing variant x psm) are clustered by bounding-box overlap.
  * Each cluster has exactly ONE winning reading; its lines are kept whole. Text from two readings is
    never concatenated or spliced, and the losers' lines in that region are discarded (kept as `alt`).
  * dedupe_* only ever deletes whole non-numeric tokens that repeat. Any token containing a digit is
    never touched, so digits come out exactly as they went in.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

Line = dict

_LEX_FILE = Path(__file__).with_name("lexicon.txt")
_NUM = re.compile(r"^[\(\-₹]?(?:Rs\.?|INR)?\d[\d,]*(?:\.\d+)?%?\)?$", re.I)
_WORD = re.compile(r"[A-Za-z]{2,}")


@lru_cache(maxsize=1)
def lexicon() -> frozenset[str]:
    try:
        return frozenset(w.strip().lower() for w in _LEX_FILE.read_text(encoding="utf-8").splitlines() if w.strip())
    except OSError:
        return frozenset()


def tokens(text: str) -> list[str]:
    return text.split()


def valid_token_stats(text: str) -> tuple[int, int]:
    """(valid, total) where valid = a well-formed number/ID, or a word found in the lexicon (domain terms + words
    harvested from text-layer pages). Devanagari words count as valid when made only of Devanagari letters/marks."""
    lex = lexicon()
    valid = total = 0
    for t in tokens(text):
        total += 1
        core = t.strip(".,:;()[]{}\"'|/-")
        if _NUM.match(t.strip(",;:")) or re.fullmatch(r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}", core):
            valid += 1
        elif core.lower() in lex:
            valid += 1
        elif re.fullmatch(r"[ऀ-ॿ]{2,}", core):
            valid += 1
        elif re.fullmatch(r"[A-Z]{5}\d{4}[A-Z]|\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]|[A-Z]{4}0[A-Z0-9]{6}", core):
            valid += 1
    return valid, total


def valid_ratio(text: str) -> float:
    v, t = valid_token_stats(text)
    return v / t if t else 0.0


# ---------------------------------------------------------------- geometry

def _inter_over_min(a: list, b: list) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) or 1
    return ix * iy / small


def iou(a: list, b: list) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _same_region(a: Line, b: Line, thr: float = 0.35) -> bool:
    """Boxes of two different readings describe the same ink when they overlap meaningfully and are on the
    same text line (vertical overlap), whichever one is the wider box."""
    ba, bb = a["bbox"], b["bbox"]
    ov_y = max(0, min(ba[3], bb[3]) - max(ba[1], bb[1])) / (min(ba[3] - ba[1], bb[3] - bb[1]) or 1)
    return ov_y > 0.5 and (iou(ba, bb) > 0.2 or _inter_over_min(ba, bb) > thr)


# ---------------------------------------------------------------- region merge

def suppress_contained(lines: list[Line]) -> list[Line]:
    """Inside ONE reading, drop a line that lies inside another line of the same reading and whose text is already
    contained in that line's text (an engine echoing a fragment). Lines with digits are never dropped."""
    keep = []
    for i, a in enumerate(lines):
        ta = " ".join(a["text"].lower().split())
        dup = False
        if not any(c.isdigit() for c in ta):
            for j, b in enumerate(lines):
                if i != j and _inter_over_min(a["bbox"], b["bbox"]) > 0.3 and len(b["text"]) > len(a["text"]) \
                        and ta in " ".join(b["text"].lower().split()):
                    dup = True
                    break
        if not dup:
            keep.append(a)
    return keep


def _chars(lines: list[Line]) -> int:
    return sum(len(re.sub(r"\s", "", l["text"])) for l in lines)


def reading_score(lines: list[Line], max_chars: int = 0) -> tuple[float, int]:
    """(confidence + 8 x valid-token ratio - coverage penalty, valid token count): primary key and tie-breaker.
    The coverage penalty (up to 40) stops a reading that dropped part of a row winning on the confidence of the
    words it did keep."""
    if not lines:
        return (0.0, 0)
    w = [max(1, len(re.sub(r"\s", "", l["text"]))) for l in lines]
    conf = sum(l["conf"] * k for l, k in zip(lines, w)) / sum(w)
    text = " ".join(l["text"] for l in lines)
    v, t = valid_token_stats(text)
    penalty = 40 * (1 - min(1.0, sum(w) / max_chars)) if max_chars else 0
    return (round(conf + 8 * (v / t if t else 0) - penalty, 3), v)


def merge_regions(readings: dict[str, list[Line]]) -> list[Line]:
    """readings: {reading_id: lines}. Returns one line set in which every region comes from a single reading."""
    items = [(rid, l) for rid, ls in readings.items() for l in suppress_contained(ls)]
    n = len(items)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    # union lines of DIFFERENT readings that cover the same ink
    order = sorted(range(n), key=lambda i: items[i][1]["bbox"][1])
    for x, i in enumerate(order):
        for j in order[x + 1:]:
            if items[j][1]["bbox"][1] > items[i][1]["bbox"][3]:
                break
            if items[i][0] != items[j][0] and _same_region(items[i][1], items[j][1]):
                parent[find(i)] = find(j)
    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)

    out: list[Line] = []
    for members in clusters.values():
        by_reading: dict[str, list[Line]] = {}
        for i in members:
            by_reading.setdefault(items[i][0], []).append(items[i][1])
        if len(by_reading) == 1:
            out.extend(next(iter(by_reading.values())))
            continue
        mx = max(_chars(ls) for ls in by_reading.values())
        best = max(by_reading, key=lambda r: reading_score(by_reading[r], mx))
        alt = {r: " ".join(l["text"] for l in ls) for r, ls in by_reading.items() if r != best}
        for l in by_reading[best]:
            out.append(dict(l, alt=alt, reading=best))
    return out


# ---------------------------------------------------------------- duplicate cleanup (never touches digits)

def _has_digit(tok: str) -> bool:
    return any(c.isdigit() for c in tok)


def _collapse_adjacent(toks: list[str]) -> list[str]:
    """Collapse an n-gram (n=4..1) repeated back to back, if none of its tokens contains a digit."""
    changed = True
    while changed:
        changed = False
        for n in (4, 3, 2, 1):
            i = 0
            while i + 2 * n <= len(toks):
                a, b = toks[i:i + n], toks[i + n:i + 2 * n]
                if [t.lower() for t in a] == [t.lower() for t in b] and not any(_has_digit(t) for t in a) \
                        and any(re.search(r"[A-Za-zऀ-ॿ]{3,}", t) for t in a):
                    del toks[i + n:i + 2 * n]
                    changed = True
                else:
                    i += 1
    return toks


def dedupe_line(text: str) -> str:
    """Remove words an engine echoed:
      'Fund Based Limits Based Limits'  -> adjacent repeated n-gram handled by suffix rule below
      'Total of Fund Based Limits  Based Limits' -> second column segment is the tail of the first, drop it.
    Column gaps (2+ spaces) are preserved otherwise. Numeric repeats ('5.40  5.40', '0.00 0.00') are legit."""
    segs = re.split(r"(\s{2,})", text)
    texts, gaps = segs[0::2], segs[1::2]
    kept: list[str] = []
    kept_gaps: list[str] = []
    for k, seg in enumerate(texts):
        toks = _collapse_adjacent(seg.split())
        if kept:
            prev = kept[-1].split()
            lo = [t.lower() for t in toks]
            if toks and not any(_has_digit(t) for t in toks) and len(toks) >= 2 and len(prev) >= len(toks) \
                    and [t.lower() for t in prev[-len(toks):]] == lo:
                continue  # tail of the previous segment repeated after a gap
        if kept:
            kept_gaps.append(gaps[k - 1])
        kept.append(" ".join(toks))
    out = kept[0] if kept else ""
    for g, s in zip(kept_gaps, kept[1:]):
        out += g + s
    return out


def dedupe_lines(lines: list[Line]) -> list[Line]:
    res = []
    for l in lines:
        t = dedupe_line(l["text"])
        res.append(l if t == l["text"] else dict(l, text=t, text_before_dedupe=l["text"]))
    return res


def digits_of(text: str) -> str:
    return "".join(c for c in text if c.isdigit())
