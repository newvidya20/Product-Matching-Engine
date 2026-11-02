# Document AI: upload borrower documents, autofill the assessment

Goal: on New Assessment, a user uploads borrower documents; the system extracts every
field it can and fills the form. The user reviews values, each traceable to a file, page and snippet.

## Decisions
- LLM/OCR: reuse server-side Gemini (`GEMINI_API_KEY`, model already used in `server/`). Gemini reads
  PDFs (digital and scanned) and images natively, so no OCR dependency. XLSX reuses the JSZip parser; CSV is plain text.
- No new runtime dependencies. Tests use `node --import tsx --test`.
- Uploads use the existing base64 JSON pattern; files live under `data/document-ai/` (already gitignored).
- Never guess: an absent value stays blank. Low-confidence or failed-validation values are flagged "Please verify".
- Never overwrite: a field the user edited is not replaced; the new value is shown for review.
- Conflicting values across documents are shown side by side and not auto-applied.

## File ownership (no agent edits another agent's files)
- architect: `docs/contracts.md`, `src/types/documentAi.ts`, `src/documentAi/fieldMap.ts`
- extraction-engineer: `server/documentAi/` pipeline files
- storage-engineer: `server/documentAi/` store and routes, `server/storage.ts`, `server.ts`, `src/modules/AssessmentHistoryModule.tsx`
- ui-builder: `src/components/documentAi/`, `src/api/documentAiClient.ts`, `src/modules/NewAssessmentModule.tsx`, `src/modules/SettingsModule.tsx`
- test-writer: `tests/`, `package.json` test script

## Phases
1. architect writes contracts. 2. ui, extraction and storage build in parallel worktrees; tests start.
3. Merge into `feature/document-ai`, run app and tests. 4. reviewer audits; fix and re-review until clean.
