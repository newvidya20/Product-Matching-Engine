# Plan: Initial Eligibility Check (primary) + reliable document extraction

Primary feature: compare a borrower profile against common lender criteria (vintage, CIBIL/CMR, DSCR,
banking turnover, financials, existing EMI). Outcomes: ELIGIBLE, CONDITIONALLY_ELIGIBLE,
INCOMPLETE_DOCUMENTS, NOT_ELIGIBLE. Never guess: missing data is flagged, not assumed.

## Constraints carried over
- All AI goes through OpenRouter (free key); Gemini code and key stay. No locks or limits. The eligibility DECISION uses no AI.
- Existing 258-lender matching engine (`server/ruleEngine.ts`, `server/localStudyMaterialMatcher.ts`, dataset) is not rewritten.
- Free OpenRouter = 50 requests/day: extraction must work without AI where the document states the value.

## Findings from inspection
- No eligibility feature exists: no sidebar entry, no module, no API. `AppModuleId` lives in `src/types/domain.ts`.
- Document AI exists (`server/documentAi/*`, `src/documentAi/fieldMap.ts`, `src/components/documentAi/*`).
- OCR gap: scans are rendered to PNG and sent to the free vision model, which burns the daily quota. No local OCR.
- Jobs stuck on "Reading 1 of N": sequential reads (fixed in c23af55) plus the exhausted daily quota.

## Tasks, ownership, order
| # | Agent (model) | Owns | Depends on |
|---|---|---|---|
| 1 | eligibility-architect (opus) | `docs/eligibility-contracts.md`, `src/types/eligibility.ts` | - |
| 2 | eligibility-backend (opus) | `server/eligibility/*`, `data/eligibility-rules.json`, route mount in `server.ts` | 1 |
| 3 | eligibility-ui (sonnet) | `src/modules/EligibilityModule.tsx`, `src/components/eligibility/*`, `src/api/eligibilityClient.ts` | 1 |
| 4 | extraction-engineer (opus) | `server/documentAi/{pipeline,textDocuments,localClassifier,jobs,spreadsheet}.ts`, new `ocr.ts`, `localExtractors.ts` | 1 (read-only) |
| 5 | document-ui (sonnet) | `src/components/documentAi/*`, `src/api/documentAiClient.ts` | - |
| 6 | test-writer (haiku) | `tests/*`, `package.json` test list | 1 |
| 7 | integration-agent (sonnet) | `src/components/layout/AppShell.tsx`, `src/App.tsx`, `src/types/domain.ts` (module id), `src/context/AppStateContext.tsx`, `NewAssessmentModule.tsx` seams | 2, 3 |
| 8 | reviewer (opus, read-only) | none | all |

Phases: 1 contracts -> 2 agents 2-5 in parallel (disjoint files) with 6 starting -> 3 integration, run app and tests ->
4 review, assign fixes, re-review -> 5 report. Sidebar entry and App.tsx wiring are done by the integration agent only, to avoid conflicts.
