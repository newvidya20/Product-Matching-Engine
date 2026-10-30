# LoanBazaar Local Product Matching

The app reads product reference PDFs from the `Study Material` folder in this project. It
extracts and saves searchable text for all indexed PDFs in
`src/data/study-material-reference.json`. Deterministic matching rules weight funding-purpose
terms above sector terms and compare them against the full extracted text and product titles.
The match returns cited source documents and relevant text evidence.

This is not machine-learning model training and does not determine lending eligibility.
Relevance scores are relative text matches, not approval probabilities. PDF text is used as
local reference evidence, not automatically converted into verified lending rules. Verify
product terms and eligibility requirements against current lender policy before advising a
borrower. Matching is local and does not send borrower details or PDF content to an AI service.

After running a match, an employee can explicitly request an optional Gemini explanation.
That request sends the borrower intake, match results, and short excerpts from cited PDFs to
Gemini. The AI explains results only; the deterministic match and pending eligibility status
cannot be changed by the AI layer. Configure `GEMINI_API_KEY` in the server environment to use
this optional feature.

## Run locally

**Prerequisite:** Node.js 20.16 or newer.

1. Install dependencies with `npm install --legacy-peer-deps`.
2. Build or refresh the local PDF index after adding/changing PDFs:
   `npm run index:study-material`
3. Start the app:
   `npm run dev`
4. Open `http://localhost:3000`.

## Deploy to Render

This project is configured as a single Node web service that serves the Vite frontend and the Express API together.

Render setup:

1. Create a Web Service on Render.
2. Connect this repository.
3. Use these settings:
   - Build Command: `npm install --legacy-peer-deps && npm run build`
   - Start Command: `npm start`
   - Node version: `20`
4. Add environment variables as needed:
   - `NODE_ENV=production`
   - `PORT=10000` (Render sets this automatically; you can leave it unset)
   - `GEMINI_API_KEY` if you want AI explanations enabled
   - `GOOGLE_SERVICE_ACCOUNT_JSON` if you want Google Sheets/Drive service-account sync enabled

A sample environment file is included at `.env.example`.

The index command scans all PDFs recursively under `Study Material`. The generated JSON
reference is stored in this project; re-run the command whenever the source PDFs change.
No Firebase sign-in, Google Drive, Google Sheets, or external database is used for matching.
The desktop sidebar can be collapsed or expanded with its toggle button.

Borrower assessments and other editable workspace state are retained locally in
`data/loanbazaar-workspace-state.json`.
