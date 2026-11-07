"""Stage 6: LLM-ready output: chunks.jsonl, merged structured_data.json (per-field source page + confidence), review_queue.md."""
from __future__ import annotations

import json
import re
from pathlib import Path

import nlp
import tranche


def est_tokens(text: str) -> int:
    deva = sum("ऀ" <= c <= "ॿ" for c in text)
    return int((len(text) - deva) / 4 + deva / 1.5) + 1


def _units(text: str) -> list[tuple[str, bool]]:
    """Split page text into (unit, is_table_run). Consecutive rows with column gaps are one atomic table unit."""
    units, buf, tab = [], [], []
    def flush_buf():
        if buf:
            units.append(("\n".join(buf), False)); buf.clear()
    def flush_tab():
        if tab:
            units.append(("\n".join(tab), True)); tab.clear()
    for ln in text.split("\n"):
        tabular = len(re.findall(r"\s{2,}|\|", ln.strip())) >= 2 and len(ln.strip()) > 8
        if tabular:
            flush_buf(); tab.append(ln)
        elif not ln.strip():
            flush_tab(); flush_buf()
        else:
            flush_tab(); buf.append(ln)
    flush_tab(); flush_buf()
    return units


def build_chunks(rel: str, cleans: dict[int, dict], doc_type: str, doc_conf: float, tables: list[dict], secs: list[dict],
                 lo: int = 500, hi: int = 800) -> list[dict]:
    """Chunks of ~lo-hi tokens, closed at headings, never inside a table run (an oversize table is its own chunk,
    split only at row boundaries with the header row repeated and `table_continued` set)."""
    chunks: list[dict] = []
    cur: dict | None = None

    def section_of(p):
        s = [x for x in secs if x["page_start"] <= p <= x["page_end"]]
        return s[-1]["title"] if s else None

    def new(p):
        return {"parts": [], "page_start": p, "page_end": p, "tokens": 0, "section": section_of(p)}

    def close():
        nonlocal cur
        if cur and cur["parts"]:
            pages = range(cur["page_start"], cur["page_end"] + 1)
            text = "\n\n".join(cur["parts"])
            ents = nlp.extract_entities(text, cur["page_start"])
            confs = [cleans[p]["confidence"] for p in pages if p in cleans and cleans[p].get("confidence") is not None]
            chunks.append({
                "id": f"{Path(rel).stem[:30]}#{len(chunks) + 1:04d}", "file": rel, "page_start": cur["page_start"], "page_end": cur["page_end"],
                "doc_type": doc_type, "doc_type_confidence": doc_conf, "section": cur["section"], "text": text, "tokens_est": est_tokens(text),
                "entities": {k: [v.get("value") or v.get("original") for v in vs][:12] for k, vs in ents.items()},
                "confidence": {"min": min(confs) if confs else None, "mean": round(sum(confs) / len(confs), 1) if confs else None},
                "needs_review": sum(len([f for f in cleans[p]["flags"]]) for p in pages if p in cleans),
                "table_ids": [t["id"] for t in tables if set(t["pages"]) & set(pages)],
                "languages": sorted({l for p in pages if p in cleans for l in cleans[p].get("languages", {})}),
            })
        cur = None

    for p in sorted(cleans):
        for unit, is_table in _units(cleans[p]["text"]):
            heading = bool(re.match(r"^[A-Z][A-Z &/,\-()']{5,70}$", unit.strip())) and "\n" not in unit
            t = est_tokens(unit)
            if cur is None:
                cur = new(p)
            if heading and cur["tokens"] >= lo:
                close(); cur = new(p)
            if cur["tokens"] + t > hi and cur["tokens"] >= lo // 2 or (is_table and t > hi and cur["tokens"]):
                close(); cur = new(p)
            if is_table and t > hi:  # oversize table: split at row boundaries, header repeated
                rows = unit.split("\n")
                hdr, rest, group = rows[0], rows[1:], []
                for r in rest:
                    group.append(r)
                    if est_tokens("\n".join([hdr] + group)) >= hi:
                        close(); cur = new(p); cur["parts"].append("\n".join([hdr] + group)); cur["tokens"] = est_tokens(cur["parts"][0])
                        cur["page_end"] = p; cur["table_continued"] = True; close(); group = []
                if group:
                    cur = new(p); cur["parts"].append("\n".join([hdr] + group)); cur["tokens"] = est_tokens(cur["parts"][0]); cur["page_end"] = p; close()
                continue
            cur["parts"].append(unit)
            cur["tokens"] += t
            cur["page_end"] = p
            if cur["tokens"] == t:
                cur["page_start"] = p
                cur["section"] = section_of(p)
    close()
    return chunks


def merged_structured(rel: str, base: dict, cleans: dict[int, dict], doc_type: str, doc_conf: float, typed: dict, tables_checks: list[dict]) -> dict:
    """Keeps the earlier keys and adds per-field provenance: every value carries its page and a confidence
    (the page's OCR confidence, capped at 60 when a validator flagged that field)."""
    flagged = {(f["page"], str(f["value"])) for c in cleans.values() for f in c["flags"]}
    entities: dict[str, list] = {}
    for p, c in sorted(cleans.items()):
        pc = c.get("confidence") or 0.0
        for kind, items in c["entities"].items():
            for it in items:
                val = it.get("value") or it.get("original")
                conf = min(pc, 60.0) if (p, str(val)) in flagged or it.get("valid") is False or ("iso" in it and it["iso"] is None) else pc
                entities.setdefault(kind, []).append(dict(it, source_page=p, confidence=conf))
    fields = {k: dict(v, confidence=(cleans.get(v["page"], {}).get("confidence"))) for k, v in typed.items()}
    return dict(base, document={"file": rel, "doc_type": doc_type, "doc_type_confidence": doc_conf},
                typed_fields=fields, entities=entities, continuity_checks=tables_checks)


def review_markdown(rel_flags: list[dict], title: str = "Review queue") -> str:
    """Every needs_review item, most important first. `rel_flags`: dicts with file, page, field, value, reason, importance."""
    items = sorted(rel_flags, key=lambda f: (-f["importance"], f.get("file", ""), f["page"]))
    L = [f"# {title}", "", f"{len(items)} item(s) need a human look, most important first. Everything not listed passed its validators.", ""]
    if not items:
        return "\n".join(L + ["Nothing flagged."]) + "\n"
    L += ["| # | importance | file | page | field | value | why |", "|---|---|---|---|---|---|---|"]
    for i, f in enumerate(items, 1):
        v = str(f["value"]).replace("|", "/")[:70]
        L.append(f"| {i} | {f['importance']} | {Path(f.get('file', '')).name[:45]} | {f['page']} | {f['field']} | {v} | {f['reason'][:110]} |")
    return "\n".join(L) + "\n"


def page_level_flags(rel: str, pages_dir: Path, total: int) -> list[dict]:
    """Flags from the clean layer plus page-level problems (low confidence, vision-assisted, failed, unreadable)."""
    out = []
    for n in range(1, total + 1):
        raw = tranche.load_raw(pages_dir, n)
        if raw is None:
            out.append({"file": rel, "page": n, "field": "page", "value": "-", "reason": "no output for this page", "importance": 100})
            continue
        if raw.get("status") == "failed":
            out.append({"file": rel, "page": n, "field": "page", "value": "-", "reason": "page failed after retries: " + "; ".join(raw.get("errors", []))[:100], "importance": 100})
        elif raw.get("source") == "blank_or_unreadable":
            out.append({"file": rel, "page": n, "field": "page", "value": "-", "reason": "OCR read nothing from this page (blank or unreadable)", "importance": 80})
        elif raw.get("source") not in ("text_layer",):
            if raw.get("confidence", 100) < 85:
                out.append({"file": rel, "page": n, "field": "page", "value": f"conf {raw['confidence']}", "reason": f"low OCR confidence after escalation level {raw.get('escalation_level', 0)}", "importance": 78})
            if raw.get("source") == "vision_fallback":
                out.append({"file": rel, "page": n, "field": "page", "value": "vision", "reason": "text transcribed by vision LLM, not verified by OCR", "importance": 72})
        cp = tranche.clean_path(pages_dir, n)
        if cp.exists():
            for f in json.loads(cp.read_text(encoding="utf-8"))["flags"]:
                out.append(dict(f, file=rel))
    return out
