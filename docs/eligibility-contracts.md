# Initial Eligibility Check contracts

Binding for every engineer on the eligibility feature. Where this refines `PLAN.md`, this file wins. Shared code:
`src/types/eligibility.ts`. If a contract is wrong or missing, report it to the orchestrator; do not work around it
or edit another role's file. Document AI rules (`docs/contracts.md`) still apply to everything they cover.

Terms: an **input** (`EligibilityInput`) is the set of borrower values the check reads. A **criterion** is one lender
test, such as DSCR. A **result** (`EligibilityResult`) is one evaluation of an input against one version of the rules.
A **record** (`EligibilityAssessmentRecord`) is a saved input with its latest result.

Principles:

- **No AI in the decision.** The outcome, every criterion status and every reason come from the deterministic engine
  in `server/eligibility/`. No LLM call is made by any eligibility route.
- **Never guess.** `null` means not provided. A missing input is flagged, never replaced by a default, a zero or a
  value from an unrelated field. A derived value with a missing input is itself missing. The only fallbacks are the
  named mirrors in section 6, and each is recorded in `inputSources`.
- **No thresholds in code.** Every number in section 5 lives in `data/eligibility-rules.json`. The engine has no
  fallback values: without a valid rules file it refuses to evaluate.

## 1. File ownership

No file has two owners.

| Role | Files |
|---|---|
| eligibility-architect | `docs/eligibility-contracts.md`, `src/types/eligibility.ts` |
| eligibility-backend | `server/eligibility/*` (engine, mapping, rules loader, store, router), `server/eligibility/defaultRules.json` (tracked seed, section 5), `data/eligibility-rules.json` (live copy, seeded at boot), and one mount line in `server.ts` |
| eligibility-ui | `src/modules/EligibilityModule.tsx`, `src/components/eligibility/*`, `src/api/eligibilityClient.ts` |
| integration-agent | `src/types/domain.ts` (adds `'eligibility'` to `AppModuleId`, nothing else), `src/components/layout/AppShell.tsx`, `src/App.tsx`, `src/context/AppStateContext.tsx`, the prefill seam in `src/modules/NewAssessmentModule.tsx` (section 7.3) |
| test-writer | `tests/*`, `package.json` test list |

Do not touch: `server/ruleEngine.ts`, `server/localStudyMaterialMatcher.ts`, `src/utils/financialMetrics.ts`,
`src/documentAi/fieldMap.ts`, `src/types/documentAi.ts`, `server/storage.ts`.

**Why a seed file.** `.gitignore` ignores all of `data/`, so `data/eligibility-rules.json` is never committed, and
Render's free disk is wiped on restart. The defaults therefore ship as `server/eligibility/defaultRules.json`. At boot,
if the live file is absent, the backend copies the seed there. Edits go to the live file. The seed is data, not code:
the engine never reads numbers from it except through this copy.

The engine must not use `calculateFinancialRatios` from `src/utils/financialMetrics.ts`: it treats missing principal
repayments and EMI as 0 for DSCR, which this contract forbids. The engine computes its own metrics (section 4).

No new runtime dependencies.

## 2. Outcome

### 2.1 Criterion status

Each enabled, applicable criterion produces exactly one status:

| Status | Meaning |
|---|---|
| `passed` | Value meets the pass threshold |
| `conditional` | Value is inside the conditional band, or a rule below caps it here |
| `failed` | Value is outside the pass threshold and outside any conditional band |
| `missing` | A required input, or `entityType` when applicability depends on it, is `null` |

Evaluation order for one criterion, first match wins:

1. `enabled: false` → skipped (`disabled`). Not a result row.
2. `appliesToEntityTypes` is a list and `entityType` is `null` → `missing`, `missingInputs: ['entityType']`.
3. `appliesToEntityTypes` is a list not containing `entityType` → skipped (`entity_type_not_applicable`).
4. `skipWhen` field holds one of its values → skipped (`skip_when_matched`). A `null` field does not match.
5. Any required input `null` → `missing`, listing every null required input.
6. Compute the value (section 4), round to 2 decimal places (scores and ranks are never rounded, section 4), classify
   by section 5 thresholds and the zero-denominator rules in section 4.

Skipped criteria go to `result.skipped` and are not result rows. They affect the outcome only through rule 2a
(section 2.2): a check in which every mandatory criterion was skipped is never `ELIGIBLE`.

### 2.2 Outcome decision table

Evaluate top to bottom over the result rows. **The first rule that matches decides.**

| # | Condition | Outcome |
|---|---|---|
| 1 | Any **mandatory** criterion is `failed` | `NOT_ELIGIBLE` |
| 2 | Any **mandatory** criterion is `missing` | `INCOMPLETE_DOCUMENTS` |
| 2a | No result row is **mandatory** (every enabled mandatory criterion was skipped by entity type or `skipWhen`, or there are no result rows at all) | `INCOMPLETE_DOCUMENTS` |
| 3 | Any criterion is `conditional` (mandatory or not), or any **non-mandatory** criterion is `failed` or `missing` | `CONDITIONALLY_ELIGIBLE` |
| 4 | Every result row is `passed` | `ELIGIBLE` |

Consequences, stated so nobody has to infer them:

- A mandatory failure wins over missing data: a borrower who already fails a hard requirement is `NOT_ELIGIBLE` even
  with documents outstanding. The missing inputs are still listed in `missingMandatoryInputs`.
- A mandatory criterion in its conditional band gives `CONDITIONALLY_ELIGIBLE`, not `NOT_ELIGIBLE`.
- A non-mandatory missing input never gives `ELIGIBLE`: what was not checked cannot be called passed. It gives
  `CONDITIONALLY_ELIGIBLE` with that input in `missingOptionalInputs`.
- Rule 4 never matches with zero result rows or with no mandatory row: rule 2a catches both. The rules file must
  enable at least one mandatory criterion (section 5.3), but that criterion can still be skipped for an entity type or
  by `skipWhen`, and a check that evaluated nothing mandatory cannot confirm eligibility. Under rule 2a
  `missingMandatoryInputs` can be empty; `outcomeReason` names the skipped mandatory criteria, e.g. `Incomplete
  documents: no mandatory criterion could be evaluated (Commercial CMR rank: not applicable to this entity type), so
  eligibility cannot be confirmed.`

`outcomeReason` names the rule and the criteria that triggered it, e.g. `Not eligible: DSCR 0.92 is below the
minimum of 1.10 (mandatory).` or `Incomplete documents: Personal CIBIL score and Average monthly banking credits are
not provided (mandatory).`

### 2.3 Severity

Fixed by status and `mandatory`. Never set by hand.

| Status | Mandatory | Non-mandatory |
|---|---|---|
| `failed` | `blocker` | `condition` |
| `missing` | `action_required` | `condition` |
| `conditional` | `condition` | `condition` |
| `passed` | `none` | `none` |

### 2.4 Result row text

- `expected`: the threshold in words, from the rules file. `number_min`: `At least 1.25 (1.10 to 1.24 is
  conditional)`. `number_max`: `At most 6 (7 is conditional)`. No band: `At least 3 years`. Enum: `Profitable 2+ years
  (1 year or breakeven is conditional)`.
- `actualDisplay`: rupees in Indian grouping (`₹ 48,00,000`), ratios to 2 dp, percent with `%`, `Not provided`
  when missing, or the zero-denominator text in section 4.
- `reason`: one templated sentence with the actual value and the threshold, or the plain names of the missing
  inputs. No AI, no free text from input.
- `sourceField`: the fieldMap ID of the direct input (`financialProfile.personalCibilScore`), `derived:<criterionId>`
  for computed metrics, or `null` when missing.

## 3. Input

`EligibilityInput` carries every key, each nullable. Names are the `BorrowerFinancialProfile` and
`BorrowerAssessment` names, plus `dscrStated`. A request whose `input` lacks a key, or has an extra one, is 400
`invalid_input`.

Validation, all failures 400 `invalid_input` with the keys in `fields`. Nothing is silently nulled or clamped:

| Inputs | Rule |
|---|---|
| All numbers | Finite |
| `netProfitAfterTax`, `ebitda`, `ebit`, `tangibleNetWorth` | Any sign (fieldMap `signed`) |
| `depreciation`, `amortization`, `interestExpense` | `>= 0` (stored as magnitude, fieldMap `expense_magnitude`) |
| Every other currency field | `>= 0` |
| `requestedAmount` | `> 0`. The New Assessment server stores 0 for blank, so 0 is never a request |
| `requestedTenureMonths` | Integer 1 to 480 |
| `businessVintageYears` | 0 to 200 |
| `personalCibilScore`, `promoterCibilScore` | Integer 300 to 900. A bureau "NTC" (-1 or 0) is not a score: send `null`. Bureaus issue whole scores, so `699.995` is 400, never rounded to 700 |
| `commercialCmrRank` | Integer 1 to 10 (1 is best) |
| `dscrStated` | -100 to 100 |
| Enums | One of the values in the type. `'not_provided'` is rejected: send `null` |

## 4. Derived metrics and formulas

All arithmetic is on stated inputs. Results are rounded to 2 dp, half away from zero, **before** comparison, so the
displayed value is the decided value. **Exception:** bureau scores and CMR ranks (units `score` and `rank`) are compared
and shown exactly, never rounded; validation already requires them to be integers (section 3), and the engine does
not round them even for a caller that skips validation, so `699.995` is `conditional` against a pass of 700. Each metric is `null` in `result.derived` when any required input is `null`.

| Metric (criterion) | Formula | Required inputs | Zero or negative denominator |
|---|---|---|---|
| DSCR (`dscr`) | `(netProfitAfterTax + depreciation + amortization + interestExpense) / (interestExpense + annualScheduledPrincipalRepayments)` | `netProfitAfterTax`, `depreciation`, `interestExpense`, `annualScheduledPrincipalRepayments` | Denominator 0: `passed`, `actual: null`, `No existing debt service` |
| Requested to monthly credits (`banking_credits_vs_requested`) | `requestedAmount / averageMonthlyBankingCredits` | `requestedAmount`, `averageMonthlyBankingCredits` | Credits 0: `failed`, `No banking credits` |
| Banking turnover ratio (`banking_turnover_ratio`) | `averageMonthlyBankingCredits * 12 / annualRevenue * 100` | `averageMonthlyBankingCredits`, `annualRevenue` | Revenue 0: `conditional`, `Revenue reported as 0; check figures` |
| TOL/TNW (`tol_tnw`) | `totalOutsideLiabilities / tangibleNetWorth` | `totalOutsideLiabilities`, `tangibleNetWorth` | TNW <= 0: `failed`, `Net worth is zero or negative` (never a passing negative ratio) |
| FOIR (`existing_emi_foir`) | `existingMonthlyEmi * 12 / ebitda * 100` | `existingMonthlyEmi`, `ebitda` | EMI 0: `passed`, `0%`, whatever EBITDA is. EBITDA <= 0 with EMI > 0: `failed`, `EBITDA does not cover any EMI` |
| Current ratio (`current_ratio`) | `currentAssets / currentLiabilities` | `currentAssets`, `currentLiabilities` | Liabilities 0: `passed`, `No current liabilities` |
| Interest coverage (`interest_coverage`) | `ebit / interestExpense` | `ebit`, `interestExpense` | Interest 0: `passed`, `No interest expense` |

Direct criteria compare the input itself: `business_vintage` (`businessVintageYears`), `annual_turnover`
(`annualRevenue`), `gst_turnover` (`gstAnnualTurnover`), `commercial_cmr` (`commercialCmrRank`), `gst_compliance`
(`gstComplianceStatus`), `profitability` (`profitabilityStatus`).

### 4.1 DSCR, in full

1. **Computed** when all four required inputs are non-null. `dscrBasis: 'computed'`.
   - `amortization` is the **one** input that may be absent: when `null` it is left out of the numerator, and the
     reason says so. Leaving it out can only lower DSCR, so this is a conservative omission, not an assumption.
     Statements usually print one "Depreciation and amortisation" line, which reads as `depreciation`.
   - `existingMonthlyEmi` is **not** used: its interest and principal are already in the denominator, and adding it
     would count them twice.
   - The proposed loan's EMI is **not** included, because no interest rate is known. This is DSCR on existing
     obligations. Section 9.
2. Else **stated**, when `dscrStated` is non-null. `dscrBasis: 'stated'`. Classified as usual, then **capped at
   `conditional`**: a typed or CMA figure is not verified against financials. The reason says `Stated DSCR, not
   computed; verify from financials`.
3. Else `missing`, listing the null required inputs. `dscrStated` is not listed: the ask is for the financials.

A stored `financialProfile.ratios.dscr` from a saved assessment is never read as `dscrStated` (section 6.1).

### 4.2 Bureau score

`personal_cibil` reads `personalCibilScore` and `promoterCibilScore`. Both null: `missing`, `missingInputs:
['personalCibilScore']`. One non-null: that one. Both non-null: **the lower** of the two, with `sourceField` naming it.
`commercialCmrRank` is a rank, not a score, and never feeds this criterion (fieldMap rule).

## 5. Rules file

`data/eligibility-rules.json`, type `EligibilityRuleConfig`. Path from env `ELIGIBILITY_RULES_FILE`, resolved
against `process.cwd()`, default `data/eligibility-rules.json`. Seeded from `server/eligibility/defaultRules.json`
when absent (section 1).

### 5.1 Default values

**These are editable defaults, not LoanBazaar policy.** They reflect common Indian bank and NBFC practice for MSME
business loans, and `status` stays `editable_default` until LoanBazaar credit confirms or changes each value and sets
`status: 'confirmed'`, `confirmedBy`, `confirmedAt`. The UI shows an "Unconfirmed default criteria" banner while
`status` is `editable_default`.

| Criterion | Kind | Mandatory | Pass | Conditional band | Fails | Rationale |
|---|---|---|---|---|---|---|
| `business_vintage` | min, years | Yes | >= 3 | 2 to < 3 | < 2 | Most lenders want 3 years of operations (two filed ITRs and audited years); some NBFCs accept 2 |
| `personal_cibil` | min, score | Yes | >= 700 | 650 to 699 | < 650 | 700+ is the usual bank cut-off; NBFCs often go to 650 with higher pricing |
| `commercial_cmr` | max, rank | No | <= 6 | 7 | >= 8 | CMR 1-6 is low to moderate risk on the CIBIL scale, 7-10 high risk. Applies to partnership, LLP, private and public limited, trust/society; skipped when the commercial report is `not_applicable` |
| `dscr` | min, ratio | Yes | >= 1.25 | 1.10 to 1.24 | < 1.10 | 1.25 is the common term-loan floor; the existing matching engine uses 1.0-1.25 by purpose |
| `banking_credits_vs_requested` | max, multiple | Yes | <= 3.0 | > 3.0 to 4.0 | > 4.0 | Unsecured business loans are commonly sized at up to 3-4 times average monthly bank credits |
| `banking_turnover_ratio` | min, percent | No | >= 60 | 40 to < 60 | < 40 | Lenders expect most sales to pass through the bank; a low ratio suggests cash sales or other accounts |
| `annual_turnover` | min, rupees | Yes | >= 50,00,000 | 25,00,000 to < 50,00,000 | < 25,00,000 | Typical entry level for unsecured MSME products |
| `gst_turnover` | min, rupees | No | >= 40,00,000 | 20,00,000 to < 40,00,000 | < 20,00,000 | ₹ 40 lakh is the GST registration threshold for goods; a lower filed turnover usually means part of sales is outside GST. Skipped when GST is `not_applicable` |
| `gst_compliance` | enum | No | `compliant` | none | `not_compliant` | Filing regularity is checked by most lenders; skipped when `not_applicable` |
| `tol_tnw` | max, ratio | No | <= 3.0 | > 3.0 to 4.0 | > 4.0 | Banks commonly accept TOL/TNW up to 3 for MSMEs, 4 with justification |
| `existing_emi_foir` | max, percent | No | <= 50 | > 50 to 65 | > 65 | Existing EMIs above half of EBITDA leave little room for a new loan |
| `profitability` | enum | Yes | `profitable_2plus_years` | `profitable_1_year`, `breakeven_or_early` | `loss_making` | Two profitable years is standard; one year or breakeven goes to credit discretion |
| `current_ratio` | min, ratio | No | >= 1.33 | 1.00 to < 1.33 | < 1.00 | 1.33 is the Tandon/Nayak committee benchmark for working capital |
| `interest_coverage` | min, ratio | No | >= 2.0 | 1.5 to < 2.0 | < 1.5 | EBIT of at least twice interest is a common comfort level |

### 5.2 Default file

`server/eligibility/defaultRules.json` must hold exactly this (the seed for the live file):

```json
{
  "schemaVersion": 1,
  "rulesVersion": "2026-11-03.1",
  "status": "editable_default",
  "confirmedBy": null,
  "confirmedAt": null,
  "currency": "INR",
  "criteria": {
    "business_vintage": { "enabled": true, "mandatory": true, "label": "Business vintage", "kind": "number_min", "unit": "years", "passAt": 3, "conditionalTo": 2, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "Most lenders want 3 years of operations (two filed ITRs and audited years); some NBFCs accept 2. Editable default: LoanBazaar to confirm." },
    "personal_cibil": { "enabled": true, "mandatory": true, "label": "Personal / promoter CIBIL score", "kind": "number_min", "unit": "score", "passAt": 700, "conditionalTo": 650, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "700+ is the usual bank cut-off; NBFCs often go to 650 with higher pricing. Editable default: LoanBazaar to confirm." },
    "commercial_cmr": { "enabled": true, "mandatory": false, "label": "Commercial CMR rank", "kind": "number_max", "unit": "rank", "passAt": 6, "conditionalTo": 7, "appliesToEntityTypes": ["partnership", "llp", "private_limited", "public_limited", "trust_society"], "skipWhen": { "field": "commercialCreditReportStatus", "values": ["not_applicable"] }, "rationale": "CMR 1-6 is low to moderate risk, 7-10 high risk. Editable default: LoanBazaar to confirm." },
    "dscr": { "enabled": true, "mandatory": true, "label": "Debt service coverage (DSCR)", "kind": "number_min", "unit": "ratio", "passAt": 1.25, "conditionalTo": 1.1, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "1.25 is the common term-loan floor. Editable default: LoanBazaar to confirm." },
    "banking_credits_vs_requested": { "enabled": true, "mandatory": true, "label": "Requested amount vs average monthly bank credits", "kind": "number_max", "unit": "multiple", "passAt": 3, "conditionalTo": 4, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "Unsecured business loans are commonly sized at up to 3-4 times average monthly credits. Editable default: LoanBazaar to confirm." },
    "banking_turnover_ratio": { "enabled": true, "mandatory": false, "label": "Banking turnover vs reported revenue", "kind": "number_min", "unit": "percent", "passAt": 60, "conditionalTo": 40, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "Most sales should pass through the bank. Editable default: LoanBazaar to confirm." },
    "annual_turnover": { "enabled": true, "mandatory": true, "label": "Annual turnover", "kind": "number_min", "unit": "currency", "passAt": 5000000, "conditionalTo": 2500000, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "Typical entry level for unsecured MSME products. Editable default: LoanBazaar to confirm." },
    "gst_turnover": { "enabled": true, "mandatory": false, "label": "GST annual turnover", "kind": "number_min", "unit": "currency", "passAt": 4000000, "conditionalTo": 2000000, "appliesToEntityTypes": "all", "skipWhen": { "field": "gstComplianceStatus", "values": ["not_applicable"] }, "rationale": "Rs 40 lakh is the GST registration threshold for goods. Editable default: LoanBazaar to confirm." },
    "gst_compliance": { "enabled": true, "mandatory": false, "label": "GST filing compliance", "kind": "enum", "unit": "enum", "pass": ["compliant"], "conditional": [], "fail": ["not_compliant"], "appliesToEntityTypes": "all", "skipWhen": { "field": "gstComplianceStatus", "values": ["not_applicable"] }, "rationale": "Filing regularity is checked by most lenders. Editable default: LoanBazaar to confirm." },
    "tol_tnw": { "enabled": true, "mandatory": false, "label": "TOL / TNW", "kind": "number_max", "unit": "ratio", "passAt": 3, "conditionalTo": 4, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "Banks commonly accept up to 3 for MSMEs, 4 with justification. Editable default: LoanBazaar to confirm." },
    "existing_emi_foir": { "enabled": true, "mandatory": false, "label": "Existing EMI to EBITDA (FOIR)", "kind": "number_max", "unit": "percent", "passAt": 50, "conditionalTo": 65, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "EMIs above half of EBITDA leave little room for a new loan. Editable default: LoanBazaar to confirm." },
    "profitability": { "enabled": true, "mandatory": true, "label": "Profitability track record", "kind": "enum", "unit": "enum", "pass": ["profitable_2plus_years"], "conditional": ["profitable_1_year", "breakeven_or_early"], "fail": ["loss_making"], "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "Two profitable years is standard; one year or breakeven goes to credit discretion. Editable default: LoanBazaar to confirm." },
    "current_ratio": { "enabled": true, "mandatory": false, "label": "Current ratio", "kind": "number_min", "unit": "ratio", "passAt": 1.33, "conditionalTo": 1, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "1.33 is the Tandon/Nayak benchmark for working capital. Editable default: LoanBazaar to confirm." },
    "interest_coverage": { "enabled": true, "mandatory": false, "label": "Interest coverage", "kind": "number_min", "unit": "ratio", "passAt": 2, "conditionalTo": 1.5, "appliesToEntityTypes": "all", "skipWhen": null, "rationale": "EBIT of at least twice interest is a common comfort level. Editable default: LoanBazaar to confirm." }
  }
}
```

### 5.3 Validation and loading

- Re-read on each request when the file's mtime changes; otherwise cached. `rulesHash` is sha256 hex of the parsed
  JSON re-serialised with keys sorted.
- Valid only if: `schemaVersion` is 1; every id in `ELIGIBILITY_CRITERION_IDS` is present and no other; each `kind`
  equals `CRITERION_DEFINITIONS[id].kind`; numbers are finite; for `number_min` `conditionalTo` is null or `<=
  passAt`, for `number_max` null or `>= passAt`; for enums, every allowed value of the input type except
  `not_provided` appears in exactly one of `pass`, `conditional`, `fail` and the criterion's `skipWhen.values`; and at
  least one criterion has `enabled` and `mandatory` both true.
- File missing after seeding: 503 `rules_unavailable`. Invalid: 503 `rules_invalid`. Neither falls back to built-in
  values. A failed reload keeps nothing: the next request re-reads.
- No edit endpoint in v1. Edit the live file (on Render, also the seed, since the disk is ephemeral), bump
  `rulesVersion`, then reassess records as needed.

## 6. Field mapping

Prefill builds an `EligibilityInput` from a saved assessment and/or a Document AI session (`POST
/api/eligibility/prefill`, and server-side on `continue`). Precedence per field: **assessment value** (if non-null
after the rules below) > **Document AI `auto_applied` value** > `null`. A person then edits freely, and their values
are `manual`.

| `EligibilityInput` | `BorrowerAssessment` path | Document AI field ID | Notes |
|---|---|---|---|
| `entityType` | `entityType` | `entityType` | Form and server default to `private_limited`; a saved value is taken as chosen (section 9) |
| `fundingPurpose` | `fundingPurpose` | `fundingPurpose` | Informational; no criterion reads it. Doc value is always `needs_verification` |
| `requestedAmount` | `requestedAmount` | `requestedAmount` | Stored `0` → `null` |
| `requestedTenureMonths` | `requestedTenureMonths` | `requestedTenureMonths` | Informational. The assessment server stores 12 for blank, indistinguishable from a real 12 |
| `businessVintageYears` | `businessVintageYears` | `businessVintageYears` | Derived-from-date doc value is `needs_verification`, so not taken |
| `personalCibilScore` | `financialProfile.personalCibilScore`, fallback `creditScore` | `financialProfile.personalCibilScore` | `creditScore` is the fieldMap mirror of this field, so the fallback is the same quantity |
| `promoterCibilScore` | `financialProfile.promoterCibilScore` | `financialProfile.promoterCibilScore` | |
| `commercialCmrRank` | `financialProfile.commercialCmrRank` | `financialProfile.commercialCmrRank` | Rank 1-10, never `creditScore` |
| `commercialCreditReportStatus` | `financialProfile.commercialCreditReportStatus` | `financialProfile.commercialCreditReportStatus` | `not_provided` → `null` |
| `annualRevenue` | `financialProfile.annualRevenue`, fallback `annualTurnoverOrIncome` when `> 0` | `financialProfile.annualRevenue` | `annualTurnoverOrIncome` 0 means unknown |
| `netProfitAfterTax` | `financialProfile.netProfitAfterTax` | `financialProfile.netProfitAfterTax` | Signed |
| `ebitda` | `financialProfile.ebitda` | `financialProfile.ebitda` | Signed |
| `ebit` | `financialProfile.ebit` | `financialProfile.ebit` | Signed |
| `depreciation` | `financialProfile.depreciation` | `financialProfile.depreciation` | |
| `amortization` | `financialProfile.amortization` | `financialProfile.amortization` | |
| `interestExpense` | `financialProfile.interestExpense` | `financialProfile.interestExpense` | |
| `profitabilityStatus` | `profitabilityStatus` | `profitabilityStatus` | `not_provided` → `null`. Doc value is derived, so always `needs_verification` |
| `currentAssets` | `financialProfile.currentAssets` | `financialProfile.currentAssets` | |
| `currentLiabilities` | `financialProfile.currentLiabilities` | `financialProfile.currentLiabilities` | |
| `totalOutsideLiabilities` | `financialProfile.totalOutsideLiabilities` | `financialProfile.totalOutsideLiabilities` | |
| `tangibleNetWorth` | `financialProfile.tangibleNetWorth` | `financialProfile.tangibleNetWorth` | Signed |
| `annualScheduledPrincipalRepayments` | `financialProfile.annualScheduledPrincipalRepayments` | `financialProfile.annualScheduledPrincipalRepayments` | |
| `existingMonthlyEmi` | `financialProfile.existingMonthlyEmi`, fallback `existingEmiObligations` | `financialProfile.existingMonthlyEmi` | fieldMap mirror pair. `0` is real |
| `averageMonthlyBankingCredits` | `financialProfile.averageMonthlyBankingCredits` | `financialProfile.averageMonthlyBankingCredits` | Bank-table average is a derivation, so `needs_verification` |
| `gstAnnualTurnover` | `financialProfile.gstAnnualTurnover` | `financialProfile.gstAnnualTurnover` | |
| `gstComplianceStatus` | `financialProfile.gstComplianceStatus`, fallback `gstTaxCompliant` (`yes` → `compliant`, `no` → `not_compliant`) | `financialProfile.gstComplianceStatus` | `not_provided` → `null`. Doc value is `alwaysReview`, so never taken. `no` may have been `not_applicable`; the reason shows the source, and a person corrects it |
| `dscrStated` | **never** | none (ratios are not extractable) | `financialProfile.ratios.dscr` on a saved assessment is overwritten on save by `calculateFinancialRatios`, which assumes zeros. Manual entry only |

### 6.1 Rules for the mapper

- A fallback is used only when the primary is `null`/absent, and `inputSources[field].path` names the fallback.
- Absent, `undefined`, `''` and `NaN` read as `null`. `0` stays `0` except where the table says otherwise.
- `financialProfile.ratios.*` is never read.
- With only `assessmentId`, the server also looks up a linked session with `findSessionByAssessment` and fills nulls
  from it. With both ids, the given session is used.

### 6.2 Document AI values

From `loadSessionState(sessionId).fields`, by the field IDs above, primaries only. **Only `status: 'auto_applied'`
is taken.** `needs_verification`, `conflict` and `rejected_validation` leave the input `null` and are listed in
`pendingVerification` with their status, so the UI can say "a document has a value waiting for review in New
Assessment". Mirrors (`creditScore`, `existingEmiObligations`, `annualTurnoverOrIncome`, `gstTaxCompliant`) are never
read from a session. `review_only` fields are never read. `applicantLabel` from the session is returned as
`applicantLabel` only when `auto_applied`.

## 7. API

Base `/api/eligibility`, mounted in `server.ts` next to the Document AI mount, before "Frontend Mounting". JSON in and
out. Errors use `EligibilityErrorBody` (`{ error, code, fields? }`). Messages never contain input values.

### 7.1 Authentication

Every route except `GET /rules` uses `requireDocumentAuth` from `server/documentAi/auth.ts`, the same cookie as
Document AI, because records and prefill hold borrower and document data. The UI reuses `DocumentAccessGate` on 401.
Mutations require `Content-Type: application/json`.

### 7.2 Endpoints

`:id` must match `ELIGIBILITY_RECORD_ID_PATTERN`, else 400 `invalid_record_id`; unknown id 404 `record_not_found`.
`documentSessionId` values must match `DOCUMENT_SESSION_ID_PATTERN` (existence not required: a session is created
on first upload). `linkedAssessmentId` must exist in `db.assessments`, else 404 `assessment_not_found`.

| Method, path | Request | Success | Notes |
|---|---|---|---|
| `GET /rules` | | `EligibilityRulesResponse` | Open. 503 when rules unavailable or invalid |
| `POST /evaluate` | `EvaluateEligibilityRequest` | `EvaluateEligibilityResponse` | **Stateless**: stores and logs nothing. For live preview while typing |
| `POST /prefill` | `PrefillEligibilityRequest` | `PrefillEligibilityResponse` | Section 6. At least one id, else 400. Unknown assessment 404. A session with no state gives all `null` from it, not 404 |
| `GET /records` | | `ListEligibilityRecordsResponse` | Newest `updatedAt` first |
| `GET /records/:id` | | `EligibilityRecordResponse` | |
| `POST /records` | `CreateEligibilityRecordRequest` | 201 `EligibilityRecordResponse` | Validates, evaluates, saves. `status` default `draft`; `final` sets `finalizedAt`. `applicantLabel` trimmed, non-empty, at most 200 characters |
| `PUT /records/:id` | `UpdateEligibilityRecordRequest` | `EligibilityRecordResponse` | `input` replaces the whole input. Re-evaluates with current rules, pushing the old result to `previousResults`. `draft` → `final` allowed, never back. On a `final` record only `linkedAssessmentId` may be sent, else 409 `record_final`. A body with **only** `linkedAssessmentId` (draft or final) is a pure link update: no re-evaluation, no `previousResults` entry, and it succeeds even when the rules file is unavailable or invalid |
| `POST /records/:id/reassess` | `{}` | `EligibilityRecordResponse` | Re-evaluates the stored input with the current rules. Allowed on `draft` and `final`. Does not re-pull inputs from sources |
| `POST /records/:id/continue` | `{}` | `ContinueEligibilityResponse` | Section 7.3. Re-evaluates against the current rules and gates on that fresh outcome. Sets `continuedAt` when allowed. Allowed on `draft` and `final`. 409 `continue_blocked_incomplete` / `continue_blocked_not_eligible`; 503 when the rules are unavailable or invalid |

`previousResults` keeps at most 20 snapshots, newest first. `rulesVersion` on the record always equals
`result.rulesVersion`.

### 7.3 Continue to New Assessment

0. **Gate.** The stored result is not trusted. The stored `input` is evaluated against the **current** rules by the
   same engine. If the fresh result's `rulesHash` differs from the stored one (or the fresh result differs in any
   other way, e.g. after an engine change), the fresh result is stored and the old one pushed to `previousResults`;
   this is kept even when continue is then refused. The gate uses the **fresh** outcome: `INCOMPLETE_DOCUMENTS` is 409
   `continue_blocked_incomplete`, `NOT_ELIGIBLE` is 409 `continue_blocked_not_eligible`, both without a prefill and
   without setting `continuedAt`. This applies whether or not the record links an assessment. A record saved
   `ELIGIBLE` that is `NOT_ELIGIBLE` under the current rules is refused. Without valid rules: 503.
   `conditions` lists **every** reason for `CONDITIONALLY_ELIGIBLE` (rule 3 of section 2.2): each `conditional` row
   (mandatory or not) and each non-mandatory row that is `failed` or `missing`. It is empty for `ELIGIBLE`.
1. If `linkedAssessmentId` is set and that assessment exists: `existingAssessmentId` is set and `prefill` is `null`.
   The UI calls `openAssessmentForEdit(existingAssessmentId)`.
2. Otherwise `prefill` is built from `input`. Only non-null inputs appear. Mirrors follow fieldMap section 4.5:
   - `personalCibilScore` → `financialProfile.personalCibilScore` and `assessment.creditScore`. If it is null and
     `promoterCibilScore` is set, `assessment.creditScore` takes the promoter score (the fieldMap fallback).
   - `existingMonthlyEmi` → `financialProfile.existingMonthlyEmi` and `assessment.existingEmiObligations`.
   - `annualRevenue` → `financialProfile.annualRevenue` and `assessment.annualTurnoverOrIncome`.
   - `gstComplianceStatus` → `financialProfile.gstComplianceStatus` and `assessment.gstTaxCompliant`:
     `compliant` → `yes`, `not_compliant` → `no`. `not_applicable` (and `null`) leave `assessment.gstTaxCompliant`
     **out**, so the form keeps `not_provided`. Never `no` for anything but `not_compliant`: the matching engine reads
     `no` as a real negative, so writing it for `not_applicable` would be a guess.
   - `dscrStated` → `financialProfile.ratios.dscr`.
   - Every other input to the same-named key in `assessment` or `financialProfile`.
3. Integration seam (integration-agent): New Assessment opens with the prefill through `assessmentToForm`, as a new
   form, not an edit. Every prefilled field is added to `editedFields` as `preexisting_value`, so Document AI never
   overwrites it. `prefill.documentSessionId` becomes the form's session id only when that session has no
   `assessmentId` (per `GET /api/document-ai/sessions/:id`); otherwise a fresh id is used. After the assessment saves,
   the client sends `PUT /records/:id { linkedAssessmentId }` (a pure link update, section 7.2).

## 8. Storage

Root `ELIGIBILITY_DATA_DIR`, resolved against `process.cwd()`, default `data/eligibility` (gitignored by `data/`).

```
data/
  eligibility-rules.json            EligibilityRuleConfig (live, seeded from server/eligibility/defaultRules.json)
  eligibility/
    records.json                    { "version": 1, "records": EligibilityAssessmentRecord[] }
```

- Same pattern as `server/storage.ts`: one JSON file, created when absent. Writes are atomic (temp file in the same
  directory, then rename) behind one in-process promise queue. Directory `0o700`, file `0o600` where supported.
- A file that exists but cannot be parsed is **not** overwritten: routes return 500 `internal_error` until it is fixed,
  so a read error cannot wipe records.
- Records are not written to `loanbazaar-workspace-state.json`, Google Sheets or `/api/bootstrap`.
- Ids are `elg_` + `crypto.randomUUID()`. `referenceCode` is `LB-ELG-<n>`, `n` = 1001 + highest existing `n`.
- **Render free plan disk is ephemeral**: records and the live rules file vanish on restart, exactly as for the other
  stores (`docs/contracts.md` section 9). Production needs a persistent disk.
- Logging: ids, outcome and fixed codes only. Never input values, applicant labels or reasons.

## 9. Known limits

| Item | Status |
|---|---|
| Defaults in section 5 are market-practice estimates | `editable_default` until LoanBazaar confirms. UI shows a banner |
| DSCR excludes the proposed loan's EMI | No interest rate is known, and assuming one is guessing. A future rules field for an assumed rate would need explicit approval |
| `entityType` on a saved assessment may be the form default | Indistinguishable from a choice. Affects only `commercial_cmr` applicability. Shown in the input view for checking |
| `requestedTenureMonths` from an assessment may be the server's default of 12 | No criterion reads it |
| `gstTaxCompliant: 'no'` cannot tell `not_compliant` from `not_applicable` | Mapped to `not_compliant`, with the fallback source shown, for a person to correct |
| `delinquencies` is free text | Not evaluated. Shown nowhere in the decision |
| No per-purpose or per-lender thresholds | One rule set in v1. The 258-lender engine is unchanged and remains the product match |
| No rules edit endpoint | Edit the file. Section 5.3 |
