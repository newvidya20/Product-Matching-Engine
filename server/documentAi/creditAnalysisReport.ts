/**
 * A credit analysis report produced by another tool (`Business Credit Triangulation Report`, headed
 * `INTEGRATED CREDIT ANALYSIS`). It restates figures from the borrower's own documents in fixed
 * tables, so it is read by its layout, never by loose label matching:
 *
 * - Values come only from rows whose label starts the line and whose figures are on that same line.
 * - The year-on-year table is read by the column order of its own header row (`Financial Metric
 *   FY2024 FY2025 FY2026`): a row is used only when it holds exactly one figure or `N/A` per
 *   column. `N/A` stays missing. Nothing is added, averaged or derived here.
 * - The policy results tables (`CIBIL Score Minimum 750 or above 756 PASS`) print thresholds beside
 *   values, so they are never read. Bureau values come from the `... <value> AVAILABLE` rows only.
 * - It is a summary by a third party, so every value except the printed bureau score and the
 *   identity rows carries a confidence below the lowest auto-apply threshold: a person confirms it.
 *   Ratios (DSCR, TOL/TNW) and the banking turnover percentage are not extractable fields.
 * Pure: no I/O, no clock, no logging.
 */
import type { RawBankMonth, RawField } from './prompt.ts';
import { readMonth } from './localExtractors.ts';

/** The report's own title, in the spaced or plain form it prints. */
export function isCreditAnalysisReportTitle(text: string): boolean {
  return (
    /\bbusiness\s+credit\s+triangulation\s+report\b/i.test(text) ||
    /\bi\s*n\s*t\s*e\s*g\s*r\s*a\s*t\s*e\s*d\s+c\s*r\s*e\s*d\s*i\s*t\s+a\s*n\s*a\s*l\s*y\s*s\s*i\s*s\b/i.test(text)
  );
}

/** A restated figure: the reviewer confirms it against the source the report names. */
export const REPORT_SUMMARY_CONFIDENCE = 0.65;

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const snip = (text: string) => clean(text).slice(0, 300);

/** One cell of the year table: a rupee figure, or N/A. */
const CELL = /(?:₹\s*-?[\d,]+(?:\.\d+)?|\bN\/A\b)/gi;
const RUPEE_FIGURE = /^₹\s*-?\d[\d,]*(?:\.\d+)?$/;

/** Year-table rows, by their label at the start of the line. Most specific first. */
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
];

/** `FY2026` as the report heads its columns: the year the FY ends in, so `FY 2025-26`. */
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

/** Basis words per column, in order: `Audited ... — Audited ... — Provisional (unaudited) ...`. */
function basisColumns(text: string): Array<'audited' | 'provisional'> {
  const words = [...text.matchAll(/\bprovisional\b(?:\s*\(\s*un-?audited\s*\))?|\bun-?audited\b|\baudited\b/gi)].map((m) =>
    m[0].toLowerCase()
  );
  if (words.some((word) => /^un-?audited$/.test(word))) return []; // unaudited alone names neither option
  return words.map((word) => (word.startsWith('provisional') ? 'provisional' : 'audited'));
}

function readYearTable(lines: readonly Line[], fields: RawField[]): void {
  let columns: string[] | null = null;
  let basisPending = false;
  let page = 0;
  // Each statement year the report states: a column heading is believed only when the report also
  // writes that year out in full somewhere (`FY2025-26`), so the column convention is its own.
  const written = new Set(lines.flatMap((line) => [...line.text.matchAll(/\bFY\s?(\d{4})\s*-\s*(\d{2})\b/gi)].map((m) => `FY ${m[1]}-${m[2]}`)));
  for (const line of lines) {
    if (line.page !== page) {
      page = line.page;
      columns = null;
    }
    const heading = line.text.match(/^financial\s+metric\s+((?:FY\s?\d{4}\s*){2,})$/i);
    if (heading) {
      const years = heading[1].trim().split(/\s+(?=FY)/i).map((token) => columnYear(token.replace(/\s+/g, '')));
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
    const cells = [...line.text.matchAll(CELL)].map((m) => m[0].replace(/\s+/g, ''));
    // Exactly one cell per column, and nothing else that looks like a figure: a wrapped or merged
    // row cannot be read by position, so it gives nothing.
    const others = line.text.replace(CELL, ' ').replace(row.label, ' ');
    if (cells.length !== columns.length || /\d/.test(others)) continue;
    cells.forEach((cell, index) => {
      if (!RUPEE_FIGURE.test(cell)) return; // N/A: not stated for that year
      fields.push(field(row.fieldId, cell, line, REPORT_SUMMARY_CONFIDENCE, { period: columns![index] }));
    });
  }
}

/** `Label ... <value> AVAILABLE` rows of the field tables (bureau, debt, identity). */
function readStatusRows(lines: readonly Line[], fields: RawField[]): string | null {
  let pan: string | null = null;
  for (const line of lines) {
    const text = line.text;
    if (!/\bAVAILABLE$/.test(text)) continue;
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^PAN\s+([A-Z]{5}\d{4}[A-Z])\s+AVAILABLE$/))) {
      pan = m[1];
      fields.push(field('identity.pan', m[1], line, 0.9));
    } else if ((m = text.match(/^GSTIN\s+(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\s+AVAILABLE$/))) {
      fields.push(field('identity.gstin', m[1], line, 0.9));
    } else if ((m = text.match(/^Company\s+Name\s+([A-Za-z][A-Za-z0-9 .&'()-]{1,118}?)\s+AVAILABLE$/))) {
      fields.push(field('applicantLabel', m[1].trim(), line, 0.9));
    } else if ((m = text.match(/^CIBIL\s+Score\b[^\d₹]*?\b([3-8]\d{2}|900)\s+AVAILABLE$/i))) {
      fields.push(field('cibil', m[1], line, 0.9));
    } else if ((m = text.match(/^Company\s+CMR\b[^\d₹]*?\b(10|[1-9])\s+AVAILABLE$/i))) {
      fields.push(field('financialProfile.commercialCmrRank', m[1], line, REPORT_SUMMARY_CONFIDENCE));
    } else if ((m = text.match(/^Monthly\s+EMI\s+used\s+for\s+debt\b[^\d₹]*?(₹\s*[\d,]+(?:\.\d+)?)\s+AVAILABLE$/i))) {
      fields.push(field('financialProfile.existingMonthlyEmi', m[1].replace(/\s+/g, ''), line, REPORT_SUMMARY_CONFIDENCE));
    } else if ((m = text.match(/^Outstanding\s+(₹\s*[\d,]+(?:\.\d+)?)\s+AVAILABLE$/i))) {
      fields.push(field('financialProfile.totalOutstandingBorrowings', m[1].replace(/\s+/g, ''), line, REPORT_SUMMARY_CONFIDENCE));
    }
  }
  return pan;
}

/**
 * `Monthly Credits by Category` rows: `Jul 2025 ₹<gross> ₹<own account> ... ₹<business> quality`.
 * Only the Gross Credits column is taken, by its place in the printed heading, and only when the row
 * has one figure per heading column. derive.ts then averages them like any bank statement's months.
 */
function readMonthlyCredits(lines: readonly Line[]): RawBankMonth[] {
  const rows = new Map<string, RawBankMonth>();
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
      heading = { text: line.text, columns: names.length, gross: names.findIndex((n) => /^gross/i.test(n)) };
      continue;
    }
    const month = readMonth(line.text);
    if (!month) {
      inTable = false; // the table ended
      continue;
    }
    const figures = [...line.text.matchAll(/₹\s*-?[\d,]+(?:\.\d+)?/g)].map((m) => m[0].replace(/\s+/g, ''));
    if (figures.length !== heading.columns || heading.gross < 0) continue;
    if (rows.has(month)) {
      rows.delete(month); // the same month twice: neither is trusted
      continue;
    }
    rows.set(month, {
      month,
      totalCredits: figures[heading.gross],
      closingBalance: null,
      page: line.page,
      sheetName: null,
      cellRef: null,
      // Verbatim: the column heading (so the reviewer sees Gross Credits was used), then the row.
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
  // A consumer score: the borrower's own for an individual or proprietor (PAN holder type P), or
  // when no holder type is printed; a promoter's for any other entity (contracts section 4.5).
  const scoreField = pan && pan[3] !== 'P' ? 'financialProfile.promoterCibilScore' : 'financialProfile.personalCibilScore';
  for (const f of fields) if (f.fieldId === 'cibil') f.fieldId = scoreField;
  return { fields, bankMonthlyTotals: readMonthlyCredits(lines) };
}
