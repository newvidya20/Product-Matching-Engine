"""Document extraction pipeline CLI.

  python pipeline.py --input <file|folder|zip> --output <dir> --lang eng+hin+mar --resume
  python pipeline.py ... --profile max --tranche-size 10 --mode sequential --detach     # overnight, resumable

Per input file the output folder holds full_text.md, pages/page_XXXX.raw.json + .clean.json, tables/, structured_data.json,
chunks.jsonl, review_queue.md, tranche_XXX_summary.json, qa_report.md. Originals are only ever read.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import re
import subprocess
import sys
import time
from collections import Counter
from multiprocessing.connection import wait
from pathlib import Path

import pymupdf as fitz

import chunks as chunkmod
import config
import intake
import nlp
import structured
import tables as tb
import tranche
import validate
import worker


# ---------------------------------------------------------------- helpers

def slug(rel: str) -> str:
    stem = re.sub(r"[^\w\-]+", "_", Path(rel).stem)[:40].strip("_") or "file"
    return f"{stem}_{hashlib.md5(rel.encode()).hexdigest()[:6]}"


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class Log:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(path, "a", encoding="utf-8")

    def __call__(self, **kw):
        self.f.write(json.dumps(kw, ensure_ascii=False) + "\n")
        self.f.flush()


# ---------------------------------------------------------------- process pool with per-page timeout + retries

class Pool:
    def __init__(self, n: int, env: dict, timeout: float, retries: int, log: Log):
        self.ctx = mp.get_context("spawn")
        self.n, self.env, self.timeout, self.retries, self.log = n, env, timeout, retries, log
        self.slots = [self._spawn() for _ in range(n)]

    def _spawn(self) -> dict:
        parent, child = self.ctx.Pipe()
        p = self.ctx.Process(target=worker.worker_main, args=(child, self.env), daemon=True)
        p.start()
        child.close()
        return {"proc": p, "conn": parent, "task": None, "t0": 0.0}

    def _respawn(self, i: int) -> None:
        s = self.slots[i]
        try:
            s["proc"].terminate()
            s["proc"].join(5)
        except Exception:
            pass
        self.slots[i] = self._spawn()

    def run(self, tasks: list[dict], on_result) -> None:
        pending = list(reversed(tasks))        # pop() takes the next task in order
        delayed: list[tuple[float, dict]] = []  # (not_before, task) for retries with backoff
        inflight = 0
        while pending or delayed or inflight:
            now = time.time()
            ready = [t for nb, t in delayed if nb <= now]
            delayed = [(nb, t) for nb, t in delayed if nb > now]
            pending.extend(reversed(ready))
            for s in self.slots:
                if s["task"] is None and pending:
                    t = pending.pop()
                    t["attempt"] = t.get("attempt", 0) + 1
                    s["task"], s["t0"] = t, time.time()
                    try:
                        s["conn"].send(t)
                    except (BrokenPipeError, OSError, EOFError):
                        # worker died while idle: replace it and try this task again (counts as an attempt)
                        s["task"] = None
                        self._respawn(self.slots.index(s))
                        self._retry_or_fail(t, "worker process died before the task was sent", delayed, on_result)
                        continue
                    inflight += 1
            busy = [s["conn"] for s in self.slots if s["task"] is not None]
            for c in (wait(busy, timeout=1.0) if busy else []):
                i = next(k for k, s in enumerate(self.slots) if s["conn"] is c)
                s = self.slots[i]
                t = s["task"]
                try:
                    kind, payload = c.recv()
                except (EOFError, OSError):
                    kind, payload = "err", "worker process died"
                    self._respawn(i)
                s["task"] = None
                inflight -= 1
                if kind == "ok":
                    payload["attempts"] = t["attempt"]
                    on_result(t, payload)
                else:
                    self._retry_or_fail(t, payload, delayed, on_result)
            for i, s in enumerate(self.slots):
                if s["task"] is not None and time.time() - s["t0"] > self.timeout:
                    t = s["task"]
                    s["task"] = None
                    inflight -= 1
                    self._respawn(i)
                    self._retry_or_fail(t, f"timeout after {self.timeout:.0f}s", delayed, on_result)

    def _retry_or_fail(self, t, err, delayed, on_result) -> None:
        self.log(event="page_error", file=t["rel"], page=t["page_no"], attempt=t["attempt"], error=err[:300])
        if t["attempt"] < self.retries:
            delayed.append((time.time() + 2 ** t["attempt"], t))  # 2s, 4s backoff
        else:
            on_result(t, {"page": t["page_no"], "file": t["rel"], "status": "failed", "source": "failed",
                          "confidence": 0.0, "text": "", "blocks": [], "tables": [], "errors": [err[:400]],
                          "attempts": t["attempt"], "seconds": 0})

    def close(self) -> None:
        for s in self.slots:
            try:
                s["conn"].send(None)
            except Exception:
                pass
        for s in self.slots:
            s["proc"].join(3)
            if s["proc"].is_alive():
                s["proc"].terminate()


# ---------------------------------------------------------------- planning

def _task(it, n, path, local, kind, args, vision) -> dict:
    return {"rel": it.rel, "page_no": n, "path": path, "local_page": local, "kind": kind, "lang": args.lang,
            "dpi": args.dpi, "conf_threshold": args.conf, "quality_threshold": args.quality, "paddle": not args.no_paddle,
            "vision": vision, "force_ocr": args.force_ocr, "size_mb": it.size_mb, "profile": args.profile}


def plan_pdf(it: intake.Item, out: Path, args, vision, pages: list[int] | None = None) -> tuple[list[dict], list[Path]]:
    """Page tasks for a PDF, resuming from checkpoints. Huge PDFs are split into SPLIT_PAGES-page parts first."""
    pages_dir = out / "pages"
    path = str(it.path)
    part_of: dict[int, tuple[str, int]] = {}
    parts: list[Path] = []
    cand = pages if pages is not None else list(range(1, it.pages + 1))
    todo = [n for n in cand if not (args.resume and tranche.page_done(pages_dir, n, it.size_mb))]
    if it.size_mb > args.huge_mb and todo:
        src = fitz.open(it.path)
        pdir = out / "_parts"
        pdir.mkdir(parents=True, exist_ok=True)
        for start in range(0, it.pages, args.split_pages):
            end = min(start + args.split_pages, it.pages)
            if not any(start + 1 <= n <= end for n in todo):
                continue
            pp_ = pdir / f"part_{start + 1:05d}.pdf"
            if not pp_.exists():
                part = fitz.open()
                part.insert_pdf(src, from_page=start, to_page=end - 1)
                part.save(pp_, garbage=3, deflate=True)
                part.close()
            parts.append(pp_)
            for n in range(start + 1, end + 1):
                part_of[n] = (str(pp_), n - start - 1)
        src.close()
    tasks = []
    for n in todo:
        p, local = part_of.get(n, (path, n - 1))
        t = _task(it, n, p, local, "pdf", args, vision)
        t["out"] = str(out)
        tasks.append(t)
    return tasks, parts


def plan_file(it, out: Path, args, vision, pages: list[int] | None = None) -> tuple[list[dict], list[Path]]:
    if it.kind == "image":
        if args.resume and tranche.page_done(out / "pages", 1, it.size_mb):
            return [], []
        t = _task(it, 1, str(it.path), 0, "image", args, vision)
        t["out"] = str(out)
        return [t], []
    tasks, parts = plan_pdf(it, out, args, vision, pages)
    if args.limit_pages:
        tasks = [t for t in tasks if t["page_no"] <= args.limit_pages]
    return tasks, parts


def ensure_lexicon(items: list[intake.Item], log=print) -> None:
    """Quality scoring and word correction need a vocabulary. If none exists yet, harvest one from the text-layer
    pages of the input files themselves (local, a few hundred pages are plenty)."""
    lex = config.HERE / "lexicon.txt"
    if lex.exists():
        return
    texts, budget = [], 400
    for it in items:
        if it.kind != "pdf" or not it.text_pages or budget <= 0:
            continue
        try:
            with fitz.open(it.path) as d:
                step = max(1, d.page_count // 12)
                for i in range(0, d.page_count, step):
                    ok, t = intake.page_has_text_layer(d[i])
                    if ok:
                        texts.append(t)
                        budget -= 1
        except Exception:
            continue
    n = nlp.build_lexicon(texts, lex)
    log(f"[lexicon] built {n} words from {len(texts)} text-layer pages -> {lex.name}")


# ---------------------------------------------------------------- per-file finalisation

def finalize_file(it: intake.Item, out: Path, args, total: int) -> tuple[dict, list[dict], dict]:
    """Assemble outputs from the checkpointed pages: full_text, tables, structured_data, chunks, review queue.
    Returns (res for validate, review flags, statement facts for the cross-file chain)."""
    pages_dir = out / "pages"
    raws = {n: tranche.load_raw(pages_dir, n) for n in range(1, total + 1)}
    todo_clean = [n for n, r in raws.items() if r and r.get("status") == "ok" and not tranche.clean_path(pages_dir, n).exists()]
    if todo_clean:
        tranche.clean_pages(pages_dir, todo_clean)
    cleans = {}
    for n, r in raws.items():
        cp = tranche.clean_path(pages_dir, n)
        if r and r.get("status") == "ok" and cp.exists():
            cleans[n] = json.loads(cp.read_text(encoding="utf-8"))
    md, md_raw = [f"# {it.rel}\n"], [f"# {it.rel} (raw OCR, no clean-up)\n"]
    page_text, page_tables = {}, {}
    for n in range(1, total + 1):
        r, c = raws.get(n), cleans.get(n)
        if r and r.get("status") == "failed":
            t = raw_t = f"[PAGE {n} FAILED: {'; '.join(r.get('errors', []))[:200]}]"
        elif r is None:
            t = raw_t = "[PAGE NOT PROCESSED]"
        else:
            raw_t = r["text"]
            t = (c or {}).get("text", raw_t)
            if not t.strip():
                t = raw_t = f"[NO TEXT FOUND ON PAGE {n} - blank or unreadable]"
            elif c and (c.get("header_text") or c.get("footer_text")):
                t += "\n\n[header/footer] " + " | ".join(x for x in (c.get("header_text", ""), c.get("footer_text", "")) if x).replace("\n", " / ")
        md.append(f"\n--- Page {n} ---\n\n{t}\n")
        md_raw.append(f"\n--- Page {n} ---\n\n{raw_t}\n")
        page_text[n] = t
        page_tables[n] = r.get("tables", []) if r else []
    atomic_write(out / "full_text.md", "\n".join(md))
    atomic_write(out / "full_text.raw.md", "\n".join(md_raw))
    stitched = tb.stitch(page_tables)
    tdir = out / "tables"
    if tdir.exists():
        for old in tdir.iterdir():
            old.unlink()
    tb.write_tables(stitched, tdir)

    base = structured.extract(page_text, stitched)
    doc_type, doc_conf, _ = nlp.classify("\n".join(page_text.values()))
    typed = nlp.extract_typed(doc_type, page_text)
    checks = []
    for t in stitched:
        r = tranche.running_balance_check(t)
        if r["checked"]:
            checks.append(dict(r, table=t["id"], pages=t["pages"]))
    secs = tranche.sections(cleans)
    atomic_write(out / "sections.json", json.dumps(secs, ensure_ascii=False, indent=1))
    atomic_write(out / "structured_data.json", json.dumps(chunkmod.merged_structured(it.rel, base, cleans, doc_type, doc_conf, typed, checks),
                                                          ensure_ascii=False, indent=1))
    chs = chunkmod.build_chunks(it.rel, cleans, doc_type, doc_conf, stitched, secs)
    atomic_write(out / "chunks.jsonl", "\n".join(json.dumps(c, ensure_ascii=False) for c in chs) + ("\n" if chs else ""))

    flags = chunkmod.page_level_flags(it.rel, pages_dir, total)
    for ck in checks:
        for b in ck["breaks"][:10]:
            flags.append({"file": it.rel, "page": b["page"], "field": "running_balance", "value": f"expected {b['expected']}, found {b['found']}",
                          "reason": "balance does not follow previous balance - debit + credit" + (" (at a page/tranche boundary)" if b["at_page_boundary"] else ""),
                          "importance": 92})
    atomic_write(out / "review_queue.md", chunkmod.review_markdown(flags, f"Review queue: {it.rel}"))

    acct = Counter({a["value"]: len(a["pages"]) for a in base["ids"]["account_no"]}).most_common(1)
    first_date = next((d["iso"] for d in base["dates"] if d["iso"]), None)
    best = max(checks, key=lambda c: c["checked"], default=None)
    facts = {"file": it.rel, "account": acct[0][0] if acct else None, "period_start": first_date,
             "opening": (typed.get("opening_balance") or {}).get("normalized") or (best or {}).get("implied_opening"),
             "closing": (typed.get("closing_balance") or {}).get("normalized") or (best or {}).get("closing")}
    res = {"pages": {n: r for n, r in raws.items() if r}, "stitched": stitched, "structured": base, "doc_type": doc_type,
           "doc_conf": doc_conf, "n_chunks": len(chs)}
    return res, flags, facts


def native_file(it: intake.Item, out: Path) -> dict:
    """docx / xlsx / csv / text: extracted natively, never OCR'd. Each sheet counts as one page."""
    out.mkdir(parents=True, exist_ok=True)
    tbls, md, page_text = [], [f"# {it.rel}\n"], {}
    if it.kind == "docx":
        text, tabs = intake.read_docx(it.path)
        units = [("Document", text, tabs)]
    elif it.kind == "xlsx":
        units = [(name, "", [rows]) for name, rows in intake.read_xlsx(it.path).items()]
    elif it.kind == "csv":
        units = [("Sheet", "", [intake.read_csv(it.path)])]
    else:
        units = [("Text", it.path.read_text(encoding="utf-8", errors="replace"), [])]
    for n, (name, text, tabs) in enumerate(units, 1):
        body = text + "".join("\n" + "\n".join(" | ".join(r) for r in t) for t in tabs)
        md.append(f"\n--- Page {n} ({name}) ---\n\n{body}\n")
        page_text[n] = body
        for t in tabs:
            if t:
                tbls.append({"id": f"table_{len(tbls) + 1:03d}", "pages": [n], "methods": ["native"],
                             "width": max(len(r) for r in t), "rows": t})
    atomic_write(out / "full_text.md", "\n".join(md))
    tb.write_tables(tbls, out / "tables")
    sd = structured.extract(page_text, tbls)
    doc_type, doc_conf, _ = nlp.classify("\n".join(page_text.values()))
    sd["document"] = {"file": it.rel, "doc_type": doc_type, "doc_type_confidence": doc_conf}
    atomic_write(out / "structured_data.json", json.dumps(sd, ensure_ascii=False, indent=1))
    n = len(units)
    qa = {"file": it.rel, "kind": it.kind, "total_pages": n, "processed_pages": n, "by_source": {"native": n},
          "low_confidence": [], "failed": [], "mean_confidence": 100.0, "tables": len(tbls), "doc_type": doc_type,
          "doc_type_confidence": doc_conf, "review_items": 0}
    atomic_write(out / "qa_report.md", validate.qa_markdown(qa, []))
    atomic_write(out / "qa.json", json.dumps(qa, indent=1))
    return qa


# ---------------------------------------------------------------- CLI

def detach(args_list: list[str], out_root: Path) -> int:
    """Relaunch this command as a detached background process with a log file (survives closing the terminal)."""
    log = out_root / "pipeline.console.log"
    cmd = [sys.executable, "-X", "utf8", str(Path(__file__).resolve())] + [a for a in args_list if a != "--detach"]
    env = dict(os.environ, DOCPIPE_CHILD="1", PYTHONWARNINGS="ignore", PYTHONUNBUFFERED="1")
    kw: dict = {}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW  # hidden console: DETACHED_PROCESS (no console) kills the OCR workers
    else:
        kw["start_new_session"] = True
    with open(log, "ab") as lf:
        p = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, close_fds=True, cwd=str(Path(__file__).resolve().parent), **kw)
    (out_root / "pipeline.pid").write_text(str(p.pid))
    print(f"started in background, pid {p.pid}\nlog: {log}")
    print(f"tail it:  PowerShell: Get-Content '{log}' -Wait -Tail 20   |   bash: tail -f '{log}'")
    print(f"stop it:  Stop-Process -Id {p.pid}   (re-run the same command with --resume to continue)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lang", default="eng+hin+mar")
    ap.add_argument("--resume", action="store_true", help="skip pages already checkpointed")
    ap.add_argument("--profile", choices=["max", "fast"], default=config.DEFAULT_PROFILE,
                    help="max: 400/500 DPI, 4 preprocessing variants, both engines on every scanned page, Paddle server models, "
                         "escalation ladder (default). fast: the original single-pass behaviour.")
    ap.add_argument("--mode", choices=["sequential", "batch"], default="sequential",
                    help="sequential: one file at a time, in tranches, strictly in order (default). batch: all pages of all files in one queue.")
    ap.add_argument("--tranche-size", type=int, default=10)
    ap.add_argument("--detach", action="store_true", help="run in the background with a log file (pipeline.console.log)")
    ap.add_argument("--workers", type=int, default=None, help="default: auto-sized from free RAM (1.2 GB per Paddle worker, 2 GB kept free)")
    ap.add_argument("--dpi", type=int, default=None, help="default 400 (max profile) / 300 (fast)")
    ap.add_argument("--conf", type=float, default=config.CONF_THRESHOLD)
    ap.add_argument("--quality", type=float, default=config.QUALITY_THRESHOLD, help="escalation trigger on the page quality score")
    ap.add_argument("--page-timeout", type=float, default=None, help="seconds per page attempt (default 1800 max / 240 fast)")
    ap.add_argument("--retries", type=int, default=config.RETRIES)
    ap.add_argument("--huge-mb", type=float, default=config.HUGE_PDF_MB, help="PDFs above this are split into parts")
    ap.add_argument("--split-pages", type=int, default=config.SPLIT_PAGES)
    ap.add_argument("--force-ocr", action="store_true", help="OCR every page even if it has a text layer")
    ap.add_argument("--no-paddle", action="store_true")
    ap.add_argument("--paddle-model", choices=["mobile", "medium", "server"], default=None, help="default medium (max) / mobile (fast). 'server' = PP-OCRv4 server: crashes/very slow on low-RAM machines")
    ap.add_argument("--det-limit", type=int, default=2560, help="Paddle detection max side in px; 0 = full resolution (about 2x slower)")
    ap.add_argument("--vision", action="store_true", help="ladder level 3 / last resort: send pages still under threshold to a vision LLM "
                    "(OpenRouter). Uploads page images to an external service; off by default.")
    ap.add_argument("--vision-model", default=os.environ.get("DOCPIPE_VISION_MODEL", "google/gemma-3-27b-it:free"))
    ap.add_argument("--password", help="password for encrypted PDFs")
    ap.add_argument("--passwords", help="JSON file {filename: password}")
    ap.add_argument("--only", help="regex; process only files whose relative name matches")
    ap.add_argument("--limit-pages", type=int, default=0, help="debug: only first N pages of each PDF")
    ap.add_argument("--inventory-only", action="store_true")
    return ap


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = build_parser().parse_args(argv)
    out_root = Path(args.output).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    if args.detach and not os.environ.get("DOCPIPE_CHILD"):
        return detach(argv, out_root)

    mx = args.profile == "max"
    args.dpi = args.dpi or (config.DPI_MAX if mx else config.DPI_DEFAULT)
    args.page_timeout = args.page_timeout or (config.MAX_PAGE_TIMEOUT_S if mx else config.PAGE_TIMEOUT_S)
    args.paddle_model = args.paddle_model or ("medium" if mx else "mobile")
    if args.workers:
        why = f"{args.workers} worker(s): set with --workers"
    elif mx:
        args.workers, why = config.auto_workers()
    else:
        args.workers = max(1, min((os.cpu_count() or 2) - 1, 3))
        why = f"{args.workers} worker(s): fast profile default min(cpu-1, 3)"
    print(f"[config] profile={args.profile} mode={args.mode} tranche={args.tranche_size} dpi={args.dpi} paddle={args.paddle_model} "
          f"lang={args.lang} resume={args.resume}", flush=True)
    print(f"[workers] {why}", flush=True)

    log = Log(out_root / "pipeline.log.jsonl")
    passwords = json.loads(Path(args.passwords).read_text()) if args.passwords else {}
    if args.password:
        passwords["*"] = args.password

    print(f"[intake] scanning {args.input}", flush=True)
    files = intake.collect(Path(args.input), out_root / "_extracted")
    if args.only:
        files = [f for f in files if re.search(args.only, f[1], re.I)]
    items = intake.inventory(files, passwords, out_root / "_repaired")
    for it in items:  # ask for passwords interactively when possible
        if it.needs_password and sys.stdin.isatty():
            import getpass
            pw = getpass.getpass(f"Password for {it.rel}: ")
            passwords[it.path.name] = pw
            intake.inspect_pdf(it, pw, out_root / "_repaired")
    items.sort(key=lambda i: -i.size_mb)  # largest first
    if args.limit_pages:
        for it in items:
            if it.kind == "pdf":
                it.pages = min(it.pages, args.limit_pages)
    atomic_write(out_root / "inventory.json", intake.inventory_json(items))
    tot = sum(i.pages for i in items)
    print(f"[intake] {len(items)} files, {tot} pages "
          f"({sum(i.text_pages for i in items)} text-layer, {sum(i.scanned_pages for i in items)} need OCR)", flush=True)
    if args.inventory_only:
        return 0
    ensure_lexicon(items, lambda m: print(m, flush=True))

    env = {"DOCPIPE_PADDLE_MODEL": args.paddle_model, "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
           "TESSDATA_PREFIX": str(config.TESSDATA), "DOCPIPE_DET_LIMIT": str(args.det_limit)}
    vision = None
    if args.vision:
        key = os.environ.get("OPENROUTER_API_KEY") or config.load_env_file(config.HERE.parent / ".env").get("OPENROUTER_API_KEY")
        if key:
            vision = {"key": key, "model": args.vision_model}
        else:
            print("[vision] no OPENROUTER_API_KEY found; vision fallback disabled", flush=True)

    t_start = time.time()
    qa_all: list[dict] = []
    all_flags: list[dict] = []
    stmt_facts: list[dict] = []
    work: list[tuple[intake.Item, Path]] = []
    for it in items:
        out = out_root / "files" / slug(it.rel)
        if it.kind in ("docx", "xlsx", "csv", "text"):
            qa_all.append(native_file(it, out))
        elif it.kind == "other" or (it.kind == "pdf" and it.pages == 0):
            qa = {"file": it.rel, "kind": it.kind, "total_pages": 0, "processed_pages": 0, "by_source": {}, "low_confidence": [],
                  "failed": [], "mean_confidence": 0, "error": it.note or ("unsupported type" if it.kind == "other" else "unreadable"), "tables": 0}
            atomic_write(out / "qa_report.md", validate.qa_markdown(qa, []))
            qa_all.append(qa)
        else:
            (out / "pages").mkdir(parents=True, exist_ok=True)
            work.append((it, out))

    already = sum(1 for it, out in work for n in range(1, it.pages + 1) if args.resume and tranche.page_done(out / "pages", n, it.size_mb))
    progress = tranche.Progress(sum(it.pages for it, _ in work), already)
    print(f"[plan] {len(work)} file(s) to read, {progress.total - already} page(s) still to do ({already} already checkpointed)", flush=True)

    def on_result(t, r):
        r["fingerprint"] = {"size_mb": t["size_mb"]}
        atomic_write(Path(t["out"]) / "pages" / f"page_{t['page_no']:04d}.raw.json", json.dumps(r, ensure_ascii=False))
        legacy = Path(t["out"]) / "pages" / f"page_{t['page_no']:04d}.json"
        if legacy.exists():  # an older fast-profile checkpoint must not shadow the new reading
            legacy.unlink()
        log(event="page", file=t["rel"], page=t["page_no"], source=r.get("source"), conf=r.get("confidence"), level=r.get("escalation_level", 0),
            quality=(r.get("quality") or {}).get("score"), seconds=r.get("seconds"), attempts=r.get("attempts"), errors=r.get("errors"),
            ladder=[{k: v for k, v in e.items() if k in ("level", "score", "confidence", "error")} for e in r.get("ladder_log", [])])
        if r["status"] == "failed" or r.get("source", "").startswith(("ocr", "vision")):
            print(f"  p{t['page_no']:>4} {Path(t['rel']).name[:45]:45} {r.get('source')} conf={r.get('confidence')} "
                  f"L{r.get('escalation_level', 0)} {r.get('seconds')}s", flush=True)

    pool = Pool(args.workers, env, args.page_timeout, args.retries, log)
    try:
        if args.mode == "batch":
            tasks, parts_all = [], {}
            for it, out in work:
                t, parts = plan_file(it, out, args, vision)
                tasks += t
                parts_all[it.rel] = parts
            print(f"[batch] {len(tasks)} pages queued", flush=True)
            pool.run(tasks, on_result)
        for it, out in work:
            parts_seen: list[Path] = []
            if args.mode == "sequential":
                def plan_fn(pages, it=it, out=out):
                    tasks, parts = plan_file(it, out, args, vision, pages)
                    parts_seen.extend(parts)
                    return tasks
                tranche.process_file_in_tranches(it, out, pool, args.tranche_size, plan_fn, on_result, progress, lambda m: print(m, flush=True))
            else:  # batch: pages are done, this only fills gaps, writes the clean layer and tranche summaries
                tranche.process_file_in_tranches(it, out, pool, max(1, it.pages), lambda pages, it=it, out=out: plan_file(it, out, args, vision, pages)[0],
                                                 on_result, progress, lambda m: print(m, flush=True))
            res, flags, facts = finalize_file(it, out, args, it.pages)
            qa, issues = validate.validate_file(it, out, res, args.conf)
            qa.update(doc_type=res["doc_type"], doc_type_confidence=res["doc_conf"], review_items=len(flags), chunks=res["n_chunks"])
            atomic_write(out / "qa_report.md", validate.qa_markdown(qa, issues))
            atomic_write(out / "qa.json", json.dumps(qa, indent=1))
            qa_all.append(qa)
            all_flags += flags
            stmt_facts.append(facts)
            if qa["processed_pages"] == qa["total_pages"]:
                for p in (out / "_parts").glob("*.pdf") if (out / "_parts").exists() else []:
                    p.unlink(missing_ok=True)
    finally:
        pool.close()

    chain = tranche.statement_chain(stmt_facts)
    atomic_write(out_root / "continuity_report.json", json.dumps({"statement_chain": chain}, indent=1))
    for c in chain:
        if not c["match"]:
            all_flags.append({"file": c["to"], "page": 1, "field": "opening_balance", "value": f"{c['next_opening']} vs previous closing {c['closing']}",
                              "reason": f"opening balance != closing balance of {Path(c['from']).name}", "importance": 93})
    atomic_write(out_root / "review_queue.md", chunkmod.review_markdown(all_flags, "Review queue (all files)"))
    validate.write_summary(out_root, qa_all, time.time() - t_start)
    bad = [q for q in qa_all if q["processed_pages"] != q["total_pages"] or q.get("error")]
    print(f"[done] {len(qa_all)} files in {time.time() - t_start:.0f}s; incomplete files: {len(bad)}; review items: {len(all_flags)}", flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    mp.freeze_support()
    sys.exit(main())
