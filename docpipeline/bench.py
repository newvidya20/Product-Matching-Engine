"""Stage 7 benchmark: fast vs max profile on real pages, scored against ground truth.

Ground truth is either the page's own native text layer (the page is OCR'd anyway with force_ocr) or a short list
of tokens checked by hand against the page image (`manual`).

  python bench.py --extracted <dir with the unpacked files> --cases bench_cases.json --out bench_results.json
"""
from __future__ import annotations

import argparse
import glob
import json
import re
import time
from collections import Counter
from pathlib import Path

import pymupdf as fitz

import config
import merge
import worker


def toks(text: str) -> list[str]:
    return [t.strip(".,;:()|[]'\"") for t in text.split() if t.strip(".,;:()|[]'\"")]


def native_truth(pdf: str, page: int) -> str:
    with fitz.open(pdf) as d:
        return d[page - 1].get_text("text", sort=True)


def score(ocr_text: str, truth: str | None, manual: list[str] | None) -> dict:
    out: dict = {}
    ocr_t = Counter(toks(ocr_text))
    if truth is not None:
        tt = Counter(toks(truth))
        num_t = Counter({k: v for k, v in tt.items() if any(c.isdigit() for c in k)})
        num_o = Counter({k: v for k, v in ocr_t.items() if any(c.isdigit() for c in k)})
        inter = sum((num_t & num_o).values())
        out["digit_token_recall"] = round(inter / max(1, sum(num_t.values())), 3)
        out["digit_token_precision"] = round(inter / max(1, sum(num_o.values())), 3)
        words_t = Counter({k: v for k, v in tt.items() if not any(c.isdigit() for c in k)})
        words_o = Counter({k: v for k, v in ocr_t.items() if not any(c.isdigit() for c in k)})
        out["word_recall"] = round(sum((words_t & words_o).values()) / max(1, sum(words_t.values())), 3)
        out["truth_digit_tokens"] = sum(num_t.values())
    if manual is not None:
        norm = re.sub(r"\s+", " ", ocr_text)
        hit = [m for m in manual if re.sub(r"\s+", " ", m) in norm]
        out["manual_fields_found"] = f"{len(hit)}/{len(manual)}"
        out["manual_fields_accuracy"] = round(len(hit) / max(1, len(manual)), 3)
        out["manual_missed"] = [m for m in manual if m not in hit]
    return out


def run_case(case: dict, extracted: Path, profile: str, vision=None) -> dict:
    pdf = glob.glob(str(extracted / "**" / case["file"]), recursive=True)[0]
    task = {"rel": case["file"], "page_no": case["page"], "path": pdf, "local_page": case["page"] - 1, "kind": "pdf", "lang": "eng+hin+mar",
            "dpi": config.DPI_DEFAULT if profile == "fast" else config.DPI_MAX, "conf_threshold": config.CONF_THRESHOLD,
            "quality_threshold": config.QUALITY_THRESHOLD, "paddle": True, "vision": vision, "force_ocr": True, "profile": profile}
    t = time.time()
    r = worker.process_page(task)
    dt = time.time() - t
    truth = native_truth(pdf, case["page"]) if case.get("truth") == "native" else None
    m = score(r["text"], truth, case.get("manual"))
    return {"case": case["name"], "profile": profile, "seconds": round(dt, 1), "confidence": r["confidence"],
            "valid_token_pct": round(100 * merge.valid_ratio(r["text"]), 1), "level": r.get("escalation_level", 0),
            "source": r["source"], "dpi": r.get("dpi"), **m, "text": r["text"]}


def table_md(rows: list[dict]) -> str:
    cols = ["case", "profile", "confidence", "valid_token_pct", "digit_token_recall", "digit_token_precision", "manual_fields_accuracy", "seconds", "level"]
    L = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        L.append("| " + " | ".join(str(r.get(c, "-")) for c in cols) + " |")
    return "\n".join(L)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--extracted", default=".")
    ap.add_argument("--cases", default=str(Path(__file__).with_name("bench_cases.json")))
    ap.add_argument("--out", required=True)
    ap.add_argument("--profiles", default="fast,max")
    ap.add_argument("--only", default="")
    ap.add_argument("--combine", nargs="*", help="merge result json files into --out (.md table) without running anything")
    a = ap.parse_args()
    if a.combine:
        allr = [r for f in a.combine for r in json.loads(Path(f).read_text(encoding="utf-8"))]
        allr.sort(key=lambda r: (r["case"], r["profile"]))
        Path(a.out).write_text(json.dumps(allr, ensure_ascii=False, indent=1), encoding="utf-8")
        Path(a.out).with_suffix(".md").write_text(table_md(allr) + "\n", encoding="utf-8")
        print(table_md(allr))
        raise SystemExit(0)
    import os
    os.environ.setdefault("DOCPIPE_PADDLE_MODEL", "mobile" if a.profiles == "fast" else "medium")
    cases = json.loads(Path(a.cases).read_text(encoding="utf-8"))
    results = []
    for c in cases:
        if a.only and a.only not in c["name"]:
            continue
        for prof in a.profiles.split(","):
            print(f"[bench] {c['name']} / {prof}", flush=True)
            results.append(run_case(c, Path(a.extracted), prof))
            print(f"        conf={results[-1]['confidence']} {results[-1]['seconds']}s", flush=True)
            Path(a.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    md = table_md(results)
    Path(a.out).with_suffix(".md").write_text(md + "\n", encoding="utf-8")
    print(md)
