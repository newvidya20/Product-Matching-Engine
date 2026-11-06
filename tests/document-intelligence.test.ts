import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocally } from '../server/documentAi/localClassifier.ts';
import { extractLocally } from '../server/documentAi/localExtractors.ts';
import { REPORT_SUMMARY_CONFIDENCE } from '../server/documentAi/creditAnalysisReport.ts';
import { extractDocument, mergeSessionResults } from '../server/documentAi/pipeline.ts';
import { shutdownOcr } from '../server/documentAi/ocr.ts';
import type { DocumentExtractionSuccess, DocumentType } from '../src/types/documentAi.ts';
import { DOCUMENT_AI_THRESHOLDS } from '../src/types/documentAi.ts';
import { buildGstin } from './helpers/documentAi.ts';

const MODEL_ENV = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'DOCUMENT_AI_LLM_FALLBACK', 'DOCUMENT_AI_OCR'];
const savedEnv = Object.fromEntries(MODEL_ENV.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

before(() => {
  for (const key of MODEL_ENV) delete process.env[key];
  process.env.DOCUMENT_AI_LLM_FALLBACK = 'off';
  process.env.DOCUMENT_AI_OCR = 'off';
  globalThis.fetch = (async () => {
    throw new Error('network access is not allowed in this test');
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await shutdownOcr();
});

const TODAY = '2026-11-04';
const PAN_PROPRIETOR = 'ABCPF1234K';
const GSTIN = buildGstin('27', PAN_PROPRIETOR);
const text = (documentType: DocumentType, pages: string[][]) =>
  extractLocally({ documentType, content: { kind: 'text', pages }, fromOcr: false });
const of = (result: { fields: Array<{ fieldId: string }> }, fieldId: string) =>
  result.fields.filter((field) => field.fieldId === fieldId) as ReturnType<typeof text>['fields'];

function reportPages(pan = PAN_PROPRIETOR): string[][] {
  return [
    ['I N T E G R AT E D C R E D I T A N A LY S I S', 'Business Credit', 'Triangulation Report', 'Fictional Weaves'],
    [
      'Company & Credit Snapshot',
      'FIELD VALIDATED VALUE / ASSESSMENT STATUS',
      'Company Name Fictional Weaves AVAILABLE',
      `PAN ${pan} AVAILABLE`,
      `GSTIN ${GSTIN} AVAILABLE`,
      'Benchmark Approved Rule Value Result',
      'CIBIL Score Minimum 750 or above 781 PASS',
      'Company CMR Below 7 3 PASS',
      'TOL / TNW Ratio Maximum 4.00 1.10x (provisional) PASS',
      'DSCR Strictly above 1.00 1.85x (provisional) PASS',
      'For FY2025-26 the firm reported provisional sales; audited FY2024-25 and FY2023-24 are compared.',
    ],
    [
      'Financial Analysis – Year-on-Year Comparison',
      'Financial Metric FY2024 FY2025 FY2026',
      'Reporting Basis & Source Audited financial statements — Audited financial statements — Provisional (unaudited) financial',
      'Revenue / Turnover ₹40,10,00,000 ₹52,20,00,000 ₹61,30,00,000',
      'EBITDA (EBIT + Depreciation) ₹2,10,00,000 ₹2,60,00,000 ₹3,05,00,000',
      'EBITDA Margin 5.24% 4.98% 4.98%',
      'Net Profit / PAT ₹1,05,00,000 ₹1,40,00,000 ₹1,72,00,000',
      'Operating Cash Flow (net cash from operating N/A N/A N/A',
      'activities)',
      'Tangible Net Worth (Net Worth − Intangible ₹6,00,00,000 ₹7,40,00,000 ₹9,12,00,000',
      'Current Assets ₹12,00,00,000 ₹14,50,00,000 ₹17,80,00,000',
      'Total Outside Liabilities ₹8,10,00,000 N/A ₹10,05,00,000',
      'DSCR N/A N/A 1.85x',
    ],
    [
      'Monthly Credits by Category (chronological)',
      'Month Gross Credits Own Account Loans Reversals And Other Unclassified Business Receipts Data Quality',
      'Jul 2025 ₹4,00,00,000 ₹10,00,000 ₹0 ₹0 ₹0 ₹3,90,00,000 complete',
      'Aug 2025 ₹5,00,00,000 ₹20,00,000 ₹0 ₹0 ₹0 ₹4,80,00,000 complete',
      'Sep 2025 ₹6,00,00,000 ₹30,00,000 ₹0 ₹0 ₹0 ₹5,70,00,000 complete',
      'Banking Turnover (BTO) 74.65%',
    ],
    [
      'Bureau / CIBIL / CMR',
      'CIBIL Score (consumer, 781 AVAILABLE',
      'Company CMR (CIBIL MSME 3 AVAILABLE',
      'Total Emi ₹9,99,999',
      'Outstanding ₹4,40,00,000 AVAILABLE',
      'Monthly EMI used for debt ₹18,40,000 AVAILABLE',
    ],
  ];
}

describe('credit analysis triangulation report', () => {
  it('is classified by its own title before the CIBIL and banking references in its body', () => {
    const title = `${reportPages().flat().join('\n')}`;
    assert.equal(classifyLocally(title, 'credit-summary.txt'), 'credit_analysis_report');
    assert.equal(classifyLocally('Company Credit Report\nCIBIL RANK', 'bureau.txt'), 'credit_report');
  });

  it('reads fixed columns, ignores policy ratios and thresholds, and keeps reported DSCR review-only', () => {
    const result = text('credit_analysis_report', reportPages());
    assert.deepEqual(
      of(result, 'financialProfile.annualRevenue').map((field) => [field.period, field.rawValue]),
      [
        ['FY 2023-24', '₹40,10,00,000'],
        ['FY 2024-25', '₹52,20,00,000'],
        ['FY 2025-26', '₹61,30,00,000'],
      ]
    );
    assert.equal(of(result, 'financialProfile.operatingCashFlow').length, 0);
    assert.deepEqual(
      of(result, 'financialProfile.totalOutsideLiabilities').map((field) => field.period),
      ['FY 2023-24', 'FY 2025-26']
    );
    assert.deepEqual(
      of(result, 'financialProfile.dataSource').map((field) => [field.period, field.enumValue]),
      [
        ['FY 2023-24', 'audited'],
        ['FY 2024-25', 'audited'],
        ['FY 2025-26', 'provisional'],
      ]
    );
    assert.deepEqual(of(result, 'financialProfile.personalCibilScore').map((field) => field.rawValue), ['781']);
    assert.equal(of(result, 'financialProfile.commercialCmrRank')[0].rawValue, '3');
    assert.deepEqual(of(result, 'financialProfile.existingMonthlyEmi').map((field) => field.rawValue), ['₹18,40,000']);
    assert.equal(of(result, 'financialProfile.totalOutstandingBorrowings')[0].rawValue, '₹4,40,00,000');
    assert.deepEqual(
      result.bankMonthlyTotals.map((month) => [month.month, month.totalCredits]),
      [
        ['2025-07', '₹4,00,00,000'],
        ['2025-08', '₹5,00,00,000'],
        ['2025-09', '₹6,00,00,000'],
      ]
    );
    assert.match(result.bankMonthlyTotals[0].snippet, /^Month Gross Credits/);
    for (const field of result.fields) {
      if (['financialProfile.personalCibilScore', 'identity.pan', 'identity.gstin', 'applicantLabel'].includes(field.fieldId)) continue;
      assert.equal(field.confidence, REPORT_SUMMARY_CONFIDENCE, field.fieldId);
    }
    assert.deepEqual(
      of(result, 'financialProfile.statedDscr').map((field) => [field.period, field.rawValue]),
      [['FY 2025-26', '1.85']]
    );
    assert.ok(!result.fields.some((field) => /tol|ratio/i.test(field.fieldId)));
  });

  it("maps a company's consumer score to the promoter field", () => {
    const result = text('credit_analysis_report', reportPages('ABCCF1234K'));
    assert.equal(of(result, 'financialProfile.personalCibilScore').length, 0);
    assert.equal(of(result, 'financialProfile.promoterCibilScore')[0].rawValue, '781');
  });

  it('extracts and merges the report without AI, retaining review statuses and period ordering', async () => {
    const bytes = Buffer.from(reportPages().map((page) => page.join('\n')).join('\n'), 'utf8');
    const result = await extractDocument({
      documentId: 'doc_00000001-0000-4000-8000-000000000001',
      fileName: 'triangulation.txt',
      kind: 'txt',
      bytes,
      declaredDocumentType: null,
      today: TODAY,
      signal: new AbortController().signal,
    });
    assert.ok(result.ok, `expected success, got ${result.ok ? '' : result.errorCode}`);
    const merged = mergeSessionResults({
      documents: [result as DocumentExtractionSuccess],
      editedFieldIds: [],
      autoApplyThreshold: DOCUMENT_AI_THRESHOLDS.defaultAutoApply,
      today: TODAY,
    }).fields;
    assert.equal(result.documentType, 'credit_analysis_report');
    assert.equal(merged['financialProfile.annualRevenue'].value, 613000000);
    assert.equal(merged['financialProfile.annualRevenue'].status, 'needs_verification');
    assert.equal(merged['financialProfile.previousAnnualRevenue'].value, 522000000);
    assert.equal(merged['financialProfile.netProfitAfterTax'].value, 17200000);
    assert.equal(merged['financialProfile.tangibleNetWorth'].value, 91200000);
    assert.equal(merged['financialProfile.dataSource'].value, 'provisional');
    assert.equal(merged['financialProfile.personalCibilScore'].status, 'auto_applied');
    assert.equal(merged['financialProfile.personalCibilScore'].value, 781);
    assert.equal(merged['financialProfile.existingMonthlyEmi'].value, 1840000);
    assert.equal(merged['financialProfile.existingMonthlyEmi'].status, 'needs_verification');
    assert.equal(merged['financialProfile.averageMonthlyBankingCredits'].value, 50000000);
    assert.equal(merged['financialProfile.averageMonthlyBankingCredits'].status, 'needs_verification');
    assert.equal(merged['financialProfile.statedDscr'].value, 1.85);
    assert.equal(merged['financialProfile.statedDscr'].status, 'needs_verification');
    assert.equal(merged['financialProfile.operatingCashFlow'], undefined);
    assert.equal(merged['financialProfile.annualScheduledPrincipalRepayments'], undefined);
  });
});
