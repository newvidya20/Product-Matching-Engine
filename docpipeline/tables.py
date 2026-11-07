"""Stage 4: table extraction (text-layer pages: PyMuPDF/pdfplumber; scanned pages: ruled-grid detection on the
image, then whitespace-aligned rows), multi-page stitching, and exact number/date normalisation."""
from __future__ import annotations

import csv
import json
import re
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

import cv2
import numpy as np

# ---------------------------------------------------------------- number / date normalisation (never alters the raw text)

_AMOUNT = re.compile(r"^\(?-?\s*(?:₹|Rs\.?|INR)?\s*\d[\d,]*(?:\.\d+)?\s*(?:Cr|Dr|CR|DR)?\)?$")


def norm_amount(raw: str) -> Decimal | None:
    """'1,23,456.78' -> Decimal('123456.78'); '(5,000.00)' -> -5000.00; None if not an amount. Handles Indian and
    Western grouping; refuses strings whose grouping is inconsistent (so OCR noise is not 'repaired' into a number)."""
    s = raw.strip()
    if not s or not _AMOUNT.match(s):
        return None
    neg = s.startswith("(") and s.endswith(")") or s.lstrip("(").lstrip().startswith("-")
    body = re.sub(r"[^\d.,]", "", s)
    if not body:
        return None
    ip, _, fp = body.partition(".")
    if "," in ip:
        g = ip.split(",")
        ok_in = 1 <= len(g[0]) <= 2 and all(len(x) == 2 for x in g[1:-1]) and len(g[-1]) == 3
        ok_we = 1 <= len(g[0]) <= 3 and all(len(x) == 3 for x in g[1:])
        if not (ok_in or ok_we):
            return None
    try:
        v = Decimal(ip.replace(",", "") + ("." + fp if fp else ""))
    except InvalidOperation:
        return None
    return -v if neg else v


_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def norm_date(raw: str) -> str | None:
    """DD/MM/YYYY (also - and .) or '12 Mar 2025' -> ISO 'YYYY-MM-DD', None when not a real calendar date."""
    s = raw.strip()
    m = re.fullmatch(r"(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})", s)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
        if y < 100:
            y += 2000 if y < 70 else 1900
    else:
        m = re.fullmatch(r"(\d{1,2})[\s\-]([A-Za-z]{3})[a-z]*[\s\-,]+(\d{4})", s)
        if not m or m[2].lower() not in _MONTHS:
            return None
        d, mo, y = int(m[1]), _MONTHS[m[2].lower()], int(m[3])
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


# ---------------------------------------------------------------- text-layer pages

def clean_cell(c) -> str:
    return re.sub(r"[ \t]+", " ", (c or "").replace("\n", " ")).strip()


def tables_from_pdf_page(page) -> list[dict]:
    """Ruled tables first (reliable); if none, a text-alignment pass on pages that are clearly tabular."""
    found: list[dict] = []
    try:
        for strategy in ("lines", "text"):
            tabs = page.find_tables(strategy=strategy)
            for t in tabs.tables:
                rows = [[clean_cell(c) for c in r] for r in t.extract()]
                rows = [r for r in rows if any(r)]
                width = max((len(r) for r in rows), default=0)
                if len(rows) >= 2 and width >= 2:
                    # text strategy is noisy on prose: demand most rows to have >=2 non-empty cells and a numeric cell
                    if strategy == "text":
                        good = sum(1 for r in rows if sum(bool(c) for c in r) >= 2)
                        numeric = sum(1 for r in rows for c in r if norm_amount(c) is not None)
                        if good < 0.7 * len(rows) or numeric < 3 or width > 14:
                            continue
                    found.append({"rows": rows, "bbox": [round(v, 1) for v in t.bbox], "method": f"pymupdf-{strategy}"})
            if found:
                break
    except Exception:
        pass
    return found


# ---------------------------------------------------------------- scanned pages

def _cluster(vals: list[int], gap: int) -> list[int]:
    vals = sorted(vals)
    out, cur = [], [vals[0]] if vals else []
    for v in vals[1:]:
        if v - cur[-1] <= gap:
            cur.append(v)
        else:
            out.append(int(np.mean(cur)))
            cur = [v]
    if cur:
        out.append(int(np.mean(cur)))
    return out


def tables_from_image(binary: np.ndarray, lines: list[dict]) -> list[dict]:
    """Find a ruled grid (long horizontal and vertical lines) and drop each OCR line into its cell."""
    inv = 255 - binary
    h, w = inv.shape
    horiz = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(40, w // 25), 1)))
    vert = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(40, h // 40))))
    ys = _cluster([int(y) for y in np.where(horiz.sum(axis=1) > 255 * w * 0.25)[0]], 8)
    xs = _cluster([int(x) for x in np.where(vert.sum(axis=0) > 255 * h * 0.04)[0]], 8)
    if len(ys) < 3 or len(xs) < 3:
        return []
    cells = [["" for _ in range(len(xs) - 1)] for _ in range(len(ys) - 1)]
    spanning = 0
    for l in sorted(lines, key=lambda l: (l["bbox"][1], l["bbox"][0])):
        cx, cy = (l["bbox"][0] + l["bbox"][2]) / 2, (l["bbox"][1] + l["bbox"][3]) / 2
        r = next((i for i in range(len(ys) - 1) if ys[i] <= cy < ys[i + 1]), None)
        c = next((i for i in range(len(xs) - 1) if xs[i] <= cx < xs[i + 1]), None)
        if r is None or c is None:
            continue
        if l["bbox"][0] < xs[c] - 15 or l["bbox"][2] > xs[c + 1] + 15:
            spanning += 1  # OCR line crosses a rule: the cell assignment is approximate
        cells[r][c] = (cells[r][c] + " " + l["text"]).strip()
    rows = [r for r in cells if any(r)]
    if len(rows) < 2:
        return []
    return [{"rows": rows, "bbox": [xs[0], ys[0], xs[-1], ys[-1]], "method": "image-grid",
             "warning": "cells assigned by line centre" if spanning else ""}]


def tables_from_text(text: str) -> list[dict]:
    """Unruled tables in OCR text: runs of >=3 rows that split on 2+ spaces into the same number (>=3) of columns."""
    out, run = [], []
    def flush():
        if len(run) >= 3:
            out.append({"rows": [r for r in run], "bbox": None, "method": "text-alignment"})
    for ln in text.splitlines():
        cells = [c.strip() for c in re.split(r"\s{2,}", ln.strip()) if c.strip()]
        if len(cells) >= 3 and (not run or abs(len(cells) - len(run[0])) <= 1):
            run.append(cells)
        else:
            flush(); run = [cells] if len(cells) >= 3 else []
    flush()
    # keep only runs that carry numbers (a column of words is a layout, not a table of data)
    return [t for t in out if sum(norm_amount(c) is not None for r in t["rows"] for c in r) >= 3]


# ---------------------------------------------------------------- stitching + writing

def _norm_row(r: list[str]) -> list[str]:
    return [re.sub(r"\W+", "", c.lower()) for c in r]


def stitch(pages: dict[int, list[dict]]) -> list[dict]:
    """Merge a table that continues across pages (last table of page n + first of n+1 with the same column count,
    repeated header row dropped). Returns [{id, pages, rows, methods}] in document order."""
    merged: list[dict] = []
    open_tbl: dict | None = None
    last_page = None
    for pno in sorted(pages):
        tbls = pages[pno]
        for k, t in enumerate(tbls):
            width = max(len(r) for r in t["rows"])
            rows = [r + [""] * (width - len(r)) for r in t["rows"]]
            cont = (open_tbl is not None and k == 0 and last_page == pno - 1 and open_tbl["width"] == width and width >= 3)
            if cont:
                if _norm_row(rows[0]) == _norm_row(open_tbl["rows"][0]):
                    rows = rows[1:]
                open_tbl["rows"] += rows
                open_tbl["row_pages"] += [pno] * len(rows)
                open_tbl["pages"].append(pno)
                open_tbl["methods"].add(t["method"])
            else:
                open_tbl = {"width": width, "rows": rows, "row_pages": [pno] * len(rows), "pages": [pno], "methods": {t["method"]},
                            "warning": t.get("warning", "")}
                merged.append(open_tbl)
            last_page = pno
        if not tbls:
            open_tbl = None
    for i, t in enumerate(merged, 1):
        t["id"] = f"table_{i:03d}"
        t["methods"] = sorted(t["methods"])
    return merged


def write_tables(tables: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for t in tables:
        with open(out_dir / f"{t['id']}.csv", "w", newline="", encoding="utf-8-sig") as f:
            csv.writer(f).writerows(t["rows"])
        (out_dir / f"{t['id']}.json").write_text(json.dumps(
            {"id": t["id"], "pages": t["pages"], "methods": t["methods"], "n_rows": len(t["rows"]), "n_cols": t["width"],
             "warning": t.get("warning", ""), "row_pages": t.get("row_pages"), "rows": t["rows"]}, ensure_ascii=False, indent=1), encoding="utf-8")
