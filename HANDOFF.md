# Handoff: where the work stands (2026-11-04)

Free-only project rules: free OpenRouter key (about 50 requests a day), Render free (512 MB, ~0.1 CPU, disk wiped on restart), local OCR. No paid services.
Never guess a value: missing data is flagged, not assumed. Never commit real borrower documents (see "Testing source files" below).

## Already pushed to main
- Eligibility Check tab (above New Borrower Assessment): nine criteria, four outcomes, save/finalize/reassess, Continue is blocked by the server for Incomplete documents and Not eligible.
  Rules: `server/eligibility/defaultRules.json`; shared constants: `src/utils/coreCreditRules.ts`.
  CIBIL 750+/700-749 conditional/<700 not; CMR below 7; TOL/TNW <= 4.00; DSCR strictly > 1.00 = operating cash flow / (principal + EMI x 12); banking turnover >= 80%;
  plus business vintage, annual turnover, profitability, requested amount vs credits. Five other criteria are switched off (kept in the file).
- Document reading: digital PDFs read natively (no OCR); only pages without text go to OCR; xlsx/csv/docx native; GSTR-3B and ITR-V read by rules with no AI;
  annual GST turnover derived only from all 12 months of one FY (always needs review).
- Render memory fixes: heap limit 360 MB in `npm start` and `render.yaml`, one file at a time, memory gate, PDF library warm-up.

## In progress when this note was written (uncommitted, may be partial)
1. Demo data: a fictional demo button on Eligibility Check; the New Assessment demo must also fill section "04. Financial Assessment & Credit Signals". Values consistent between both and a really Conditionally eligible result.
2. Keep uploads/reading results/form in the browser until the Reset button is pressed (and the Eligibility form until "New check"); banner when the server restarted. WIP file: `src/components/documentAi/draftStore.ts`, `useDocumentAiForm.ts`.
3. Why a small PDF filled only ~4 fields: investigate with the three real ZIPs in `Testing source files/` (local only), extend local readers/classifier for: audited + provisional financial statements, CMR, CIBIL, company profile, existing debt profile, credit rating report (CRISIL/CARE/ICRA), purchase and sales ledger. Map only to existing fields.

## Needs your action
- The folder `Testing source files/` (three real company ZIPs, 169 MB) is staged in git. Do NOT commit it: run `git restore --staged "Testing source files"` and add the folder to `.gitignore`.
- Ask: which small PDF filled only 4 fields? (so it can be tested exactly)

## Known limits / open decisions
- Mandatory flags: only CIBIL and DSCR block on their own; CMR, TOL/TNW, banking turnover give Conditionally eligible when failed (one-word change in the rules file).
- The matching engine (`server/ruleEngine.ts`) still has per-purpose thresholds that differ from the five core rules and does not flag missing CIBIL/CMR/TOL-TNW/DSCR/BTO. Left unchanged on purpose.
- AI fallback can fill average monthly banking credits directly (field map allows it); real bank ledgers have no monthly totals.
- Not tested on a real Render instance; `docs/contracts.md` is out of date (derivation rules, server_busy code, 60 s PDF timeout).
- Eligibility Check has no upload box: documents are uploaded on New Borrower Assessment, saved, then prefilled into Eligibility.

## How to check
`npx tsc --noEmit`, then `npm test` (run with OPENROUTER_API_KEY, GEMINI_API_KEY and LLM_PROVIDER unset). Browser checks: Playwright scripts used earlier live outside the repo.
