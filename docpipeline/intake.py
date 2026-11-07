"""Stage 0 + inventory: classify inputs, expand ZIPs, repair/unlock PDFs, native docx/xlsx/csv extraction.

Nothing is ever loaded whole: PDFs are opened lazily by PyMuPDF and read page by page.
"""
from __future__ import annotations

import csv
import json
import re
import subprocess
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf as fitz  # PyMuPDF

import config

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
SKIP_NAMES = {"thumbs.db", ".ds_store"}


@dataclass
class Item:
    path: Path                  # file to process (original, or a repaired copy)
    rel: str                    # stable relative name used for the output folder
    kind: str                   # pdf | image | docx | xlsx | csv | text | other
    size_mb: float = 0.0
    pages: int = 0
    text_pages: int = 0
    scanned_pages: int = 0
    note: str = ""              # repaired / encrypted / corrupt
    needs_password: bool = False
    extra: dict = field(default_factory=dict)


def kind_of(p: Path) -> str:
    e = p.suffix.lower()
    if e == ".pdf":
        return "pdf"
    if e in IMAGE_EXT:
        return "image"
    if e == ".docx":
        return "docx"
    if e in (".xlsx", ".xlsm"):
        return "xlsx"
    if e in (".csv", ".tsv"):
        return "csv"
    if e in (".txt", ".md"):
        return "text"
    if e == ".zip":
        return "zip"
    return "other"


def safe_extract_zip(zpath: Path, dest: Path, depth: int = 0) -> list[Path]:
    """Extract (recursively) without zip-slip; entries are streamed to disk, never held in memory."""
    dest.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    root = dest.resolve()
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            target = (dest / info.filename).resolve()
            if root not in target.parents:
                continue  # path traversal attempt
            if target.name.lower() in SKIP_NAMES:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.stat().st_size != info.file_size:
                with z.open(info) as src, open(target, "wb") as dst:
                    while chunk := src.read(1 << 20):
                        dst.write(chunk)
            if target.suffix.lower() == ".zip" and depth < 4:
                out += safe_extract_zip(target, target.with_suffix(""), depth + 1)
            else:
                out.append(target)
    return out


def collect(inp: Path, work: Path) -> list[tuple[Path, str]]:
    """Return [(file, relative-name)] for every processable file under `inp` (zips expanded into `work`)."""
    inp = inp.resolve()
    files: list[tuple[Path, str]] = []
    if inp.is_file():
        bases = [(inp, inp.name)]
    else:
        bases = [(p, str(p.relative_to(inp))) for p in sorted(inp.rglob("*")) if p.is_file()]
    for p, rel in bases:
        if p.name.lower() in SKIP_NAMES:
            continue
        if p.suffix.lower() == ".zip":
            sub = work / re.sub(r"[^\w.\- ]", "_", p.stem.strip())
            for q in safe_extract_zip(p, sub):
                files.append((q, str(Path(p.stem.strip()) / q.relative_to(sub))))
        else:
            files.append((p, rel))
    return files


# ---------------------------------------------------------------- PDF handling

def page_has_text_layer(page: "fitz.Page") -> tuple[bool, str]:
    """True when the native text is long enough and not garbage (cid placeholders, replacement chars...)."""
    txt = page.get_text("text") or ""
    return text_is_good(txt), txt


def text_is_good(txt: str) -> bool:
    s = txt.strip()
    if len(s) < config.MIN_TEXT_CHARS:
        return False
    if "(cid:" in s or s.count("�") > len(s) * 0.02:
        return False
    sane = sum(1 for c in s if c.isalnum() or c.isspace() or c in ".,:;-/()&%@'\"#*+=_<>[]|₹")
    return sane / len(s) >= config.MIN_ALNUM_RATIO


def repair_pdf(src: Path, dst_dir: Path) -> Path | None:
    """Try qpdf, then PyMuPDF re-save. Original is untouched; the repaired copy goes to dst_dir."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (src.stem + ".repaired.pdf")
    q = config.find_qpdf()
    if q:
        r = subprocess.run([q, str(src), str(dst)], capture_output=True)
        if r.returncode in (0, 3) and dst.exists() and dst.stat().st_size > 0:  # 3 = warnings only
            return dst
    try:
        with fitz.open(src) as d:
            d.save(dst, garbage=4, clean=True, deflate=True)
        return dst
    except Exception:
        return None


def open_pdf(path: Path, password: str | None, repair_dir: Path) -> tuple[fitz.Document | None, Path, str, bool]:
    """-> (doc, path_used, note, needs_password)."""
    try:
        doc = fitz.open(path)
        if doc.needs_pass:
            if password and doc.authenticate(password):
                return doc, path, "decrypted", False
            return None, path, "encrypted: password required", True
        if doc.page_count == 0:
            raise ValueError("no pages")
        return doc, path, "", False
    except Exception as e:
        fixed = repair_pdf(path, repair_dir)
        if fixed:
            try:
                doc = fitz.open(fixed)
                if doc.page_count > 0:
                    return doc, fixed, f"repaired ({type(e).__name__})", False
            except Exception:
                pass
        return None, path, f"corrupt, repair failed: {e}", False


def inspect_pdf(item: Item, password: str | None, repair_dir: Path) -> None:
    doc, used, note, needs_pw = open_pdf(item.path, password, repair_dir)
    item.note, item.needs_password = note, needs_pw
    if doc is None:
        return
    item.path = used
    item.pages = doc.page_count
    for i in range(doc.page_count):
        ok, _ = page_has_text_layer(doc[i])
        item.text_pages += ok
    item.scanned_pages = item.pages - item.text_pages
    doc.close()


def inventory(files: list[tuple[Path, str]], passwords: dict[str, str], repair_dir: Path) -> list[Item]:
    items: list[Item] = []
    for p, rel in files:
        it = Item(path=p, rel=rel, kind=kind_of(p), size_mb=round(p.stat().st_size / 1048576, 2))
        if it.kind == "pdf":
            inspect_pdf(it, passwords.get(p.name) or passwords.get("*"), repair_dir)
        elif it.kind == "image":
            it.pages = it.scanned_pages = 1
        items.append(it)
    return items


# ---------------------------------------------------------------- native office / text readers

def read_docx(path: Path) -> tuple[str, list[list[list[str]]]]:
    import docx
    d = docx.Document(str(path))
    paras = [p.text for p in d.paragraphs if p.text.strip()]
    tables = [[[c.text.strip() for c in row.cells] for row in t.rows] for t in d.tables]
    return "\n".join(paras), tables


def read_xlsx(path: Path) -> dict[str, list[list[str]]]:
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheets: dict[str, list[list[str]]] = {}
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            if any(c is not None and str(c).strip() for c in row):
                rows.append(["" if c is None else str(c) for c in row])
        sheets[ws.title] = rows
    wb.close()
    return sheets


def read_csv(path: Path) -> list[list[str]]:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            with open(path, newline="", encoding=enc) as f:
                return [r for r in csv.reader(f, delimiter="\t" if path.suffix.lower() == ".tsv" else ",")]
        except UnicodeDecodeError:
            continue
    return []


def inventory_json(items: list[Item]) -> str:
    return json.dumps(
        [dict(rel=i.rel, kind=i.kind, size_mb=i.size_mb, pages=i.pages, text_layer_pages=i.text_pages,
              scanned_pages=i.scanned_pages, note=i.note) for i in items], indent=1)
