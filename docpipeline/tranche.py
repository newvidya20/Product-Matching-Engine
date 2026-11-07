"""Stage 5b: tranche-by-tranche reading. One file at a time, N pages at a time, strictly in order.

After every tranche: all pages must have output (missing ones are re-run, up to 3 passes, before moving on),
the NLP clean layer is written, and tranche_XXX_summary.json + one progress line are produced.
Also: continuity checks that cross tranche / page / file boundaries, and section tracking.
"""
from __future__ import annotations

import json
import re
import time
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Callable

import nlp
import validate
from tables import norm_amount


def raw_path(pages_dir: Path, n: int) -> Path:
    p = pages_dir / f"page_{n:04d}.raw.json"
    return p if p.exists() else pages_dir / f"page_{n:04d}.json"  # legacy name from the fast-profile runs


def clean_path(pages_dir: Path, n: int) -> Path:
    return pages_dir / f"page_{n:04d}.clean.json"


def load_raw(pages_dir: Path, n: int) -> dict | None:
    try:
        return json.loads(raw_path(pages_dir, n).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def page_done(pages_dir: Path, n: int, size_mb: float) -> bool:
    return validate.page_ok(raw_path(pages_dir, n), size_mb)


class Progress:
    def __init__(self, total_pages: int, already: int = 0):
        self.total, self.done, self.t0, self.start_done = total_pages, already, time.time(), already

    def advance(self, n: int) -> None:
        self.done += n

    def eta(self) -> str:
        made = self.done - self.start_done
        if made <= 0:
            return "?"
        sec = (time.time() - self.t0) / made * (self.total - self.done)
        return f"{int(sec // 3600)}h{int(sec % 3600 // 60):02d}m"

    def elapsed(self) -> str:
        s = time.time() - self.t0
        return f"{int(s // 3600)}h{int(s % 3600 // 60):02d}m{int(s % 60):02d}s"


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def clean_pages(pages_dir: Path, numbers: list[int], repeated: set[str] | None = None) -> dict[int, dict]:
    """Write page_XXXX.clean.json for the given pages (raw stays untouched). Returns {page: clean}."""
    out = {}
    for n in numbers:
        raw = load_raw(pages_dir, n)
        if raw is None or raw.get("status") != "ok":
            continue
        c = nlp.clean_page(raw, repeated)
        write_json(clean_path(pages_dir, n), c)
        out[n] = c
    return out


def tranche_summary(k: int, total_t: int, a: int, b: int, pages_dir: Path, cleans: dict[int, dict], elapsed: float, rerun: list[int]) -> dict:
    raws = [load_raw(pages_dir, n) for n in range(a, b + 1)]
    raws = [r for r in raws if r]
    src = Counter(r.get("source") for r in raws)
    ocr = [r for r in raws if r.get("source") not in ("text_layer", None)]
    ents: Counter = Counter()
    top: dict[str, set] = {}
    flags = []
    for c in cleans.values():
        for kind, items in c["entities"].items():
            ents[kind] += len(items)
            top.setdefault(kind, set()).update(str(i.get("value") or i.get("original")) for i in items[:5])
        flags += c["flags"]
    return {"tranche": k, "of": total_t, "page_range": [a, b], "pages": b - a + 1, "pages_with_output": len(raws),
            "sources": dict(src), "avg_confidence": round(sum(r.get("confidence", 0) for r in raws) / len(raws), 1) if raws else None,
            "avg_confidence_ocr_only": round(sum(r["confidence"] for r in ocr) / len(ocr), 1) if ocr else None,
            "low_confidence_pages": [r["page"] for r in ocr if r.get("confidence", 100) < 85],
            "entity_counts": dict(ents), "entity_samples": {k_: sorted(v)[:5] for k_, v in top.items()},
            "validation_flags": len(flags), "flag_samples": sorted(flags, key=lambda f: -f["importance"])[:8],
            "escalation_levels": {str(r["page"]): r.get("escalation_level", 0) for r in ocr},
            "missing_pages_rerun": rerun, "elapsed_s": round(elapsed, 1)}


def process_file_in_tranches(it, out: Path, pool, size: int, plan_fn: Callable[[list[int]], list[dict]], on_result, progress: Progress,
                             say=print) -> dict:
    """Run one file to completion. plan_fn(pages) -> tasks for exactly those pages."""
    pages_dir = out / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    ranges = [(a, min(a + size - 1, it.pages)) for a in range(1, it.pages + 1, size)]
    summaries = []
    for k, (a, b) in enumerate(ranges, 1):
        t0 = time.time()
        todo = [n for n in range(a, b + 1) if not page_done(pages_dir, n, it.size_mb)]
        first_todo = len(todo)
        rerun: list[int] = []
        for attempt in range(1, 4):
            if not todo:
                break
            pool.run(plan_fn(todo), on_result)
            todo = [n for n in range(a, b + 1) if not page_done(pages_dir, n, it.size_mb)]
            if todo and attempt < 3:
                rerun = sorted(set(rerun) | set(todo))
                say(f"  [tranche {k}] pages {todo} have no valid output, re-running (pass {attempt + 1})")
        # a tranche is closed only when every page has output; a page that failed 3x stays 'failed' in its raw file
        numbers = list(range(a, b + 1))
        repeated = nlp.repeated_lines([[b_ for b_ in (load_raw(pages_dir, n) or {}).get("blocks", [])] for n in numbers])
        cleans = clean_pages(pages_dir, numbers, repeated)
        s = tranche_summary(k, len(ranges), a, b, pages_dir, cleans, time.time() - t0, rerun)
        s["still_missing"] = todo
        write_json(out / f"tranche_{k:03d}_summary.json", s)
        summaries.append(s)
        progress.advance(b - a + 1)
        say(f"tranche {k}/{len(ranges)} | pages {a}-{b} | conf {s['avg_confidence']} | flags {s['validation_flags']}"
            f"{' | MISSING ' + str(todo) if todo else ''} | {progress.elapsed()} | ETA {progress.eta()}  [{Path(it.rel).name[:40]}]")
    # whole-document clean pass: header/footer detection is better with every page known
    all_n = list(range(1, it.pages + 1))
    blocks_by_page = [(load_raw(pages_dir, n) or {}).get("blocks", []) for n in all_n]
    clean_pages(pages_dir, all_n, nlp.repeated_lines(blocks_by_page))
    return {"tranches": summaries}


# ---------------------------------------------------------------- continuity across pages / tranches / files

def _num(s: str) -> Decimal | None:
    s = (s or "").strip()
    if not s:
        return None
    s2 = re.sub(r"\s*(Cr|Dr|CR|DR)\.?$", "", s)
    return norm_amount(s2)


def _cols(header: list[str]) -> dict[str, int]:
    cols: dict[str, int] = {}
    for i, h in enumerate(header):
        low = h.lower()
        if "balance" in low and "bal" not in cols:
            cols["bal"] = i
        elif re.search(r"debit|withdrawal|\bdr\b", low) and "dr" not in cols:
            cols["dr"] = i
        elif re.search(r"credit|deposit|\bcr\b", low) and "cr" not in cols:
            cols["cr"] = i
    return cols


def running_balance_check(table: dict) -> dict:
    """prev balance - debit + credit must equal the next balance. Rows carry their page (`row_pages`) so a break
    at a page/tranche boundary is reported as such."""
    rows = table["rows"]
    if len(rows) < 3:
        return {"checked": 0, "breaks": []}
    hdr_i = next((i for i, r in enumerate(rows[:4]) if "bal" in _cols(r)), None)
    if hdr_i is None:
        return {"checked": 0, "breaks": []}
    c = _cols(rows[hdr_i])
    pages = table.get("row_pages") or [table["pages"][0]] * len(rows)
    prev, checked, breaks = None, 0, []
    first = last = None
    for i in range(hdr_i + 1, len(rows)):
        r = rows[i]
        bal = _num(r[c["bal"]]) if c["bal"] < len(r) else None
        if bal is None:
            continue
        dr = _num(r[c["dr"]]) if "dr" in c and c["dr"] < len(r) else None
        cr = _num(r[c["cr"]]) if "cr" in c and c["cr"] < len(r) else None
        if prev is not None and (dr is not None or cr is not None):
            exp = prev - (dr or Decimal(0)) + (cr or Decimal(0))
            checked += 1
            if abs(exp - bal) > Decimal("0.01"):
                breaks.append({"row": i, "page": pages[i], "page_prev": pages[i - 1], "expected": str(exp), "found": str(bal),
                               "at_page_boundary": pages[i] != pages[i - 1]})
        elif prev is None and (dr is not None or cr is not None):
            first = bal + (dr or Decimal(0)) - (cr or Decimal(0))  # implied opening balance
        prev = bal
        last = bal
    return {"checked": checked, "breaks": breaks[:25], "n_breaks": len(breaks), "implied_opening": str(first) if first is not None else None,
            "closing": str(last) if last is not None else None}


def statement_chain(files: list[dict]) -> list[dict]:
    """files: [{file, account, period_start (iso), opening, closing}]. For the same account, ordered by period,
    each opening balance must equal the previous closing balance."""
    out = []
    by_acct: dict[str, list[dict]] = {}
    for f in files:
        if f.get("account") and f.get("opening") is not None and f.get("closing") is not None and f.get("period_start"):
            by_acct.setdefault(f["account"], []).append(f)
    for acct, fs in by_acct.items():
        fs.sort(key=lambda f: f["period_start"])
        for p, n in zip(fs, fs[1:]):
            ok = abs(Decimal(p["closing"]) - Decimal(n["opening"])) <= Decimal("0.01")
            out.append({"account": acct, "from": p["file"], "to": n["file"], "closing": p["closing"], "next_opening": n["opening"], "match": ok})
    return out


HEADING = re.compile(r"^(?:annexure|schedule|note|part|section|chapter|appendix)\b[\s\-:.A-Z0-9a-z]*$|^[A-Z][A-Z &/,\-()']{5,70}$", re.I)


def sections(cleans: dict[int, dict]) -> list[dict]:
    """Heading-delimited sections; a section runs on across pages until the next heading."""
    secs: list[dict] = []
    for n in sorted(cleans):
        lines = [ln.strip() for ln in cleans[n]["text"].split("\n") if ln.strip()]
        for i, s in enumerate(lines):
            if 4 < len(s) <= 70 and HEADING.match(s) and not re.search(r"\d{3,}", s) and (s.isupper() or s.lower().startswith(("annexure", "schedule", "note"))):
                if secs and i > 0:
                    secs[-1]["page_end"] = n  # the previous section still had text on this page above the new heading
                secs.append({"title": s, "page_start": n, "page_end": n})
        if secs:
            secs[-1]["page_end"] = n
    return secs
