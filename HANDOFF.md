# Update 2026-11-06: document reading rebuilt as local, proved readers

Why extraction "did nothing" before: with no free LLM quota, bank statements gave no monthly totals, Schedule III statements gave 2 fields,
CIBIL print-outs (every glyph repeated 4x) were classed "other", the lender/EMI sheet was "other", and any PDF with an /Encrypt mark was
refused even when it opens freely (the CMR report). Now, with NO AI at all, the real "Neelam" ZIP (146 files, 131 MB) reads in about 1 minute.
New readers (server/documentAi): bankStatements.ts (every row proved by the running balance, checked against printed totals, capped SBI
statements marked partial, split-month fragments stitched in derive.ts), financialStatements.ts (Schedule III, lakh/crore, current vs
previous year, sums proved against printed totals), creditReports.ts (CIBIL consumer, commercial CMR report, 4x-glyph collapse),
debtObligations.ts (EMI sheet total, sanction letters), companyIdentity.ts (CIN -> entity type, incorporation date).
`reconciled` = computed from printed figures and proved by arithmetic (skips the printed-figure check). Derived vintage / profitability /
bank average now auto-apply when their inputs are clean; GST annual turnover stays review-only.
Local test harness idea: run the pipeline on the ZIP with DOCUMENT_AI_LLM_FALLBACK=off.
Known open points: two directors' CIBIL scores conflict (user picks the promoter); multi-account bank average includes own-account transfers
(kept at 0.8, review); DSCR needs annual principal repayments (not derivable from an EMI sheet, entered by the user); scanned FY23-24/24-25
statements only read via OCR (first 5 pages); not browser-tested in this session.

# Handoff (updated 2026-11-04, stopped because of the weekly usage limit)

Rules for this project: FREE only (free OpenRouter key ~50 requests/day, Render free 512 MB / ~0.1 CPU / disk wiped on restart, local OCR). No paid services.
Never guess a value: missing data is flagged, not assumed. NEVER commit real borrower documents.

## DONE and on `main` (deployed by Render)
- Eligibility Check tab (above New Borrower Assessment). Nine criteria, four outcomes, save / finalize / reassess, server blocks Continue for Incomplete documents and Not eligible.
  Rules: `server/eligibility/defaultRules.json`, shared constants `src/utils/coreCreditRules.ts`.
  CIBIL 750+ eligible / 700-749 conditional / <700 not; CMR below 7; TOL/TNW <= 4.00; DSCR strictly > 1.00 = operating cash flow / (principal + EMI x 12); banking turnover >= 80%;
  plus business vintage, annual turnover, profitability, requested amount vs credits. Five other criteria are switched off (kept in the file).
- Document reading: digital PDFs native (no OCR); only pages without text go to OCR; xlsx/csv/docx native; GSTR-3B and ITR-V read by rules with no AI;
  annual GST turnover derived only from all 12 months of one FY (always needs review).
- Render memory fixes: 360 MB heap in `npm start` and `render.yaml`, one file at a time, memory gate, PDF library warm-up, AI circuit breaker, "server busy" error.

## NOT DONE (unfinished code is saved on branch `wip/demo-data-and-report-readers`, NOT on main)
1. Demo data
   - Fictional demo button on Eligibility Check: file `src/components/eligibility/demoData.ts` + `EligibilityModule.tsx` (started, not verified in a browser).
   - New Assessment demo must also fill section "04. Financial Assessment & Credit Signals" (`NewAssessmentModule.tsx`, not verified).
   - Test file `tests/demo-data.test.ts` exists but is NOT in the package.json test list.
2. Keep uploads / reading results / form in the browser until Reset is pressed (and the Eligibility form until "New check"), with a banner when the server restarted.
   Started: `src/components/documentAi/draftStore.ts`, `useDocumentAiForm.ts`. Not finished, not browser-tested.
3. Reading the user's real documents better (why a small PDF filled only ~4 fields):
   - New reader for the "Business Credit Triangulation Report" (the user's other tool's report): `server/documentAi/creditAnalysisReport.ts`, plus changes in `localClassifier.ts`, `localExtractors.ts`, `merge.ts`, `pipeline.ts`, `prompt.ts`, `src/documentAi/fieldMap.ts`, `src/types/documentAi.ts`.
   - Layout: three year columns FY2024 | FY2025 | FY2026 (FY2026 provisional): read by column header, FY2026 = current, the others previous. "N/A" stays missing (operating cash flow is N/A). Printed policy thresholds ("Minimum 750 or above") are not values. Report DSCR (1.97x, provisional, different method) goes only to a stated-DSCR field as needs-verification.
   - Still to cover: audited and provisional financial statements, CMR, CIBIL, company profile, existing debt profile, CRISIL/CARE/ICRA rating, purchase and sales ledger.
   - Test file `tests/document-intelligence.test.ts` exists, NOT in the test list. Status when stopped: 25 of 26 pass; failing test: "splits a horizontal (T-form) account into its two sides".
   - `npx tsc --noEmit` passes on the WIP branch.
4. Open decisions: make CMR / TOL-TNW / banking turnover mandatory (they only give Conditionally eligible when failed); align the matching engine `server/ruleEngine.ts` per-purpose thresholds with the five core rules (left unchanged on purpose); block the AI from filling average monthly banking credits directly.

## How to continue
`git switch wip/demo-data-and-report-readers`, then: register the two test files in package.json, fix the failing T-form test, run `npx tsc --noEmit` and `npm test` (with OPENROUTER_API_KEY, GEMINI_API_KEY, LLM_PROVIDER unset), check the demo buttons and keep-until-Reset in a browser, then merge into main.
Test the report reader on the user's real file `Downloads\Royal_Enterprises_Triangulation_Report (2).pdf` locally only (never copy values into the repo).

## Needs your action
- The folder `Testing source files/` (three real company ZIPs, 169 MB) is staged in git. Do NOT commit it: run `git restore --staged "Testing source files"` and add the folder to `.gitignore`.
- `docs/contracts.md` is out of date (derivation rules, server_busy code, 60 s PDF timeout).
