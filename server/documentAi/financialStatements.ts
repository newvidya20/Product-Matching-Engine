/**
 * Schedule III financial statement reader: a vertical balance sheet, a profit and loss account and
 * a cash flow statement, read from text the server already has (PDF text layer, OCR lines), with no AI.
 *
 * Never-guess rules:
 * - Each printed line is matched by its own label to one standard item; the unit ("Rs. In Lakhs") and
 *   the current / previous year columns come from the statement's own headings.
 * - A note-number column is never taken for a figure: only figures with a decimal point, a thousands
 *   separator, four or more digits, or a dash count as values.
 * - A value that is not printed as one figure (current assets, EBITDA, net worth ...) is computed from
 *   printed lines and emitted with `reconciled: true` only when the statement proves itself:
 *   equity + non-current + current liabilities = TOTAL EQUITY & LIABILITIES, non-current + current
 *   assets = TOTAL ASSETS, and total income - total expenses = profit before tax. If a check fails the
 *   derived items are left out, never repaired.
 * - Only a year-end column is used. A half-yearly P&L with five columns is read only when its heading
 *   says "Year ended", and then only the last two columns (this year, last year).
 * Pure: no I/O, no clock, no logging.
 */
import type { AmountUnit } from './validators.ts';
import type { RawField } from './prompt.ts';

const SNIPPET_MAX = 300;
const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const snip = (text: string) => clean(text).slice(0, SNIPPET_MAX);

// ------------------------------------------------------------------ Dates and periods

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MON = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*`;

interface YearMonth {
  year: number;
  month: number;
}

const DATE_PATTERNS: ReadonlyArray<{ re: RegExp; read: (m: RegExpMatchArray) => YearMonth | null }> = [
  // 31-Mar-26, 31 March 2026, 31st March, 2026
  {
    re: new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?[-./\s]+${MON}[-./\s,]*(\d{4}|\d{2})\b`, 'gi'),
    read: (m) => ym(Number(m[2].length === 2 ? 2000 + Number(m[2]) : m[2]), MONTHS[m[1].toLowerCase()]),
  },
  // March 31, 2026
  {
    re: new RegExp(String.raw`\b${MON}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'gi'),
    read: (m) => ym(Number(m[2]), MONTHS[m[1].toLowerCase()]),
  },
  // 31.03.2026, 31/03/26
  {
    re: /\b\d{1,2}[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g,
    read: (m) => ym(m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]), Number(m[1])),
  },
  // 2025-26 : a financial year ends in March of the second year
  {
    re: /(?<![\d.,-])((?:19|20)\d{2})\s*[-–/]\s*(\d{4}|\d{2})(?![\d.,-])/g,
    read: (m) => {
      const first = Number(m[1]);
      const second = m[2].length === 2 ? Math.floor(first / 100) * 100 + Number(m[2]) : Number(m[2]);
      return second === first + 1 ? ym(second, 3) : null;
    },
  },
];

function ym(year: number, month: number | undefined): YearMonth | null {
  if (!month || month < 1 || month > 12 || year < 1990 || year > 2100) return null;
  return { year, month };
}

/** Period-end dates written in `text`, in order of appearance. */
function datesIn(text: string): Array<YearMonth & { at: number }> {
  const out: Array<YearMonth & { at: number }> = [];
  for (const { re, read } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = read(m);
      if (value) out.push({ ...value, at: m.index ?? 0 });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function stripDates(text: string): string {
  let out = text;
  for (const { re } of DATE_PATTERNS) out = out.replace(re, (m) => ' '.repeat(m.length));
  return out;
}

/** `FY 2025-26` for a year ending 31 March; null for any other year-end (never guessed). */
function fyLabel(end: YearMonth): string | null {
  if (end.month !== 3) return null;
  return `FY ${end.year - 1}-${String(end.year % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ Lines and figures

interface Line {
  text: string;
  page: number;
}

interface Figure {
  /** As printed, e.g. `(197.61)` or `154.76`. */
  token: string;
  value: number;
}

interface Row {
  label: string;
  line: string;
  page: number;
  cur: Figure | null;
  prev: Figure | null;
  /** Row carried more than two figures (a multi-column layout). */
  columns: number;
}

const DASHES = new Set(['-', '–', '—', '--']);
const FIGURE = /^\(?-?\d[\d,]*(?:\.\d+)?\)?$/;

/** A figure and not a note number or a serial: decimals, separators or four-plus digits. */
function isValueToken(token: string): boolean {
  if (DASHES.has(token)) return true;
  if (!FIGURE.test(token)) return false;
  const digits = token.replace(/[^\d]/g, '');
  return token.includes('.') || token.includes(',') || digits.length >= 4;
}

function toFigure(token: string): Figure | null {
  if (DASHES.has(token)) return { token, value: 0 };
  const negative = token.startsWith('(') || token.startsWith('-');
  const digits = token.replace(/[^\d.]/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return { token, value: negative && value !== 0 ? -value : value };
}

const LABEL_NUMBERING = /^(?:[ivx]{1,4}\s+(?=[a-z(])|\(?[a-z]{1,2}\)\s*|\(?[ivx]{1,4}\)\s*|\(?\d{1,2}\)\s*|[ivx]{1,4}\.\s*(?=[a-z])|[ivx]{1,4}\.\s+|\d{1,2}\.\s+|[a-z]\.\s+)+/i;

function normaliseLabel(label: string): string {
  return clean(label)
    .replace(/[|:]+/g, ' ')
    .replace(LABEL_NUMBERING, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Splits a line into its label and the trailing run of figures. Note numbers (small bare integers)
 * between the label and the figures are dropped.
 */
function splitLine(text: string): { label: string; figures: string[] } {
  const tokens = clean(stripDates(text)).split(' ').filter(Boolean);
  let end = tokens.length;
  const figures: string[] = [];
  while (end > 0 && isValueToken(tokens[end - 1])) {
    figures.unshift(tokens[end - 1]);
    end -= 1;
  }
  // A note number sits between the label and the figures.
  while (end > 0 && figures.length > 0 && /^\d{1,2}$/.test(tokens[end - 1])) end -= 1;
  return { label: tokens.slice(0, end).join(' '), figures };
}

// ------------------------------------------------------------------ Units

const SCALE_WORD = /\b(?:lakhs?|lacs?|crores?|crs?|thousands?|millions?|mn)\b/i;

const UNIT_WORDS: ReadonlyArray<[RegExp, AmountUnit]> = [
  [/\bcrores?\b|\bcrs?\b/i, 'crore'],
  [/\blakhs?\b|\blacs?\b/i, 'lakh'],
  [/\bthousands?\b/i, 'thousand'],
  [/\bmillions?\b|\bmn\b/i, 'million'],
];

/** `Rs. In Lakhs`, `(₹ in Crores)`, `Amount in Rs. Lakhs`: a short heading line with no figure. */
function unitHeading(text: string): { unit: AmountUnit; unitText: string } | null {
  const line = clean(text);
  if (line.length > 80) return null;
  if (!/(?:rs\.?|inr|₹|rupees|amounts?|figures?|in)\b/i.test(line)) return null;
  if (/\d/.test(stripDates(line))) return null;
  // An explicit "in Rupees" heading is a unit too: figures are then full rupees, not scaled.
  if (/^\(?\s*(?:all\s+)?(?:amounts?\s+|figures?\s+)?in\s+(?:rs\.?|₹|inr|rupees)\s*\)?\.?$/i.test(line)) {
    return { unit: 'rupees', unitText: line };
  }
  const match = line.match(/(?:rs\.?|inr|₹|rupees|amounts?|figures?)?\s*(?:in|\()\s*(?:rs\.?|₹|inr)?\s*'?\s*(lakhs?|lacs?|crores?|crs?|thousands?|millions?|mn)\b/i);
  if (!match) return null;
  const unit = UNIT_WORDS.find(([re]) => re.test(match[1]))?.[1];
  return unit ? { unit, unitText: line } : null;
}

// ------------------------------------------------------------------ Sections

type Kind = 'bs' | 'pl' | 'cf';

const HEADING_START = new RegExp(
  String.raw`^(?:(?:standalone|consolidated|audited|unaudited|provisional|abridged)\s+)*(?:` +
    String.raw`(?<bs>balance\s+sheet|statement\s+of\s+assets\s*(?:&|and)\s*liabilities)|` +
    String.raw`(?<pl>statement\s+of\s+(?:audited\s+|unaudited\s+)?(?:financial\s+results?|profit\s*(?:&|and)\s*loss(?:\s+account)?)|profit\s*(?:&|and)\s*loss\s+(?:account|statement)|statement\s+of\s+income|trading(?:\s+(?:and|&)\s+profit\s*(?:&|and)\s*loss)?\s+account)|` +
    String.raw`(?<cf>cash\s*flow\s+statement|statement\s+of\s+cash\s+flows?)` +
    String.raw`)`,
  'i'
);
const NOTES_HEADING = /^(?:notes?\s+(?:to|forming)|significant\s+accounting\s+policies|summary\s+of\s+(?:material\s+)?(?:significant\s+)?accounting)/i;

function headingKind(text: string): Kind | null {
  const line = clean(text);
  if (line.length > 120 || line.endsWith(',')) return null;
  const match = HEADING_START.exec(line);
  if (!match?.groups) return null;
  // The rest of a real title is a date or a few words ("as at 31st March 2025"), not a sentence.
  const rest = clean(stripDates(line.slice(match[0].length))).replace(/[^A-Za-z ]/g, ' ');
  if (rest.split(/\s+/).filter((w) => w.length > 2).length > 8) return null;
  if (splitLine(line).figures.length >= 2) return null;
  return match.groups.bs ? 'bs' : match.groups.pl ? 'pl' : 'cf';
}

interface Section {
  kind: Kind;
  consolidated: boolean;
  headingLine: Line;
  lines: Line[];
  unit: { unit: AmountUnit; unitText: string } | null;
}

function findSections(lines: readonly Line[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = headingKind(line.text);
    const notes = NOTES_HEADING.test(clean(line.text));
    if (heading || notes) {
      current = null;
      if (heading) {
        const near = lines.slice(Math.max(0, i - 3), i + 1).map((l) => l.text).join(' ');
        // A unit heading counts only when it belongs to this statement: on its title block, just
        // above the heading on the same page, or (below) inside the section. Never carried over
        // from an earlier statement or page.
        let unit: Section['unit'] = null;
        for (let j = i - 1; j >= Math.max(0, i - 3) && !unit; j -= 1) {
          if (lines[j].page === line.page) unit = unitHeading(lines[j].text);
        }
        current = { kind: heading, consolidated: /consolidated/i.test(near), headingLine: line, lines: [line], unit };
        sections.push(current);
      }
      continue;
    }
    if (!current) continue;
    if (line.page - current.headingLine.page > 2) {
      current = null;
      continue;
    }
    const found = unitHeading(line.text);
    if (found) {
      if (!current.unit) current.unit = found;
      continue;
    }
    current.lines.push(line);
  }
  return sections;
}

// ------------------------------------------------------------------ Rows

interface ParsedSection {
  section: Section;
  rows: Row[];
  /** Period end of the current (first) and previous year columns. */
  current: YearMonth | null;
  previous: YearMonth | null;
  fullYear: boolean;
  multiColumn: boolean;
  singleColumn: boolean;
}

/** Current and previous year-end dates from the section's headings (the lines before its first row). */
interface ColumnInfo {
  current: YearMonth | null;
  previous: YearMonth | null;
  /** The columns read are whole financial years ending 31 March, by their own headings. */
  fullYear: boolean;
  /** More than two figures per row are allowed: the last two are the "Year ended" columns. */
  multiColumn: boolean;
}

const PERIODIC = /\b(?:quarter(?:ly)?|half[\s-]*year(?:ly)?|(?:three|six|nine)\s+months?|\d{1,2}\s+months?)\b/i;
const ENDED_PHRASE = /(quarter(?:ly)?|half[\s-]*year(?:ly)?|(?:three|six|nine)\s+months?|year)\s*-?\s*ended/gi;
const FULL_YEAR_HEADING = /year\s*-?\s*ended|for\s+the\s+year|as\s+(?:at|on)\b|financial\s+year|\bFY\b/i;

/**
 * Which columns are which, from the section's own headings. Current is the later heading date, the
 * previous column the earlier one; with one date printed the previous column has no period at all.
 * A heading that names a quarter, half year or part-year is refused unless it is a multi-column
 * result whose LAST heading is plain "Year ended" over two 31 March dates a year apart.
 */
function columnDates(section: Section): ColumnInfo {
  const head: Line[] = [];
  for (const line of section.lines) {
    if (head.length > 0 && splitLine(line.text).figures.length >= 2 && !isDateOnly(line.text)) break;
    head.push(line);
    if (head.length >= 16) break;
  }
  const headText = head.map((l) => l.text).join(' ');
  const none: ColumnInfo = { current: null, previous: null, fullYear: false, multiColumn: false };
  const dates = head.flatMap((l) => datesIn(l.text));
  if (dates.length === 0) return none;

  const index = (d: YearMonth) => d.year * 12 + d.month;
  const last = dates[dates.length - 1];
  const before = dates[dates.length - 2];
  let current: YearMonth;
  let previous: YearMonth | null = null;
  if (before && index(before) !== index(last)) {
    const later = index(before) >= index(last) ? before : last;
    const earlier = later === before ? last : before;
    current = { year: later.year, month: later.month };
    previous = { year: earlier.year, month: earlier.month };
  } else {
    current = { year: last.year, month: last.month };
  }
  // The previous column is a whole year earlier, same month; anything else is not a year-on-year pair.
  if (previous && !(previous.month === current.month && previous.year === current.year - 1)) previous = null;
  const march = current.month === 3;

  const phrases = [...headText.matchAll(ENDED_PHRASE)].map((m) => m[1].toLowerCase().replace(/\s+/g, ' '));
  if (PERIODIC.test(headText)) {
    const lastPhrase = phrases[phrases.length - 1];
    const lastTwoAreYears = dates.length > 2 && previous !== null && before !== undefined && index(before) !== index(last);
    const ok = lastPhrase === 'year' && march && lastTwoAreYears;
    return ok ? { current, previous, fullYear: true, multiColumn: true } : none;
  }
  // Two year-on-year dates printed as column headings (`2024-25 | 2023-24`) are a heading of their own.
  const fullYear = march && (FULL_YEAR_HEADING.test(headText) || previous !== null);
  return { current, previous, fullYear, multiColumn: false };
}

function isDateOnly(text: string): boolean {
  return !/[A-Za-z]{3,}/.test(clean(stripDates(text)).replace(/[^A-Za-z ]/g, ' '));
}

/** Text with no figure and a label worth keeping for a figure that wraps onto the next line. */
const SKIP_PENDING = /^(?:particulars|note|notes|audited|un-?audited|rs\.?|sr\.?|for\b|chartered|firm|membership|place|date|udin|sd\/-|din\b)/i;

function parseSection(section: Section): ParsedSection {
  const dates = columnDates(section);
  const rows: Row[] = [];
  let pending: string | null = null;
  let singles = 0;
  let pairs = 0;
  const raw: Array<{ label: string; figures: string[]; text: string; page: number }> = [];
  for (const line of section.lines) {
    const { label, figures } = splitLine(line.text);
    const hasLetters = /[A-Za-z]{2,}/.test(label);
    if (figures.length === 0) {
      if (hasLetters && !SKIP_PENDING.test(clean(label)) && clean(label).length < 200) {
        raw.push({ label, figures: [], text: line.text, page: line.page });
        pending = label;
      }
      continue;
    }
    let useLabel = label;
    if (!hasLetters) {
      if (!pending) continue;
      useLabel = pending;
    }
    pending = null;
    if (figures.length >= 2) pairs += 1;
    else singles += 1;
    raw.push({ label: useLabel, figures, text: line.text, page: line.page });
  }
  const singleColumn = pairs === 0 && singles > 0;
  for (const r of raw) {
    if (r.figures.length === 0) {
      rows.push({ label: normaliseLabel(r.label), line: r.text, page: r.page, cur: null, prev: null, columns: 0 });
      continue;
    }
    const figs = r.figures;
    let cur: Figure | null;
    let prev: Figure | null = null;
    if (singleColumn) {
      cur = toFigure(figs[figs.length - 1]);
    } else if (figs.length >= 2) {
      // More than two columns (quarter, half year ... year): trusted only when the heading says year ended.
      if (figs.length > 2 && !dates.multiColumn) continue;
      cur = toFigure(figs[figs.length - 2]);
      prev = toFigure(figs[figs.length - 1]);
    } else if (DASHES.has(figs[0])) {
      cur = { token: figs[0], value: 0 };
    } else {
      continue; // one figure among two columns: which column is unknown
    }
    if (!cur) continue;
    rows.push({ label: normaliseLabel(r.label), line: r.text, page: r.page, cur, prev, columns: figs.length });
  }
  return {
    section,
    rows,
    current: dates.current,
    previous: singleColumn ? null : dates.previous,
    fullYear: dates.fullYear,
    multiColumn: dates.multiColumn,
    singleColumn,
  };
}

// ------------------------------------------------------------------ Balance sheet

type Block = 'eq' | 'ncl' | 'cl' | 'nca' | 'ca' | null;

function blockOf(label: string): Block | undefined {
  if (/^equity\s*(?:&|and)\s*liabilit|^liabilities$|^assets$|^total\s+(?:equ\w*|liab\w*|assets?)\s*(?:&|and)?/.test(label)) return null;
  if (/shareholders?['’]?s?\s*(?:funds?|equity)|^equity$|owners?['’]?\s*funds?|capital\s+and\s+reserves/.test(label)) return 'eq';
  if (/^non[\s-]*current\s+liabilit/.test(label)) return 'ncl';
  if (/^current\s+liabilit/.test(label)) return 'cl';
  if (/^non[\s-]*current\s+assets?/.test(label)) return 'nca';
  if (/^current\s+assets?/.test(label)) return 'ca';
  return undefined;
}

type Col = 'cur' | 'prev';

interface BalanceSheet {
  totalAssets: Row | null;
  totalEquityLiabilities: Row | null;
  blocks: Record<'eq' | 'ncl' | 'cl' | 'nca' | 'ca', Row[]>;
  blockTotals: Partial<Record<'eq' | 'ncl' | 'cl' | 'nca' | 'ca', Row>>;
}

const TOTAL_EL = /^total\s+equ\w*\s*(?:&|and)\s*liab\w*|^total\s+liab\w*\s*(?:&|and)\s*equ\w*|^equity\s+and\s+liabilities\s+total/;
const TOTAL_ASSETS = /^total\s+assets?$/;

function readBalanceSheet(parsed: ParsedSection): BalanceSheet | null {
  const blocks: BalanceSheet['blocks'] = { eq: [], ncl: [], cl: [], nca: [], ca: [] };
  const blockTotals: BalanceSheet['blockTotals'] = {};
  let block: Block = null;
  let totalAssets: Row | null = null;
  let totalEL: Row | null = null;
  // Which side of the sheet we are on, so a bare `TOTAL` row can be told apart: the first one after
  // EQUITY AND LIABILITIES is the liabilities total, the one after ASSETS the assets total.
  let side: 'L' | 'A' | null = null;
  for (const row of parsed.rows) {
    if (row.cur === null) {
      if (/^equity\s*(?:&|and)\s*liabilit|^liabilities$/.test(row.label)) side = 'L';
      else if (/^assets$/.test(row.label)) side = 'A';
      const next = blockOf(row.label);
      if (next !== undefined) block = next;
      continue;
    }
    if (/^total$/.test(row.label) && side) {
      if (side === 'L' && !totalEL) totalEL = row;
      else if (side === 'A' && !totalAssets) totalAssets = row;
      block = null;
      continue;
    }
    if (TOTAL_EL.test(row.label)) {
      totalEL = row;
      block = null;
      continue;
    }
    if (TOTAL_ASSETS.test(row.label)) {
      totalAssets = row;
      block = null;
      continue;
    }
    // A heading that carries figures is that group's printed total.
    const headingBlock = blockOf(row.label);
    if (headingBlock && !row.label.startsWith('total')) {
      blockTotals[headingBlock] = row;
      continue;
    }
    if (/^total\s+(?:shareholders|equity|funds|non[\s-]*current|current|liabilities|assets?)\b/.test(row.label) && block) {
      blockTotals[block] = row;
      continue;
    }
    if (block) blocks[block].push(row);
  }
  if (!totalAssets && !totalEL) return null;
  return { totalAssets, totalEquityLiabilities: totalEL, blocks, blockTotals };
}

const valueOf = (row: Row, col: Col): number | null => (col === 'cur' ? row.cur?.value ?? null : row.prev?.value ?? null);

function sumBlock(rows: readonly Row[], col: Col): number | null {
  let sum = 0;
  for (const row of rows) {
    const v = valueOf(row, col);
    if (v === null) return null; // a line with no figure in this column: the sum cannot be proved
    sum += v;
  }
  return sum;
}

const tolerance = (rows: number) => 0.006 * Math.max(rows, 1) + 0.011;
const near = (a: number, b: number, rows: number) => Math.abs(a - b) <= tolerance(rows);
const fmt = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

// ------------------------------------------------------------------ Output

class Emitter {
  readonly fields: RawField[] = [];
  constructor(
    private readonly confidence: number,
    private readonly unit: { unit: AmountUnit; unitText: string } | null
  ) {}

  printed(fieldId: string, row: Row, col: Col, period: string | null, cap = 1): void {
    const figure = col === 'cur' ? row.cur : row.prev;
    if (!figure || DASHES.has(figure.token)) return;
    this.fields.push({
      fieldId,
      rawValue: figure.token,
      enumValue: null,
      page: row.page,
      sheetName: null,
      cellRef: null,
      snippet: snip(row.line),
      confidence: Math.min(this.confidence, cap),
      statedUnit: this.unit?.unit ?? null,
      unitText: this.unit?.unitText || null,
      period,
      subjectRef: null,
    });
  }

  computed(fieldId: string, value: number, parts: readonly Row[], col: Col, period: string | null, note: string, cap = 1): void {
    const quoted = parts
      .map((row) => {
        const figure = col === 'cur' ? row.cur : row.prev;
        return `${row.label.replace(/\s+/g, ' ')} ${figure?.token ?? ''}`.trim();
      })
      .join(' + ');
    this.fields.push({
      fieldId,
      rawValue: fmt(value),
      enumValue: null,
      page: parts[0]?.page ?? null,
      sheetName: null,
      cellRef: null,
      snippet: snip(`${note}: ${quoted}`),
      confidence: Math.min(this.confidence, cap),
      statedUnit: this.unit?.unit ?? null,
      unitText: this.unit?.unitText || null,
      period,
      subjectRef: null,
      reconciled: true,
    });
  }
}

const periodOf = (end: YearMonth | null): string | null => (end ? fyLabel(end) : null);

function emitBalanceSheet(parsed: ParsedSection, emit: Emitter): void {
  const bs = readBalanceSheet(parsed);
  if (!bs) return;
  const period = periodOf(parsed.current);
  const total = bs.totalAssets ?? bs.totalEquityLiabilities;
  if (bs.totalAssets) emit.printed('financialProfile.totalAssets', bs.totalAssets, 'cur', period);

  const { eq, ncl, cl, nca, ca } = bs.blocks;
  const rowCount = eq.length + ncl.length + cl.length + nca.length + ca.length;
  const eqSum = sumBlock(eq, 'cur');
  const nclSum = sumBlock(ncl, 'cur');
  const clSum = sumBlock(cl, 'cur');
  const ncaSum = sumBlock(nca, 'cur');
  const caSum = sumBlock(ca, 'cur');
  const totalFigure = total?.cur?.value ?? null;
  if (!total || totalFigure === null) return;

  // The two sides of the balance sheet must each add up to the printed total, and to one another.
  const liabilitySide =
    eqSum !== null && nclSum !== null && clSum !== null && near(eqSum + nclSum + clSum, bs.totalEquityLiabilities?.cur?.value ?? totalFigure, eq.length + ncl.length + cl.length);
  const assetSide = ncaSum !== null && caSum !== null && near(ncaSum + caSum, bs.totalAssets?.cur?.value ?? totalFigure, nca.length + ca.length);
  if (bs.totalAssets && bs.totalEquityLiabilities && !near(bs.totalAssets.cur!.value, bs.totalEquityLiabilities.cur!.value, 2)) return;
  void rowCount;

  if (assetSide && ca.length > 0) {
    emit.computed('financialProfile.currentAssets', caSum!, ca, 'cur', period, 'Current assets (non-current + current = total assets)');
  }
  if (liabilitySide && cl.length > 0) {
    emit.computed('financialProfile.currentLiabilities', clSum!, cl, 'cur', period, 'Current liabilities (equity + non-current + current = total)');
  }
  if (!liabilitySide) return;

  emit.computed('financialProfile.shareholdersEquity', eqSum!, eq, 'cur', period, "Shareholders' funds");
  const outside = nclSum! + clSum!;
  const outsideRows = [...ncl, ...cl];
  emit.computed('financialProfile.totalLiabilities', outside, outsideRows, 'cur', period, 'Non-current + current liabilities');
  emit.computed('financialProfile.totalOutsideLiabilities', outside, outsideRows, 'cur', period, 'Outside liabilities = total less net worth');

  // Tangible net worth: funds less intangible assets. No intangibles line at all is reviewed, not assumed nil.
  const intangibles = nca.filter((row) => /intangible/.test(row.label) && !/under\s+development/.test(row.label));
  const intangibleSum = sumBlock(intangibles, 'cur');
  if (intangibleSum !== null) {
    emit.computed(
      'financialProfile.tangibleNetWorth',
      eqSum! - intangibleSum,
      [...eq, ...intangibles],
      'cur',
      period,
      intangibles.length > 0 ? "Net worth less intangible assets" : "Net worth (no intangible assets line printed)",
      intangibles.length > 0 ? 1 : 0.8
    );
  }

  // Borrowings are picked by label, so they are reviewed rather than auto-applied.
  const borrowings = [...ncl, ...cl].filter((row) => /borrowing|debenture|term\s+loans?|current\s+maturit|loans?\s+from/.test(row.label) && !/advances?/.test(row.label));
  const borrowingSum = sumBlock(borrowings, 'cur');
  if (borrowings.length > 0 && borrowingSum !== null) {
    emit.computed('financialProfile.totalOutstandingBorrowings', borrowingSum, borrowings, 'cur', period, 'Borrowings', 0.8);
  }
}

// ------------------------------------------------------------------ Profit and loss

const find = (rows: readonly Row[], re: RegExp, exclude?: RegExp): Row | null =>
  rows.find((row) => row.cur !== null && re.test(row.label) && !(exclude && exclude.test(row.label))) ?? null;

function emitProfitAndLoss(parsed: ParsedSection, emit: Emitter): void {
  const { rows } = parsed;
  const cur = periodOf(parsed.current);
  const prev = periodOf(parsed.previous);

  const revenueOps = find(rows, /^(?:total\s+)?revenue\s+from\s+operations|^net\s+sales|^revenue\s+from\s+sale|^sales\b|^turnover|^gross\s+revenue|^income\s+from\s+operations|^net\s+revenue/, /other|total\s+income/);
  // `Total revenue` can include other income, so it stands in only when no operations line exists, and is reviewed.
  const revenueTotal = revenueOps ? null : find(rows, /^total\s+revenue$|^revenue$/, /other/);
  const revenue = revenueOps ?? revenueTotal;
  const totalIncome = find(rows, /^total\s+(?:income|revenue)$|^total\s+income\b/);
  const totalExpenses = find(rows, /^total\s+expenses?/);
  const financeCosts = find(rows, /^finance\s+costs?|^finance\s+charges|^interest\s+expenses?|^interest\s+and\s+finance|^interest\s+(?:paid|charges|on\s+(?:borrowings|loans?|term))|^interest$/, /income|received|earned/);
  const depreciation = find(rows, /depreciation/, /accumulated|^less/);
  const pbt = find(rows, /profit.*before.*tax|^pbt$/, /exceptional|extraordinary|discontinu/) ?? find(rows, /profit.*before.*tax/);
  const pat = find(rows, /^profit(?:\s*\/?\s*\(?loss\)?)?\s*for\s+(?:the\s+)?(?:period|year)|^profit(?:\s*\/?\s*\(?loss\)?)?\s*after\s+tax|^net\s+profit(?:\s*\/?\s*\(?loss\)?)?\b(?!.*before)|^pat$|^profit\s*\/\s*\(?loss\)?$/, /before|comprehensive|per\s+share|attributable/);

  if (revenue) {
    const cap = revenueTotal ? 0.8 : 1;
    emit.printed('financialProfile.annualRevenue', revenue, 'cur', cur, cap);
    if (prev) emit.printed('financialProfile.annualRevenue', revenue, 'prev', prev, cap);
  }
  if (pat) {
    emit.printed('financialProfile.netProfitAfterTax', pat, 'cur', cur);
    if (prev) emit.printed('financialProfile.netProfitAfterTax', pat, 'prev', prev);
  }
  if (depreciation) emit.printed('financialProfile.depreciation', depreciation, 'cur', cur);
  if (financeCosts) emit.printed('financialProfile.interestExpense', financeCosts, 'cur', cur);

  // EBIT / EBITDA are sums of printed lines, so the P&L has to prove itself first when it can.
  if (pbt && financeCosts && depreciation && pbt.cur && financeCosts.cur && depreciation.cur) {
    if (totalIncome?.cur && totalExpenses?.cur && !near(totalIncome.cur.value - totalExpenses.cur.value, pbt.cur.value, 3)) return;
    const amort = find(rows, /^amorti[sz]ation/, /depreciation/);
    const ebit = pbt.cur.value + financeCosts.cur.value;
    const parts = [pbt, financeCosts];
    emit.computed('financialProfile.ebit', ebit, parts, 'cur', cur, 'Profit before tax + finance costs');
    const ebitda = ebit + depreciation.cur.value + (amort?.cur?.value ?? 0);
    emit.computed('financialProfile.ebitda', ebitda, [...parts, depreciation, ...(amort ? [amort] : [])], 'cur', cur, 'Profit before tax + finance costs + depreciation');
  }
}


// ------------------------------------------------------------------ T-form (two-sided) statements

const FIG_SRC = String.raw`\(?-?\d[\d,]*(?:\.\d+)?\)?`;
/** `Capital Account 10,00,000 Fixed Assets 20,00,000`: a left item and a right item on one line. */
const PAIR_LINE = new RegExp(String.raw`^(.*?[A-Za-z].*?)\s+(${FIG_SRC})\s+(.*?[A-Za-z].*?)\s+(${FIG_SRC})$`);

interface TPair {
  left: Row;
  right: Row;
}

function tRow(label: string, token: string, line: Line): Row | null {
  if (!isValueToken(token)) return null;
  const figure = toFigure(token);
  return figure ? { label: normaliseLabel(label), line: line.text, page: line.page, cur: figure, prev: null, columns: 1 } : null;
}

function tPairs(section: Section): TPair[] {
  const pairs: TPair[] = [];
  for (const line of section.lines) {
    const m = PAIR_LINE.exec(clean(stripDates(line.text)));
    if (!m) continue;
    const left = tRow(m[1], m[2], line);
    const right = tRow(m[3], m[4], line);
    if (left && right) pairs.push({ left, right });
  }
  return pairs;
}

/** Liabilities and Assets side by side: a header names both, and several lines carry two items. */
function isTForm(section: Section): boolean {
  const named = section.lines
    .slice(0, 14)
    .some((l) => /liabilit/i.test(l.text) && /\bassets?\b/i.test(l.text) && splitLine(l.text).figures.length === 0);
  return named && tPairs(section).length >= 3;
}

const T_EQUITY = /capital|reserve|surplus|profit|share\s+premium|retained/;
const T_CURRENT_LIAB = /creditor|payable|provision|outstanding|overdraft|cash\s+credit|expenses|bills\s+payable|current\s+maturit|advances?\s+from|short/;
const T_TERM_LIAB = /loan|borrowing|debenture|term|secured|mortgage/;
const T_FIXED = /fixed|plant|machiner|building|land|furniture|vehicle|computer|equipment|investment|goodwill|intangible|patent|trademark|preliminary|capital\s+work/;
const T_CURRENT_ASSET = /stock|inventor|debtor|receivable|cash|bank|advance|prepaid|deposit|accrued|closing/;

interface TBlock {
  rows: TPair[];
  left: Row;
  right: Row;
}

/** Blocks of pairs ended by a `Total | Total` pair; only a block whose two sides agree is used. */
function tBlocks(pairs: readonly TPair[]): TBlock[] {
  const blocks: TBlock[] = [];
  let rows: TPair[] = [];
  for (const pair of pairs) {
    if (/^total\b/.test(pair.left.label) && /^total\b/.test(pair.right.label)) {
      const sumL = rows.reduce((t, r) => t + r.left.cur!.value, 0);
      const sumR = rows.reduce((t, r) => t + r.right.cur!.value, 0);
      if (
        rows.length > 0 &&
        near(sumL, pair.left.cur!.value, rows.length) &&
        near(sumR, pair.right.cur!.value, rows.length) &&
        near(pair.left.cur!.value, pair.right.cur!.value, 2)
      ) {
        blocks.push({ rows, left: pair.left, right: pair.right });
      }
      rows = [];
      continue;
    }
    rows.push(pair);
  }
  return blocks;
}

const sumOf = (rows: readonly Row[]) => rows.reduce((t, r) => t + r.cur!.value, 0);

function emitTFormBalanceSheet(parsed: ParsedSection, emit: Emitter): void {
  const period = periodOf(parsed.current);
  const block = tBlocks(tPairs(parsed.section))[0];
  if (!block) return; // the two sides do not agree with their printed totals: nothing is derived
  emit.printed('financialProfile.totalAssets', block.right, 'cur', period);
  const left = block.rows.map((r) => r.left);
  const right = block.rows.map((r) => r.right);
  const kindOfLeft = (row: Row) =>
    T_CURRENT_LIAB.test(row.label) ? 'cl' : T_TERM_LIAB.test(row.label) ? 'ncl' : T_EQUITY.test(row.label) ? 'eq' : null;
  const kindOfRight = (row: Row) => (T_FIXED.test(row.label) ? 'nca' : T_CURRENT_ASSET.test(row.label) ? 'ca' : null);

  if (right.every((r) => kindOfRight(r))) {
    const ca = right.filter((r) => kindOfRight(r) === 'ca');
    if (ca.length > 0) emit.computed('financialProfile.currentAssets', sumOf(ca), ca, 'cur', period, 'Current assets (both sides total the same)');
  }
  if (!left.every((r) => kindOfLeft(r))) return;
  const eq = left.filter((r) => kindOfLeft(r) === 'eq');
  const cl = left.filter((r) => kindOfLeft(r) === 'cl');
  const equity = sumOf(eq);
  const others = left.filter((r) => !eq.includes(r));
  const outside = block.left.cur!.value - equity;
  if (cl.length > 0) emit.computed('financialProfile.currentLiabilities', sumOf(cl), cl, 'cur', period, 'Current liabilities (both sides total the same)');
  if (eq.length === 0) return;
  emit.computed('financialProfile.shareholdersEquity', equity, eq, 'cur', period, 'Capital and reserves');
  emit.computed('financialProfile.totalLiabilities', outside, others, 'cur', period, 'Liabilities other than capital and reserves');
  emit.computed('financialProfile.totalOutsideLiabilities', outside, others, 'cur', period, 'Outside liabilities');
  const intangibles = right.filter((r) => /goodwill|intangible|patent|trademark|preliminary/.test(r.label));
  emit.computed(
    'financialProfile.tangibleNetWorth',
    equity - sumOf(intangibles),
    [...eq, ...intangibles],
    'cur',
    period,
    'Capital and reserves less intangibles',
    intangibles.length > 0 ? 1 : 0.8
  );
}

/** Trading and Profit & Loss account: expenses on the left, income on the right, each block balanced. */
function emitTFormProfitAndLoss(parsed: ParsedSection, emit: Emitter): void {
  const cur = periodOf(parsed.current);
  for (const block of tBlocks(tPairs(parsed.section))) {
    const strip = (label: string) => label.replace(/^(?:to|by)\s+/, '');
    const left = block.rows.map((r) => ({ ...r.left, label: strip(r.left.label) }));
    const right = block.rows.map((r) => ({ ...r.right, label: strip(r.right.label) }));
    const sales = right.find((r) => /^(?:sales|revenue\s+from\s+operations|turnover|net\s+sales)\b/.test(r.label));
    if (sales) emit.printed('financialProfile.annualRevenue', sales, 'cur', cur);
    const profit = left.find((r) => /^net\s+profit\b/.test(r.label));
    if (profit) emit.printed('financialProfile.netProfitAfterTax', profit, 'cur', cur, 0.8);
    const dep = left.find((r) => /depreciation/.test(r.label));
    if (dep) emit.printed('financialProfile.depreciation', dep, 'cur', cur);
    const interest = left.find((r) => /^interest|^finance\s+charges|^finance\s+costs?/.test(r.label) && !/received|income/.test(r.label));
    if (interest) emit.printed('financialProfile.interestExpense', interest, 'cur', cur);
  }
}

// ------------------------------------------------------------------ Cash flow

function emitCashFlow(parsed: ParsedSection, emit: Emitter): void {
  const row = find(parsed.rows, /^net\s+cash\b.*operating\s+activit|^cash\s+(?:flow\s+)?(?:generated\s+)?from\s+operating\s+activit/, /before|investing|financing/);
  if (row) emit.printed('financialProfile.operatingCashFlow', row, 'cur', periodOf(parsed.current));
}

// ------------------------------------------------------------------ Entry point

export function readFinancialStatements(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  const lines: Line[] = pages.flatMap((page, index) => page.map((text) => ({ text, page: index + 1 })));
  const sections = findSections(lines);
  const out: RawField[] = [];
  let label: RawField | null = null;
  // No scale word anywhere in the document means plain rupees; one named elsewhere never scales this statement.
  const docNamesScale = lines.some((l) => SCALE_WORD.test(l.text));

  for (const kind of ['bs', 'pl', 'cf'] as const) {
    const parsed = sections
      .filter((s) => s.kind === kind)
      .map(parseSection)
      // Whole 31 March years only, with a unit heading of their own: never scaled by a guessed unit.
      .filter((p) => p.fullYear && (p.section.unit !== null || !docNamesScale) && p.rows.some((r) => r.cur !== null));
    // Standalone before consolidated; then the first section with the most recognised rows.
    parsed.sort((a, b) => Number(a.section.consolidated) - Number(b.section.consolidated));
    for (const candidate of parsed) {
      const emit = new Emitter(confidence, candidate.section.unit);
      if (kind === 'bs') (isTForm(candidate.section) ? emitTFormBalanceSheet : emitBalanceSheet)(candidate, emit);
      else if (kind === 'pl') (tPairs(candidate.section).length >= 3 ? emitTFormProfitAndLoss : emitProfitAndLoss)(candidate, emit);
      else emitCashFlow(candidate, emit);
      if (emit.fields.length === 0) continue;
      out.push(...emit.fields);
      const period = periodOf(candidate.current);
      if (!label && period) {
        label = {
          fieldId: 'financialProfile.financialYearLabel',
          rawValue: period,
          enumValue: null,
          page: candidate.section.headingLine.page,
          sheetName: null,
          cellRef: null,
          snippet: snip(candidate.section.headingLine.text),
          confidence,
          statedUnit: null,
          unitText: null,
          period: null,
          subjectRef: null,
        };
      }
      break; // the first section that reads is the statement; later copies (notes, summaries) are ignored
    }
  }
  if (label) out.push(label);
  return out;
}
