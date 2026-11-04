/**
 * Deterministic reader for GSTR-3B returns, as printed by the GST portal. No AI.
 *
 * A GSTR-3B states no annual turnover: each return covers one month (or one quarter for a QRMP
 * filer). This reader takes, as printed, the "Total taxable value" of Table 3.1 rows (a), (b), (c)
 * and (e), and the return's Year and Period. Adding them up is the server's job, later, in
 * derive.ts, and only when all 12 months of one financial year are present.
 *
 * Never-guess rules:
 * - The form is recognised only by its printed title line, `Form GSTR-3B`.
 * - Year and Period are taken only from their own labelled lines (`Year 2025-26`, `Period April`
 *   or `Period Apr-Jun`). Anything else gives nothing.
 * - A row is read only when its printed label and its five figures (taxable value, integrated,
 *   central, state/UT tax, cess) are on the same line, or the label's wrapped continuation line.
 *   The taxable value must be a figure, not a dash. A row printed twice gives nothing.
 * - If (a), (b) or (c) is not read, the return gives no period at all, so nothing partial is summed.
 * - Each figure keeps the verbatim line it was read from, for the source check and the snippet.
 * Pure: no I/O, no clock, no logging.
 */
import type { RawField } from './prompt.ts';

const SNIPPET_MAX = 300;

export interface RawGstReturnPeriod {
  form: 'GSTR-3B';
  /** As printed after `Year`, such as `2025-26`. */
  yearText: string;
  /** As printed after `Period`, such as `April` or `Apr-Jun`. */
  periodText: string;
  outwardTaxable: string;
  zeroRated: string;
  nilExempt: string;
  nonGst: string | null;
  /** The GSTIN printed on the supplier's line, unvalidated. */
  gstin: string | null;
  /** 1-based page of Table 3.1. */
  page: number;
  /** Verbatim prefixes of the lines read (each up to its taxable value), at most 300 characters. */
  snippet: string;
  /** The full verbatim line each figure was read from, for the check against the source. */
  lines: { outwardTaxable: string; zeroRated: string; nilExempt: string; nonGst: string | null };
  confidence: number;
}

export interface Gstr3bReading {
  period: RawGstReturnPeriod | null;
  /** Labelled identity values printed on the return (legal name). */
  fields: RawField[];
}

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();

const TITLE = /^form\s+gstr[\s-]?3b$/i;
const YEAR = /^year\s*:?\s*((?:19|20)\d{2}\s*-\s*(?:\d{2}|\d{4}))$/i;
const PERIOD = /^(?:tax\s+)?period\s*:?\s*([A-Za-z]+(?:\s*-\s*[A-Za-z]+)?)$/i;
const SECTION_START = /^3\.1\s+details\s+of\s+outward\s+supplies/i;
/** Table 3.1.1, 3.2 or 4 begins: rows after it are not Table 3.1's. */
const SECTION_END = /^(?:3\.1\.1|3\.2|4\.?)\s+\S/;
const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;
const SUPPLIER_GSTIN = /^(?:\d+\.?\s*)?gstin(?:\s+of\s+the\s+supplier)?\b/i;
const LEGAL_NAME = /^(?:\d+\s*)?\(?a\)?\.?\s*legal\s+name\s+of\s+the\s+registered\s+person\s*:?\s+(.+)$/i;

type RowKey = 'outwardTaxable' | 'zeroRated' | 'nilExempt' | 'reverseCharge' | 'nonGst';

const ROWS: ReadonlyArray<{ key: RowKey; label: RegExp }> = [
  { key: 'outwardTaxable', label: /^\(\s*a\s*\)\s*outward\s+taxable\s+supplies\s*\(\s*other\s+than\s+zero\s+rated/i },
  { key: 'zeroRated', label: /^\(\s*b\s*\)\s*outward\s+taxable\s+supplies\s*\(\s*zero\s+rated\s*\)/i },
  { key: 'nilExempt', label: /^\(\s*c\s*\)\s*other\s+outward\s+supplies\s*\(\s*nil\s+rated\s*,?\s*exempted\s*\)/i },
  // Read only so that its figures are never taken for another row's; never counted.
  { key: 'reverseCharge', label: /^\(\s*d\s*\)\s*inward\s+supplies\s*\(\s*liable\s+to\s+reverse\s+charge\s*\)/i },
  { key: 'nonGst', label: /^\(\s*e\s*\)\s*non[\s-]*gst\s+outward\s+supplies/i },
];
const ANY_ROW = /^\(\s*[a-z]\s*\)/i;

/** Five trailing columns: a figure (with paise, optional grouping) or a dash. */
const FIGURE = String.raw`(?:\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?|-)`;
const FIVE_COLUMNS = new RegExp(String.raw`(?:^|\s)(${FIGURE})\s+(${FIGURE})\s+(${FIGURE})\s+(${FIGURE})\s+(${FIGURE})$`);

interface RowRead {
  taxable: string;
  /** The verbatim line holding the figures. */
  line: string;
  /** Verbatim text of the label and figure lines, up to and including the taxable value. */
  shown: string;
}

/** The taxable value of a row whose five figures end `line`, or end its wrapped continuation. */
function readRow(line: string, next: string | undefined): RowRead | null {
  const own = line.match(FIVE_COLUMNS);
  if (own && own.index !== undefined) {
    if (own[1] === '-') return null;
    const end = own.index + own[0].indexOf(own[1]) + own[1].length;
    return { taxable: own[1], line, shown: line.slice(0, end) };
  }
  // The label wrapped and the figures sit on the continuation line, which is no row of its own.
  if (next === undefined || ANY_ROW.test(next) || SECTION_END.test(next)) return null;
  const wrapped = next.match(FIVE_COLUMNS);
  if (!wrapped || wrapped.index === undefined || wrapped[1] === '-') return null;
  const words = next.slice(0, wrapped.index).trim();
  if (/\d/.test(words) || words.length > 60) return null;
  const end = wrapped.index + wrapped[0].indexOf(wrapped[1]) + wrapped[1].length;
  return { taxable: wrapped[1], line: next, shown: `${line} ${next.slice(0, end)}` };
}

/** True when the text carries the GSTR-3B title line on one of its first lines. */
export function isGstr3b(pages: ReadonlyArray<readonly string[]>): boolean {
  return (pages[0] ?? []).slice(0, 15).some((line) => TITLE.test(clean(line)));
}

/** Reads a GSTR-3B. Returns no period when the form, its Year, its Period or a counted row is not certain. */
export function readGstr3b(pages: ReadonlyArray<readonly string[]>, confidence: number): Gstr3bReading {
  const none: Gstr3bReading = { period: null, fields: [] };
  if (!isGstr3b(pages)) return none;

  const lines = pages.flatMap((page, index) => page.map((text) => ({ text: clean(text), page: index + 1 })));
  const unique = (pattern: RegExp) => {
    const found = lines.filter((line) => pattern.test(line.text));
    return found.length === 1 ? found[0] : null;
  };

  const fields: RawField[] = [];
  const nameLine = unique(LEGAL_NAME);
  const name = nameLine?.text.match(LEGAL_NAME)?.[1]?.trim();
  if (nameLine && name && name.length >= 3 && name.length <= 120 && /[A-Za-z]{2}/.test(name)) {
    fields.push({
      fieldId: 'applicantLabel',
      rawValue: name,
      enumValue: null,
      page: nameLine.page,
      sheetName: null,
      cellRef: null,
      snippet: nameLine.text.slice(0, SNIPPET_MAX),
      confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: null,
    });
  }

  const yearLine = unique(YEAR);
  const periodLine = unique(PERIOD);
  if (!yearLine || !periodLine) return { period: null, fields };

  const start = lines.findIndex((line) => SECTION_START.test(line.text));
  if (start < 0) return { period: null, fields };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (SECTION_END.test(lines[i].text)) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end);

  const read = new Map<RowKey, RowRead & { page: number }>();
  const seen = new Set<RowKey>();
  section.forEach((line, index) => {
    const row = ROWS.find((candidate) => candidate.label.test(line.text));
    if (!row) return;
    if (seen.has(row.key)) {
      read.delete(row.key); // printed twice: neither is trusted
      return;
    }
    seen.add(row.key);
    const value = readRow(line.text, section[index + 1]?.page === line.page ? section[index + 1].text : undefined);
    if (value) read.set(row.key, { ...value, page: line.page });
  });

  const a = read.get('outwardTaxable');
  const b = read.get('zeroRated');
  const c = read.get('nilExempt');
  const e = seen.has('nonGst') ? read.get('nonGst') : undefined;
  if (!a || !b || !c) return { period: null, fields };

  const gstinLine = lines.find((line) => SUPPLIER_GSTIN.test(line.text) && GSTIN.test(line.text));
  const snippetParts = [yearLine.text, periodLine.text, a.shown, b.shown, c.shown, ...(e ? [e.shown] : [])];
  return {
    fields,
    period: {
      form: 'GSTR-3B',
      yearText: yearLine.text.match(YEAR)![1].replace(/\s+/g, ''),
      periodText: periodLine.text.match(PERIOD)![1].replace(/\s+/g, ''),
      outwardTaxable: a.taxable,
      zeroRated: b.taxable,
      nilExempt: c.taxable,
      nonGst: e?.taxable ?? null,
      gstin: gstinLine?.text.match(GSTIN)?.[1] ?? null,
      page: a.page,
      snippet: snippetParts.join(' | ').slice(0, SNIPPET_MAX),
      lines: { outwardTaxable: a.line, zeroRated: b.line, nilExempt: c.line, nonGst: e?.line ?? null },
      confidence,
    },
  };
}

// ------------------------------------------------------------------ Periods

const MONTH_NUMBER: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAME = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;

function monthNumber(word: string): number | null {
  return MONTH_NAME.test(word) ? MONTH_NUMBER[word.slice(0, 3).toLowerCase()] : null;
}

/**
 * The YYYY-MM months a printed period covers within the FY that starts in April of `startYear`:
 * one named month, or a whole FY quarter (`Apr-Jun`, `Jul-Sep`, `Oct-Dec`, `Jan-Mar`). Anything
 * else (a range that is not a quarter, an unknown word) is null.
 */
export function periodMonths(periodText: string, startYear: number): string[] | null {
  const parts = periodText.split('-').map((part) => part.trim());
  const toMonth = (n: number) => `${n >= 4 ? startYear : startYear + 1}-${String(n).padStart(2, '0')}`;
  if (parts.length === 1) {
    const n = monthNumber(parts[0]);
    return n === null ? null : [toMonth(n)];
  }
  if (parts.length !== 2) return null;
  const from = monthNumber(parts[0]);
  const to = monthNumber(parts[1]);
  if (from === null || to === null || ![4, 7, 10, 1].includes(from) || to !== from + 2) return null;
  return [from, from + 1, from + 2].map(toMonth);
}
