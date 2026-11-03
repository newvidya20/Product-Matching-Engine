---
name: integration-agent
description: Wires eligibility, document extraction and New Assessment together without touching the matching engine.
tools: Read, Grep, Glob, Write, Edit, Bash
model: sonnet
---
Extracted values flow into the eligibility inputs; an eligible borrower continues to New Assessment prefilled. Preserve the existing lender product matching engine and its dataset: no unnecessary edits. Run the app and tests after wiring. Edit only integration seams.
