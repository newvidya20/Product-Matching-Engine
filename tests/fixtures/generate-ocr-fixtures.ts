/**
 * Fictional fixtures for local OCR and the deterministic extractors. Every name and figure is
 * invented. Regenerate with: node --import tsx tests/fixtures/generate-ocr-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const DIR = fileURLToPath(new URL('./', import.meta.url));

function render(lines: string[], format: 'png' | 'jpeg' | 'webp'): Buffer {
  const width = 1400;
  const height = 120 + lines.length * 70;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111111';
  ctx.font = '36px sans-serif';
  lines.forEach((line, index) => ctx.fillText(line, 60, 90 + index * 70));
  if (format === 'png') return canvas.toBuffer('image/png');
  if (format === 'jpeg') return canvas.toBuffer('image/jpeg', 92);
  return canvas.toBuffer('image/webp', 95);
}

const CREDIT_REPORT = [
  'FICTIONAL SAMPLE - ILLUSTRATIVE SCAN, NOT A REAL CREDIT REPORT',
  'Credit Information Report (FICTIONAL)',
  'Name: FICTIONAL SAMPLE PROMOTER',
  'Report date: 12-05-2025',
  'CIBIL Score: 762',
  'CMR Rank: CMR-4',
];

const BANK_SUMMARY = [
  'FICTIONAL SAMPLE BANK - ILLUSTRATIVE SCAN, NOT A REAL BANK',
  'Statement of Account (FICTIONAL)',
  'Account number: XXXXXX9876',
  'Closing balance and deposit summary',
  'Month    Total Credits    Total Debits    Closing Balance',
  'Apr-2025    4,10,000.00    3,95,000.00    2,15,000.00',
  'May-2025    3,80,000.00    3,60,000.00    2,35,000.00',
];

const GST_SCAN = [
  'FICTIONAL SAMPLE - ILLUSTRATIVE SCAN, NOT A REAL GST RETURN',
  'Form GSTR-9 Annual Return (FICTIONAL)',
  'Financial year: FY 2024-25',
  'Aggregate turnover: Rs. 2,40,00,000.00',
];

const FINANCIALS_TXT = [
  'FICTIONAL SAMPLE - ILLUSTRATIVE DOCUMENT, NOT REAL FINANCIAL STATEMENTS',
  'FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
  'Balance Sheet and Statement of Profit and Loss (FICTIONAL)',
  '(Rs. in lakhs)',
  'Particulars  Note  FY 2024-25  FY 2023-24',
  'Revenue from operations  18  1,250.00  1,000.00',
  'Finance costs  21  (60.00)  (50.00)',
  'Profit after tax  32.20  18.50',
  'Total current assets  310.00  280.00',
  'Total current liabilities  120.00  110.00',
  'Revenue growth %  25  18',
  'EBITDA  140.00',
].join('\n');

const BANK_CSV = [
  'FICTIONAL SAMPLE BANK - bank statement, monthly summary (illustrative)',
  'Account number,XXXXXX5555',
  'Month,Total Credits,Total Debits,Closing Balance',
  'Jan-2025,"5,20,000.00","4,90,000.00","1,80,000.00"',
  'Feb-2025,"4,75,000.00","5,05,000.00","1,50,000.00"',
  'Mar-2025,"6,10,000.00","5,40,000.00","2,20,000.00"',
].join('\n');

writeFileSync(DIR + 'FICTIONAL-credit-report-scan.png', render(CREDIT_REPORT, 'png'));
writeFileSync(DIR + 'FICTIONAL-bank-summary-scan.jpg', render(BANK_SUMMARY, 'jpeg'));
writeFileSync(DIR + 'FICTIONAL-gst-annual-return-scan.webp', render(GST_SCAN, 'webp'));
writeFileSync(DIR + 'FICTIONAL-financials-two-years.txt', `${FINANCIALS_TXT}\n`);
writeFileSync(DIR + 'FICTIONAL-bank-monthly-summary.csv', `${BANK_CSV}\n`);
console.log('ocr fixtures written');
