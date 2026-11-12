/**
 * Reader for a lender's repayment / amortisation / EMI schedule (one loan per document). No AI.
 *
 * Never-guess rules:
 *  - a row is a serial number, a due date and then amounts; the amounts are placed by a column layout
 *    chosen for the whole table (the layout that proves the most rows), and a row is KEPT only when
 *    its arithmetic holds: principal + interest = instalment and opening - principal = closing
 *    (or, where no closing column is printed, = the next row's opening), each within 1 rupee. A row
 *    that fails is dropped, never repaired. Fewer than 3 kept rows -> nothing is emitted;
 *  - existingMonthlyEmi is the regular instalment: the one most-frequent non-zero instalment value
 *    (a tie, or fewer than 3 rows carrying it, emits nothing), so a broken-period first row or an odd
 *    last instalment is never taken;
 *  - annualScheduledPrincipalRepayments is the sum of principal over the due dates in the 12 months
 *    after `asOf` (past and same-day dates excluded) and only when that window is provably complete:
 *    contiguous instalment numbers, one regular step (monthly / quarterly / half-yearly) and every
 *    expected due date present. A loan that provably ends inside the window (last kept row repays its
 *    whole opening balance) is complete with fewer rows. Otherwise it is NOT emitted (a partial sum is
 *    wrong);
 *  - outstanding balances are not emitted, and nothing is summed across loans.
 * Pure: no I/O, no clock (asOf is a parameter), no logging.
 */
import type { RawField } from './prompt.ts';

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ Amounts and dates

const INDIAN = /^\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?$/;
const WESTERN = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;
const PLAIN = /^\d+(?:\.\d{1,2})?$/;

/** Exact paise for a printed amount (`1,23,456.78`, `3,093,239.00`, `156132`), or null when malformed. */
export function parseScheduleAmount(token: string): number | null {
  const text = token.replace(/^(?:₹|rs\.?|inr)/i, '');
  if (!(INDIAN.test(text) || WESTERN.test(text) || PLAIN.test(text))) return null;
  const [whole, frac = ''] = text.replace(/,/g, '').split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface ParsedDate {
  y: number;
  m: number;
  d: number;
  iso: string;
}

function makeDate(y: number, m: number, d: number): ParsedDate | null {
  if (m < 1 || m > 12 || d < 1 || y < 1990 || y > 2100) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { y, m, d, iso };
}

const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

/** DD/MM/YYYY, DD-MM-YY, DD.MM.YYYY, DD-Mon-YYYY, DD-Mon-YY (day first, always). */
export function parseScheduleDate(text: string): ParsedDate | null {
  let m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (m) return makeDate(fullYear(m[3]), Number(m[2]), Number(m[1]));
  m = text.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[-/. ]?(\d{4}|\d{2})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    return month ? makeDate(fullYear(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

const monthIndex = (d: ParsedDate) => d.y * 12 + d.m - 1;

// ------------------------------------------------------------------ Rows

interface Row {
  serial: number;
  date: ParsedDate;
  page: number;
  /** The row as printed, for the snippet. */
  text: string;
  /** Paise per printed column position (null = a malformed token), at most 5. */
  cols: Array<number | null>;
  raw: string[];
}

interface Resolved {
  row: Row;
  opening: number;
  emi: number;
  principal: number;
  interest: number;
  closing: number | null;
  emiText: string;
  principalText: string;
}

/** Column roles by position: O opening, E instalment, P principal, I interest, C closing. */
const LAYOUTS: readonly string[] = [
  'OEPIC', 'OPIEC', 'OEIPC', 'OIPEC',
  'OEPI', 'OPIE', 'OEIP', 'OIPE',
];

const TOLERANCE = 100; // 1 rupee in paise
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

function isRowStart(tokens: string[], at: number): { len: number; date: ParsedDate } | null {
  if (!/^\d{1,3}$/.test(tokens[at])) return null;
  const one = tokens[at + 1] === undefined ? null : parseScheduleDate(tokens[at + 1]);
  if (one) return { len: 2, date: one };
  if (tokens[at + 3] !== undefined) {
    const three = parseScheduleDate(`${tokens[at + 1]} ${tokens[at + 2]} ${tokens[at + 3]}`);
    if (three) return { len: 4, date: three };
  }
  return null;
}

function parseRows(pages: ReadonlyArray<readonly string[]>): Row[] {
  const rows: Row[] = [];
  pages.forEach((lines, pageIndex) => {
    const tokens = clean(lines.join(' ')).split(/[\s|]+/).filter(Boolean);
    const starts: Array<{ at: number; len: number; date: ParsedDate }> = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const start = isRowStart(tokens, i);
      if (start) {
        starts.push({ at: i, ...start });
        i += start.len - 1;
      }
    }
    starts.forEach((start, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].at : tokens.length;
      const body = tokens.slice(start.at + start.len, end);
      const cols: Array<number | null> = [];
      const raw: string[] = [];
      for (const token of body) {
        if (cols.length >= 5) break;
        if (!/\d/.test(token)) continue;
        cols.push(parseScheduleAmount(token));
        raw.push(token);
      }
      rows.push({
        serial: Number(tokens[start.at]),
        date: start.date,
        page: pageIndex + 1,
        text: tokens.slice(start.at, Math.min(end, start.at + start.len + 6)).join(' '),
        cols,
        raw,
      });
    });
  });
  return rows;
}

/** Place a row's amounts by a layout and check its own arithmetic. Null when it does not hold. */
function resolveRow(row: Row, layout: string): Resolved | null {
  if (row.cols.length < layout.length) return null;
  const at = (role: string) => {
    const i = layout.indexOf(role);
    return i < 0 ? null : row.cols[i];
  };
  const opening = at('O');
  const emi = at('E');
  const principal = at('P');
  const interest = at('I');
  const closing = layout.includes('C') ? at('C') : null;
  if (opening === null || emi === null || principal === null || interest === null) return null;
  if (layout.includes('C') && closing === null) return null;
  if (!near(principal + interest, emi)) return null;
  if (closing !== null && !near(opening - principal, closing)) return null;
  if (opening < 0 || principal < 0 || interest < 0) return null;
  return {
    row,
    opening,
    emi,
    principal,
    interest,
    closing,
    emiText: row.raw[layout.indexOf('E')],
    principalText: row.raw[layout.indexOf('P')],
  };
}

/** The rows a layout proves; without a closing column each row is tied to its neighbour's opening. */
function keptRows(rows: Row[], layout: string): Resolved[] {
  const own = rows.map((r) => resolveRow(r, layout)).filter((r): r is Resolved => r !== null);
  if (layout.includes('C')) return own;
  const bySerial = new Map(own.map((r) => [r.row.serial, r]));
  return own.filter((r) => {
    const next = bySerial.get(r.row.serial + 1);
    const prev = bySerial.get(r.row.serial - 1);
    return (
      (next !== undefined && near(r.opening - r.principal, next.opening)) ||
      (prev !== undefined && near(prev.opening - prev.principal, r.opening))
    );
  });
}

/** Rows with a repeated serial, or out of date order against their neighbours, are not trusted. */
function trustworthy(rows: Resolved[]): Resolved[] {
  const count = new Map<number, number>();
  for (const r of rows) count.set(r.row.serial, (count.get(r.row.serial) ?? 0) + 1);
  const unique = rows.filter((r) => count.get(r.row.serial) === 1).sort((a, b) => a.row.serial - b.row.serial);
  const bad = new Set<Resolved>();
  for (let i = 1; i < unique.length; i += 1) {
    if (unique[i].row.date.iso <= unique[i - 1].row.date.iso) {
      bad.add(unique[i]);
      bad.add(unique[i - 1]);
    }
  }
  return unique.filter((r) => !bad.has(r));
}

// ------------------------------------------------------------------ Lender and header

const HEADER_CUE = /instal+ment|\binstl\b|\bemi\b|repayment|amorti[sz]ation|payment\s+schedule|principal|interest/i;
const LENDER = /((?:[A-Za-z&.]+\s+){1,3}(?:Finance|Finvest|Fincorp|Finserv|Capital|Bank|Moneywise|Financial|Credit)(?:\s+(?:Services|Co-?op\.?|Private|Pvt\.?)){0,3}\s+(?:Limited|Ltd\.?))/i;
const GENERIC_LEAD = /^(?:A|An|The|Of|From|To|By|For|With|And|Name|Bank|Customer|Loan|Branch|Your|Our|Dear|Welcome)$/i;

function lenderName(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(LENDER);
    if (!m) continue;
    const words = m[1].split(' ');
    while (words.length > 1 && GENERIC_LEAD.test(words[0])) words.shift();
    if (words.length >= 2) return words.join(' ').replace(/[.,]+$/, '');
  }
  return null;
}

// ------------------------------------------------------------------ Reader

const fmtRupees = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

export function readRepaymentSchedule(
  pages: ReadonlyArray<readonly string[]>,
  confidence: number,
  asOf: string
): RawField[] {
  const lines = pages.flatMap((p) => p.map(clean).filter(Boolean));
  if (!lines.some((l) => HEADER_CUE.test(l))) return [];
  const rows = parseRows(pages);
  if (rows.length < 3) return [];

  let best: Resolved[] = [];
  for (const layout of LAYOUTS) {
    const kept = trustworthy(keptRows(rows, layout));
    if (kept.length > best.length) best = kept;
  }
  if (best.length < 3) return [];

  const lender = lenderName(lines);
  const out: RawField[] = [];
  const base = { sheetName: null, cellRef: null, enumValue: null, statedUnit: null, unitText: null, period: null } as const;

  // ---- The regular instalment: the single most frequent non-zero value ----
  const freq = new Map<number, Resolved[]>();
  for (const r of best) if (r.emi > 0) freq.set(r.emi, [...(freq.get(r.emi) ?? []), r]);
  const ranked = [...freq.values()].sort((a, b) => b.length - a.length);
  if (ranked.length > 0 && ranked[0].length >= 3 && (ranked.length === 1 || ranked[1].length < ranked[0].length)) {
    const at = ranked[0][0];
    out.push({
      ...base,
      fieldId: 'financialProfile.existingMonthlyEmi',
      rawValue: at.emiText,
      page: at.row.page,
      snippet: `Repayment schedule, instalment ${at.row.serial} (${ranked[0].length} of ${best.length} rows): ${at.row.text}`.slice(0, 300),
      confidence,
      subjectRef: lender,
    });
  }

  // ---- Principal due in the 12 months after asOf, only when that window is provably complete ----
  const start = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null;
  const asOfDate = start ? makeDate(Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8))) : null;
  if (asOfDate) {
    const endIso = `${asOfDate.y + 1}-${asOf.slice(5)}`;
    const ordered = [...best].sort((a, b) => a.row.serial - b.row.serial);
    const win = ordered.filter((r) => r.row.date.iso > asOf && r.row.date.iso <= endIso);
    if (complete(win, ordered, asOfDate)) {
      const total = win.reduce((s, r) => s + r.principal, 0);
      const first = win[0];
      out.push({
        ...base,
        fieldId: 'financialProfile.annualScheduledPrincipalRepayments',
        rawValue: fmtRupees(total),
        page: first.row.page,
        snippet:
          `Scheduled principal for ${win.length} instalments due ${first.row.date.iso} to ${win[win.length - 1].row.date.iso}: ` +
          `${win.map((r) => r.principalText).join(' + ')} = ${fmtRupees(total)}`.slice(0, 300),
        confidence,
        subjectRef: lender,
        reconciled: true,
      });
    }
  }
  return out;
}

/** Whether the rows due in the window are all of them (see the header). */
function complete(win: Resolved[], all: Resolved[], asOf: ParsedDate): boolean {
  if (win.length < 2) return false;
  for (let i = 1; i < win.length; i += 1) if (win[i].row.serial !== win[i - 1].row.serial + 1) return false;
  const step = monthIndex(win[1].row.date) - monthIndex(win[0].row.date);
  if (![1, 3, 6].includes(step)) return false;
  for (let i = 1; i < win.length; i += 1) {
    if (monthIndex(win[i].row.date) - monthIndex(win[i - 1].row.date) !== step) return false;
  }
  const first = win[0];
  const priorKnown = all.some((r) => r.row.serial === first.row.serial - 1);
  // The row before the first in-window row must not itself be due inside the window.
  const priorIso = (() => {
    const mi = monthIndex(first.row.date) - step;
    const y = Math.floor(mi / 12);
    const m = (mi % 12) + 1;
    return `${y}-${String(m).padStart(2, '0')}-${String(first.row.date.d).padStart(2, '0')}`;
  })();
  const asOfIso = `${asOf.y}-${String(asOf.m).padStart(2, '0')}-${String(asOf.d).padStart(2, '0')}`;
  if (!(priorKnown || priorIso <= asOfIso || first.row.serial <= 1)) return false;
  if (win.length === 12 / step) return true;
  if (win.length > 12 / step) return false;
  // Fewer rows than a full year: only when the loan provably ends here.
  const last = win[win.length - 1];
  const tableEnd = all[all.length - 1];
  if (last === tableEnd && near(last.opening - last.principal, 0)) return true;
  return false;
}
