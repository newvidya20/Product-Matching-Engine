"""Stage 7: validation, QA reports and spot-check images.

  python validate.py --output <dir> [--spotcheck 3 --seed 7]
"""
from __future__ import annotations

import argparse
import json
import re
import random
import textwrap
from decimal import Decimal
from pathlib import Path

import pymupdf as fitz

from tables import norm_amount


def page_ok(path: Path, size_mb: float) -> bool:
    """A checkpoint counts only if it parses, succeeded, and was made from a file of the same size."""
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d.get("status") == "ok" and abs(d.get("fingerprint", {}).get("size_mb", -1) - size_mb) < 0.005
    except (OSError, json.JSONDecodeError):
        return False


def _truly_blank(pdf: Path, page_no: int) -> bool:
    try:
        with fitz.open(pdf) as d:
            pix = d[page_no - 1].get_pixmap(dpi=40, colorspace=fitz.csGRAY)
            s = pix.samples
            return sum(1 for b in s if b < 200) / max(1, len(s)) < 0.002
    except Exception:
        return False


def check_table_totals(tables: list[dict]) -> dict:
    """For each row labelled 'total', compare numeric cells with the sum of the numeric cells above it
    (since the previous total). Counts only comparisons where the column above holds >=2 numbers."""
    ok = bad = 0
    detail = []
    for t in tables:
        rows = t["rows"]
        start = 1
        for i, r in enumerate(rows):
            if i == 0 or not any("total" in c.lower() for c in r[:2]):
                continue
            for col, cell in enumerate(r):
                stated = norm_amount(cell) if cell else None
                if stated is None:
                    continue
                above = [norm_amount(rows[k][col]) for k in range(start, i) if col < len(rows[k])]
                nums = [v for v in above if v is not None]
                if len(nums) < 2:
                    continue
                if abs(sum(nums, Decimal(0)) - stated) <= Decimal("0.01"):
                    ok += 1
                else:
                    bad += 1
                    detail.append({"table": t["id"], "pages": t["pages"], "row": i, "col": col, "stated": str(stated),
                                   "computed": str(sum(nums, Decimal(0)))})
            start = i + 1
    return {"checked": ok + bad, "matched": ok, "mismatched": bad, "mismatches": detail[:20]}


def validate_file(it, out: Path, res: dict, conf_thr: float) -> tuple[dict, list[str]]:
    pages = res["pages"]
    total = it.pages
    ok_pages = {n: p for n, p in pages.items() if p.get("status") == "ok"}
    missing = [n for n in range(1, total + 1) if n not in ok_pages]
    failed = [n for n, p in pages.items() if p.get("status") == "failed"]
    by_source: dict[str, int] = {}
    for p in ok_pages.values():
        by_source[p["source"]] = by_source.get(p["source"], 0) + 1
    ocr = [p for p in ok_pages.values() if p["source"] not in ("text_layer",)]
    low = [{"page": p["page"], "confidence": p["confidence"], "source": p["source"]} for p in ocr
           if p["confidence"] < conf_thr and p["source"] != "blank_or_unreadable"]
    issues: list[str] = []
    if missing:
        issues.append(f"MISSING pages (not processed): {missing}")
    for n, p in sorted(ok_pages.items()):
        if p["source"] == "blank_or_unreadable":
            if _truly_blank(it.path, n):
                issues.append(f"page {n}: blank (no ink detected)")
            else:
                issues.append(f"page {n}: has content but OCR read nothing -> UNREADABLE")
        elif p["source"] != "text_layer" and p.get("illegible_lines"):
            issues.append(f"page {n}: {p['illegible_lines']} line(s) marked [ILLEGIBLE]")
    totals = check_table_totals(res["stitched"])
    if totals["mismatched"]:
        issues.append(f"{totals['mismatched']} table total(s) do not equal the sum of the rows above (see qa.json)")
    bad_dates = [d["raw"] for d in res["structured"]["dates"] if not d["valid"]]
    if bad_dates:
        issues.append(f"{len(bad_dates)} date-like string(s) are not valid calendar dates: {bad_dates[:8]}")
    if res["structured"]["invalid_ids"]:
        issues.append("GSTIN checksum failed: " + ", ".join(i["value"] for i in res["structured"]["invalid_ids"][:6]))
    levels: dict[str, int] = {}
    for p in ocr:
        k = f"L{p.get('escalation_level', 0)}"
        levels[k] = levels.get(k, 0) + 1
    qa = {"file": it.rel, "kind": it.kind, "total_pages": total, "processed_pages": len(ok_pages),
          "escalation_levels": levels, "levels_by_page": {str(p["page"]): p.get("escalation_level", 0) for p in ocr if p.get("escalation_level", 0)},
          "profile": next((p.get("profile") for p in ocr if p.get("profile")), None),
          "missing": missing, "failed": failed, "by_source": by_source, "low_confidence": low,
          "mean_confidence_ocr": round(sum(p["confidence"] for p in ocr) / len(ocr), 1) if ocr else None,
          "ocr_pages": len(ocr), "tables": len(res["stitched"]), "table_totals": totals, "issues": issues,
          "seconds": round(sum(p.get("seconds", 0) for p in ok_pages.values()), 1),
          "note": it.note}
    return qa, issues


def qa_markdown(qa: dict, issues: list[str]) -> str:
    L = [f"# QA report: {qa['file']}", "",
         f"- Total pages: **{qa['total_pages']}**  |  processed: **{qa['processed_pages']}**  "
         f"({'OK' if qa['total_pages'] == qa['processed_pages'] and qa['total_pages'] else 'INCOMPLETE'})",
         f"- Pages by source: {qa.get('by_source') or '-'}",
         f"- ASSERTION processed_pages == total_pages: **{'PASS' if qa['processed_pages'] == qa['total_pages'] else 'FAIL'}** "
         f"({qa['processed_pages']} == {qa['total_pages']})",
         f"- OCR pages: {qa.get('ocr_pages', 0)}, mean OCR confidence: {qa.get('mean_confidence_ocr')}, profile: {qa.get('profile') or '-'}",
         f"- Final escalation level per OCR page: {qa.get('escalation_levels') or '-'}"
         + (f"  (pages above L0: {qa['levels_by_page']})" if qa.get("levels_by_page") else ""),
         f"- Document type: {qa.get('doc_type', '-')} (confidence {qa.get('doc_type_confidence', '-')}); review items: {qa.get('review_items', '-')}",
         f"- Tables (after multi-page stitching): {qa.get('tables', 0)}"]
    if qa.get("note"):
        L.append(f"- Intake note: {qa['note']}")
    if qa.get("error"):
        L.append(f"- ERROR: {qa['error']}")
    L += ["", "## Low-confidence pages", ""]
    L += [f"- page {p['page']}: {p['confidence']} ({p['source']})" for p in qa.get("low_confidence", [])] or ["- none"]
    L += ["", "## Failed pages", ""]
    L += [f"- page {n}" for n in qa.get("failed", [])] or ["- none"]
    L += ["", "## Missing pages", ""]
    L += [f"- page {n}" for n in qa.get("missing", [])] or ["- none"]
    tt = qa.get("table_totals")
    if tt:
        L += ["", f"## Table sanity: {tt['checked']} totals checked, {tt['matched']} matched, {tt['mismatched']} mismatched"]
    L += ["", "## Validation issues", ""] + ([f"- {i}" for i in issues] or ["- none"])
    return "\n".join(L) + "\n"


def write_summary(out_root: Path, qa_all: list[dict], seconds: float) -> None:
    total = sum(q["total_pages"] for q in qa_all)
    done = sum(q["processed_pages"] for q in qa_all)
    src: dict[str, int] = {}
    for q in qa_all:
        for k, v in (q.get("by_source") or {}).items():
            src[k] = src.get(k, 0) + v
    lv: dict[str, int] = {}
    for q in qa_all:
        for k, v in (q.get("escalation_levels") or {}).items():
            lv[k] = lv.get(k, 0) + v
    ocr_n = sum(q.get("ocr_pages", 0) for q in qa_all)
    ocr_conf = (sum((q.get("mean_confidence_ocr") or 0) * q.get("ocr_pages", 0) for q in qa_all) / ocr_n) if ocr_n else None
    L = ["# Pipeline summary", "", f"- Files: {len(qa_all)}", f"- Pages: {done}/{total} processed", f"- By source: {src}",
         f"- OCR pages: {ocr_n}, page-weighted mean OCR confidence: {round(ocr_conf, 1) if ocr_conf else '-'}",
         f"- Escalation levels (OCR pages, final level): {lv}",
         f"- ASSERTION total_pages == processed_pages across all files: **{'PASS' if done == total else 'FAIL'}** ({done} == {total})",
         f"- Review queue items: {sum(q.get('review_items', 0) for q in qa_all)} (see review_queue.md)",
         f"- Wall time: {seconds:.0f}s", "", "## Files needing attention", ""]
    flag = [q for q in qa_all if q["processed_pages"] != q["total_pages"] or q.get("error") or q.get("low_confidence") or q.get("failed")]
    for q in flag:
        L.append(f"- {q['file']}: {q['processed_pages']}/{q['total_pages']} pages"
                 + (f", low-confidence pages {[p['page'] for p in q['low_confidence']]}" if q.get("low_confidence") else "")
                 + (f", failed {q['failed']}" if q.get("failed") else "") + (f", error: {q['error']}" if q.get("error") else ""))
    if not flag:
        L.append("- none")
    (out_root / "summary.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    (out_root / "qa_summary.json").write_text(json.dumps(qa_all, indent=1, default=str), encoding="utf-8")


# ---------------------------------------------------------------- spot check

def spotcheck(out_root: Path, n: int = 3, seed: int | None = None) -> list[Path]:
    """Side-by-side PNG per sampled page: original page image | extracted text. Prefers OCR'd pages."""
    from PIL import Image, ImageDraw, ImageFont
    inv = {i["rel"]: i for i in json.loads((out_root / "inventory.json").read_text(encoding="utf-8"))}
    cands = []
    for pj in sorted((out_root / "files").glob("*/pages/page_*.json")):
        if pj.name.endswith(".clean.json"):
            continue
        if pj.name.endswith(".json") and not pj.name.endswith(".raw.json") and pj.with_suffix(".raw.json").exists():
            continue
        d = json.loads(pj.read_text(encoding="utf-8"))
        if d.get("status") == "ok" and d["text"].strip():
            cands.append((pj, d))
    rnd = random.Random(seed)
    ocr = [c for c in cands if c[1]["source"] != "text_layer"]
    pick = rnd.sample(ocr, min(2, len(ocr))) + rnd.sample([c for c in cands if c[1]["source"] == "text_layer"], 1)
    pick = pick[:n] if len(pick) >= n else pick + rnd.sample(cands, min(n - len(pick), len(cands)))
    (out_root / "spotcheck").mkdir(exist_ok=True)
    outs = []
    base = out_root / "_extracted"
    for k, (pj, d) in enumerate(pick, 1):
        rel = d["file"]
        src = next((p for p in [Path(base, *Path(rel).parts[1:]), Path(base, rel)] if p.exists()), None)
        if src is None:
            hits = list(base.rglob(Path(rel).name))
            src = hits[0] if hits else None
        img = None
        if src and src.suffix.lower() == ".pdf":
            with fitz.open(src) as doc:
                pix = doc[d["page"] - 1].get_pixmap(dpi=90, alpha=False)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        elif src:
            img = Image.open(src).convert("RGB")
            img.thumbnail((900, 1300))
        if img is None:
            continue
        h = img.height
        font = None
        for fname in ("Nirmala.ttf", "consola.ttf"):  # Nirmala renders Devanagari
            try:
                font = ImageFont.truetype(fname, 12)
                break
            except OSError:
                continue
        font = font or ImageFont.load_default()
        cp = pj.with_name(re.sub(r"\.(raw\.)?json$", ".clean.json", pj.name))
        clean_text = json.loads(cp.read_text(encoding="utf-8")).get("text", "") if cp.exists() else "(no clean layer)"

        def text_panel(txt: str, width: int = 560) -> Image.Image:
            pn = Image.new("RGB", (width, h), "white")
            dr = ImageDraw.Draw(pn)
            y = 4
            for ln in txt.splitlines():
                for seg in (textwrap.wrap(ln, 80, replace_whitespace=False) or [""]):
                    if y > h - 14:
                        break
                    dr.text((6, y), seg, fill="black", font=font)
                    y += 14
            return pn
        raw_p, clean_p = text_panel(d["text"]), text_panel(clean_text)
        canvas = Image.new("RGB", (img.width + raw_p.width + clean_p.width + 20, h + 24), "#dddddd")
        canvas.paste(img, (0, 24)); canvas.paste(raw_p, (img.width + 10, 24)); canvas.paste(clean_p, (img.width + raw_p.width + 20, 24))
        dd = ImageDraw.Draw(canvas)
        dd.text((6, 6), f"{Path(rel).name}  page {d['page']}  source={d['source']}  conf={d['confidence']}  level={d.get('escalation_level', '-')}", fill="black", font=font)
        dd.text((img.width + 14, 6), "RAW OCR", fill="darkred", font=font)
        dd.text((img.width + raw_p.width + 24, 6), "CLEAN (nlp)", fill="darkgreen", font=font)
        p = out_root / "spotcheck" / f"spotcheck_{k}.png"
        canvas.save(p)
        outs.append(p)
    return outs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    ap.add_argument("--spotcheck", type=int, default=3)
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    for p in spotcheck(Path(a.output), a.spotcheck, a.seed):
        print(p)
