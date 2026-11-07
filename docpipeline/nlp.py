"""Post-processing on OCR text. The raw OCR output is never changed: this produces a separate `clean` view.

Principles: a correction is made only where a validator can confirm it (checksum / pattern / lexicon + low OCR
confidence). Every change is logged in `corrections` with before/after. Failures become `needs_review` flags,
never silent fixes. Nothing is invented.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from merge import lexicon
from structured import ACCT, DATE, GSTIN, IFSC, PAN, gstin_valid
from tables import norm_amount, norm_date

# ---------------------------------------------------------------- domain dictionary

DOMAIN_TERMS = """
GST GSTIN GSTR GSTR-3B PAN IFSC CIN DIN CIBIL CMR DSCR TOL TNW EBITDA EBIT PBT PAT ROC MCA TDS TCS ITR CGST SGST IGST
cess taxable outward inward supplies intra-state inter-state turnover invoice debit credit ledger debtors creditors sundry
fund based limits non-fund sanction sanctioned facility facilities renewal enhancement existing proposed cash credit
overdraft term loan working capital hypothecation collateral primary security guarantee guarantor personal corporate
mortgage immovable movable stock book debts receivables margin drawing power processing fee documentation tenor
repayment instalment installment monthly quarterly moratorium interest rate floating fixed spread MCLR repo benchmark
EMI principal outstanding overdue default arrears closing opening balance withdrawal deposit narration cheque
transaction statement account branch beneficiary remittance NEFT RTGS IMPS UPI ECS mandate standby letter guarantee
bank guarantee LC BG FDR deposit lien assignment insurance policy valuation stamp duty registration
balance sheet liabilities assets shareholders reserves surplus share capital borrowings secured unsecured current
non-current provisions payables inventories investments depreciation revenue operations expenses profit loss tax
deferred auditor auditors independent opinion report directors director proprietor partner partnership firm limited
private public company companies act registered office annexure schedule notes particulars amount total
assessment year computation income exempt deduction chargeable gross net worth turnover
Aadhaar Aadhar passport voter driving licence address proof date birth
State Bank India SBI HDFC ICICI Axis Kotak Yes Bank IDBI Canara Baroda Punjab National Union Indian Overseas Central UCO
Bandhan IndusInd Federal RBL Citizen Cooperative Co-op Finserv Finvest Fincorp Capital Finance Credit Saison Clix Ambit
Godrej Hero Tata Aditya Birla Bajaj Piramal Muthoot Shriram Mahindra Cholamandalam
Mumbai Thane Pune Delhi Gujarat Maharashtra Surat Ahmedabad Nagpur Nashik Industrial Estate Floor Road Marg Nagar Lower Parel
Limited Private Pvt Ltd LLP Linens Garments Enterprises Industries Corporation Exports Imports Traders Trading
""".split()

BANKS = ["State Bank of India", "SBI", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Yes Bank", "IDBI Bank",
         "Canara Bank", "Bank of Baroda", "Punjab National Bank", "Union Bank of India", "Bank of India", "Indian Bank",
         "Central Bank of India", "UCO Bank", "IndusInd Bank", "Federal Bank", "RBL Bank", "Bandhan Bank", "Citizen Credit Co-operative Bank",
         "Aditya Birla Finance", "Ambit Finvest", "Clix Capital", "Godrej Finance", "Credit Saison", "Hero FinCorp", "Tata Capital",
         "Bajaj Finance", "SMC Moneywise", "Piramal", "Muthoot", "Shriram Finance", "Mahindra Finance"]


@lru_cache(maxsize=1)
def vocab() -> frozenset[str]:
    return frozenset({t.lower() for t in DOMAIN_TERMS if len(t) > 2}) | lexicon()


@lru_cache(maxsize=1)
def _delete_index() -> dict[str, set[str]]:
    idx: dict[str, set[str]] = defaultdict(set)
    for w in vocab():
        if 4 <= len(w) <= 24 and w.isalpha():
            for i in range(len(w)):
                idx[w[:i] + w[i + 1:]].add(w)
    return idx


def build_lexicon(text_pages: list[str], out: Path, min_count: int = 3) -> int:
    """Harvest a vocabulary from text-layer pages (real text from these document families)."""
    c: Counter = Counter()
    for t in text_pages:
        c.update(w.lower() for w in re.findall(r"[A-Za-z]{3,24}", t))
    words = sorted(w for w, n in c.items() if n >= min_count)
    out.write_text("\n".join(words), encoding="utf-8")
    lexicon.cache_clear()
    vocab.cache_clear()
    _delete_index.cache_clear()
    return len(words)


# ---------------------------------------------------------------- Devanagari + language id

_COMBINING_NOT_INITIAL = "ािीुूृेैोौ़्ँंः"


def normalize_devanagari(s: str) -> str:
    """NFC + only fixes that cannot change a valid word: drop zero-width junk, drop a space that precedes a sign that can
    never start a word, collapse a repeated vowel sign / virama, drop trailing virama doubles."""
    s = unicodedata.normalize("NFC", s)
    s = s.replace("​", "").replace("﻿", "")
    s = re.sub(rf"(?<=[ऀ-ॿ]) +([{_COMBINING_NOT_INITIAL}])", r"\1", s)
    s = re.sub(rf"([{_COMBINING_NOT_INITIAL}])\1+", r"\1", s)
    return unicodedata.normalize("NFC", s)


_MR = {"आहे", "आहेत", "आणि", "च्या", "मध्ये", "येथे", "नाही", "होते", "तसेच", "यांचे", "करण्यात", "शाखा", "वसाहत"}
_HI = {"है", "हैं", "और", "का", "की", "के", "में", "से", "नहीं", "पर", "यह", "एक", "भारतीय", "बैंक"}


def line_language(text: str) -> str:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return "num"
    deva = sum("ऀ" <= c <= "ॿ" for c in letters) / len(letters)
    if deva < 0.15:
        return "eng"
    if deva < 0.85:
        return "mixed-eng-deva"
    words = set(re.findall(r"[ऀ-ॿ]+", text))
    mr, hi = len(words & _MR), len(words & _HI)
    return "mar" if mr > hi else ("hin" if hi > mr else "deva")


# ---------------------------------------------------------------- OCR error correction (validator-gated)

_TO_DIGIT = str.maketrans({"O": "0", "o": "0", "D": "0", "I": "1", "l": "1", "i": "1", "|": "1", "Z": "2", "S": "5", "s": "5",
                           "G": "6", "B": "8", "g": "9", "q": "9"})
_TO_LETTER = str.maketrans({"0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B"})


def _pos_fix(tok: str, kinds: str) -> str:
    """kinds: one char per position: 'L' letter, 'D' digit, 'A' any alnum, or a literal."""
    out = []
    for ch, k in zip(tok, kinds):
        if k == "D":
            out.append(ch.translate(_TO_DIGIT) if not ch.isdigit() else ch)
        elif k == "L":
            out.append(ch.translate(_TO_LETTER).upper() if not ch.isalpha() else ch.upper())
        elif k == "A":
            out.append(ch.upper())
        else:
            out.append(k)
    return "".join(out)


def _changes(a: str, b: str) -> int:
    return sum(x != y for x, y in zip(a, b))


def correct_ids(text: str) -> tuple[str, list[dict]]:
    """Fix confusable characters inside tokens that are shaped like PAN / GSTIN / IFSC / amounts / account numbers,
    and only when the corrected token passes its validator."""
    fixes: list[dict] = []

    def log(kind, a, b):
        fixes.append({"kind": kind, "before": a, "after": b})

    out_lines = []
    for line in text.split("\n"):
        def fix_tok(m: re.Match) -> str:
            tok = m.group(0)
            core = tok.strip(".,:;()")
            if len(core) == 15 and not GSTIN.fullmatch(core):
                cand = _pos_fix(core, "DDLLLLLDDDDLAZA")
                if GSTIN.fullmatch(cand) and gstin_valid(cand):
                    log("gstin", core, cand)
                    return tok.replace(core, cand)
            if len(core) == 10 and not PAN.fullmatch(core) and not core.isdigit():
                cand = _pos_fix(core, "LLLLLDDDDL")
                if PAN.fullmatch(cand) and (_changes(core.upper(), cand) <= 2 or re.search(r"\bPAN\b", line, re.I)):
                    log("pan", core, cand)
                    return tok.replace(core, cand)
            if len(core) == 11 and not IFSC.fullmatch(core):
                cand = _pos_fix(core, "LLLL0AAAAAA")
                if IFSC.fullmatch(cand) and (re.search(r"IFS", line, re.I) or _changes(core.upper(), cand) <= 1):
                    log("ifsc", core, cand)
                    return tok.replace(core, cand)
            if re.fullmatch(r"[\dOoIlSBZGgq|,.]{4,}", core) and re.search(r"[OoIlSBZGgq|]", core) and re.search(r"\d.*\d", core):
                cand = core.translate(_TO_DIGIT)
                if norm_amount(cand) is not None and ("," in cand or "." in cand) and norm_amount(core) is None:
                    log("amount", core, cand)
                    return tok.replace(core, cand)
            return tok

        line2 = re.sub(r"[A-Za-z0-9|][A-Za-z0-9|,.()]*[A-Za-z0-9|)]", fix_tok, line)
        # account numbers after a label
        def fix_acct(m: re.Match) -> str:
            raw = m.group(2)
            cand = raw.translate(_TO_DIGIT)
            if cand != raw and cand.isdigit() and 9 <= len(cand) <= 18:
                log("account_no", raw, cand)
                return m.group(1) + cand
            return m.group(0)
        line2 = re.sub(r"((?:a/?c|account)\s*(?:no\.?|number)?\s*[:\-]?\s*)([0-9OoIlSB]{9,18})\b", fix_acct, line2, flags=re.I)
        out_lines.append(line2)
    return "\n".join(out_lines), fixes


def _case_like(src: str, word: str) -> str:
    if src.isupper():
        return word.upper()
    if src[:1].isupper():
        return word.capitalize()
    return word


def correct_words(line: str, conf: float, low_conf: float = 85.0) -> tuple[str, list[dict]]:
    """Dictionary correction for alphabetic words, only when OCR confidence for the line is low, the word is unknown,
    exactly one lexicon word is one edit away (or 'rn'<->'m'), and the word contains no digit."""
    if conf >= low_conf:
        return line, []
    vc, idx = vocab(), _delete_index()
    fixes = []

    def fix(m: re.Match) -> str:
        w = m.group(0)
        lw = w.lower()
        if len(w) < 5 or lw in vc or not w.isalpha():
            return w
        cands = set()
        for i in range(len(lw) + 1):          # w has an extra letter  -> deleting it gives a word
            if lw[:i] + lw[i + 1:] in vc:
                cands.add(lw[:i] + lw[i + 1:])
        cands |= idx.get(lw, set())            # w is missing a letter
        for i in range(len(lw)):               # one substitution (via delete-index on both sides)
            for cand in idx.get(lw[:i] + lw[i + 1:], set()):
                if len(cand) == len(lw) and sum(a != b for a, b in zip(cand, lw)) == 1:
                    cands.add(cand)
        if "m" in lw:                          # 'rn' read as 'm' (and the reverse)
            cands |= {c for c in (lw.replace("m", "rn", 1),) if c in vc}
        if "rn" in lw:
            cands |= {c for c in (lw.replace("rn", "m", 1),) if c in vc}
        if len(cands) == 1:
            new = _case_like(w, next(iter(cands)))
            fixes.append({"kind": "word", "before": w, "after": new, "line_conf": conf})
            return new
        return w

    return re.sub(r"[A-Za-z]+", fix, line), fixes


# ---------------------------------------------------------------- entities

CIN = re.compile(r"\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b")
DIN = re.compile(r"\bDIN\s*[:\-]?\s*(\d{8})\b", re.I)
PHONE = re.compile(r"(?<!\d)(?:\+91[\s\-]?|0)?[6-9]\d{9}(?!\d)")
EMAIL = re.compile(r"\b[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+\b")
PCT = re.compile(r"(?<![\w.])\d{1,3}(?:\.\d{1,3})?\s?%")
SCALED = re.compile(r"(?:₹|Rs\.?|INR)?\s?(\d+(?:\.\d+)?)\s*(Cr(?:ore)?s?|Lakhs?|Lacs?|Lac|Mn|Million)\b", re.I)
COMPANY = re.compile(r"\b((?:M/s\.?\s+)?[A-Z][A-Za-z&.'\-]*(?:\s+[A-Z&][A-Za-z&.'\-]*){0,6}\s+(?:Private\s+Limited|Pvt\.?\s*Ltd\.?|Limited|Ltd\.?|LLP|Industries|Enterprises|Corporation))\b")
PINCODE = re.compile(r"(?<!\d)[1-9]\d{5}(?!\d)")
_SCALE = {"cr": Decimal(10_000_000), "lac": Decimal(100_000), "lakh": Decimal(100_000), "mn": Decimal(1_000_000), "million": Decimal(1_000_000)}


def scaled_amounts(text: str) -> list[dict]:
    out = []
    for m in SCALED.finditer(text):
        unit = m.group(2).lower().rstrip("s")
        unit = "cr" if unit.startswith("cr") else ("lakh" if unit.startswith(("lakh", "lac")) else unit)
        out.append({"raw": m.group(0).strip(), "number": m.group(1), "unit": unit,
                    "value_inr": str(Decimal(m.group(1)) * _SCALE.get(unit, Decimal(1)))})
    return out


def extract_entities(text: str, page: int) -> dict:
    ents: dict[str, list] = defaultdict(list)
    for m in GSTIN.findall(text):
        ents["gstin"].append({"value": m, "valid": gstin_valid(m), "page": page})
    for m in PAN.findall(text):
        ents["pan"].append({"value": m, "page": page})
    for m in IFSC.findall(text):
        ents["ifsc"].append({"value": m, "page": page})
    for m in ACCT.findall(text):
        ents["account_no"].append({"value": m, "page": page})
    for m in CIN.findall(text):
        ents["cin"].append({"value": m, "page": page})
    for m in DIN.findall(text):
        ents["din"].append({"value": m, "page": page})
    for raw in DATE.findall(text):
        ents["date"].append({"original": raw, "iso": norm_date(raw), "page": page})
    from structured import AMOUNT
    for m in AMOUNT.finditer(text):
        v = norm_amount(m.group(0).strip())
        if v is not None:
            ents["amount"].append({"original": m.group(0).strip(), "value": str(v), "page": page})
    ents["scaled_amount"] = [dict(a, page=page) for a in scaled_amounts(text)]
    for m in PCT.findall(text):
        ents["percentage"].append({"value": m.replace(" ", ""), "page": page})
    for m in PHONE.findall(text):
        ents["phone"].append({"value": m.strip(), "page": page})
    for m in EMAIL.findall(text):
        ents["email"].append({"value": m, "page": page})
    for m in COMPANY.findall(text):
        ents["company"].append({"value": m.strip(), "page": page})
    low = text.lower()
    for b in BANKS:
        if b.lower() in low:
            ents["bank"].append({"value": b, "page": page})
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        if PINCODE.search(ln) and re.search(r"[A-Za-z]{3,}", ln):
            ents["address"].append({"value": " ".join(x.strip() for x in lines[max(0, i - 1):i + 1]), "page": page, "heuristic": True})
    return {k: v for k, v in ents.items() if v}


# ---------------------------------------------------------------- validators -> needs_review flags

def validate_entities(ents: dict, page: int) -> list[dict]:
    flags = []

    def flag(field, value, reason, importance):
        flags.append({"page": page, "field": field, "value": value, "reason": reason, "importance": importance, "status": "needs_review"})
    for g in ents.get("gstin", []):
        if not g["valid"]:
            flag("gstin", g["value"], "GSTIN checksum failed", 90)
    for d in ents.get("date", []):
        if d["iso"] is None:
            flag("date", d["original"], "not a valid calendar date (DD/MM/YYYY assumed)", 40)
    for p in ents.get("pan", []):
        if p["value"][3] not in "ABCFGHLJPT":
            flag("pan", p["value"], "4th character is not a valid PAN holder type", 70)
    return flags


def table_arithmetic_flags(tables: list[dict], page: int) -> list[dict]:
    from validate import check_table_totals
    res = check_table_totals([{"id": f"p{page}_t{i}", "pages": [page], "rows": t["rows"]} for i, t in enumerate(tables)])
    return [{"page": page, "field": "table_total", "value": f"{m['stated']} vs computed {m['computed']}",
             "reason": f"stated total does not equal sum of rows above ({m['table']} row {m['row']} col {m['col']})",
             "importance": 85, "status": "needs_review"} for m in res["mismatches"]]


# ---------------------------------------------------------------- document type classification + typed extractors

DOC_TYPES: dict[str, list[tuple[str, int]]] = {
    "bank_statement": [("statement of account", 4), ("opening balance", 3), ("closing balance", 3), ("withdrawal", 2), ("deposit", 1),
                       ("narration", 3), ("value dt", 2), ("chq", 2), ("particulars", 1), ("tran date", 3), ("balance", 1), ("debit", 1), ("credit", 1)],
    "gst_return": [("gstr-3b", 6), ("gstr", 3), ("gstin", 2), ("taxable value", 3), ("integrated tax", 3), ("outward supplies", 3), ("input tax credit", 3), ("legal name", 2)],
    "balance_sheet": [("balance sheet", 6), ("total assets", 3), ("shareholders", 2), ("liabilities", 2), ("equity and liabilities", 4), ("reserves and surplus", 3)],
    "profit_and_loss": [("profit and loss", 6), ("statement of profit", 5), ("revenue from operations", 4), ("total expenses", 3), ("profit before tax", 3), ("earnings per share", 2)],
    "sanction_letter": [("sanction", 4), ("facility", 2), ("terms and conditions", 3), ("rate of interest", 3), ("security", 2), ("limit", 1), ("repayment", 2), ("we accept", 2), ("guarantor", 2)],
    "repayment_schedule": [("repayment schedule", 6), ("instalment", 3), ("installment", 3), ("emi", 2), ("principal", 1), ("outstanding", 1)],
    "itr_or_computation": [("assessment year", 4), ("computation of income", 5), ("total income", 3), ("income tax return", 5), ("itr-", 3), ("acknowledgement number", 3), ("tax payable", 2)],
    "form_26as": [("26as", 6), ("tax credit statement", 5), ("deductor", 3), ("tds", 1)],
    "tax_audit": [("form no. 3cd", 5), ("3cb", 3), ("3ca", 3), ("tax audit", 4), ("section 44ab", 4)],
    "audit_report": [("independent auditor", 6), ("basis for opinion", 4), ("key audit matters", 3), ("auditor's report", 4)],
    "credit_report": [("cibil", 5), ("credit score", 4), ("cmr", 4), ("enquiries", 2), ("credit information", 3), ("transunion", 3)],
    "ledger_register": [("sundry debtors", 5), ("sundry creditors", 5), ("sales register", 5), ("purchase register", 5), ("ledger", 2), ("voucher", 2)],
    "kyc": [("aadhaar", 5), ("passport", 4), ("voter", 3), ("driving licence", 4), ("date of birth", 2), ("address proof", 3), ("kyc", 4)],
    "company_profile": [("company profile", 5), ("about us", 2), ("our products", 2), ("incorporated", 2), ("directors", 1)],
}


def classify(text: str) -> tuple[str, float, dict]:
    low = text.lower()
    scores = {t: sum(w * min(3, low.count(k)) for k, w in kws) for t, kws in DOC_TYPES.items()}
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    top, second = ranked[0][1], ranked[1][1]
    if top < 5:
        return "other", 0.0, scores
    conf = round(top / (top + second + 4), 2)
    return ranked[0][0], conf, {k: v for k, v in ranked[:4]}


_AMT = r"((?:₹|Rs\.?)?\s?\(?-?\d[\d,]*(?:\.\d+)?\)?(?:\s?(?:Cr|Dr))?)"
FIELD_SPECS: dict[str, dict[str, str]] = {
    "bank_statement": {"opening_balance": r"opening\s+balance", "closing_balance": r"closing\s+balance",
                       "total_debits": r"total\s+(?:debit|withdrawal)s?", "total_credits": r"total\s+(?:credit|deposit)s?"},
    "gst_return": {"taxable_value_outward": r"taxable\s+value", "integrated_tax": r"integrated\s+tax", "central_tax": r"central\s+tax",
                   "state_tax": r"state/ut\s+tax|state\s+tax", "total_itc": r"net\s+itc|itc\s+available"},
    "balance_sheet": {"total_assets": r"total\s+assets", "total_liabilities": r"total\s+(?:equity\s+and\s+)?liabilities",
                      "share_capital": r"share\s+capital", "reserves_surplus": r"reserves\s+(?:and|&)\s+surplus", "net_worth": r"net\s*worth|shareholders'?\s+funds"},
    "profit_and_loss": {"revenue_from_operations": r"revenue\s+from\s+operations", "total_expenses": r"total\s+expenses",
                        "profit_before_tax": r"profit\s+before\s+tax", "profit_after_tax": r"profit\s+(?:after\s+tax|for\s+the\s+(?:year|period))"},
    "sanction_letter": {"total_limit": r"total\s+limits?", "cash_credit": r"cash\s+credit", "interest_rate": r"rate\s+of\s+interest|interest\s+rate",
                        "processing_fee": r"processing\s+fee"},
    "itr_or_computation": {"total_income": r"total\s+income", "tax_payable": r"tax\s+payable|net\s+tax", "gross_total_income": r"gross\s+total\s+income"},
    "credit_report": {"credit_score": r"(?:cibil|credit)\s+score|cmr\s+rank"},
}


def extract_typed(doc_type: str, page_text: dict[int, str]) -> dict:
    """Label -> first amount on the same line. Every hit carries page and the source line; absent = not reported."""
    spec = FIELD_SPECS.get(doc_type, {})
    found: dict[str, dict] = {}
    for pno in sorted(page_text):
        for ln in page_text[pno].split("\n"):
            for field, label in spec.items():
                if field in found:
                    continue
                m = re.search(label, ln, re.I)
                if not m:
                    continue
                rest = ln[m.end():]
                a = re.search(_AMT, rest)
                val = a.group(1).strip() if a else None
                if val and norm_amount(val) is not None:
                    found[field] = {"value": val, "normalized": str(norm_amount(val)), "page": pno, "source_line": ln.strip()[:160]}
    return found


# ---------------------------------------------------------------- reading order, header/footer

def order_blocks(blocks: list[dict], page_w: float, page_h: float, repeated: set[str] | None = None) -> dict:
    """Split blocks into header/body/footer and put body in reading order (column-major when a clear gutter exists).
    A block is header/footer when it sits in the top/bottom 6% band, or its text repeats on most pages (`repeated`)."""
    repeated = repeated or set()
    hdr, ftr, body = [], [], []
    for b in blocks:
        y0, y1 = b["bbox"][1], b["bbox"][3]
        key = re.sub(r"\d+", "#", b["text"].strip().lower())
        if key in repeated and y1 < page_h * 0.2:
            hdr.append(b)
        elif key in repeated and y0 > page_h * 0.8:
            ftr.append(b)
        elif y1 < page_h * 0.06:
            hdr.append(b)
        elif y0 > page_h * 0.94:
            ftr.append(b)
        else:
            body.append(b)
    cols = _columns(body, page_w)
    if cols:
        ordered = []
        for col in cols:
            ordered += sorted(col, key=lambda b: (b["bbox"][1], b["bbox"][0]))
        layout = f"{len(cols)}-column"
    else:
        ordered = sorted(body, key=lambda b: ((b["bbox"][1] + b["bbox"][3]) / 2, b["bbox"][0]))
        layout = "single"
    return {"header": hdr, "body": ordered, "footer": ftr, "layout": layout}


def _columns(blocks: list[dict], page_w: float) -> list[list[dict]] | None:
    """Two columns when no wide block crosses the page's centre band and both sides hold a good share of blocks."""
    if len(blocks) < 12 or page_w <= 0:
        return None
    mid = page_w / 2
    band = page_w * 0.04
    cross = [b for b in blocks if b["bbox"][0] < mid - band and b["bbox"][2] > mid + band]
    if len(cross) > 0.1 * len(blocks):
        return None
    left = [b for b in blocks if (b["bbox"][0] + b["bbox"][2]) / 2 < mid]
    right = [b for b in blocks if (b["bbox"][0] + b["bbox"][2]) / 2 >= mid]
    if min(len(left), len(right)) < 0.3 * len(blocks):
        return None
    # rows made of one left + one right block at the same height are a table/form, not prose columns
    paired = sum(1 for l in left if any(abs((l["bbox"][1] + l["bbox"][3]) - (r["bbox"][1] + r["bbox"][3])) < (l["bbox"][3] - l["bbox"][1]) for r in right))
    if paired > 0.6 * min(len(left), len(right)):
        return None
    return [left + cross, right]


def repeated_lines(pages: list[list[dict]], share: float = 0.5, min_pages: int = 4) -> set[str]:
    """Normalised line texts that appear on at least `share` of the pages (running headers/footers)."""
    if len(pages) < min_pages:
        return set()
    c: Counter = Counter()
    for blocks in pages:
        c.update({re.sub(r"\d+", "#", b["text"].strip().lower()) for b in blocks if len(b["text"].strip()) > 3})
    return {k for k, n in c.items() if n >= share * len(pages)}


# ---------------------------------------------------------------- page-level entry point

def clean_page(raw: dict, repeated: set[str] | None = None, page_size: tuple[float, float] | None = None) -> dict:
    """raw: a page result (blocks with text/bbox/conf, text, tables). Returns the clean view; `raw` is not modified."""
    page = raw["page"]
    blocks = [dict(b) for b in raw.get("blocks", [])]
    corrections: list[dict] = []
    if blocks:
        w = max((b["bbox"][2] for b in blocks), default=1)
        h = max((b["bbox"][3] for b in blocks), default=1)
        pw, ph = page_size or (w, h)
        parts = order_blocks(blocks, pw, ph, repeated)
        for b in parts["header"] + parts["body"] + parts["footer"]:
            t = normalize_devanagari(b["text"])
            if b.get("illegible"):
                b["clean_text"] = t
                continue
            t, f1 = correct_ids(t)
            t, f2 = correct_words(t, b.get("conf", 100.0))
            b["clean_text"] = t
            for f in f1 + f2:
                corrections.append(dict(f, page=page))
            b["lang"] = line_language(t)
        from ocr_engines import rows_to_text
        def txt(bs):
            return rows_to_text([dict(b, text=b["clean_text"]) for b in bs])
        header_text, body_text, footer_text = txt(parts["header"]), txt(parts["body"]), txt(parts["footer"])
        layout = parts["layout"]
        langs = Counter(b["lang"] for b in parts["body"] if b.get("lang") not in (None, "num"))
    else:
        t = normalize_devanagari(raw.get("text", ""))
        body_text, f = correct_ids(t)
        corrections += [dict(x, page=page) for x in f]
        header_text = footer_text = ""
        layout, langs = "single", Counter()
    ents = extract_entities(body_text, page)
    flags = validate_entities(ents, page) + table_arithmetic_flags(raw.get("tables", []), page)
    for c in corrections:
        if c["kind"] in ("gstin", "pan", "ifsc", "account_no", "amount"):
            flags.append({"page": page, "field": c["kind"], "value": c["after"], "reason": f"OCR confusable corrected from '{c['before']}' (validator passed)",
                          "importance": 55, "status": "needs_review"})
    if raw.get("illegible_lines"):
        flags.append({"page": page, "field": "page_text", "value": f"{raw['illegible_lines']} line(s)", "reason": "text marked [ILLEGIBLE]",
                      "importance": 75, "status": "needs_review"})
    return {"page": page, "source": raw.get("source"), "confidence": raw.get("confidence"), "text": body_text, "header_text": header_text,
            "footer_text": footer_text, "layout": layout, "languages": dict(langs), "entities": ents, "corrections": corrections,
            "flags": flags, "tables": raw.get("tables", [])}
