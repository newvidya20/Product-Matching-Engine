/**
 * The LoanBazaar "Business Credit Triangulation Report" read with no AI, through the real PDF text-layer
 * reader and the whole local pipeline. Fixture: tests/fixtures/triangulation-report.pdf (a copy of the
 * report's key-page layout; pages are consecutive 1..8). No request leaves this process.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { classifyLocally } from '../server/documentAi/localClassifier.ts';
import { validateGstin } from '../server/documentAi/validators.ts';
import { isTriangulationReport, readTriangulationReport } from '../server/documentAi/triangulationReport.ts';
import { extractDocument, mergeSessionResults } from '../server/documentAi/pipeline.ts';
import { readPdfText } from '../server/documentAi/spreadsheet.ts';
import type { DocumentExtractionSuccess, ExtractedField } from '../src/types/documentAi.ts';

const TODAY = '2026-11-10';
const FILE = 'SAMPLE_GRAIN_MILLING_PROCESSING_UNIT_LLP_Triangulation_Report (6).pdf';
const MODEL_ENV = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'DOCUMENT_AI_LLM_FALLBACK', 'DOCUMENT_AI_OCR'];
const saved = Object.fromEntries(MODEL_ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let fetchCalls = 0;

before(() => {
  for (const k of MODEL_ENV) delete process.env[k];
  process.env.DOCUMENT_AI_OCR = 'off';
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network access is not allowed in this test');
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of MODEL_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const bytes = () => new Uint8Array(fs.readFileSync(new URL('./fixtures/triangulation-report.pdf', import.meta.url)));

async function run(): Promise<DocumentExtractionSuccess> {
  const result = await extractDocument({
    documentId: `doc_${crypto.randomUUID()}`,
    fileName: FILE,
    kind: 'pdf',
    bytes: bytes(),
    declaredDocumentType: null,
    today: TODAY,
    signal: new AbortController().signal,
  });
  assert.ok(result.ok, `expected success, got ${result.ok ? '' : result.errorCode}`);
  return result as DocumentExtractionSuccess;
}

const byField = (r: DocumentExtractionSuccess, id: string) => r.fields.filter((f) => f.fieldId === id);
const one = (r: DocumentExtractionSuccess, id: string, period: string | null = null): ExtractedField => {
  const hits = byField(r, id).filter((f) => f.period === period);
  assert.equal(hits.length, 1, `${id} ${period}: ${hits.length} candidates`);
  return hits[0];
};
const merge = (r: DocumentExtractionSuccess) =>
  mergeSessionResults({ documents: [r], editedFieldIds: [], autoApplyThreshold: 0.85, today: TODAY });

describe('Triangulation report reader (no AI)', () => {
  it('is recognised from its text layer, by title plus Section 1', async () => {
    const read = await readPdfText(bytes(), new AbortController().signal);
    assert.equal(read.source.kind, 'pdf');
    const text = read.source.kind === 'pdf' ? (read.source.pages ?? []).map((p) => p.join('\n')).join('\n') : '';
    assert.ok(isTriangulationReport(text));
    assert.equal(classifyLocally(text, FILE), 'triangulation_report');
    assert.equal(classifyLocally('Business Credit Triangulation Report', FILE), null, 'the title alone is not enough');
  });

  it('reads identity as printed; the printed GSTIN passes its checksum', async () => {
    const r = await run();
    assert.equal(r.documentType, 'triangulation_report');
    assert.equal(one(r, 'applicantLabel').value, 'SAMPLE GRAIN MILLING & PROCESSING UNIT LLP');
    assert.equal(one(r, 'identity.pan').value, 'ABCPE1234F');
    const gstin = one(r, 'identity.gstin');
    assert.equal(gstin.rawValue, '27ABCPE1234F1ZB');
    assert.equal(gstin.value, '27ABCPE1234F1ZB');
    assert.equal(gstin.status, 'needs_verification', 'review-only fields are never auto-applied');
  });

  it('records a GSTIN exactly as printed even when its checksum fails, leaving validation to flag it', () => {
    const pages = [
      ['INTEGRATED CREDIT ANALYSIS', 'Business Credit', 'Triangulation Report'],
      ['SECTION 1', 'Company & Credit Snapshot', 'GSTIN', 'Source: Supplied source data', '27ABCPE1234F1Z5 AVAILABLE'],
    ];
    const fields = readTriangulationReport(pages, 0.9);
    assert.equal(fields.find((f) => f.fieldId === 'identity.gstin')?.rawValue, '27ABCPE1234F1Z5');
    assert.equal(validateGstin('27ABCPE1234F1Z5').ok, false);
  });

  it('gives every yearly value its own period, with Indian amounts parsed exactly', async () => {
    const r = await run();
    assert.equal(one(r, 'financialProfile.annualRevenue', 'FY 2023-24').value, 2_54_10_35_165);
    assert.equal(one(r, 'financialProfile.annualRevenue', 'FY 2024-25').value, 5_05_36_34_449);
    assert.equal(one(r, 'financialProfile.annualRevenue', 'FY 2025-26').value, 3_35_54_93_995);
    const latest = (id: string) => one(r, id, 'FY 2025-26');
    assert.equal(latest('financialProfile.netProfitAfterTax').value, 6_92_63_750);
    assert.equal(latest('financialProfile.ebitda').value, 17_29_40_194);
    assert.equal(latest('financialProfile.ebit').value, 14_76_04_982);
    assert.equal(latest('financialProfile.interestExpense').value, 7_83_41_232);
    assert.equal(latest('financialProfile.totalOutstandingBorrowings').value, 69_96_93_083);
    assert.equal(latest('financialProfile.shareholdersEquity').value, 62_74_34_010);
    assert.equal(latest('financialProfile.tangibleNetWorth').value, 62_74_34_010);
    assert.equal(latest('financialProfile.currentAssets').value, 1_20_92_42_598);
    assert.equal(latest('financialProfile.currentLiabilities').value, 61_04_08_018);
    assert.equal(latest('financialProfile.totalOutsideLiabilities').value, 97_59_88_498);
    assert.equal(one(r, 'financialProfile.netProfitAfterTax', 'FY 2023-24').value, 8_01_22_176);
    assert.ok(byField(r, 'financialProfile.annualRevenue').every((f) => f.source.page === 3), 'page of the table');
    assert.match(one(r, 'financialProfile.annualRevenue', 'FY 2025-26').source.snippet, /Revenue \/ Turnover/);
  });

  it('holds the provisional latest year for a person to confirm, never auto-applied', async () => {
    const r = await run();
    const latest = one(r, 'financialProfile.annualRevenue', 'FY 2025-26');
    assert.notEqual(latest.status, 'auto_applied');
    assert.ok(latest.reasons.includes('low_confidence'));
  });

  it('does not label the combined Depreciation & Amortisation as depreciation, and leaves N/A absent', async () => {
    const r = await run();
    assert.equal(byField(r, 'financialProfile.depreciation').length, 0);
    assert.equal(byField(r, 'financialProfile.amortization').length, 0);
    assert.equal(byField(r, 'financialProfile.operatingCashFlow').length, 0, 'N/A operating cash flow stays absent');
    assert.equal(byField(r, 'financialProfile.commercialCmrRank').length, 0, 'CMR is N/A: absent, never 0');
    assert.equal(byField(r, 'creditScore').length, 0);
  });

  it('keeps each promoter CIBIL score as its own named candidate, never the headline or an average', async () => {
    const r = await run();
    const scores = byField(r, 'financialProfile.personalCibilScore');
    assert.deepEqual(
      scores.map((s) => [s.subjectRef, s.value]),
      [
        ['PROMOTER ONE SAMPLE', 740],
        ['PROMOTER TWO SAMPLE', 756],
        ['PROMOTER THREE SAMPLE', 756],
      ]
    );
    assert.equal(new Set(scores.map((s) => s.candidateId)).size, 3);
    const field = merge(r).fields['financialProfile.personalCibilScore'];
    assert.equal(field.status, 'needs_verification');
    assert.ok(field.reasons.includes('multiple_subjects'));
    assert.equal(field.candidates.length, 3);
  });

  it("reads the EMI, the fully covered GST year only, and the report's own ratios as stated review-only values", async () => {
    const r = await run();
    assert.equal(one(r, 'financialProfile.existingMonthlyEmi').value, 67_85_553);
    const gst = byField(r, 'financialProfile.gstAnnualTurnover');
    assert.deepEqual(
      gst.map((g) => g.period),
      ['FY 2024-25'],
      'the 10/12 year is part-year and not emitted'
    );
    assert.equal(gst[0].value, 5_04_95_01_146.75);
    const dscr = one(r, 'review.statedDscr');
    assert.equal(dscr.rawValue, '1.35x (provisional)');
    assert.equal(dscr.status, 'needs_verification');
    assert.equal(one(r, 'review.statedTolTnw').rawValue, '1.56x (provisional)');
    assert.equal(byField(r, 'financialProfile.ratios.dscr').length, 0, 'never stored as a computed ratio');
  });

  it('merges without calling FY2024 vs FY2026 a conflict', async () => {
    const r = await run();
    const revenue = merge(r).fields['financialProfile.annualRevenue'];
    assert.notEqual(revenue.status, 'conflict');
    assert.equal(revenue.value, 3_35_54_93_995);
    assert.equal(fetchCalls, 0);
  });
});
