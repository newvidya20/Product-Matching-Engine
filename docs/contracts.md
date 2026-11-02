# Document AI contracts

Binding for every engineer. Where this refines `PLAN.md`, this file wins. Shared code:
`src/types/documentAi.ts` and `src/documentAi/fieldMap.ts`. If a contract is wrong or missing, report it to
the orchestrator; do not work around it or edit another role's file.

Terms: a **session** is the set of documents for one assessment, and exists before the assessment does.
A **candidate** (`ExtractedField`) is one value read from one place. A **field result** (`FieldResult`) is
the merged view across candidates, and is what the form consumes.

## 1. File ownership

No file has two owners. This replaces the `PLAN.md` list.

| Role | Files |
|---|---|
| architect | `docs/contracts.md`, `src/types/documentAi.ts`, `src/documentAi/fieldMap.ts`. Already done: `documentSessionId?` in `src/types/domain.ts`, and the `server/documentAi/pipeline.ts` stub, which passes to extraction-engineer. |
| extraction-engineer | `server/documentAi/pipeline.ts`, `gemini.ts`, `prompt.ts`, `validators.ts`, `merge.ts`, `derive.ts`, `spreadsheet.ts` (all in `server/documentAi/`) |
| storage-engineer | `server/documentAi/router.ts`, `auth.ts`, `store.ts`, `jobs.ts`, `fileValidation.ts`, `activity.ts`, `retention.ts`; `server.ts`; `server/googleSheetsClient.ts`; `server/storage.ts`; `src/modules/AssessmentHistoryModule.tsx`; `src/context/AppStateContext.tsx`; `.env.example`; `render.yaml` |
| ui-builder | `src/components/documentAi/*`, `src/api/documentAiClient.ts`, `src/modules/NewAssessmentModule.tsx`, `src/modules/SettingsModule.tsx` |
| test-writer | `tests/`, `package.json` (test script only) |

Do not touch: `src/types/domain.ts`, `src/api/client.ts`, `server/pdfExtractionService.ts`,
`src/utils/financialMetrics.ts`. `server/documentAi/spreadsheet.ts` uses JSZip directly, because the existing
parser is private and drops sheet names and cell references.

**Merge order:** storage-engineer, extraction-engineer, ui-builder, test-writer. Until storage merges, ui-builder
may see tsc errors only for `editingAssessmentId` and `openAssessmentForEdit`, both defined in section 8.

Engineers must not add runtime dependencies. The runtime is Node 22: `engines.node` in `package.json` is `22.x`, and
`pdfjs-dist` itself needs 22.13 or later.

## 2. Pipeline and routes seam

`server/documentAi/pipeline.ts` exports exactly these. Types are in `src/types/documentAi.ts`.

```ts
export function extractDocument(input: ExtractDocumentInput): Promise<DocumentExtractionResult>;
export function mergeSessionResults(input: MergeSessionInput): MergeSessionOutput;
export function readSpreadsheetPreview(bytes: Uint8Array, kind: 'xlsx' | 'csv'): Promise<SpreadsheetPreview>;
```

- `extractDocument` handles one file. Document failures return `{ ok: false, errorCode }`. It rejects only if
  `signal` aborts, and `jobs.ts` records that as `llm_timeout`. It does no storage or logging of content. Outside it,
  `readPdfSource` logs one fixed code when a PDF cannot be read: `pdf_read_timeout`, `pdf_engine_failed` (pdf.js would not
  load, a server fault) or `pdf_bad_document`. The error's own text is never logged, as it can quote the document.
- `mergeSessionResults` is pure: no I/O, no clock, no env. Call it after every job, delete, type override and
  `PUT .../edits`, and after a threshold change. Pass successful results of all documents whose result still exists,
  oldest upload first: array order is what "latest upload" means in section 4.4.
- **Merge is the enforcement point.** `mergeSessionResults` itself applies every rule in section 4.2, so nothing reaches
  `auto_applied` by any path. A candidate's input `status` and `reasons` are placeholders that merge recomputes, except
  `ambiguous_unit`, which is preserved because it depends on the stated unit. `value: null` on input means the value
  failed to parse, and stays rejected. `buildCandidates` normalises values and may set provisional statuses.
- Merge is pure and never holds document text, so the check against source text runs once, in `buildCandidates`, while
  the file is in memory. Its outcome is stored as `sourceCheck` (with `rowLabel` and `sourceSign`), and merge caps on them.
- `jobs.ts` owns queueing, concurrency, the per-file timeout and persistence. `gemini.ts` owns retries, and the timeout of
  each attempt. Up to 4 attempts per call, 90 seconds each, on 429, 503, 408, 504 and an attempt that times out. Backoff is
  capped exponential with equal jitter: 1-2 s, 2-4 s, 4-8 s. The SDK is set to no retries (`retryOptions: { attempts: 1 }`),
  so there is one retry loop, and the job's signal stops it at once. Exhausted retries give `llm_rate_limited` or
  `llm_timeout`, and the client offers Retry for both. **The retry budget can exceed the file budget:** one call can reach
  374 seconds (4 × 90 s, plus up to 14 s of backoff), and a file makes up to two calls, while `jobs.ts` allows a file 300
  seconds. A file can therefore end in `llm_timeout` at 300 seconds, before its retries run out. That code is retryable.
- Validators live in `server/documentAi/validators.ts` with the signatures in section 6.

## 3. Extracted field JSON

Candidate (`ExtractedField`):

```json
{
  "candidateId": "doc_1f0c...:financialProfile.netProfitAfterTax:0",
  "fieldId": "financialProfile.netProfitAfterTax",
  "value": -1250000,
  "rawValue": "(12.50)",
  "confidence": 0.93,
  "source": {
    "documentId": "doc_1f0c...",
    "fileName": "balance-sheet-fy25.pdf",
    "documentType": "financial_statement",
    "page": 7,
    "sheetName": null,
    "cellRef": null,
    "snippet": "Profit / (Loss) after tax (12.50)   8.40"
  },
  "status": "auto_applied",
  "reasons": [],
  "period": "FY 2024-25",
  "subjectRef": null,
  "statedUnit": "lakh",
  "unitText": "(Rs. in lakhs)",
  "sourceCheck": "verified",
  "rowLabel": "Profit / (Loss) after tax | (12.50) | 8.40"
}
```

- `value`: number or string, normalised by the validators. The server normalises; the model never does arithmetic
  or unit conversion. `0` is a real value. Absent means no candidate at all, never `null`, `""`, `0` or `"N/A"`.
- `value` is `null` only under `rejected_validation`. `rawValue` then shows what was read.
- `confidence`: 0 to 1, from the model, rounded to 2 places. It is uncalibrated, which is why section 4.2 adds
  deterministic checks. Derived values take the lowest confidence among their inputs.
- `source`: `page` is 1-based and PDF-only. Spreadsheets set `sheetName` and `cellRef`. CSV sets
  `cellRef: "row:<n>"`. Images set all three to null. `snippet` is verbatim and at most 300 characters.
- `status`: one of `auto_applied`, `needs_verification`, `conflict`, `rejected_validation`.
- `statedUnit`, `unitText`: the model's reading of the table or page header, and that header quoted verbatim.
- `sourceCheck`: `verified`, `failed` or `no_text`, set by the server against text it read itself (section 4.2). Absent
  reads as `no_text`.
- `rowLabel`: for `signed` and currency fields, the text the server read in the value's row or printed line, at most 300
  characters. For a spreadsheet, the row's label cells and any negative figures.
- `sourceSign`: a negative the server read at the value, kept apart from `rowLabel` so that the 300 character cut cannot
  lose it. `negative_figure`: the spreadsheet cell holding the value is negative. `negative_in_row`: another figure in its
  row or printed line is. Absent when it read none.

Field result (`FieldResult`) adds `candidates`, `suggestedCandidateId`, `mirrorOf` and `overriddenByUser`.

| Status | Written to form? | UI label | User actions |
|---|---|---|---|
| `auto_applied` | Yes, unless edited | Auto-filled | Edit |
| `needs_verification` | **No**. Shown as a suggestion by the field | Please verify | Accept, or type |
| `conflict` | **No**. Values side by side | Conflict | Pick one, or type |
| `rejected_validation` | **No** | Please verify (invalid value) | Type only; no one-click accept |

## 4. Decision rules

### 4.1 Thresholds

| Name | Value |
|---|---|
| Auto-apply threshold | Setting. Default 0.85, range 0.70 to 0.99, inclusive |
| Discard | Below 0.50: dropped, counted in `droppedLowConfidence`, not stored |

### 4.2 Status of one candidate

Evaluate top to bottom; the first match wins. `reasons` collects every condition that applies.

1. Unknown `fieldId`, `extractable: false`, or `extractionMode` other than `direct`: **drop silently**. The exception is
   a candidate carrying a `derivation` whose rule is the one its field names: it stays, and takes `derived_value`.
2. Confidence below 0.50: **drop** and count.
3. Validator fails, or value outside `allowedValues`, `min`/`max`, or the `signPolicy`, or non-INR currency:
   `rejected_validation`.
4. Any of these: `needs_verification`.
   - Confidence below the threshold (`low_confidence`).
   - The value is not found in `snippet` (`value_not_in_snippet`). Compare `rawValue` when present, otherwise the value,
     because a scaled value is not what the page prints: -1250000 from `(12.50)` in lakh matches a snippet showing
     `(12.50)`. Digits only for numbers, after stripping separators, as whole numbers keeping the decimal point, so `1.25`
     is not found in `12.5`; case-folded for strings. For enums, the check is that the snippet is non-empty. Derived values
     are exempt, as they take `derived_value` anyway.
   - The candidate fails the check against text the server read itself (`not_in_source`). See "Source text check" below.
   - An enum that is `explicit_request` or `alwaysReview` (`enum_review_required`), which is every enum `explicit_request`
     field, plus `gstComplianceStatus`, and `gstTaxCompliant` through it. Any other enum whose snippet has none of the
     evidence keywords the field map defines for that option (`enum_no_evidence`). An option with no keywords cannot
     auto-apply. `entityType` from a registration document is the expected auto-apply case.
   - A `signed` field with a positive value whose snippet or `rowLabel` says loss, deficit, negative, shortfall or similar
     (`loss_wording`). The name of a statement ("Statement of Profit and Loss") does not count. A row label does, with one
     exemption: the neutral `Profit / (Loss)` or `(Loss) / Profit` label, only when neither the snippet nor the row text the
     server read holds a bracketed or minus-signed figure, in any column. Otherwise the row takes `loss_wording`, so on
     `Profit / (Loss) after tax (12.50) 8.40` both a positive 12.50 and the positive 8.40 are capped, and `(12.50)` read as
     negative is not. In a spreadsheet the sign is also compared with the parsed cell: a positive value from a cell holding
     `-1250000` or `(12.50)` takes `loss_wording`, whatever the row is called. An unbracketed loss on a neutral row is an
     accepted residual, section 13.
   - A unit that does not agree (`unit_mismatch`) or is not INR (`non_inr_unit`), section 6.3.
   - An `annualFlow` field with a part-year period or wording (`part_year_period`), section 4.3.
   - The document type is not in `sourceDocumentTypes`, including `other` (`unexpected_source_type`).
   - The document was flagged `injectionSuspected`, or fails the identity check in section 4.4
     (`injection_suspected`, `identity_mismatch`).
   - A `periodScoped` field has `period: null` (`period_unknown`).
   - An ambiguous unit (`ambiguous_unit`, section 6.3).
   - It is a derived value or a mirror fallback (`derived_value`, `fallback_source`).
5. `review_only` target: `needs_verification`.
6. Otherwise: `auto_applied`.

**Source text check.** `buildCandidates` compares each candidate with text the server read itself, never with the model's
own snippet:

| File | What the server reads | A candidate fails when |
|---|---|---|
| `xlsx`, `csv` | Parsed visible cells. Hidden sheets, rows (including zero height) and columns are excluded, and do not reach the model | `rawValue` is in no visible cell, preferring the cited cell. For an enum, its evidence keyword is in no cell |
| Digital `pdf` | The text layer, via `pdfjs-dist`. Digital means at least 50 non-space characters | Any digits of `snippet` or `rawValue` are absent. A string's `rawValue`, or an enum's evidence keyword, is absent. An inline unit differs from the unit printed beside that figure |
| A PDF that will not parse, or takes over 20 seconds | Nothing | Always. A file must not escape the check by breaking the parser. The pdf.js task is destroyed on timeout |
| Scanned `pdf`, images | Nothing | Never: `no_text`. See section 12 |

`unitText` must also be in the source where a source exists. A failure gives `not_in_source` and caps at
`needs_verification`. A bank month whose figure fails against text the server read is dropped. On a PDF the server could
not read there is nothing to fail against, so its months are kept with `sourceCheck: 'failed'`, and an average worked out
from them carries `not_in_source`, which tells the reviewer why. Fewer than 3 months derive nothing, as on any other file.

**Never guess.** If a document does not state a value, there is no candidate. The prompt says so, and the server
enforces it by rules 1 and 4. `review_only` values appear in the Review panel only.

`explicit_request` fields (`requestedAmount`, `requestedTenureMonths`, `fundingPurpose`, `statedPurpose`, all
`dynamicPurposeAnswers.*`): the model must return them only when the document states the borrower's own request in
words; the snippet must show it. Allowed sources are in the field map, which therefore lists no `credit_report` or
`cma_projection` for them: neither states a request in words. They are never inferred from turnover, an existing
facility, or a document's general theme. An `existing_sanction_letter` is about an existing facility and
never supplies `requestedAmount`: `buildCandidates` drops an `explicit_request` candidate from a source not listed, and
merge caps any that arrives by another path with `unexpected_source_type`. If stated and clean, the non-enum ones auto-apply
like any other field. The enum ones are always `needs_verification` (`enum_review_required`).

`positive_only` fields: a document can establish "yes"/"available". Absence never produces "no".

### 4.3 Conflicts

Group candidates by field after the checks above. `rejected_validation` candidates stay listed but do not take part.

Comparison group: for `periodScoped` fields, the same normalised `period`. Different periods are **not** a conflict:
the latest period is chosen, and older candidates are kept with `superseded_period`. An older statement's
`annualRevenue` for exactly the prior year becomes a candidate for `previousAnnualRevenue`.

**Part-year figures.** `annualFlow` fields (revenue, previous revenue, GST turnover, PAT, EBITDA, EBIT, depreciation,
amortization, interest expense, operating cash flow, scheduled principal repayments) need a full-FY period label. A date
other than 31 March, or part-year wording in the snippet or unit text (six months ended, Q2, H1, half year, YTD, quarter
ended and the like), takes `part_year_period`, even if the model labelled it FY. A range or other period text normalises to
`null` and takes `period_unknown`. A bare 31 March stays that FY, because statements head columns that way; a quarter ended 31
March is caught only by its wording. A part-year candidate never beats a full-year one, however late: it is listed with
`superseded_period`, and does not cap the full-year result. It feeds neither `previousAnnualRevenue`, the turnover
cross-check, nor `profitabilityStatus`. If no full-year candidate exists, it remains as `needs_verification`. Balance-sheet
fields keep point-in-time dates.

Equality:

| Value type | Equal when |
|---|---|
| Currency | `abs(a - b) <= max(1, 0.005 * max(abs(a), abs(b)))`. Example: 1,00,00,000 and 1,00,40,000 agree; 1,00,00,000 and 1,00,60,000 conflict |
| Score, rank, months, days, percent, count, years | Exactly equal |
| Enum | Exactly equal |
| Strings | Equal after NFKC, case-fold, removal of punctuation and extra spaces, and mapping `pvt`→`private`, `ltd`→`limited`, `&`→`and` |
| Dates, FY | Equal after normalisation |

Within tolerance, candidates agree. The result takes the most precise value (most significant digits), breaking ties
by section 4.4, and the highest of the agreeing confidences.

If any two eligible candidates in the group differ, the field is `conflict`: `value: null`, every candidate listed,
`reasons: ['values_differ']`. This applies inside a single document too. Conflicts are **never** auto-resolved. If
any candidate in a group is `needs_verification` and all agree, the result is `needs_verification`.

Different `subjectRef` (two bank accounts, two promoters' reports) is not a conflict, and is never added up. The field
is `needs_verification` with `multiple_subjects` and all candidates listed.

**Turnover cross-check.** `annualTurnoverOrIncome` compares `financialProfile.annualRevenue` with
`financialProfile.gstAnnualTurnover` in the same period, with the currency tolerance. A difference makes
`annualTurnoverOrIncome` a `conflict`, while the two source fields keep their own results.

### 4.4 Precedence and identity

Precedence only sets `suggestedCandidateId`, displayed as "Suggested source". It never applies a value.

| Field group | Order, strongest first |
|---|---|
| Turnover, revenue, P&L, balance sheet | Audited `financial_statement` (`dataSource: audited`), `itr`, `gst_return`, provisional then management `financial_statement`, `loan_application` |
| Identity, name, entity, dates | `registration_certificate`, `gst_certificate`, `pan_card`, `itr`, `financial_statement`, then others |
| Bureau | `credit_report` with the latest report date |
| Facilities | `existing_sanction_letter`, `bank_statement`, `credit_report`, `loan_application` |
| Anything else | Highest confidence; ties broken by latest upload |

`cma_projection` is never a source for historical figures. Any period ending after `today` is rejected.
`bank_statement` credits are never turnover.

Identity check: the 10 characters at GSTIN positions 3 to 12 are its PAN. Two identities mismatch when two GSTINs embed
different PANs, or when a non-individual PAN (fourth character not `P`) differs from a GSTIN's embedded PAN. Every
candidate from the minority documents gets `identity_mismatch`; with no majority, all of them do. Add a
`SessionWarning`. A `pan_card` with fourth character `P` may be a promoter's in a company file, so it does not trigger
the check and, when any non-`P` identity is in the session, does not supply `applicantLabel`.

### 4.5 Duplicates and derived values

Mirrors are decided in the field map. Only the primary is asked of the model. The merge copies its result to the mirror
with `mirrorOf` set. Each field has its own edited state: editing one does not edit the other.

| Mirror (top-level, used by rule engine) | Primary | Fallback (capped at `needs_verification`) |
|---|---|---|
| `annualTurnoverOrIncome` | `financialProfile.annualRevenue` | `financialProfile.gstAnnualTurnover` |
| `creditScore` | `financialProfile.personalCibilScore` | `financialProfile.promoterCibilScore` |
| `existingEmiObligations` | `financialProfile.existingMonthlyEmi` | none |

- `commercialCmrRank` is a 1 to 10 rank, not a score. It never feeds `creditScore`.
- For a company, a report on an individual feeds `promoterCibilScore`. For `individual` or `proprietorship`, or
  when no entity type is established, it feeds `personalCibilScore`.
- `gstTaxCompliant` from `gstComplianceStatus`: `compliant`→`yes`; `not_compliant` and `not_applicable`→`no`;
  `not_provided` produces nothing. It keeps the source status (`gst_compliance_mirror`), which is always
  `needs_verification`.

Derivations run in `derive.ts`. Each uses stated inputs only, and is always `needs_verification`.
If a direct candidate exists, it wins and the derived value is not produced.

| Rule | Output | Inputs and method |
|---|---|---|
| `vintage_from_establishment_date` | `businessVintageYears` | Full years from `identity.dateOfEstablishment` to `today`, rounded down to the nearest 0.5 |
| `profitability_from_pat` | `profitabilityStatus` | Latest PAT < 0: `loss_making`. Latest = 0: `breakeven_or_early`. Latest > 0 and previous FY PAT > 0: `profitable_2plus_years`. Latest > 0 otherwise: `profitable_1_year`. Nothing is derived if an input has `loss_wording`. Part-year PAT is not an input |
| `average_monthly_from_bank_table` | `averageMonthlyBankingCredits`, `averageMonthlyBankingBalance` | Mean of `bankMonthlyTotals` for one `subjectRef`, needing 3 or more distinct months. Rounded to the rupee |

### 4.6 Required fields cannot always autofill

`applicantLabel`, `fundingPurpose`, `requestedAmount` and `requestedTenureMonths` are required. The last three are the
borrower's request, not borrower data. GST, bank, balance sheet and PAN files do not state them, so they stay at blank
or default, and the Review panel shows a **Still needed** list from `REQUIRED_FIELDS`. A default is not an answer:
`requestedTenureMonths` keeps 36 and `fundingPurpose` keeps `working_capital` until a document or a person supplies them,
and both appear in **Still needed** until then.

Submit with unresolved conflicts or verifications: warn inline and require a second click. Save Draft never blocks on these.

### 4.7 Zero and negatives

`signPolicy` in the field map decides:

| Policy | Fields | Behaviour |
|---|---|---|
| `signed` | PAT, EBITDA, EBIT, tangible net worth, shareholders' equity, operating cash flow, average bank balance | Negatives are real and must survive to the saved record |
| `expense_magnitude` | Depreciation, amortization, interest expense | Statements print these in parentheses; store the magnitude |
| `non_negative` | All else | A negative is `rejected_validation` |

ui-builder must:

- Replace every `Number(x) || null`, in `buildFinancialProfile` and in `onChange`, with `parseNumericInput` from the
  field map. `0` stays `0`, blank stays `null`.
- Drop `min="0"` for `signed` fields. Drive `min` from the definition.
- Keep text during typing so `-` is not destroyed. Use `updateFinancialField` with the string and parse on save, or
  an equivalent.

`Number(form.annualTurnoverOrIncome) || 0` and the matching server line remain; turnover is `non_negative` and `0`
means unknown there. The rule engine reads top-level fields, so a blank must not be presented as a value.

## 5. Edited fields

**Rule: a field the user edited is never overwritten by Document AI.** No exception, including re-extraction and new
uploads. The new value appears in the Review panel with `overriddenByUser: true` and a **Use document value** action.

`SessionEdits` tracks two maps by field ID, with no values:

- `editedFields`: fields a person owns. Added on any change to a field, including clearing it (`cleared`), on
  accepting a suggestion (`accepted_document_value`), on resolving a conflict (`resolved_conflict`), on loading the
  demo sample (`demo_sample`, for each field it sets), and on reopen (`preexisting_value`, section 8).
- `appliedFields`: fields Document AI wrote, and the candidate. Used to revert and to clear.

Tracking is client-first. `editedFieldsRef` updates **synchronously inside the change handler**, before any network
call, so a poll landing mid-keystroke cannot overwrite. `PUT .../edits` follows, debounced 500 ms and retried. The client's
view is authoritative for writing to the form. The server's copy drives `overriddenByUser` and survives reloads.
On save, the client flushes pending edits first.

`applyFieldResults` in `src/components/documentAi/` is a pure function, applied after each hydrate:

```
fundingPurpose first, then collateralAvailable, then the rest. For each field result:
  skip review_only
  skip dynamic fields whose purpose differs from form.fundingPurpose (they remain in Review)
  if fieldId in editedFields: do not write
  else if status is auto_applied: write toFormValue(), record in appliedFields
  else if fieldId in appliedFields: revert to defaultValue, remove from appliedFields
```

So a value auto-applied from document A, and now contradicted by document B, returns to default and shows as a conflict.
Details:

- If `fundingPurpose` changes, the existing handler clears `dynamicPurposeAnswers`; also drop edited and applied entries
  for the old purpose's dynamic fields, then re-run apply.
- Any auto-applied `collateralType`, `collateralValue` or `collateralDescription` also sets `collateralAvailable` to `yes`,
  unless that is in `editedFields`. In that case hold them unwritten, since those inputs are disabled.
- **Reset** starts a new session ID and empties both maps. The old session stays until the unlinked TTL.
- Removing an edit happens only through **Use document value**, which is itself recorded as `accepted_document_value`.
- Treat a value equal to `defaultValue` as not provided only for autofill. Never infer "edited" from a value differing.

## 6. Validators

`server/documentAi/validators.ts`, extraction-engineer. All are pure and never throw.

```ts
type Validated<T> = { ok: true; value: T } | { ok: false; code: string };
validatePan(raw: string): Validated<string>;
validateGstin(raw: string): Validated<string>;
parseIndianAmount(raw: string, ctx: { statedUnit?: AmountUnit | null; documentType: DocumentType; amountNature?: 'limit' }):
  { ok: true; value: number; ambiguousUnit: boolean; inlineUnit: AmountUnit | null } | { ok: false; code: string };
parseDate(raw: string, ctx: { today: string; allowFuture?: boolean }): Validated<string>; // YYYY-MM-DD
normalizeFinancialYear(raw: string): Validated<string>;                                    // 'FY 2024-25'
parsePercent(raw: string): Validated<number>;
type AmountUnit = 'rupees' | 'thousand' | 'lakh' | 'crore' | 'million';
```

### 6.1 PAN

Upper-case and strip spaces. Must match `^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$`. The fourth character is the holder
type: P individual, C company, F firm or LLP, H HUF, A AOP, T trust, B BOI, L local authority, J artificial juridical
person, G government. It does not establish `entityType`: F covers partnership and LLP, C covers private and public.

### 6.2 GSTIN

Upper-case and strip spaces. Must be 15 characters matching `^[0-9]{2}[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`.
State code in 01 to 38, or 97, or 99. Characters 3 to 12 must pass the PAN check. Checksum, with alphabet
`0-9` then `A-Z` (values 0 to 35):

```
sum = 0
for i in 0..13 (left to right):
  p = value(char[i]) * (i odd ? 2 : 1)
  sum += floor(p / 36) + (p % 36)
check = alphabet[(36 - (sum % 36)) % 36]   // must equal char[14]
```

Test vectors: `27AAPFU0939F1ZV` and `29AAGCB7383J1Z4` are valid. `27ABCDE1234F1Z5` fails (expected `0`).

### 6.3 Indian currency

The model returns `rawValue` verbatim and, separately, `statedUnit` from a header such as "Rs. in lakhs", with that header
quoted in `unitText`. The server multiplies. Order:

1. Trim. Strip `₹`, `Rs`, `Rs.`, `INR`, `Re.`, and trailing `/-`, in any case. Any other currency mark (`$`, `USD`, `EUR`)
   fails with `non_inr_currency`.
2. Negatives: `(1,234)`, `-1,234`, `1,234-`. All mean negative. In `bank_statement` only, a trailing `Dr` means negative.
3. A trailing `Cr`/`CR` on a balance or transaction amount in `bank_statement` is the **credit marker**, not crore: strip
   it, no multiplier. On a limit (`amountNature: 'limit'`, such as `ccOdSanctionedLimit`) and elsewhere, `Cr`, `Crs`, `Crore(s)`
   mean crore.
4. Inline unit: `L`, `Lac(s)`, `Lakh(s)` → 1e5; `Cr...` → 1e7; `Mn`, `Million` → 1e6; `K`, `Thousand` → 1e3.
5. Number: digits with `,` in any grouping (`12,50,000` or `1,250,000`), and at most one `.`. No other characters.
   Reject `1.250.000`, `12,5`, ranges and words.
6. Multiplier: an inline unit beats `statedUnit`. `'000`, `Rs. in thousands` is `thousand`. Otherwise `statedUnit`, otherwise 1.
7. Set `ambiguousUnit: true` when an inline unit differs from `statedUnit`; when a figure below 1,000 with decimals has
   no unit at all, outside `bank_statement` and `gst_return`; when a non-zero `financial_statement` figure below 1,00,000 has
   no unit at all; or when a limit in `bank_statement` reads `Cr` on a figure of 1,00,000 or more, which may be a credit
   marker. The value is still computed; the candidate takes `ambiguous_unit` and is capped at `needs_verification`.
8. Round to 2 decimal places. Then the field's `signPolicy` applies.

Unit checks, in merge, for currency fields. Any failure caps at `needs_verification`:

- `unit_mismatch`: a unit in `rawValue` is not beside that figure in the snippet, nor named in it (`1.25 Cr` against
  `1.25 Lakh`). Or the snippet prints a unit beside the figure that `rawValue` dropped, or that differs from `statedUnit`.
  Or `statedUnit` is set, and `unitText` is missing or names another unit. Or the snippet, the row text or `unitText` holds
  unit header text the value was not scaled by, **whatever the magnitude**: `(Rs. in '000) Revenue 12,50,000` with no stated
  unit is capped, because the value was taken as rupees. A unit that belongs to one figure is not a header: one printed after
  a figure (`a limit of 50 lakh`), a figure spelled out (`Rupees Twelve Lakh Fifty Thousand only`), or a bank statement's
  credit marker. A bank month failing this check is dropped.
- `non_inr_unit`: a non-INR currency in the snippet, `unitText` or `rowLabel`, wherever it appears.

| Input | Context | Result |
|---|---|---|
| `₹12,50,000/-` | | 1250000 |
| `Rs. 1.25 Cr` | | 12500000 |
| `12.5 lakh` | | 1250000 |
| `(12.50)` | stated `lakh` | -1250000 |
| `1,250.00` | stated `thousand` | 1250000 |
| `1,23,456.00 Cr` | `bank_statement` | 123456 |
| `5,000.00 Dr` | `bank_statement` | -5000 |
| `2.5 Cr` | `bank_statement`, limit | 25000000 |
| `2,000` | `financial_statement` | 2000, `ambiguousUnit` |
| `0` or `0.00` | | 0 |
| `-` or `Nil` or blank | | failure; the model should omit it |
| `USD 5,000` | | failure `non_inr_currency` |

### 6.4 Dates

Output `YYYY-MM-DD`. Accept `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `DD-Mon-YYYY`, `D Month YYYY`, `YYYY-MM-DD`.
Numeric forms are always day first. Reject impossible dates (`31/02/2024`), two-digit years, and future dates unless
`allowFuture`.

FY: `normalizeFinancialYear` accepts `FY 2024-25`, `F.Y. 2024-2025`, `2024-25`, `Year ended 31 March 2025`, and gives
`FY 2024-25`. Assessment years shift one back: `AY 2025-26` is `FY 2024-25`. The second year must be the first plus one.

## 7. API

Base `/api/document-ai`. JSON with the error body `DocumentAiErrorBody`. Error messages never contain document content,
values or provider error text.

### 7.1 Authentication

**Finding.** The server has no working auth today. `AuthModule` sign-in runs entirely in the browser: accounts,
plain-text passwords and the role sit in `localStorage` (`signInLocalUser`, `readStoredUsers`). `getAccessToken` in
`AppStateContext.tsx` is a constant returning `null`, and `requestJson` sends no `Authorization` header, so
`resolveCurrentUser` always gives `user: null`. The Bearer path is unusable here even if a client sent a token:
`verifyGoogleAccessToken` gives any Google account the `employee` role. Nothing the client says about itself can be
trusted, so document routes get a server-held secret.

**Scheme.** Shared access codes, exchanged for an HttpOnly cookie. No bearer tokens are accepted on these routes.

- `DOCUMENT_AI_ACCESS_CODE` gives role `employee`. `DOCUMENT_AI_ADMIN_CODE` gives role `admin`. Compare with
  `crypto.timingSafeEqual` over SHA-256 digests.
- `POST /auth/session` with `CreateAuthSessionRequest`. On success set cookie `lb_docai_session`:
  `HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200`, plus `Secure` when `NODE_ENV=production`. `Path=/api` rather than
  `/api/document-ai`, because `DELETE /api/assessments/:id` also reads the cookie, to decide whether it may purge a session.
- Value: `v1.<base64url JSON {sub, email, name, role, exp}>.<base64url HMAC-SHA256>`. The payload also holds `cv`, a keyed
  digest of the role's current code, so changing a code ends that role's sessions. The HMAC key is a dedicated secret,
  never derived from a code: `DOCUMENT_AI_SESSION_SECRET` if set, otherwise a random secret generated once and persisted
  with mode 0600 as `session-secret` under the data dir. With no admin code, no admin session can exist. The middleware
  parses the `Cookie` header by hand; no cookie-parser.
- `actorEmail` and `actorDisplayName` come from the client's `currentUser`. They are attribution only, marked as
  self-reported, and carry no privilege.
- Throttle: 10 failed attempts per 15 minutes per client, then 429 `too_many_attempts` for that client, plus a global
  ceiling of 200 failures per 15 minutes so one client cannot block everyone. The client key is the socket address
  locally, and the last `X-Forwarded-For` hop (the one Render's proxy appends) when `NODE_ENV=production`. Per process.
- Middleware `requireDocumentAuth`, in `auth.ts`, guards everything except `GET /auth/status`, `POST /auth/session`, and
  `POST /auth/logout`. It sets `res.locals.documentActor: DocumentActor`. All authenticated staff can reach all
  sessions, as the app has no per-user scoping.
- Mutations require `Content-Type: application/json`, on top of `SameSite=Strict`.

**Modes.**

| Situation | Behaviour |
|---|---|
| Code configured | Cookie required, in every environment |
| No code, `NODE_ENV=production` | **Fail closed**: 503 `auth_not_configured` on all guarded routes |
| No code, not production, socket address loopback, no `X-Forwarded-For` | Allowed as `{ via: 'local_dev', role: 'admin', email: 'local@localhost' }` |
| No code, not production, anything else | 503 `auth_not_configured` |

This covers local mode without a workspace, because the mode depends on neither `spreadsheetId` nor a service account.
`requireAdminIfWorkspaceActive` must not be used: without a workspace it lets everyone through.

**Client.** `src/api/documentAiClient.ts` uses `fetch` with `credentials: 'same-origin'`. On 401 `unauthenticated`,
`DocumentAccessGate` asks for the code once and retries. `signOut` in `AppStateContext` also calls `POST /auth/logout`, so the
next person on a shared browser is locked out. The cookie makes `<img>` and `<iframe>` previews work without
placing a token in a URL.

### 7.2 Endpoints

`:sessionId`, `:documentId`, `:jobId` must match the patterns in the types file, else 400 `invalid_session_id` or 404.
A document must belong to the session in its path, and a job likewise, else 404.

| Method, path | Request | Success | Notes |
|---|---|---|---|
| `GET /auth/status` | | `AuthStatusResponse` | Open |
| `POST /auth/session` | `CreateAuthSessionRequest` | `AuthStatusResponse` | Open, throttled |
| `POST /auth/logout` | | 204 | Open, clears cookie |
| `GET /settings` | | `DocumentAiSettingsResponse` | Any actor |
| `PUT /settings` | `UpdateDocumentAiSettingsRequest` | `DocumentAiSettingsResponse` | Admin only, else 403 `forbidden`. Out of range: 400 |
| `GET /sessions?assessmentId=` | | `FindSessionResponse` | `session: null` when none |
| `GET /sessions/:sessionId` | | `DocumentSessionState` | 404 until first upload, which the client treats as empty |
| `POST /sessions/:sessionId/link` | `LinkSessionRequest` | `DocumentSessionState` | Assessment must exist. A session has one assessment and vice versa; a different existing link is 409 |
| `POST /sessions/:sessionId/documents` | `UploadDocumentRequest` | 201 `UploadDocumentResponse` | Creates the session if new. One file per request |
| `GET /sessions/:sessionId/documents` | | `ListDocumentsResponse` | |
| `PATCH /sessions/:sessionId/documents/:documentId` | `UpdateDocumentRequest` | `DocumentSessionState` | Sets `documentTypeOverridden`; client then re-extracts with `force` |
| `GET .../documents/:documentId/file?disposition=inline\|attachment` | | bytes | See section 7.4 |
| `GET .../documents/:documentId/preview` | | `SpreadsheetPreview` | `xlsx` and `csv` only |
| `DELETE .../documents/:documentId?mode=file_only\|file_and_clear_fields` | | `DeleteDocumentResponse` | See section 7.5 |
| `POST /sessions/:sessionId/extract` | `StartExtractionRequest` | 202 `StartExtractionResponse` | One active job per session, else 409 `job_in_progress` with `jobId` |
| `GET /sessions/:sessionId/jobs/:jobId` | | `JobStatusResponse` | Polling |
| `PUT /sessions/:sessionId/edits` | `UpdateEditsRequest` | `SessionEdits` | Unknown field IDs: 400 |

If disabled: upload and extract give 403 `disabled`. Read, delete, edits and settings still work, so documents stay
manageable. A missing `GEMINI_API_KEY` allows upload; the job fails per document with `llm_not_configured`.

### 7.3 Upload checks

Reuse the existing base64 JSON path: `express.json` is already 100 MB, so add no parser. ui-builder pre-checks size
client-side. On the server, in order:

1. Enabled, session ID valid, `fileName` a non-empty string, `base64` valid.
2. Decoded size up to 12 MB (413 `file_too_large`), 25 files per session (`too_many_files`), 100 MB per session (`session_too_large`).
3. Kind from magic bytes, in `fileValidation.ts`. The extension must agree, else 415 `type_mismatch`. Client `mimeType` is ignored.

| Kind | Extensions | Check |
|---|---|---|
| pdf | `.pdf` | `%PDF-` within the first 1024 bytes |
| png | `.png` | `89 50 4E 47 0D 0A 1A 0A` |
| jpeg | `.jpg`, `.jpeg` | `FF D8 FF` |
| webp | `.webp` | `RIFF` at 0 and `WEBP` at 8 |
| xlsx | `.xlsx` | `PK 03 04`, and via JSZip contains `[Content_Types].xml` and `xl/workbook.xml`, and total uncompressed size at most 60 MB |
| csv | `.csv` | No magic number: no NUL in the first 64 KB and valid UTF-8 (with or without BOM) |

Anything else is 415 `unsupported_type`. `.xls` and encrypted Office files start `D0 CF 11 E0`: reject with
`unsupported_type` and copy asking for `.xlsx`. A PDF with `/Encrypt` near its trailer is accepted, and extraction reports
`password_protected`, because bank statements are often locked. Password entry is out of scope for v1, and the UI asks
for an unlocked copy.

Same SHA-256 within a session returns the existing document with `duplicate: true`.

### 7.4 File serving

Always: `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`,
and `Content-Type` from the stored kind. `Content-Disposition` uses RFC 5987 `filename*` from `originalName`.

`inline` is allowed only for PDF and images, and sets `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'self'; frame-ancestors 'self'`.
`xlsx` and `csv` are always `attachment`. The UI previews them from `/preview`, rendered as plain text cells.
No `sandbox` directive: it stops Chrome's PDF viewer.

If bytes are gone: 404 `file_missing`.

### 7.5 Delete modes

- `file_only`: remove bytes, set `fileDeletedAt`. The extraction result stays, so values and provenance remain. `clearFieldIds` is empty.
- `file_and_clear_fields`: remove bytes and the extraction result, then re-merge. `clearFieldIds` holds fields in
  `appliedFields` whose candidate came from this document and which are not in `editedFields`. The server drops those
  from `appliedFields`, and the client blanks them to `defaultValue`, then applies the new `state.fields`, since another
  document may now supply the value.

The server cannot change an assessment for this; form state belongs to the open form. So `file_and_clear_fields` is
offered only on the New Assessment page, and History offers `file_only`. Edited fields are never cleared.

### 7.6 Async extraction

Extraction can take over 30 seconds per file, so `POST .../extract` returns 202 immediately.

- Queue: in-process, global concurrency 2, FIFO, 300 seconds per file via `AbortController`. Files sequentially
  go to `extractDocument`. One failing document does not stop the rest.
- Terminal status: `completed`; `completed_with_errors` if some failed; `failed` if all did.
- Persist the job after every state change. On boot, any `queued` or `running` job becomes `failed`, and its unfinished
  documents `failed` with `interrupted`. The client offers Retry.
- Polling: every 2 s for the first 30 s, then every 5 s, until terminal. After 70 minutes, stop and show a Refresh action.
  On terminal, `GET /sessions/:sessionId`, and run `applyFieldResults`. On page load, resume from `state.activeJob`.
- Results are merged and saved **before** the job is marked terminal.

## 8. Sessions, drafts and reopening

### Session lifecycle

1. On mounting New Assessment, the client generates `ds_` + `crypto.randomUUID()`, and keeps it in `sessionStorage`
   under `lb.docai.activeSession`, so leaving the page and returning resumes it. The session is created on first upload.
2. On save, the client sends `documentSessionId` in the body of `createAssessment` or `updateAssessment`. No change
   to `AppStateContext` signatures or `client.ts` is needed, because the field is on `BorrowerAssessment`.
3. In `POST` and `PUT /api/assessments`, storage-engineer links the session through `linkSessionToAssessment(sessionId, assessmentId)`
   from `store.ts`, after the record is saved. A failed link is logged, and does not fail the save. The client also
   retries via `POST .../link` when it sees no link on hydrate.
4. On success, the client clears `lb.docai.activeSession`.

The durable link is `session.assessmentId` under the Document AI store. `documentSessionId` on the assessment is a
request field and convenience only, since Sheets does not store it and `/api/bootstrap` replaces records from Sheets.
Look sessions up with `GET /sessions?assessmentId=`. The server keeps this index in memory, built at boot from `session.json` files.

`createAssessment(payload, true)` navigates away before resolving, and the module unmounts. Nothing after that call may rely on component state.

### Reopening a draft

`AppStateContext.tsx` is edited by storage-engineer only. `selectedAssessmentId` alone cannot mean "editing": bootstrap
sets it to the first record. So add exactly:

```ts
// AppState
editingAssessmentId: string | null;               // initial null

// Action
| { type: 'OPEN_ASSESSMENT_FOR_EDIT'; assessmentId: string }
// sets editingAssessmentId and selectedAssessmentId, and activeModule 'new-assessment'

// Reducer: SET_MODULE also sets editingAssessmentId: null

// AppContextValue
openAssessmentForEdit: (assessmentId: string) => void;
```

History (storage-engineer): an **Edit Draft** button in the row, and in the details drawer, only for `status === 'draft'`.
Other statuses keep their current actions. The Details drawer lists documents, with preview, download and `file_only` delete,
from `GET /sessions?assessmentId=`.

New Assessment (ui-builder): when `state.editingAssessmentId` is set, on mount:

1. Build the form from the assessment with an `assessmentToForm` helper: numbers to strings, `null` to `''`, and
   `collateralAvailable` to `yes`/`no`. Keep `financialProfile`, and fall back to blank if absent.
2. `GET /sessions?assessmentId=`. If found, use that session ID and hydrate. If none, use a new ID, linked on the next save.
3. **Saved values win.** Do not run `applyFieldResults` on reopen. Any field whose value differs from `defaultValue` and which is
   not in `appliedFields` is added to `editedFields` as `preexisting_value`. New documents added afterwards go through the usual
   rule.
4. Save Draft calls `updateAssessment(id, payload)` and stays on the page. Submit calls `updateAssessment` with
   `status: 'submitted'`, then `openAssessmentInEngine(id)`. Both use the same payload builder as create.

The page heading reads "Edit Draft <referenceCode>" while editing. `PUT /api/assessments/:id` must ignore `id`,
`referenceCode`, `createdAt`, `latestEvaluation` and `documentSessionId` from the body; today it spreads `req.body`.

### Server fixes by storage-engineer

- `POST /api/assessments` must store `financialProfile` from the body, with `undefined` when absent.
- **Sheets also drops it.** `SHEET_HEADERS.Borrower_Assessments` has no financial column, and `/api/bootstrap`, `connect`
  and `sync` replace `db.assessments` from Sheets. With a connected sheet, `financialProfile` is lost on the next page
  load, even with the POST fix. Append `financial_profile_json` at the **end** of the header list, serialise it in
  `serializeAssessmentRow`, and read it in `readAllWorkbookData` with `safeJsonParse`, using `undefined` on absence.
  Bootstrap must keep the local `financialProfile` when the sheet cell is empty, because existing sheets lack the column
  until `repair-schema` runs.
- `DELETE /api/assessments/:id` must also purge the linked session. `reset-demo-assessments` needs no change.
- Mount, as one small edit before the "Frontend Mounting" comment, so the SPA catch-all cannot take these paths:

```ts
app.use('/api/document-ai', createDocumentAiRouter({
  assessmentExists: (id) => db.assessments.some((a) => a.id === id),
}));
```

ui-builder also fixes the two baseline tsc errors: line 211, by typing blank numeric fields `null` in place of `''` and dropping
the cast; and line 268, by adding `financialProfile` to the demo object, spreading `createBlankForm(...)`.
Section 5's card heading becomes `05.`. Build the 18 inputs in `FINANCIAL_FIELDS_NEEDING_INPUT` from the field map, in a
collapsible "More financial details" group in section 04. Otherwise auto-filled values could not be seen or edited.
Replace `DYNAMIC_QUESTIONS_BY_PURPOSE` with `dynamicFieldsForPurpose`, so labels and options have one source.

## 9. Storage

Root: `DOCUMENT_AI_DATA_DIR`, resolved against `process.cwd()`, default `data/document-ai` (gitignored by `data/`).

**Render free plan has an ephemeral disk**, and sleeps when idle, which restarts it. Everything here, including uploaded
files, provenance, edits, settings and the activity log, disappears on restart or deploy. Free plans cannot attach a
disk. `server/storage.ts` has the same problem. Production use needs a paid instance with a persistent disk, and
`DOCUMENT_AI_DATA_DIR` pointed at the mount. The code must cope with an empty root at any time: a missing session is 404 and
the client starts empty. A saved assessment keeps its form values.

```
<root>/
  settings.json                       DocumentAiSettings
  activity/2026-11.jsonl              ActivityEvent, one per line, append only
  sessions/<sessionId>/
    session.json                      DocumentSessionRecord
    edits.json                        SessionEdits
    provenance.json                   MergeSessionOutput plus { autoApplyThreshold: number }
    files/<documentId>.<ext>          bytes
    documents/<documentId>.json       StoredDocument
    results/<documentId>.json         DocumentExtractionSuccess
    jobs/<jobId>.json                 ExtractionJob
```

Rules:

- Only server-generated IDs and `FILE_KIND_EXTENSION` build paths. `originalName` is never part of a path.
- All paths go through one `safeJoin(root, ...parts)`, which validates each segment against the ID patterns,
  resolves, and asserts the result starts with `root + path.sep`. Anything else throws.
- Sanitise `originalName`: take the part after the last `/` or `\`, NFC, drop control characters and bidi marks, trim,
  cap at 120 characters keeping the extension, fallback `document`.
- Writes are atomic: temp file in the same directory, then rename. Each session has an in-process promise queue for
  read-modify-write. `edits.json` merges by key and increments `revision`.
- Directories `0o700`, files `0o600`, where the OS supports it.
- Never store base64 or document text. `results/` holds snippets, `unitText` and `rowLabel`, and is treated as borrower data.
- `saveDatabase` is not used. Nothing from here goes into the workspace JSON, Sheets, or `/api/bootstrap`.

Env vars, added to `.env.example` and `render.yaml` (`sync: false`) by storage-engineer:

| Variable | Default | Purpose |
|---|---|---|
| `DOCUMENT_AI_DATA_DIR` | `data/document-ai` | Storage root |
| `DOCUMENT_AI_ACCESS_CODE` | none | Employee unlock. Use at least 16 random characters |
| `DOCUMENT_AI_ADMIN_CODE` | none | Admin unlock, for settings |
| `DOCUMENT_AI_ENABLED` | unset | `false` forces off, overriding settings. Needed on an ephemeral disk, where a stored "off" is lost |
| `DOCUMENT_AI_GEMINI_MODEL` | `gemini-3.8-flash` | Same model as `server/` today |
| `GEMINI_API_KEY` | existing | Server only |

## 10. Settings

New "Document AI" card in `SettingsModule`. It uses `/settings` above, not `SystemSettings`: `/api/settings` is unauthenticated for
reads and without a workspace for writes, and `/api/bootstrap` returns it to anyone.

| Option | Type | Default | Range |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `autoApplyThreshold` | number | 0.85 | 0.70 to 0.99, step 0.01 |
| `retentionDays` | integer | 30 | 1 to 365 |

Non-admins see read-only values. When `disabledByEnv`, the toggle is disabled with an explanation. When `llmConfigured` is
false, show a warning. Changing the threshold re-merges only as sessions are next read: on `GET /sessions/:id`, compare the
threshold stored in `provenance.json` and re-merge if it changed.

Retention in `retention.ts` runs at boot and every 6 hours, by `uploadedAt`:

- Files past `retentionDays`: delete bytes and `results/<id>.json`, set `fileDeletedReason: 'retention'`, re-merge. Applies to
  linked and unlinked sessions alike. Assessment values do not change.
- Sessions with `assessmentId: null` older than 72 hours: delete the whole directory. A session with `detachedAt` set is
  exempt from this: it lost its assessment to a delete, and waits for normal retention, its directory going once `detachedAt`
  is past `retentionDays`. Linking the session to an assessment clears `detachedAt`.
- Reducing `retentionDays` takes effect on the next run. Never touch `activity/`.

## 11. Activity log

`ACTIVITY_EVENT_TYPES` in the types file is the closed list. `ActivityEvent` has no free-text field, deliberately.
`activity.ts`, storage-engineer, exposes `logActivity(event)`, which never throws.

**Log IDs, file names, field IDs and fixed codes. Never values:** no PAN, GSTIN, amount, snippet, `rawValue`, document text, access code,
or provider response. This also applies to `console.*` and error messages. File names can hold identifiers, so
before logging, mask any substring matching a PAN or GSTIN shape with `[MASKED]`.

| Event | Fields of note |
|---|---|
| `auth_session_created`, `auth_session_failed`, `auth_logout` | `actor`; `code` is the role, or `via` |
| `session_created`, `session_linked`, `unlinked_session_purged` | `sessionId`, `assessmentId` |
| `file_uploaded`, `file_rejected` | `fileName`; `code` is the kind or rejection code; `counts.bytes` |
| `file_previewed`, `file_downloaded` | `documentId` |
| `file_deleted`, `fields_cleared` | `documentId`; `code` is the mode; `fieldIds` |
| `document_type_overridden` | `documentId`; `code` is the new type |
| `extraction_queued`, `extraction_started`, `extraction_completed` | `jobId`; `counts.documents`, `counts.failed` |
| `extraction_document_completed` | `documentId`; `code` is the document type; `counts` per status; `fieldIds` |
| `extraction_document_failed` | `documentId`; `code` is the `ExtractionErrorCode` |
| `injection_suspected` | `documentId` |
| `field_edited`, `field_accepted`, `conflict_resolved` | `fieldIds`, from `PUT .../edits`, one event per batch |
| `settings_changed` | `actor`; `counts` carries threshold and retention, which are not borrower data |
| `retention_purged` | `counts.files` |

## 12. Security

**Key.** `GEMINI_API_KEY` is read only in `server/documentAi/gemini.ts`, is never logged or returned, and never has a `VITE_`
prefix. Only `llmConfigured` reaches the client. Map provider errors to `ExtractionErrorCode`. Do not forward
`err.message`, which `server/` does elsewhere.

**Prompt injection.** Document text is hostile input: a borrower gains from a higher number.

- Send the document as data. The system instruction states that text in it is never an instruction, and that the only job is
  to report what is written. The instruction goes in `systemInstruction`, and is built only from the field map.
- Never put `originalName` in a prompt. Refer to the file by its position only.
- Spreadsheet and CSV text is delimited with a per-request random marker, and any occurrence of it is stripped from the content.
  Hidden sheets, rows and columns are not sent to the model.
- No tools, no URL fetching. `responseMimeType: 'application/json'` with a strict `responseSchema`; `temperature: 0`.
- Response schema includes `suspiciousInstructions: boolean`. `prompt.ts` also runs a pattern scan on spreadsheet and CSV text, including
  hidden sheets, for phrases such as "ignore previous instructions". Either sets `injectionSuspected`, which caps every candidate of
  that document at `needs_verification`, and logs `injection_suspected`.
- The controls that hold even if the model is fooled are downstream: the field allowlist, validators, section 4.2 and human
  review. A document cannot set `assignedOfficer`, `isFictionalDemo` or `advisorNotes`, whatever the model returns.
- **The check against source text is only as strong as the server's own reading of the file, and that differs by file:**

| File | What holds if the model is fooled or invents a value |
|---|---|
| `xlsx`, `csv` | The raw value must be in a visible parsed cell. The server cannot tell whether it is the right cell if the model cites the wrong row of the same figure, except through the row label it reads |
| Digital `pdf` | The digits must be somewhere in the text layer, at document level, not at the cited place, and a number that is on the page under another label passes. The text layer can also differ from what is rendered, as with white or hidden text |
| Scanned `pdf`, images | **No check against the source exists, because the server has no text of its own.** `snippet` and `unitText` are the model's word, and the snippet check compares the model with itself. An invented value that is confident, validates, and quotes a snippet that agrees with it **will auto-apply**. Auto-apply stays allowed here only for values that pass confidence and validation, and this is a residual risk, not a control. Mitigation is the source preview beside each field and human review. The fix, if the risk is not accepted, is to cap every `no_text` candidate at `needs_verification`, or to add server-side OCR |
- Snippets and names render as text. No `dangerouslySetInnerHTML`. Spreadsheet preview cells are text, so a cell starting `=` does nothing.

**Exposed elsewhere.** `identity.*` values live only in the authenticated store. They stay out of `customAttributes` and
the assessment on purpose, because assessments are served without auth by `GET /api/assessments` and `/api/bootstrap`, and are
copied to Sheets.

**Data-handling note.** Shown in the upload card, and in the Settings card:

> Uploaded documents are sent to Google's Gemini API for processing and may contain personal and financial data, including PAN and bank details. Upload only documents you are authorised to process.

- Files go inline, one per request. The Files API is not used, so nothing is left stored there by us, though provider
  retention still applies. Retention settings cover this server only; they cannot recall anything sent to Google.
- Google's terms differ by tier: on unpaid Gemini API use, content may be used to improve products and may be seen by reviewers.
  Check current terms. KYC documents should only go through a paid-tier key. See section 13.
- Data leaves India. Whoever owns compliance must confirm this against the DPDP Act and lender agreements.
- Fixtures use fictional data only.

## 13. Known limits

| Item | Status |
|---|---|
| Access codes are shared, so the audit trail shows self-reported names | Accepted for v1. Fixing it needs server-side accounts |
| Assessments, now including financial profiles, are readable without auth at `GET /api/assessments` and `/api/bootstrap` | Pre-existing and wider than this feature. Not fixed here |
| Client-side auth stores passwords in plain text in `localStorage`, and role selection is client-side | Pre-existing. Not fixed here |
| Negative net worth gives a negative TOL/TNW, which passes the rule engine's `> tolTnwMax` check. Autofill now preserves such negatives | Pre-existing logic in `server/ruleEngine.ts`, unowned here. Orchestrator to decide |
| The `DSCR` input appears editable, but `buildFinancialProfile` overwrites `ratios` on save | Pre-existing. Unchanged |
| Password-protected PDFs | Reported as `password_protected`. No password entry in v1 |
| Scanned PDFs and images have no server-readable text, so nothing verifies their values against the source | Residual risk, section 12. Values passing confidence and validation still auto-apply |
| Part-year figures labelled as a bare 31 March, with no wording in the snippet | Taken as the full year, because statements head columns that way |
| An unbracketed loss printed on a `Profit / (Loss)` row, such as `Profit / (Loss) after tax 12.50` where the document means a loss | Accepted residual. The row is exempt from `loss_wording`, as nothing on it says the figure is negative, so it can auto-apply as a profit. Section 4.2 |
| Unsaved form values are lost on leaving the page | Pre-existing. Documents and auto-applied fields resume; typed values do not |
