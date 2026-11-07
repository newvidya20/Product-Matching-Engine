"""Shared settings and tool discovery for the document pipeline. Nothing here reads document content."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESSDATA = HERE / "tessdata"  # eng/hin/mar/osd (tessdata_best), shipped beside the code
# pytesseract splits its config with shlex, which mangles Windows paths containing spaces, so the
# data directory is passed through the environment instead of --tessdata-dir.
os.environ["TESSDATA_PREFIX"] = str(TESSDATA)

# Page thresholds
MIN_TEXT_CHARS = 40          # fewer printable chars than this -> page has no usable text layer
MIN_ALNUM_RATIO = 0.55       # share of alnum+space+common punctuation among chars; below = garbage layer
CONF_THRESHOLD = 85.0        # OCR pages under this get the second engine, then the vision fallback
DPI_DEFAULT = 300
DPI_SMALL_FONT = 400
CHUNK_PAGES = 10             # pages handed to a worker at a time
SPLIT_PAGES = 20             # PDFs larger than HUGE_PDF_MB are processed as parts of this many pages
HUGE_PDF_MB = 100
PAGE_TIMEOUT_S = 240
RETRIES = 3

# Profiles. `fast` is the original behaviour; `max` is the accuracy profile (hours are fine, resumable).
DEFAULT_PROFILE = "max"
DPI_MAX = 400                # max profile base DPI
DPI_MAX_SMALL = 500          # when the median letter height is small
QUALITY_THRESHOLD = 85.0     # escalation ladder trigger (escalate.quality score)
MAX_PAGE_TIMEOUT_S = 1800    # one max-profile page can take many minutes (up to ~25 readings + ladder)
PADDLE_GB = 1.2              # RAM per Paddle worker
RESERVE_GB = 2.0             # always left free


def free_ram_gb() -> float:
    """Available physical memory in GB (Windows API; falls back to /proc/meminfo; 4.0 if unknown)."""
    try:
        import ctypes

        class MS(ctypes.Structure):
            _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong), ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong),
                        ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong),
                        ("ae", ctypes.c_ulonglong)]
        ms = MS()
        ms.l = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        return ms.ap / 2**30
    except Exception:
        try:
            for line in open("/proc/meminfo"):
                if line.startswith("MemAvailable"):
                    return int(line.split()[1]) / 2**20
        except OSError:
            pass
    return 4.0


def auto_workers(cpu: int | None = None) -> tuple[int, str]:
    """Workers = min(cpu-1, floor((free RAM - reserve) / per-worker GB)), at least 1. Returns (n, explanation)."""
    cpu = cpu or os.cpu_count() or 2
    free = free_ram_gb()
    by_ram = int(max(0.0, free - RESERVE_GB) // PADDLE_GB)
    n = max(1, min(cpu - 1, by_ram))
    return n, f"{n} worker(s): {free:.1f} GB RAM free, reserve {RESERVE_GB:.0f} GB, {PADDLE_GB} GB/worker -> RAM allows {by_ram}; cpu-1 = {cpu - 1}"


def find_tesseract() -> str | None:
    found = shutil.which("tesseract")
    if found:
        return found
    for cand in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
        if os.path.exists(cand):
            return cand
    return None


def find_qpdf() -> str | None:
    found = shutil.which("qpdf")
    if found:
        return found
    base = Path(r"C:\Program Files")
    for p in base.glob("qpdf*/bin/qpdf.exe"):
        return str(p)
    return None


def find_ghostscript() -> str | None:
    for name in ("gswin64c", "gs"):
        found = shutil.which(name)
        if found:
            return found
    return None


def load_env_file(path: Path) -> dict[str, str]:
    """Minimal .env reader. Values are returned, never printed."""
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out
