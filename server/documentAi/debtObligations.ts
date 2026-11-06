/**
 * Existing-debt readers, no AI: a borrower's loan obligation sheet (one row per facility) and
 * lenders' sanction letters.
 *
 * Never-guess rules:
 * - Only term-loan rows that print an EMI count toward the monthly EMI; working-capital lines
 *   (CC, EPC, overdraft, limits) have no EMI and are skipped, never estimated.
 * - An EMI printed as `66500 (approx)` is not exact: it is summed but named in the snippet and the
 *   value drops below the auto-apply threshold, so a person confirms it.
 * - Outstanding balances are not emitted: no field for them accepts an existing_sanction_letter.
 * - annualScheduledPrincipalRepayments needs the principal part of each EMI, which a sheet that
 *   prints only the EMI cannot give: it is never derived here.
 * Pure: no I/O, no clock, no logging.
 */
import type { RawField } from './prompt.ts';
import type { ParsedSheet, SheetRow } from './spreadsheet.ts';

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();

interface Columns {
  headerRow: number;
  lender: number;
  facility: number;
  emi: number;
}

function findColumns(row: SheetRow): Omit<Columns, 'headerRow'> | null {
  const at = (re: RegExp) => row.cells.find((cell) => re.test(clean(cell.text)))?.column ?? -1;
  const emi = at(/^emi$/i);
  const lender = at(/name\s+of\s+(?:bank|nbfc|lender)|^(?:bank|lender)\b/i);
  const facility = at(/f[a-z]*ility\s+type|type\s+of\s+(?:loan|facility)/i);
  if (emi < 0 || lender < 0) return null;
  return { lender, facility, emi };
}

function locate(sheets: readonly ParsedSheet[]): { sheet: ParsedSheet; columns: Columns } | null {
  for (const sheet of sheets) {
    if (sheet.hidden) continue;
    for (const row of sheet.rows.slice(0, 15)) {
      const columns = findColumns(row);
      if (columns) return { sheet, columns: { ...columns, headerRow: row.rowNumber } };
    }
  }
  return null;
}

/** A sheet that lists lenders with an EMI column. */
export function isObligationSheet(sheets: readonly ParsedSheet[]): boolean {
  return locate(sheets) !== null;
}

interface Figure {
  value: number;
  exact: boolean;
  text: string;
  ref: string;
}

function figureAt(row: SheetRow, column: number): Figure | null {
  const cell = row.cells.find((c) => c.column === column);
  if (!cell) return null;
  const text = clean(cell.text);
  const match = text.match(/^(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)\s*(\(?\s*(?:approx\.?|approximately)\s*\)?)?$/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? { value, exact: !match[2], text, ref: cell.ref } : null;
}

const WORKING_CAPITAL = /working\s+capital|\bcc\b|cash\s+credit|overdraft|\bod\b|\bepc\b|packing|limit|sloc|eclg|\bbg\b|letter\s+of\s+credit/i;

/** Existing monthly EMI: the sum of the EMI column over term-loan rows. */
export function readObligationSheet(sheets: readonly ParsedSheet[], confidence: number): RawField[] {
  const found = locate(sheets);
  if (!found) return [];
  const { sheet, columns } = found;
  const parts: Array<{ lender: string; emi: Figure }> = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= columns.headerRow || row.hidden) continue;
    const cellText = (column: number) => clean(row.cells.find((c) => c.column === column)?.text ?? '');
    const lender = cellText(columns.lender);
    if (!lender || /^total/i.test(lender)) continue;
    const facility = columns.facility >= 0 ? cellText(columns.facility) : '';
    if (WORKING_CAPITAL.test(facility)) continue;
    const emi = figureAt(row, columns.emi);
    if (emi) parts.push({ lender, emi });
  }
  if (parts.length === 0) return [];

  const total = Math.round(parts.reduce((sum, p) => sum + p.emi.value, 0) * 100) / 100;
  const approx = parts.filter((p) => !p.emi.exact);
  const shown = parts.slice(0, 5).map((p) => `${p.lender} ${p.emi.text}`).join(', ');
  const snippet =
    `${parts.length} term-loan EMIs from the EMI column: ${shown}${parts.length > 5 ? ', ...' : ''}` +
    ` = ${total}` +
    (approx.length > 0 ? `. Printed approx, not exact: ${approx.map((p) => p.lender).join(', ')}.` : '.');
  return [
    {
      fieldId: 'financialProfile.existingMonthlyEmi',
      rawValue: String(total),
      enumValue: null,
      page: null,
      sheetName: sheet.name,
      cellRef: parts[0].emi.ref,
      snippet: snippet.slice(0, 300),
      // Below auto-apply (0.85) when any EMI is only approximate.
      confidence: approx.length > 0 ? Math.min(confidence, 0.6) : confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: null,
      reconciled: true,
    },
  ];
}

// ------------------------------------------------------------------ Sanction letters

const LIMIT = /\b(?:cash\s+credit|cc|overdraft|od|working\s+capital)\s+limit(?:\s+sanctioned)?\b|\blimit\s+sanctioned\b|\bsanctioned\s+limit\b/i;
const AMOUNT_G = /(?:rs\.?|inr|₹)\s*([\d,]{5,}(?:\.\d{1,2})?)(?:\s*\/-)?(\s*(?:lakhs?|lacs?|crores?|crs?|mn|millions?|thousands?)\b)?/gi;

/**
 * A sanction letter names one facility. Its EMI is one loan's, never the borrower's total, and its
 * amount is that loan's, never a request, so neither is read. A cash-credit / overdraft limit is
 * read only when the letter states exactly one limit figure on a labelled line.
 */
export function readSanctionLetter(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  const hits: Array<{ value: string; page: number; text: string }> = [];
  pages.forEach((lines, pageIndex) => {
    for (const raw of lines) {
      const text = clean(raw);
      if (!LIMIT.test(text)) continue;
      const amounts = [...text.matchAll(AMOUNT_G)];
      // Two figures on a line (`enhanced from Rs 30,00,000 to Rs 50,00,000`) leave the limit
      // unclear; a unit word after the figure (`Rs 5 crore`) is not applied here, so the line is skipped.
      if (amounts.length !== 1 || amounts[0][2]) continue;
      hits.push({ value: amounts[0][1], page: pageIndex + 1, text });
    }
  });
  const distinct = new Set(hits.map((h) => Number(h.value.replace(/,/g, ''))));
  if (hits.length === 0 || distinct.size !== 1) return [];
  const hit = hits[0];
  return [
    {
      fieldId: 'financialProfile.ccOdSanctionedLimit',
      rawValue: hit.value,
      enumValue: null,
      page: hit.page,
      sheetName: null,
      cellRef: null,
      snippet: hit.text.slice(0, 300),
      confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: null,
    },
  ];
}
