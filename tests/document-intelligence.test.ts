/**
 * Basic lending documents read with no AI: titles the local classifier recognises, Indian statement
 * layouts (notes, T-form accounts, two year columns in lakhs, provisional headings), a borrower's
 * loan obligation sheet, and a credit analysis (triangulation) report read by its fixed layout.
 * All names, identifiers and figures are FICTIONAL. No test reaches a network.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocally } from '../server/documentAi/localClassifier.ts';
import { extractLocally, splitSides } from '../server/documentAi/localExtractors.ts';
import { REPORT_SUMMARY_CONFIDENCE } from '../server/documentAi/creditAnalysisReport.ts';
import { extractDocument, mergeSessionResults } from '../server/documentAi/pipeline.ts';
import { buildExtractionInstruction } from '../server/documentAi/prompt.ts';
import { shutdownOcr } from '../server/documentAi/ocr.ts';
import type { ParsedSheet } from '../server/documentAi/spreadsheet.ts';
import type { AcceptedFileKind, DocumentExtractionSuccess, DocumentType } from '../src/types/documentAi.ts';
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
const text = (documentType: DocumentType, pages: string[][]) =>
  extractLocally({ documentType, content: { kind: 'text', pages }, fromOcr: false });
const of = (result: { fields: Array<{ fieldId: string }> }, fieldId: string) =>
  result.fields.filter((f) => f.fieldId === fieldId) as ReturnType<typeof text>['fields'];

// ------------------------------------------------------------------ Fictional PDF

function pdfEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A plain one-font text PDF, one line per row, so pdf.js reads the lines back as printed. */
function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + 2 * index} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [ ${kids} ] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, index) => {
    const ops = ['BT', '/F1 9 Tf', '12 TL', '40 760 Td', ...lines.map((line, i) => `${i ? 'T* ' : ''}(${pdfEscape(line)}) Tj`), 'ET'].join('\n');
    objects[4 + 2 * index] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>`;
    objects[5 + 2 * index] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function extract(fileName: string, kind: AcceptedFileKind, bytes: Uint8Array): Promise<DocumentExtractionSuccess> {
  const result = await extractDocument({
    documentId: 'doc_00000001-0000-4000-8000-000000000001',
    fileName,
    kind,
    bytes,
    declaredDocumentType: null,
    today: TODAY,
    signal: new AbortController().signal,
  });
  assert.ok(result.ok, `expected success, got ${result.ok ? '' : result.errorCode}`);
  return result;
}

const merge = (documents: DocumentExtractionSuccess[]) =>
  mergeSessionResults({ documents, editedFieldIds: [], autoApplyThreshold: DOCUMENT_AI_THRESHOLDS.defaultAutoApply, today: TODAY });

// ------------------------------------------------------------------ Classification

describe('local classifier: the basic lending documents by their printed titles', () => {
  const cases: Array<[string, string, DocumentType]> = [
    ['bs.pdf', 'FICTIONAL TRADERS PRIVATE LIMITED\nBalance Sheet as at 31st March 2025\nParticulars Note 31.03.2025 31.03.2024', 'financial_statement'],
    ['pl.pdf', 'Statement of Profit and Loss for the year ended 31 March 2025', 'financial_statement'],
    ['prov.pdf', 'Provisional Balance Sheet as on 31st March 2026', 'financial_statement'],
    ['audit.pdf', "INDEPENDENT AUDITOR'S REPORT\nReport on the Audit of the Standalone Financial Statements", 'financial_statement'],
    ['sheet.xlsx', 'Loan Obligation Sheet\nLender | EMI Amount | Outstanding', 'debt_profile'],
    ['rating.pdf', 'CRISIL Ratings\nRating Rationale\nFictional Mills Limited: Rating Reaffirmed', 'credit_rating_report'],
    ['deck.pdf', 'Corporate Presentation\nFictional Agro Exports', 'company_profile'],
    ['sales.pdf', 'FICTIONAL FABRICS\nSales Report\nPeriod : 01 Apr 24 To 31 Mar 25', 'sales_purchase_ledger'],
    ['report.pdf', 'I N T E G R AT E D C R E D I T A N A LY S I S\nBusiness Credit\nTriangulation Report\nCIBIL GSTR-3B bank statement', 'credit_analysis_report'],
    // Already recognised before: unchanged.
    ['cmr.pdf', 'Company Credit Report\nCIBIL RANK', 'credit_report'],
    ['fs.pdf', 'Balance Sheet\nStatement of Profit and Loss', 'financial_statement'],
  ];
  for (const [fileName, title, expected] of cases) {
    it(`${expected}: ${title.split('\n')[0].slice(0, 40)}`, () => {
      assert.equal(classifyLocally(title, fileName), expected);
    });
  }

  it('still answers nothing when two second-tier types match equally', () => {
    assert.equal(classifyLocally('Balance Sheet as at 31 March 2025\nLoan obligation sheet: EMI', 'x.pdf'), null);
  });
});

// ------------------------------------------------------------------ Financial statements

describe('Indian statement layouts', () => {
  it('reads a provisional Tally-style statement: note numbers, heading period and data source', () => {
    const result = text('financial_statement', [
      [
        'FICTIONAL EXPORTS PRIVATE LIMITED',
        'Provisional Balance Sheet as on 31st March 2026',
        'PARTICULARS AMOUNT',
        '(1) SHAREHOLDERS FUND',
        '(a) Share capital 1 Rs. 3,00,00,000.00',
        "(c) Total shareholders' funds 2 Rs. 14,88,49,093.03",
        'Total current assets 9 Rs. 68,30,17,190.25',
      ],
      [
        'Provisional P & L as on 31st March 2026',
        'Sales Accounts Rs. 1,00,75,91,232.13',
        'Profit Before Tax (PBT) Rs. 7,02,60,372.36',
        'Profit After Tax (PAT) Rs. 4,83,39,136.19',
      ],
    ]);
    const [equity] = of(result, 'financialProfile.shareholdersEquity');
    assert.equal(equity.rawValue, 'Rs. 14,88,49,093.03');
    assert.equal(equity.period, 'FY 2025-26');
    assert.equal(of(result, 'financialProfile.currentAssets')[0].rawValue, 'Rs. 68,30,17,190.25');
    const [revenue] = of(result, 'financialProfile.annualRevenue');
    assert.equal(revenue.rawValue, 'Rs. 1,00,75,91,232.13');
    assert.equal(revenue.period, 'FY 2025-26');
    const pat = of(result, 'financialProfile.netProfitAfterTax');
    assert.deepEqual(pat.map((f) => f.rawValue), ['Rs. 4,83,39,136.19']); // never the PBT row
    const sources = of(result, 'financialProfile.dataSource');
    assert.ok(sources.length > 0);
    assert.ok(sources.every((f) => f.enumValue === 'provisional' && f.period === 'FY 2025-26'));
    assert.ok(of(result, 'financialProfile.financialYearLabel').some((f) => /31st March 2026/.test(f.rawValue)));
  });

  it('splits a horizontal (T-form) account into its two sides', () => {
    assert.deepEqual(splitSides('Capital Account 1 5,90,49,972.83 Fixed Assets 5 24,36,954.01'), [
      'Capital Account 1 5,90,49,972.83',
      'Fixed Assets 5 24,36,954.01',
    ]);
    // Period columns are one row, never two sides.
    assert.deepEqual(splitSides('Revenue from operations 12 1,250.50 1,100.25'), ['Revenue from operations 12 1,250.50 1,100.25']);
    const result = text('financial_statement', [
      [
        'Balance Sheet as on 31st March 2025',
        'Capital Account 1 5,90,49,972.83 Fixed Assets 5 24,36,954.01',
        'Profit & Loss for the year Ending 31st March 2025',
        'To Opening Stock 6,45,05,900.00 By Sales 11 72,33,25,018.08',
        'To Net Profit 6,47,15,306.39',
      ],
    ]);
    assert.equal(of(result, 'financialProfile.shareholdersEquity')[0].rawValue, '5,90,49,972.83');
    assert.equal(of(result, 'financialProfile.annualRevenue')[0].rawValue, '72,33,25,018.08');
    assert.equal(of(result, 'financialProfile.annualRevenue')[0].period, 'FY 2024-25');
    assert.equal(of(result, 'financialProfile.netProfitAfterTax')[0].rawValue, '6,47,15,306.39');
  });

  it('pairs two year columns in lakhs by the heading, and never takes the previous year as current', () => {
    const result = text('financial_statement', [
      [
        'Audited Balance Sheet as at 31 March 2026',
        '(Rs. in lakhs)',
        'Particulars Note 31.03.2026 31.03.2025',
        'Tangible Net Worth 3 2,450.75 2,100.00',
        'Total Outside Liabilities 4 3,120.40 2,980.10',
        'Net Cash Flows from Operating Activities 412.30 (55.20)',
      ],
    ]);
    for (const fieldId of ['financialProfile.tangibleNetWorth', 'financialProfile.totalOutsideLiabilities', 'financialProfile.operatingCashFlow']) {
      const rows = of(result, fieldId);
      assert.equal(rows.length, 2, fieldId);
      assert.equal(rows[0].period, 'FY 2025-26', fieldId);
      assert.equal(rows[1].period, 'FY 2024-25', fieldId);
      assert.ok(rows.every((f) => f.statedUnit === 'lakh'), fieldId);
    }
    assert.equal(of(result, 'financialProfile.tangibleNetWorth')[0].rawValue, '2,450.75');
    assert.equal(of(result, 'financialProfile.operatingCashFlow')[1].rawValue, '(55.20)');
    assert.ok(of(result, 'financialProfile.dataSource').every((f) => f.enumValue === 'audited'));
  });

  it('gives nothing for two figures with no period heading, and no data source from Un-audited', () => {
    const result = text('financial_statement', [
      ['Statement of Un-audited Results', 'Revenue from operations 1,250.50 1,100.25', 'Tangible net worth 900.00 800.00'],
    ]);
    assert.equal(of(result, 'financialProfile.annualRevenue').length, 0);
    assert.equal(of(result, 'financialProfile.tangibleNetWorth').length, 0);
    assert.equal(of(result, 'financialProfile.dataSource').length, 0);
  });

  it('reads a fictional audited statement PDF end to end with no AI', async () => {
    const pdf = buildPdf([
      [
        'FICTIONAL MILLS PRIVATE LIMITED',
        'Balance Sheet as at 31 March 2026',
        '(Rs. in lakhs)',
        'Particulars Note 31.03.2026 31.03.2025',
        "Total shareholders' funds 2 2,450.75 2,100.00",
        'Total current assets 9 3,980.20 3,410.00',
        'Total current liabilities 10 2,105.60 1,990.45',
      ],
      [
        'Statement of Profit and Loss for the year ended 31 March 2026',
        '(Rs. in lakhs)',
        'Particulars Note 31.03.2026 31.03.2025',
        'Revenue from operations 12 9,875.40 8,640.10',
        'Profit for the year 512.35 401.20',
      ],
    ]);
    const result = await extract('fictional-audited.pdf', 'pdf', pdf);
    assert.equal(result.documentType, 'financial_statement');
    assert.equal(result.model, 'local-rules');
    const merged = merge([result]).fields;
    assert.equal(merged['financialProfile.annualRevenue'].value, 987540000);
    assert.equal(merged['financialProfile.previousAnnualRevenue'].value, 864010000);
    assert.equal(merged['financialProfile.netProfitAfterTax'].value, 51235000);
    assert.equal(merged['financialProfile.currentAssets'].value, 398020000);
    assert.equal(merged['financialProfile.shareholdersEquity'].value, 245075000);
    assert.equal(merged['profitabilityStatus'].value, 'profitable_2plus_years');
    assert.equal(merged['financialProfile.annualRevenue'].status, 'auto_applied');
  });
});

describe('model fallback asks only for what the server could not read', () => {
  it('leaves fields already read out of the extraction instruction', () => {
    const all = buildExtractionInstruction('financial_statement');
    const missingOnly = buildExtractionInstruction(
      'financial_statement',
      new Set(['financialProfile.annualRevenue', 'financialProfile.netProfitAfterTax'])
    );
    assert.match(all, /- financialProfile\.annualRevenue:/);
    assert.doesNotMatch(missingOnly, /- financialProfile\.annualRevenue:/);
    assert.doesNotMatch(missingOnly, /- financialProfile\.netProfitAfterTax:/);
    assert.match(missingOnly, /- financialProfile\.tangibleNetWorth:/);
  });
});

// ------------------------------------------------------------------ Debt profile

const sheet = (rows: string[][]): ParsedSheet => ({
  name: 'Obligations',
  hidden: false,
  rows: rows.map((cells, r) => ({
    rowNumber: r + 1,
    cells: cells.flatMap((text, c) => (text ? [{ ref: `${String.fromCharCode(65 + c)}${r + 1}`, column: c, text }] : [])),
  })),
});

describe('loan obligation sheet (debt_profile)', () => {
  it("takes the printed Total under the EMI and Outstanding headings, by column, for review", () => {
    const result = extractLocally({
      documentType: 'debt_profile',
      fromOcr: false,
      content: {
        kind: 'sheets',
        fileKind: 'xlsx',
        sheets: [
          sheet([
            ['Sr No', 'Lender', 'Sanctioned Amount', 'Outstanding', 'EMI Start Date', 'EMI Amount'],
            ['1', 'Fictional Bank', '50,00,000', '41,20,000', '05-01-2025', '1,10,500'],
            ['2', 'Fictional NBFC', '20,00,000', '12,40,000', '05-06-2024', '72,300'],
            ['', 'TOTAL', '70,00,000', '53,60,000', '', '1,82,800'],
          ]),
        ],
      },
    });
    const [emi] = of(result, 'financialProfile.existingMonthlyEmi');
    assert.equal(emi.rawValue, '1,82,800');
    assert.equal(emi.cellRef, 'F4');
    assert.ok(emi.confidence < DOCUMENT_AI_THRESHOLDS.minAutoApply);
    assert.equal(of(result, 'financialProfile.totalOutstandingBorrowings')[0].rawValue, '53,60,000');
    assert.equal(result.fields.length, 2); // rows are never added up
  });

  it('two Total rows (subtotals) become a conflict, never a sum', async () => {
    const result = extractLocally({
      documentType: 'debt_profile',
      fromOcr: false,
      content: {
        kind: 'sheets',
        fileKind: 'xlsx',
        sheets: [sheet([['Lender', 'EMI Amount (Rs.)'], ['A', '10,000'], ['TOTAL', '10,000'], ['B', '20,000'], ['TOTAL', '20,000']])],
      },
    });
    assert.deepEqual(of(result, 'financialProfile.existingMonthlyEmi').map((f) => f.rawValue), ['10,000', '20,000']);
  });
});

// ------------------------------------------------------------------ Credit analysis report

const PAN_PROPRIETOR = 'ABCPF1234K';
const GSTIN = buildGstin('27', PAN_PROPRIETOR);

function reportPages(pan = PAN_PROPRIETOR): string[][] {
  return [
    ['I N T E G R AT E D C R E D I T A N A LY S I S', 'Business Credit', 'Triangulation Report', 'Fictional Weaves'],
    [
      'S E C T I O N 1',
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
      'S E C T I O N 3',
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
      'S E C T I O N 5',
      'Monthly Credits by Category (chronological)',
      'Month Gross Credits Own Account Loans Reversals And Other Unclassified Business Receipts Data Quality',
      'Jul 2025 ₹4,00,00,000 ₹10,00,000 ₹0 ₹0 ₹0 ₹3,90,00,000 complete',
      'Aug 2025 ₹5,00,00,000 ₹20,00,000 ₹0 ₹0 ₹0 ₹4,80,00,000 complete',
      'Sep 2025 ₹6,00,00,000 ₹30,00,000 ₹0 ₹0 ₹0 ₹5,70,00,000 complete',
      'Banking Turnover (BTO) 74.65%',
    ],
    [
      'S E C T I O N 6',
      'Bureau / CIBIL / CMR',
      'CIBIL Score (consumer, 781 AVAILABLE',
      'promoter)',
      'Company CMR (CIBIL MSME 3 AVAILABLE',
      'Total Emi ₹9,99,999',
      'Outstanding ₹4,40,00,000 AVAILABLE',
      'Monthly EMI used for debt ₹18,40,000 AVAILABLE',
      'service',
    ],
  ];
}

describe('credit analysis (triangulation) report', () => {
  it('reads the year table by its column headings; N/A stays missing; thresholds are never values', () => {
    const result = text('credit_analysis_report', reportPages());
    const revenue = of(result, 'financialProfile.annualRevenue');
    assert.deepEqual(
      revenue.map((f) => [f.period, f.rawValue]),
      [
        ['FY 2023-24', '₹40,10,00,000'],
        ['FY 2024-25', '₹52,20,00,000'],
        ['FY 2025-26', '₹61,30,00,000'],
      ]
    );
    assert.equal(of(result, 'financialProfile.operatingCashFlow').length, 0);
    // N/A in the middle column: the other two keep their own years.
    assert.deepEqual(of(result, 'financialProfile.totalOutsideLiabilities').map((f) => f.period), ['FY 2023-24', 'FY 2025-26']);
    assert.deepEqual(
      of(result, 'financialProfile.dataSource').map((f) => [f.period, f.enumValue]),
      [
        ['FY 2023-24', 'audited'],
        ['FY 2024-25', 'audited'],
        ['FY 2025-26', 'provisional'],
      ]
    );
    // The score from the bureau section, never the 750 threshold; a proprietor's PAN: personal score.
    assert.deepEqual(of(result, 'financialProfile.personalCibilScore').map((f) => f.rawValue), ['781']);
    assert.equal(of(result, 'financialProfile.commercialCmrRank')[0].rawValue, '3');
    // The printed debt-service EMI, never the promoter report's Total Emi row.
    assert.deepEqual(of(result, 'financialProfile.existingMonthlyEmi').map((f) => f.rawValue), ['₹18,40,000']);
    assert.equal(of(result, 'financialProfile.totalOutstandingBorrowings')[0].rawValue, '₹4,40,00,000');
    // Gross Credits column, quoted with its heading.
    assert.deepEqual(result.bankMonthlyTotals.map((m) => [m.month, m.totalCredits]), [
      ['2025-07', '₹4,00,00,000'],
      ['2025-08', '₹5,00,00,000'],
      ['2025-09', '₹6,00,00,000'],
    ]);
    assert.match(result.bankMonthlyTotals[0].snippet, /^Month Gross Credits/);
    // Restated figures are reviewed; only the printed score and identity rows may apply.
    for (const field of result.fields) {
      if (['financialProfile.personalCibilScore', 'identity.pan', 'identity.gstin', 'applicantLabel'].includes(field.fieldId)) continue;
      assert.equal(field.confidence, REPORT_SUMMARY_CONFIDENCE, field.fieldId);
    }
    assert.ok(!result.fields.some((f) => /dscr|tol|ratio/i.test(f.fieldId)));
  });

  it("gives a company's report score to the promoter field", () => {
    const result = text('credit_analysis_report', reportPages('ABCCF1234K'));
    assert.equal(of(result, 'financialProfile.personalCibilScore').length, 0);
    assert.equal(of(result, 'financialProfile.promoterCibilScore')[0].rawValue, '781');
  });

  it('is classified by its title and merged with the latest year current, prior year previous, all reviewed', async () => {
    const body = Buffer.from(reportPages().map((lines) => lines.join('\n')).join('\n'), 'utf8');
    const result = await extract('triangulation.txt', 'txt', body);
    assert.equal(result.documentType, 'credit_analysis_report');
    const fields = merge([result]).fields;
    assert.equal(fields['financialProfile.annualRevenue'].value, 613000000);
    assert.equal(fields['financialProfile.annualRevenue'].status, 'needs_verification');
    assert.equal(fields['financialProfile.previousAnnualRevenue'].value, 522000000);
    assert.equal(fields['financialProfile.netProfitAfterTax'].value, 17200000);
    assert.equal(fields['financialProfile.tangibleNetWorth'].value, 91200000);
    assert.equal(fields['financialProfile.dataSource'].value, 'provisional');
    assert.equal(fields['financialProfile.personalCibilScore'].status, 'auto_applied');
    assert.equal(fields['financialProfile.personalCibilScore'].value, 781);
    assert.equal(fields['financialProfile.existingMonthlyEmi'].value, 1840000);
    assert.equal(fields['financialProfile.existingMonthlyEmi'].status, 'needs_verification');
    assert.equal(fields['financialProfile.averageMonthlyBankingCredits'].value, 50000000);
    assert.equal(fields['financialProfile.averageMonthlyBankingCredits'].status, 'needs_verification');
    assert.equal(fields['financialProfile.operatingCashFlow'], undefined);
    assert.equal(fields['financialProfile.annualScheduledPrincipalRepayments'], undefined);
  });
});
