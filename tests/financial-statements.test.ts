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

test("a unit heading is the statement's own; with no scale word anywhere the figures are plain rupees", () => {
  const noUnit = BS.filter((l) => l !== 'Rs. In Lakhs');
  // No scale word anywhere in the document: plain rupees, no stated unit.
  const plain = readFinancialStatements([noUnit], 0.9);
  assert.equal(by(plain, 'totalAssets')?.statedUnit, null);
  assert.equal(by(plain, 'totalAssets')?.unitText, null);
  // A scale named on another page does not scale a statement that has no heading of its own.
  assert.equal(readFinancialStatements([['All figures in Lakhs unless stated'], noUnit], 0.9).length, 0);
  const rupees = BS.map((l) => (l === 'Rs. In Lakhs' ? '(Amount in Rupees)' : l));
  assert.equal(by(readFinancialStatements([rupees], 0.9), 'totalAssets')?.statedUnit, 'rupees');
});

const SIMPLE = [
  'ABC PRIVATE LIMITED',
  'BALANCE SHEET AS AT 31ST MARCH 2025',
  'Particulars Note 31.03.2025 31.03.2024',
  'EQUITY AND LIABILITIES',
  'Shareholders funds',
  'Share capital 1 10,00,000 10,00,000',
  'Reserves and surplus 2 40,00,000 30,00,000',
  'Non-current liabilities',
  'Long-term borrowings 3 50,00,000 60,00,000',
  'Current liabilities',
  'Short-term borrowings 4 20,00,000 15,00,000',
  'Trade payables 5 30,00,000 25,00,000',
  'Other current liabilities 6 5,00,000 4,00,000',
  'TOTAL 1,55,00,000 1,44,00,000',
  'ASSETS',
  'Non-current assets',
  'Property, plant and equipment 7 60,00,000 55,00,000',
  'Current assets',
  'Inventories 8 40,00,000 38,00,000',
  'Trade receivables 9 35,00,000 30,00,000',
  'Cash and bank balances 10 20,00,000 21,00,000',
  'TOTAL 1,55,00,000 1,44,00,000',
];

test('bare TOTAL rows on each side prove current assets, current liabilities and equity', () => {
  const out = readFinancialStatements([SIMPLE], 0.9);
  assert.equal(by(out, 'totalAssets')?.rawValue, '1,55,00,000');
  assert.equal(by(out, 'currentAssets')?.rawValue, '9500000.00');
  assert.equal(by(out, 'currentLiabilities')?.rawValue, '5500000.00');
  assert.equal(by(out, 'shareholdersEquity')?.rawValue, '5000000.00');
  const broken = SIMPLE.map((l, i) => (i === SIMPLE.length - 1 ? 'TOTAL 1,60,00,000 1,44,00,000' : l));
  assert.equal(by(readFinancialStatements([broken], 0.9), 'currentAssets'), undefined);
});

test('heading styles count as column headings', () => {
  for (const head of ['March 31, 2025 | March 31, 2024', '2024-25 | 2023-24', 'As at 31st March 2025 As at 31st March 2024']) {
    const lines = SIMPLE.map((l) => (l.startsWith('Particulars') ? `Particulars ${head}` : l));
    assert.equal(by(readFinancialStatements([lines], 0.9), 'totalAssets')?.period, 'FY 2024-25', head);
  }
});

const PL_SIMPLE = (patLabel: string, revLabel = 'Revenue from operations') => [
  'STATEMENT OF PROFIT AND LOSS FOR THE YEAR ENDED 31ST MARCH 2025',
  'Particulars 2024-25 2023-24',
  `${revLabel} 11 4,50,00,000 3,90,00,000`,
  'Other income 12 2,00,000 1,00,000',
  'Total income 4,52,00,000 3,91,00,000',
  'Finance costs 15 9,00,000 10,00,000',
  'Depreciation and amortisation 16 8,00,000 7,00,000',
  'Other expenses 17 3,60,00,000 3,50,00,000',
  'Total expenses 3,77,00,000 3,67,00,000',
  'Profit before tax 75,00,000 24,00,000',
  `${patLabel} 56,00,000 18,00,000`,
];

test('common P&L labels are recognised', () => {
  for (const label of ['Profit for the year', 'Profit after tax', 'Net profit', 'Profit/(Loss) for the period']) {
    assert.equal(by(readFinancialStatements([PL_SIMPLE(label)], 0.9), 'netProfitAfterTax', 'FY 2024-25')?.rawValue, '56,00,000', label);
  }
  const total = readFinancialStatements([PL_SIMPLE('Profit for the year', 'Total revenue')], 0.9);
  assert.equal(by(total, 'annualRevenue', 'FY 2024-25')?.confidence, 0.8);
  const ops = readFinancialStatements([PL_SIMPLE('Profit for the year')], 0.9);
  assert.equal(by(ops, 'annualRevenue', 'FY 2024-25')?.confidence, 0.9);
  assert.equal(by(ops, 'interestExpense')?.rawValue, '9,00,000');
  assert.equal(by(ops, 'depreciation')?.rawValue, '8,00,000');
});

const T_BS = [
  'ABC TRADERS',
  'BALANCE SHEET AS AT 31ST MARCH 2025',
  'Liabilities Rs. Assets Rs.',
  'Capital Account 10,00,000 Fixed Assets 10,00,000',
  'Reserves 5,00,000 Furniture 5,00,000',
  'Secured Loan 15,00,000 Stock in Trade 12,00,000',
  'Sundry Creditors 8,00,000 Sundry Debtors 9,00,000',
  'Outstanding Expenses 2,00,000 Cash at Bank 4,00,000',
  'Total 40,00,000 Total 40,00,000',
];

test('T-form balance sheet is read only when both sides agree', () => {
  const out = readFinancialStatements([T_BS], 0.9);
  assert.equal(by(out, 'totalAssets')?.rawValue, '40,00,000');
  assert.equal(by(out, 'shareholdersEquity')?.rawValue, '1500000.00');
  assert.equal(by(out, 'currentLiabilities')?.rawValue, '1000000.00');
  assert.equal(by(out, 'currentAssets')?.rawValue, '2500000.00');
  assert.equal(by(out, 'currentAssets')?.reconciled, true);
  const bad = T_BS.map((l) => (l.startsWith('Total') ? 'Total 40,00,000 Total 50,00,000' : l));
  assert.equal(by(readFinancialStatements([bad], 0.9), 'totalAssets'), undefined);
});

test('Trading and P&L account is read per balanced block', () => {
  const lines = [
    'TRADING AND PROFIT & LOSS ACCOUNT FOR THE YEAR ENDED 31ST MARCH 2025',
    'To Opening Stock 10,00,000 By Sales 90,00,000',
    'To Purchases 60,00,000 By Closing Stock 20,00,000',
    'To Gross Profit c/d 40,00,000 By Scrap Sales 1,00,000',
    'Total 1,10,00,000 Total 1,11,00,000',
    'To Interest 4,00,000 By Gross Profit b/d 40,00,000',
    'To Depreciation 6,00,000 By Other Income 1,00,000',
    'To Net Profit 31,00,000 By Rent Received 0.00',
    'Total 41,00,000 Total 41,00,000',
  ];
  const res = readFinancialStatements([lines], 0.9);
  assert.equal(by(res, 'netProfitAfterTax')?.rawValue, '31,00,000');
  assert.equal(by(res, 'depreciation')?.rawValue, '6,00,000');
  assert.equal(by(res, 'interestExpense')?.rawValue, '4,00,000');
  // The first block (1,10,00,000 vs 1,11,00,000) does not agree, so no revenue is taken from it.
  assert.equal(by(res, 'annualRevenue'), undefined);
});
