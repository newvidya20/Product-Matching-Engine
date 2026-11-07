"""Key-field extraction from page text: IDs (PAN, GSTIN, IFSC, account numbers), dates, amounts, key/value pairs.
Pure regex over what the pages actually say. Nothing is inferred; every hit carries its page number."""
from __future__ import annotations

import re
from collections import defaultdict

from tables import norm_amount, norm_date

PAN = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
GSTIN = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b")
IFSC = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")
ACCT = re.compile(r"(?:a/?c|account)\s*(?:no\.?|number|#)?\s*[:\-]?\s*(\d{9,18})\b", re.I)
DATE = re.compile(r"\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-,]+\d{4})\b")
AMOUNT = re.compile(r"(?<![\w.])(?:₹|Rs\.?|INR)?\s?\(?-?\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?\)?(?![\w,])|(?<![\w.,])(?:₹|Rs\.?|INR)\s?\d+(?:\.\d{1,2})?(?![\w,])")
KV = re.compile(r"^\s*([A-Za-z][A-Za-z0-9 /().&'\-]{2,45}?)\s*[:：]\s+(\S.{0,160})$")
NAMEKEY = re.compile(r"\b(name|borrower|applicant|company|firm|proprietor|director|guarantor|customer)\b", re.I)

_B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_valid(g: str) -> bool:
    """Checksum of the 15th character (GSTN algorithm)."""
    total = 0
    for i, ch in enumerate(g[:14]):
        v = _B36.index(ch) * (1 if i % 2 == 0 else 2)
        total += v // 36 + v % 36
    return _B36[(36 - total % 36) % 36] == g[14]


def extract(page_text: dict[int, str], tables: list[dict]) -> dict:
    ids: dict[str, dict[str, list[int]]] = {k: defaultdict(list) for k in ("pan", "gstin", "ifsc", "account_no")}
    dates: dict[str, dict] = {}
    amounts: list[dict] = []
    kv: list[dict] = []
    names: list[dict] = []
    for pno, text in sorted(page_text.items()):
        for m in PAN.findall(text):
            ids["pan"][m].append(pno)
        for m in GSTIN.findall(text):
            ids["gstin"][m].append(pno)
        for m in IFSC.findall(text):
            ids["ifsc"][m].append(pno)
        for m in ACCT.findall(text):
            ids["account_no"][m].append(pno)
        for raw in DATE.findall(text):
            iso = norm_date(raw)
            d = dates.setdefault(raw, {"raw": raw, "iso": iso, "valid": iso is not None, "pages": []})
            d["pages"].append(pno)
        for ln in text.splitlines():
            m = KV.match(ln)
            if m:
                key, val = m.group(1).strip(), m.group(2).strip()
                kv.append({"key": key, "value": val, "page": pno})
                if NAMEKEY.search(key) and not re.search(r"\d{4,}", val):
                    names.append({"label": key, "name": val, "page": pno})
            for a in AMOUNT.finditer(ln):
                v = norm_amount(a.group(0).strip())
                if v is not None:
                    amounts.append({"raw": a.group(0).strip(), "value": str(v), "page": pno, "line": ln.strip()[:120]})
    out_ids = {}
    for k, found in ids.items():
        out_ids[k] = [{"value": v, "pages": sorted(set(p)), **({"checksum_valid": gstin_valid(v)} if k == "gstin" else {})}
                      for v, p in sorted(found.items())]
    line_items = []
    for t in tables:
        for r in t["rows"][1:]:
            line_items.append({"table": t["id"], "pages": t["pages"], "header": t["rows"][0], "row": r})
    return {"ids": out_ids,
            "dates": sorted(dates.values(), key=lambda d: (d["iso"] is None, d["iso"] or d["raw"])),
            "names": names, "key_values": kv, "amounts": amounts,
            "line_items_note": f"{len(line_items)} table rows across {len(tables)} tables; see tables/ for CSV+JSON",
            "invalid_ids": [i for i in out_ids["gstin"] if not i["checksum_valid"]]}
