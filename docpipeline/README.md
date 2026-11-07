# Document extraction pipeline (OCR + NLP + tables + LLM-ready output)

Reads every page of large PDFs, scanned PDFs, images, ZIPs, DOCX and XLSX/CSV; writes text, tables, key fields, RAG
chunks and a review queue, plus a QA report that proves no page was skipped. Originals are only read, never changed.
Everything runs locally. Nothing leaves the machine unless you pass `--vision`.

## Setup (Windows)

```powershell
winget install --id Python.Python.3.12 -e --source winget
winget install --id UB-Mannheim.TesseractOCR -e --source winget
winget install --id QPDF.QPDF -e --source winget          # PDF repair (optional but recommended)
py -3.12 -m pip install -r docpipeline\requirements.txt
```

`docpipeline/tessdata/` must hold `eng`, `hin`, `mar`, `osd` `.traineddata` (tessdata_best:
https://github.com/tesseract-ocr/tessdata_best). PaddleOCR downloads its models once on first use (cached in `~/.paddlex`).

## Run in max-accuracy mode (default profile), overnight, resumable

```powershell
cd docpipeline
python pipeline.py --input "..\Testing source files\Neelam .zip" --output ..\output\max --lang eng+hin+mar --resume --detach
Get-Content ..\output\max\pipeline.console.log -Wait -Tail 20      # watch progress (Ctrl+C stops watching, not the job)
```

`--detach` starts a background process (pid in `pipeline.pid`, log in `pipeline.console.log`). Stop it any time
(`Stop-Process -Id <pid>`); run the same command again and `--resume` continues from the last finished page.
One progress line per tranche: `tranche k/total | pages a-b | conf | flags | elapsed | ETA`.

Validate and look at three random pages (image | raw OCR | clean text):

```powershell
python validate.py --output ..\output\max --spotcheck 3
python -m unittest discover tests            # 30+ unit tests (merge, NLP, tranche, chunks, ladder)
```

## Profiles and flags

| flag | meaning |
|---|---|
| `--profile max` (default) | 400 DPI (500 when the median letter height is small), 4 preprocessing variants (gray, adaptive threshold, denoised+sharpened, 1.5x upscale), Tesseract psm 6+4+11 on each, PaddleOCR on every scanned page, region-level merge, escalation ladder |
| `--profile fast` | the original single pass: 300 DPI, Paddle mobile + Tesseract |
| `--mode sequential` (default) / `batch` | one file at a time in tranches, strictly in order / one global page queue |
| `--tranche-size N` | pages per tranche (10). After each tranche every page must have output or it is re-run (3 passes) |
| `--workers N` | default auto: min(cpu-1, (free RAM - 2 GB) / 1.2 GB); the choice is printed |
| `--det-limit N` | Paddle detection max side in px (default 2560; `0` = full resolution, about 2x slower, +0.2 point) |
| `--paddle-model medium\|mobile\|server` | default medium (max) / mobile (fast). `server` (PP-OCRv4 server) is available but crashed natively above ~2400 px and ran ~450 s/page on the 8 GB test machine |
| `--vision` | ladder level 3: pages still under the threshold are sent to a free OpenRouter vision model and labelled `vision_fallback` (uploads page images, off by default) |
| `--quality N` | escalation threshold on the page quality score (85) |
| others | `--force-ocr`, `--only <regex>`, `--password`, `--passwords file.json`, `--huge-mb/--split-pages` (PDFs above 100 MB are split into 20-page parts), `--limit-pages`, `--inventory-only` |

## How a page is read

1. Text layer first (PyMuPDF). Good layer = enough characters and not garbage; then no OCR.
2. Scanned page, max profile: rasterize, auto-rotate (OSD plus a 4-rotation reading check), deskew, flatten background,
   denoise, CLAHE. Read as 4 image variants x 3 Tesseract page-segmentation modes (eng+hin+mar) plus PaddleOCR.
3. **Merge (`merge.py`)**: all readings are clustered by bounding-box overlap; each region has exactly one winning
   reading (confidence + valid-token share, with a coverage penalty). Text of two readings is never concatenated.
   A dedupe pass removes echoed words (`Fund Based Limits  Based Limits`), never touches numeric tokens, and digits are never
   altered by any merge/cleanup step (unit-tested).
4. **Escalation ladder (`escalate.py`)**: quality score = confidence, valid-token %, garbage ratio, expected-field
   completeness (e.g. "GSTIN" present but no valid GSTIN). Under the threshold: L1 higher DPI + other variants; L2 other
   psm/language sets and horizontal bands read separately; L3 vision (only with `--vision`). Final level per page is in
   the log, the page JSON and `qa_report.md`. Unreadable lines stay `[ILLEGIBLE p<N>]`.
5. **NLP layer (`nlp.py`)** produces `page_XXXX.clean.json` and leaves `page_XXXX.raw.json` untouched: confusable
   fixes (O/0, l/1, S/5, B/8) only inside tokens shaped like PAN/GSTIN/IFSC/amounts/account numbers and only when the
   validator then passes (GSTIN checksum); dictionary fixes only at low OCR confidence with a unique one-edit candidate and
   never in tokens containing digits; Devanagari NFC + safe matra fixes; per-line language (eng/hin/mar); entities (GSTIN,
   PAN, IFSC, CIN, DIN, accounts, dates->ISO with original kept, amounts incl. Cr/Lakh, %, phone, email, company, bank,
   address); validators (-> `needs_review`, never silently fixed); document type with confidence and a type-specific field
   extractor; header/footer split and column-aware reading order.

## Output per input file (`<output>/files/<name>_<hash>/`)

`full_text.md` (clean, `--- Page N ---` markers) and `full_text.raw.md` · `pages/page_XXXX.raw.json|.clean.json` ·
`tables/*.csv|json` (multi-page tables stitched, with `row_pages`) · `structured_data.json` (every field has source page and
confidence) · `chunks.jsonl` (500-800 token chunks cut at headings, tables never split mid-table) · `sections.json` ·
`review_queue.md` · `tranche_XXX_summary.json` · `qa_report.md`.
Run level: `summary.md`, `review_queue.md` (all files, most important first), `continuity_report.json` (closing balance of
one statement vs opening balance of the next), `qa_summary.json`, `inventory.json`, `pipeline.log.jsonl`, `spotcheck/`.

## Known limitations

- Ghostscript is not on winget, so image-PDF compression is not done.
- Paddle runs the Latin/English model; Devanagari is read by Tesseract (hin/mar).
- Borderless scanned tables may come back as text rows rather than a grid.
- Tiny print can still be misread (e.g. `8-39` for `B-39` in a 6 pt footer); such values are not auto-corrected.
- Handwriting is read opportunistically and is the first thing to verify in `review_queue.md`.
- Max profile is slow on a CPU-only 8 GB machine (minutes per scanned page); that is why it is resumable.
