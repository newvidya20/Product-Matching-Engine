/**
 * Deterministic extractors (server/documentAi/localExtractors.ts) and OCR text clean-up. Pure: no
 * model, no network. All text is fictional.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractLocally, LOCAL_OCR_CONFIDENCE, LOCAL_TEXT_CONFIDENCE, readMonth } from '../server/documentAi/localExtractors.ts';
import { ocrTextToLines, repairOcrFigures } from '../server/documentAi/ocr.ts';
import type { DocumentType } from '../src/types/documentAi.ts';

const text = (documentType: DocumentType, lines: string[], fromOcr = false) =>
  extractLocally({ documentType, content: { kind: 'text', pages: [lines] }, fromOcr });
const byField = (result: ReturnType<typeof text>, fieldId: string) => result.fields.filter((f) => f.fieldId === fieldId);

describe('labelled values from text', () => {
  it('reads GST turnover with its financial year and quotes the line it came from', () => {
    const result = text('gst_return', [
      'GST Annual Return Summary (FICTIONAL)',
      'Financial year: FY 2024-25',
      'Aggregate turnover as per return: Rs. 1,25,00,000.00',
    ]);
    const [turnover] = byField(result, 'financialProfile.gstAnnualTurnover');
    assert.equal(turnover.rawValue, 'Rs. 1,25,00,000.00');
    assert.equal(turnover.period, 'FY 2024-25');
    assert.equal(turnover.page, 1);
    assert.equal(turnover.snippet, 'Aggregate turnover as per return: Rs. 1,25,00,000.00');
    assert.equal(turnover.confidence, LOCAL_TEXT_CONFIDENCE);
  });

  it('never takes a preceding-year turnover as this year', () => {
    const result = text('gst_return', [
      'Financial year: FY 2024-25',
      'Aggregate turnover in the preceding financial year: Rs. 90,00,000',
    ]);
    assert.equal(byField(result, 'financialProfile.gstAnnualTurnover').length, 0);
  });

  it('pairs figures with period columns, skipping a note number, and keeps the stated unit', () => {
    const result = text('financial_statement', [
      '(Rs. in lakhs)',
      'Particulars  Note  FY 2024-25  FY 2023-24',
      'Revenue from operations  18  1,250.00  1,000.00',
    ]);
    const revenue = byField(result, 'financialProfile.annualRevenue');
    assert.deepEqual(
      revenue.map((f) => [f.rawValue, f.period, f.statedUnit]),
      [
        ['1,250.00', 'FY 2024-25', 'lakh'],
        ['1,000.00', 'FY 2023-24', 'lakh'],
      ]
    );
  });

  it('never takes a unit phrase in a sentence as a unit heading', () => {
    const result = text('financial_statement', [
      'Particulars  FY 2024-25',
      'The directors note that the company now reports its results in lakhs rather than in thousands as before',
      'Revenue from operations  1,250.00',
    ]);
    const [revenue] = byField(result, 'financialProfile.annualRevenue');
    assert.equal(revenue.rawValue, '1,250.00');
    assert.equal(revenue.statedUnit, null);
  });

  it('a unit phrase on a line with a figure is not a heading', () => {
    const result = text('financial_statement', [
      'Particulars  FY 2024-25',
      'Loans of 25 in lakhs were repaid',
      'Revenue from operations  1,250.00',
    ]);
    assert.equal(byField(result, 'financialProfile.annualRevenue')[0].statedUnit, null);
  });

  it('still reads a short or bracketed unit heading', () => {
    for (const heading of ['All figures in lakhs unless otherwise stated', 'Amount in ₹ crores', '(Rs. in lakhs)']) {
      const result = text('financial_statement', [heading, 'Particulars  FY 2024-25', 'Revenue from operations  1,250.00']);
      assert.ok(byField(result, 'financialProfile.annualRevenue')[0].statedUnit, heading);
    }
  });

  it('a bracketed unit on a row of figures applies to that row only', () => {
    const result = text('financial_statement', [
      'Particulars  FY 2024-25',
      'Revenue from operations (Rs. in lakhs)  1,250.00',
      'Total current assets  310.00',
    ]);
    assert.equal(byField(result, 'financialProfile.annualRevenue')[0].statedUnit, 'lakh');
    assert.equal(byField(result, 'financialProfile.currentAssets')[0].statedUnit, null);
  });

  it('does not carry a unit or period columns to the next page', () => {
    const result = extractLocally({
      documentType: 'financial_statement',
      content: {
        kind: 'text',
        pages: [
          ['(Rs. in lakhs)', 'Particulars  FY 2024-25  FY 2023-24', 'Revenue from operations  1,250.00  1,000.00'],
          ['Total current assets  310.00  280.00'],
        ],
      },
      fromOcr: false,
    });
    assert.equal(byField(result, 'financialProfile.annualRevenue').length, 2);
    // Page 2 has two figures and no heading of its own: the periods are not stated there.
    assert.equal(byField(result, 'financialProfile.currentAssets').length, 0);
  });

  it('does not carry a unit or period columns into a new statement on the same page', () => {
    const result = text('financial_statement', [
      '(Rs. in lakhs)',
      'Particulars  FY 2024-25  FY 2023-24',
      'Revenue from operations  1,250.00  1,000.00',
      'Cash Flow Statement for the year ended 31.03.2025',
      'Particulars  FY 2024-25',
      'Net cash generated from operating activities  95.00',
    ]);
    assert.equal(byField(result, 'financialProfile.annualRevenue')[0].statedUnit, 'lakh');
    const [cash] = byField(result, 'financialProfile.operatingCashFlow');
    assert.equal(cash.rawValue, '95.00');
    assert.equal(cash.statedUnit, null);
  });

  it('returns nothing when the figures do not fit the columns (unknown layout)', () => {
    const result = text('financial_statement', ['Particulars  FY 2024-25  FY 2023-24', 'EBITDA  140.00']);
    assert.equal(byField(result, 'financialProfile.ebitda').length, 0);
  });

  it('returns nothing for two figures with no period heading', () => {
    const result = text('financial_statement', ['Revenue from operations  1,250.00  1,000.00']);
    assert.equal(byField(result, 'financialProfile.annualRevenue').length, 0);
  });

  it('reads a CIBIL score and a CMR rank, and marks the commercial report available', () => {
    const result = text('credit_report', ['CIBIL Score: 762', 'CMR Rank: CMR-4']);
    assert.equal(byField(result, 'financialProfile.personalCibilScore')[0]?.rawValue, '762');
    assert.equal(byField(result, 'financialProfile.commercialCmrRank')[0]?.rawValue, 'CMR-4');
    assert.equal(byField(result, 'financialProfile.commercialCreditReportStatus')[0]?.enumValue, 'available');
  });

  it('ignores a score line holding more than one possible score', () => {
    const result = text('credit_report', ['CIBIL Score: 762 (previous 701)']);
    assert.equal(byField(result, 'financialProfile.personalCibilScore').length, 0);
  });

  it('extracts nothing from a document of unknown type', () => {
    const result = text('other', ['Aggregate turnover: Rs. 1,00,000', 'CIBIL Score: 700']);
    assert.deepEqual(result, { fields: [], bankMonthlyTotals: [] });
  });

  it('only reports fields the document type may supply', () => {
    const result = text('bank_statement', ['CIBIL Score: 700', 'Aggregate turnover: Rs. 10,00,000']);
    assert.equal(result.fields.length, 0);
  });

  it('marks OCR values below every auto-apply threshold', () => {
    const result = text('credit_report', ['CIBIL Score: 762'], true);
    assert.equal(result.fields[0]?.confidence, LOCAL_OCR_CONFIDENCE);
    assert.ok(LOCAL_OCR_CONFIDENCE < 0.7);
  });
});

describe('bank statement months', () => {
  it('reads a printed monthly summary table, never summing transactions', () => {
    const result = text('bank_statement', [
      'Statement of Account',
      'Account number: XXXXXX9876',
      'Month  Total Credits  Total Debits  Closing Balance',
      'Apr-2025  4,10,000.00  3,95,000.00  2,15,000.00',
      'May-2025  3,80,000.00  3,60,000.00  2,35,000.00',
    ]);
    assert.deepEqual(
      result.bankMonthlyTotals.map((m) => [m.month, m.totalCredits, m.closingBalance, m.subjectRef]),
      [
        ['2025-04', '4,10,000.00', '2,15,000.00', 'XXXXXX9876'],
        ['2025-05', '3,80,000.00', '2,35,000.00', 'XXXXXX9876'],
      ]
    );
  });

  it('uses the printed totals of a one-month statement', () => {
    const result = text('bank_statement', [
      'Statement period: 01-05-2025 to 31-05-2025',
      '02-05-2025 NEFT CR CLIENT A 85,000.00 Cr 3,20,000.00 Cr',
      'Total credits: 2,40,000.00 Cr',
      'Closing balance: 1,95,000.00 Cr',
    ]);
    assert.deepEqual(
      result.bankMonthlyTotals.map((m) => [m.month, m.totalCredits, m.closingBalance]),
      [['2025-05', '2,40,000.00 Cr', '1,95,000.00 Cr']]
    );
  });

  it('gives no month for a multi-month statement that prints only a grand total', () => {
    const result = text('bank_statement', [
      'Statement period: 01-04-2025 to 30-06-2025',
      'Total credits: 12,40,000.00',
      'Closing balance: 1,95,000.00',
    ]);
    assert.equal(result.bankMonthlyTotals.length, 0);
  });

  it('drops a summary row that does not fit the heading', () => {
    const result = text('bank_statement', [
      'Month  Total Credits  Closing Balance',
      'Apr-2025  4,10,000.00',
    ]);
    assert.equal(result.bankMonthlyTotals.length, 0);
  });

  it('reads month labels in the common forms', () => {
    assert.equal(readMonth('Apr-2025 1'), '2025-04');
    assert.equal(readMonth("Sept'24"), '2024-09');
    assert.equal(readMonth('04/2025'), '2025-04');
    assert.equal(readMonth('2025-04'), '2025-04');
    assert.equal(readMonth('Opening balance'), null);
  });
});

describe('spreadsheet cells', () => {
  it('pairs a value cell with the period heading over its column and cites the cell', () => {
    const result = extractLocally({
      documentType: 'financial_statement',
      fromOcr: false,
      content: {
        kind: 'sheets',
        fileKind: 'xlsx',
        sheets: [
          {
            name: 'P&L',
            hidden: false,
            rows: [
              { rowNumber: 1, cells: [{ ref: 'A1', column: 0, text: 'Particulars' }, { ref: 'B1', column: 1, text: 'FY 2024-25' }] },
              { rowNumber: 2, cells: [{ ref: 'A2', column: 0, text: 'Profit after tax' }, { ref: 'B2', column: 1, text: '3220000' }] },
            ],
          },
        ],
      },
    });
    const [pat] = result.fields;
    assert.equal(pat.fieldId, 'financialProfile.netProfitAfterTax');
    assert.equal(pat.cellRef, 'B2');
    assert.equal(pat.sheetName, 'P&L');
    assert.equal(pat.period, 'FY 2024-25');
  });
});

describe('OCR text clean-up', () => {
  it('repairs a grouping mark read as a full stop only when one reading is possible', () => {
    assert.equal(repairOcrFigures('Rs. 1.25,00,000.00'), 'Rs. 1,25,00,000.00');
    assert.equal(repairOcrFigures('3.80.000.00'), '3,80,000.00');
    assert.equal(repairOcrFigures('1,25,00,000.00'), '1,25,00,000.00');
    assert.equal(repairOcrFigures('12.50'), '12.50');
    assert.equal(repairOcrFigures('1.2.3.45'), '1.2.3.45');
  });

  it('leaves a figure untouched when more than one reading is possible', () => {
    // The first full stop may be the real decimal point: 1,234.56 followed by noise.
    assert.equal(repairOcrFigures('1,234.567.89'), '1,234.567.89');
    assert.equal(repairOcrFigures('1,25.00.000.00'), '1,25.00.000.00');
    // Fits neither grouping: a 3-digit first group with 2-digit groups.
    assert.equal(repairOcrFigures('123.45.678.90'), '123.45.678.90');
    // Mixed group sizes.
    assert.equal(repairOcrFigures('1.234.56.789.00'), '1.234.56.789.00');
    // Only full stops, Western grouping: one reading.
    assert.equal(repairOcrFigures('1.234.567.89'), '1,234,567.89');
  });

  it('splits OCR text into trimmed lines and drops noise', () => {
    assert.deepEqual(ocrTextToLines('  CIBIL Score: 762  \n\n | \nCMR Rank:     CMR-4\n'), ['CIBIL Score: 762', 'CMR Rank:  CMR-4']);
  });
});

describe('a figure with no period of its own (audit E)', () => {
  const twoPages = (pageTwoHeading: string) =>
    extractLocally({
      documentType: 'financial_statement',
      fromOcr: false,
      content: {
        kind: 'text',
        pages: [
          ['Statement of Profit and Loss (FICTIONAL)', 'For the year ended 31 March 2025', 'Revenue from operations  1,25,00,000'],
          [pageTwoHeading, 'Revenue from operations  1,00,00,000'],
        ],
      },
    });

  it('a two-year statement whose page 2 lists the prior year under an unrecognised heading: no period is guessed', () => {
    const result = twoPages('Comparative figures (2023-24)');
    const revenue = byField(result, 'financialProfile.annualRevenue');
    assert.deepEqual(
      revenue.map((f) => [f.rawValue, f.page, f.period]),
      [
        // Page 1's own heading states its period.
        ['1,25,00,000', 1, 'FY 2024-25'],
        // Page 2's figure never takes the first period found in the document: period_unknown.
        ['1,00,00,000', 2, null],
      ]
    );
  });

  it('a prior-year heading with no year printed also counts as a second period', () => {
    const result = twoPages('Previous year figures');
    const pageTwo = byField(result, 'financialProfile.annualRevenue').find((f) => f.page === 2);
    assert.ok(pageTwo);
    assert.equal(pageTwo.period, null);
  });

  it('control: a document that states exactly one period gives it to a figure with no column', () => {
    const result = text('financial_statement', [
      'Statement of Profit and Loss (FICTIONAL)',
      'For the year ended 31 March 2025',
      'Revenue from operations  1,25,00,000',
    ]);
    assert.equal(byField(result, 'financialProfile.annualRevenue')[0].period, 'FY 2024-25');
  });

  it('the same year written two ways is one period: assessment year 2025-26 is FY 2024-25', () => {
    const result = text('itr', [
      'Assessment Year 2025-26',
      'Financial Year 2024-25',
      'Gross receipts  48,00,000',
    ]);
    assert.equal(byField(result, 'financialProfile.annualRevenue')[0]?.period, 'FY 2024-25');
  });

  it('a report or filing date is not a second period', () => {
    const result = text('gst_return', [
      'Financial year: FY 2024-25',
      'Date of filing: 20.12.2025',
      'Aggregate turnover: Rs. 1,25,00,000.00',
    ]);
    assert.equal(byField(result, 'financialProfile.gstAnnualTurnover')[0].period, 'FY 2024-25');
  });

  it('with pages left unread, no figure takes a document-wide period', () => {
    const result = extractLocally({
      documentType: 'financial_statement',
      fromOcr: false,
      complete: false,
      content: { kind: 'text', pages: [['Financial year: FY 2024-25'], ['Revenue from operations  1,25,00,000']] },
    });
    assert.equal(byField(result, 'financialProfile.annualRevenue')[0].period, null);
    const whole = extractLocally({
      documentType: 'financial_statement',
      fromOcr: false,
      content: { kind: 'text', pages: [['Financial year: FY 2024-25'], ['Revenue from operations  1,25,00,000']] },
    });
    assert.equal(byField(whole, 'financialProfile.annualRevenue')[0].period, 'FY 2024-25', 'control: read in full');
  });

  it('a spreadsheet that states two periods gives no period to a figure without a heading', () => {
    const cell = (ref: string, column: number, value: string) => ({ ref, column, text: value });
    const result = extractLocally({
      documentType: 'financial_statement',
      fromOcr: false,
      content: {
        kind: 'sheets',
        fileKind: 'xlsx',
        sheets: [
          {
            name: 'Summary',
            hidden: false,
            rows: [
              { rowNumber: 1, cells: [cell('A1', 0, 'For the year ended 31 March 2025')] },
              { rowNumber: 2, cells: [cell('A2', 0, 'Revenue from operations'), cell('B2', 1, '12500000')] },
            ],
          },
          {
            name: 'Prior',
            hidden: false,
            rows: [
              { rowNumber: 1, cells: [cell('A1', 0, 'Comparative figures 2023-24')] },
              { rowNumber: 2, cells: [cell('A2', 0, 'Revenue from operations'), cell('B2', 1, '10000000')] },
            ],
          },
        ],
      },
    });
    const revenue = byField(result, 'financialProfile.annualRevenue');
    assert.equal(revenue.length, 2);
    assert.ok(revenue.every((f) => f.period === null));
  });
});
