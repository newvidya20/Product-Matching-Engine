import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFinancialStatements } from '../server/documentAi/financialStatements.ts';

const BS = [
  'FICTIONAL TEST CO LIMITED',
  'AUDITED STATEMENT OF ASSETS & LIABILITIES AS ON MARCH 31, 2026',
  'Rs. In Lakhs',
  '31-Mar-26 31-Mar-25',
  'Particulars Note No.',
  'I. EQUITY AND LIABILITIES',
  "(1) Shareholder's Funds",
  '(a) Share Capital 2 100.00 100.00',
  '(b) Reserves & Surplus 3 300.00 250.00',
  '(2) Non Current Liabilities',
  '(a) Long Term Borrowings 4 200.00 220.00',
  '(b) Deferred Tax Liability - -',
  'Current Liabilities',
  '(a) Short-term Borrowings 5 150.00 140.00',
  '(b) Trade Payables',
  '(i) Total outstanding dues of micro enterprises 10.00 12.00',
  '6',
  '(ii) Total outstanding dues of creditors other than micro enterprises and small',
  '90.00 80.00',
  'enterprises',
  'TOTAL EQUITY & LIABILITIES 850.00 802.00',
  'II.ASSETS',
  '(1) Non-current assets',
  '(i) Property, Plant and Equipment 9 300.00 290.00',
  '(ii) Intangible assets -',
  '(2) Current assets',
  '(a) Inventories 12 350.00 300.00',
  '(b) Trade Receivable 13 200.00 212.00',
  'TOTAL ASSETS 850.00 802.00',
];
const PL = [
  'STATEMENT OF AUDITED FINANCIAL RESULT FOR THE YEAR ENDED MARCH 31, 2026',
  'Rs. In Lakhs',
  'Half year ended Year Ended',
  '31-Mar-26 30-Sep-25 31-Mar-25 31-Mar-26 31-Mar-25',
  'I Revenue from Operations 600.00 500.00 700.00 1,100.00 1,000.00',
  'II Other Income 20.00 10.00 5.00 30.00 15.00',
  'III Total Income (I+II) 620.00 510.00 705.00 1,130.00 1,015.00',
  'IV Expenses',
  '(d) Finance Costs 21 20.00 20.00 30.00 40.00 60.00',
  '(e) Depreciation and Amortisation Expenses 22 10.00 10.00 10.00 20.00 20.00',
  '(f) Other Expenses 23 960.00 0.00 0.00 960.00 900.00',
  'Total expenses 990.00 40.00 40.00 1,020.00 980.00',
  'V Profit/ (Loss) before Tax (III-IV) 110.00 470.00 665.00 110.00 35.00',
  'VII Profit / (Loss) for period (V-VI) 80.00 400.00 500.00 80.00 25.00',
];

const by = (fields: ReturnType<typeof readFinancialStatements>, id: string, period?: string) =>
  fields.find((f) => f.fieldId === `financialProfile.${id}` && (period === undefined || f.period === period));

test('reads a Schedule III balance sheet with unit, note column and wrapped labels', () => {
  const out = readFinancialStatements([BS], 0.9);
  assert.equal(by(out, 'totalAssets')?.rawValue, '850.00');
  assert.equal(by(out, 'totalAssets')?.statedUnit, 'lakh');
  assert.equal(by(out, 'totalAssets')?.unitText, 'Rs. In Lakhs');
  assert.equal(by(out, 'currentAssets')?.rawValue, '550.00');
  assert.equal(by(out, 'currentLiabilities')?.rawValue, '250.00');
  assert.equal(by(out, 'shareholdersEquity')?.rawValue, '400.00');
  assert.equal(by(out, 'totalOutsideLiabilities')?.rawValue, '450.00');
  assert.equal(by(out, 'tangibleNetWorth')?.rawValue, '400.00');
  assert.equal(by(out, 'totalOutstandingBorrowings')?.rawValue, '350.00');
  assert.equal(by(out, 'currentAssets')?.reconciled, true);
  assert.equal(by(out, 'financialYearLabel')?.rawValue, 'FY 2025-26');
});

test('skips derived balance sheet items when the sheet does not balance', () => {
  const broken = BS.map((l) => (l.startsWith('TOTAL ASSETS') ? 'TOTAL ASSETS 999.00 802.00' : l));
  const out = readFinancialStatements([broken], 0.9);
  assert.equal(by(out, 'currentAssets'), undefined);
  assert.equal(by(out, 'shareholdersEquity'), undefined);
});

test('reads year-end columns of a half-yearly P&L and derives EBITDA only from proved lines', () => {
  const out = readFinancialStatements([PL], 0.9);
  assert.equal(by(out, 'annualRevenue', 'FY 2025-26')?.rawValue, '1,100.00');
  assert.equal(by(out, 'annualRevenue', 'FY 2024-25')?.rawValue, '1,000.00');
  assert.equal(by(out, 'netProfitAfterTax', 'FY 2025-26')?.rawValue, '80.00');
  assert.equal(by(out, 'ebitda')?.rawValue, '170.00');
  assert.equal(by(out, 'ebit')?.rawValue, '150.00');
  const wrong = PL.map((l) => (l.startsWith('Total expenses') ? 'Total expenses 990.00 40.00 40.00 1,000.00 980.00' : l));
  assert.equal(by(readFinancialStatements([wrong], 0.9), 'ebitda'), undefined);
});

test('refuses a half-year or quarter statement, even with two columns', () => {
  const half = [
    'STATEMENT OF UNAUDITED FINANCIAL RESULTS FOR THE HALF YEAR ENDED SEPTEMBER 30, 2025',
    'Rs. In Lakhs',
    'Half year ended',
    '30-Sep-25 30-Sep-24',
    'I Revenue from Operations 500.00 450.00',
    'VII Profit / (Loss) for period (V-VI) 40.00 30.00',
  ];
  assert.equal(readFinancialStatements([half], 0.9).length, 0);
  // A year ended 30 June is not a 31 March financial year either.
  const june = PL.map((l) => l.replace(/31-Mar-2([56])/g, '30-Jun-2$1').replace('MARCH 31', 'JUNE 30'));
  assert.equal(by(readFinancialStatements([june], 0.9), 'annualRevenue'), undefined);
});

test('multi-column result: the year ended columns are picked by their heading, not by position of any two figures', () => {
  const noYearHeading = PL.map((l) => (l === 'Half year ended Year Ended' ? 'Half year ended' : l));
  assert.equal(by(readFinancialStatements([noYearHeading], 0.9), 'annualRevenue'), undefined);
});

test('one heading date: the previous column gets no period and no prior-year values', () => {
  const oneDate = BS.map((l) => (l === '31-Mar-26 31-Mar-25' ? '31-Mar-26' : l));
  const out = readFinancialStatements([oneDate], 0.9);
  assert.equal(by(out, 'totalAssets')?.period, 'FY 2025-26');
  const pl = PL.map((l) => (l === '31-Mar-26 30-Sep-25 31-Mar-25 31-Mar-26 31-Mar-25' ? 'Year Ended 31-Mar-26' : l)).filter((l) => l !== 'Half year ended Year Ended');
  const two = pl.map((l) => (/^(?:I |II |III |\(|Total|V |VII )/.test(l) ? l.replace(/(\d[\d,.]*) (\d[\d,.]*) (\d[\d,.]*) (\d[\d,.]*) (\d[\d,.]*)$/, '$4 $5') : l));
  const out2 = readFinancialStatements([['STATEMENT OF AUDITED FINANCIAL RESULT FOR THE YEAR ENDED MARCH 31, 2026', 'Rs. In Lakhs', 'Year Ended 31-Mar-26', ...two.slice(3)]], 0.9);
  assert.equal(by(out2, 'annualRevenue', 'FY 2025-26')?.rawValue, '1,100.00');
  assert.equal(out2.some((f) => f.fieldId === 'financialProfile.annualRevenue' && f.period !== 'FY 2025-26'), false);
});

test('current vs previous follows the heading dates, whichever column comes first', () => {
  const reversed = BS.map((l) => (l === '31-Mar-26 31-Mar-25' ? '31-Mar-25 31-Mar-26' : l));
  const out = readFinancialStatements([reversed], 0.9);
  assert.equal(by(out, 'totalAssets')?.period, 'FY 2025-26');
});

test('a unit heading from an earlier statement is not carried over; a statement with none is skipped', () => {
  const noUnit = BS.filter((l) => l !== 'Rs. In Lakhs');
  assert.equal(readFinancialStatements([noUnit], 0.9).length, 0);
  assert.equal(readFinancialStatements([BS, noUnit.map((l) => l)], 0.9).some((f) => f.page === 2), false);
  const rupees = BS.map((l) => (l === 'Rs. In Lakhs' ? '(Amount in Rupees)' : l));
  assert.equal(by(readFinancialStatements([rupees], 0.9), 'totalAssets')?.statedUnit, 'rupees');
});
