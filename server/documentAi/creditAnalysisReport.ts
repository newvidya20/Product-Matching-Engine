/**
 * Reads the fixed layout of the Business Credit Triangulation Report. It only accepts labelled
 * rows and the report's own financial-year and monthly-credit tables; thresholds and ratios are
 * intentionally ignored. Restated figures stay below the auto-apply threshold for human review.
 */
import type { RawBankMonth, RawField } from './prompt.ts';

export function isCreditAnalysisReportTitle(text: string): boolean {
  return (
    /\bbusiness\s+credit\s+triangulation\s+report\b/i.test(text) ||
    /\bi\s*n\s*t\s*e\s*g\s*r\s*a\s*t\s*e\s*d\s+c\s*r\s*e\s*d\s*i\s*t\s+a\s*n\s*a*l*y\s*s\s*i\s*s\b/i.test(text)
  );
}

export const REPORT_SUMMARY_CONFIDENCE = 0.65;

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const snip = (text: string) => clean(text).slice(0, 300);
const CELL = /(?:₹\s*-?[\d,]+(?:\.\d+)?|\bN\/A\b)/gi;
const RUPEE_FIGURE = /^₹\s*-?\d[\d,]*(?:\.\d+)?$/;

const YEAR_ROWS: ReadonlyArray<{ fieldId: string; label: RegExp }> = [
  { fieldId: 'financialProfile.annualRevenue', label: /^revenue\s*\/\s*turnover\b/i },
  { fieldId: 'financialProfile.ebitda', label: /^ebitda\b(?!\s+margin)/i },
  { fieldId: 'financialProfile.ebit', label: /^ebit\b(?!da)/i },
  { fieldId: 'financialProfile.netProfitAfterTax', label: /^net\s+profit\s*\/\s*pat\b/i },
  { fieldId: 'financialProfile.interestExpense', label: /^interest\s*\/\s*finance\s+cost\b/i },
  { fieldId: 'financialProfile.operatingCashFlow', label: /^operating\s+cash\s+flow\b(?!\s*\/)/i },
  { fieldId: 'financialProfile.tangibleNetWorth', label: /^tangible\s+net\s+worth\b/i },
  { fieldId: 'financialProfile.currentAssets', label: /^current\s+assets\b/i },
  { fieldId: 'financialProfile.currentLiabilities', label: /^current\s+liabilities\b/i },
  { fieldId: 'financialProfile.totalOutsideLiabilities', label: /^total\s+outside\s+liabilities\b/i },
  { fieldId: 'financialProfile.statedDscr', label: /^dscr\b/i },
];

function columnYear(token: string): string | null {
  const year = Number(token.slice(2));
  if (!Number.isInteger(year) || year < 1990 || year > 2200) return null;
  return `FY ${year - 1}-${String(year % 100).padStart(2, '0')}`;
}

interface Line {
  text: string;
  page: number;
}

function field(
  fieldId: string,
  rawValue: string,
  line: Line,
  confidence: number,
  extra: Partial<RawField> = {}
): RawField {
  return {
    fieldId,
    rawValue,
    enumValue: null,
    page: line.page,
    sheetName: null,
    cellRef: null,
    snippet: snip(line.text),
    confidence,
    statedUnit: null,
    unitText: null,
    period: null,
    subjectRef: null,
    ...extra,
  };
}

function basisColumns(text: string): Array<'audited' | 'provisional'> {
  const words = [...text.matchAll(/\bprovisional\b(?:\s*\(\s*un-?audited\s*\))?|\bun-?audited\b|\baudited\b/gi)].map((m) =>
    m[0].toLowerCase()
  );
  if (words.some((word) => /^un-?audited$/.test(word))) return [];
  return words.map((word) => (word.startsWith('provisional') ? 'provisional' : 'audited'));
}

function readYearTable(lines: readonly Line[], fields: RawField[]): void {
  let columns: string[] | null = null;
  let basisPending = false;
  let page = 0;
  const written = new Set(
    lines.flatMap((line) =>
      [...line.text.matchAll(/\bFY\s?(\d{4})\s*-\s*(\d{2})\b/gi)].map((m) => `FY ${m[1]}-${m[2]}`)
    )
  );
  for (const line of lines) {
    if (line.page !== page) {
      page = line.page;
      columns = null;
    }
    const heading = line.text.match(/^financial\s+metric\s+((?:FY\s?\d{4}\s*){2,})$/i);
    if (heading) {
      const years = heading[1]
        .trim()
        .split(/\s+(?=FY)/i)
        .map((token) => columnYear(token.replace(/\s+/g, '')));
      columns = years.every((year): year is string => year !== null && written.has(year)) ? years : null;
      basisPending = columns !== null;
      continue;
    }
    if (!columns) continue;
    if (basisPending && /^reporting\s+basis\b/i.test(line.text)) {
      basisPending = false;
      const basis = basisColumns(line.text);
      if (basis.length === columns.length) {
        basis.forEach((option, index) =>
          fields.push(
            field('financialProfile.dataSource', option, line, REPORT_SUMMARY_CONFIDENCE, {
              enumValue: option,
              period: columns![index],
            })
          )
        );
      }
      continue;
    }
    const row = YEAR_ROWS.find((candidate) => candidate.label.test(line.text));
    if (!row) continue;
    const cellPattern =
      row.fieldId === 'financialProfile.statedDscr'
        ? /(?:₹\s*-?[\d,]+(?:\.\d+)?|\bN\/A\b|\b\d+(?:\.\d+)?x\b)/gi
        : CELL;
    const cells = [...line.text.matchAll(cellPattern)].map((m) => m[0].replace(/\s+/g, ''));
    const others = line.text.replace(cellPattern, ' ').replace(row.label, ' ');
    if (cells.length !== columns.length || /\d/.test(others)) continue;
    cells.forEach((cell, index) => {
      if (RUPEE_FIGURE.test(cell)) {
        fields.push(field(row.fieldId, cell, line, REPORT_SUMMARY_CONFIDENCE, { period: columns![index] }));
      } else if (row.fieldId === 'financialProfile.statedDscr' && /^\d+(?:\.\d+)?x$/i.test(cell)) {
        fields.push(field(row.fieldId, cell.slice(0, -1), line, REPORT_SUMMARY_CONFIDENCE, { period: columns![index] }));
      }
    });
  }
}

function readStatusRows(lines: readonly Line[], fields: RawField[]): string | null {
  let pan: string | null = null;
  for (const line of lines) {
    const text = line.text;
    if (!/\bAVAILABLE$/.test(text)) continue;
    let match: RegExpMatchArray | null;
    if ((match = text.match(/^PAN\s+([A-Z]{5}\d{4}[A-Z])\s+AVAILABLE$/))) {
      pan = match[1];
      fields.push(field('identity.pan', match[1], line, 0.9));
    } else if ((match = text.match(/^GSTIN\s+(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\s+AVAILABLE$/))) {
      fields.push(field('identity.gstin', match[1], line, 0.9));
    } else if ((match = text.match(/^Company\s+Name\s+([A-Za-z][A-Za-z0-9 .&'()-]{1,118}?)\s+AVAILABLE$/))) {
      fields.push(field('applicantLabel', match[1].trim(), line, 0.9));
    } else if ((match = text.match(/^CIBIL\s+Score\b[^\d₹]*?\b([3-8]\d{2}|900)\s+AVAILABLE$/i))) {
      fields.push(field('cibil', match[1], line, 0.9));
    } else if ((match = text.match(/^Company\s+CMR\b[^\d₹]*?\b(10|[1-9])\s+AVAILABLE$/i))) {
      fields.push(field('financialProfile.commercialCmrRank', match[1], line, REPORT_SUMMARY_CONFIDENCE));
    } else if ((match = text.match(/^Monthly\s+EMI\s+used\s+for\s+debt\b[^\d₹]*?(₹\s*[\d,]+(?:\.\d+)?)\s+AVAILABLE$/i))) {
      fields.push(field('financialProfile.existingMonthlyEmi', match[1].replace(/\s+/g, ''), line, REPORT_SUMMARY_CONFIDENCE));
    } else if ((match = text.match(/^Outstanding\s+(₹\s*[\d,]+(?:\.\d+)?)\s+AVAILABLE$/i))) {
      fields.push(field('financialProfile.totalOutstandingBorrowings', match[1].replace(/\s+/g, ''), line, REPORT_SUMMARY_CONFIDENCE));
    }
  }
  return pan;
}

function reportMonth(text: string): string | null {
  const match = text.match(/^([A-Za-z]{3,9})\.?[\s'’-]+((?:19|20)\d{2})\b/);
  if (!match) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
    match[1].slice(0, 3).toLowerCase()
  );
  return month < 0 ? null : `${match[2]}-${String(month + 1).padStart(2, '0')}`;
}

function readMonthlyCredits(lines: readonly Line[]): RawBankMonth[] {
  const rows = new Map<string, RawBankMonth>();
  const duplicates = new Set<string>();
  let heading: { text: string; columns: number; gross: number } | null = null;
  let inTable = false;
  for (const line of lines) {
    if (/^monthly\s+credits\s+by\s+category\b/i.test(line.text)) {
      inTable = true;
      heading = null;
      continue;
    }
    if (!inTable) continue;
    if (!heading) {
      if (!/^month\s+gross\s+credits\b/i.test(line.text)) continue;
      const names = line.text
        .replace(/^month\s+/i, '')
        .match(/gross\s+credits|own\s+account|loans|reversals\s+and\s+other|unclassified|business\s+receipts/gi);
      if (!names) {
        inTable = false;
        continue;
      }
      heading = { text: line.text, columns: names.length, gross: names.findIndex((name) => /^gross/i.test(name)) };
      continue;
    }
    const month = reportMonth(line.text);
    if (!month) {
      inTable = false;
      continue;
    }
    const figures = [...line.text.matchAll(/₹\s*-?[\d,]+(?:\.\d+)?/g)].map((m) => m[0].replace(/\s+/g, ''));
    if (figures.length !== heading.columns || heading.gross < 0) continue;
    if (rows.has(month)) {
      rows.delete(month);
      duplicates.add(month);
      continue;
    }
    if (duplicates.has(month)) continue;
    rows.set(month, {
      month,
      totalCredits: figures[heading.gross],
      closingBalance: null,
      page: line.page,
      sheetName: null,
      cellRef: null,
      snippet: snip(`${heading.text} | ${line.text}`),
      statedUnit: null,
      unitText: null,
      confidence: REPORT_SUMMARY_CONFIDENCE,
      subjectRef: null,
    });
  }
  return [...rows.values()];
}

export interface CreditAnalysisReading {
  fields: RawField[];
  bankMonthlyTotals: RawBankMonth[];
}

export function readCreditAnalysisReport(pages: ReadonlyArray<readonly string[]>): CreditAnalysisReading {
  const lines = pages.flatMap((page, index) => page.map((text) => ({ text: clean(text), page: index + 1 })));
  const fields: RawField[] = [];
  readYearTable(lines, fields);
  const pan = readStatusRows(lines, fields);
  const scoreField = pan && pan[3] !== 'P' ? 'financialProfile.promoterCibilScore' : 'financialProfile.personalCibilScore';
  for (const item of fields) if (item.fieldId === 'cibil') item.fieldId = scoreField;
  return { fields, bankMonthlyTotals: readMonthlyCredits(lines) };
}
