/**
 * Bank statement reader: turns the transaction table of an Indian bank statement into monthly
 * credit totals and closing balances, with no AI.
 *
 * Every row is proved by arithmetic, the way a person checks a ledger: the new balance must equal
 * the previous balance plus the credit or minus the debit, to the paisa. A row is only used when it
 * reconciles, so a misread figure cannot slip in. The statement as a whole is then checked against
 * its printed opening balance, closing balance and (where printed) its own credit/debit totals.
 *
 * Handles the layouts seen in practice:
 * - one amount and a running balance on a line (SBI, Axis: the date may sit on the next line);
 * - explicit Debit and Credit columns with the balance printed apart from the row (co-operative
 *   banks): the credit column is read, and the balance chain is still used as the check;
 * - overdraft / cash credit accounts whose balance is negative (`-1,04,25,314.80`, `-,71,90,244.17`,
 *   `1,38,217.04 Dr.`).
 * Pure: no I/O, no clock, no logging.
 */

export interface BankTransaction {
  /** YYYY-MM-DD, or null when no date could be tied to the row. */
  date: string | null;
  credit: number;
  debit: number;
  /** Running balance after the row, when it was found. */
  balance: number | null;
  page: number;
  /** The balance chain proves this row. */
  proved: boolean;
}

export interface ParsedBankStatement {
  bank: string | null;
  accountNumber: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  opening: number | null;
  closing: number | null;
  /** Totals the bank prints itself (Axis `TRANSACTION TOTAL DR/CR`). */
  printedTotals: { debit: number; credit: number } | null;
  transactions: BankTransaction[];
  /** The bank says more entries exist than this file lists. Totals would be partial. */
  truncated: boolean;
  /** Every row proved, and opening + credits - debits = closing. */
  reconciled: boolean;
  provedRows: number;
  unprovedRows: number;
}

export interface BankMonthSummary {
  month: string;
  credits: number;
  debits: number;
  /** Balance after the month's last row; null when none was found. */
  closing: number | null;
  rows: number;
  /** Page of the month's first row. */
  page: number;
}

// ------------------------------------------------------------------ Tokens

const MONEY = /(?<![A-Za-z0-9.,])(-?,?\(?(?:\d[\d,]*)?\.\d{2})\)?(?![\d])/g;

/** `1,04,25,314.80`, `-,71,90,244.17`, `(1,200.00)`: a figure with two decimals. */
export function parseMoney(token: string): number | null {
  const negative = /^-|^\(/.test(token.trim());
  const digits = token.replace(/[^\d.]/g, '');
  if (!/^\d*\.\d{2}$/.test(digits)) return null; // `.95` is a figure too: 0.95 printed with no leading zero
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

interface MoneyToken {
  value: number;
  index: number;
}

function moneyTokens(line: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  for (const match of line.matchAll(MONEY)) {
    const value = parseMoney(match[1]);
    if (value !== null) out.push({ value, index: match.index ?? 0 });
  }
  return out;
}

const cents = (value: number) => Math.round(value * 100);
const sameMoney = (a: number, b: number) => cents(a) === cents(b);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** First date in `text`: dd/mm/yyyy, dd-mm-yyyy, dd Mon yyyy, dd-Mon-yyyy. */
export function firstDate(text: string): string | null {
  const numeric = text.match(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d])/);
  const named = text.match(/(?<![\d/.-])(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})(?![\d])/);
  const candidates: Array<{ at: number; value: string | null }> = [];
  if (numeric) candidates.push({ at: numeric.index ?? 0, value: iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1])) });
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    if (month) candidates.push({ at: named.index ?? 0, value: iso(Number(named[3]), month, Number(named[1])) });
  }
  return candidates.sort((a, b) => a.at - b.at).find((c) => c.value)?.value ?? null;
}

function allDates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d])/g)) {
    const d = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) out.push(d);
  }
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})(?![\d])/g)) {
    const month = MONTHS[m[2].toLowerCase()];
    const d = month ? iso(Number(m[3]), month, Number(m[1])) : null;
    if (d) out.push(d);
  }
  return out;
}

// ------------------------------------------------------------------ Header facts

const BANKS: ReadonlyArray<[RegExp, string]> = [
  [/axis\s+bank|\bUTIB0/i, 'Axis Bank'],
  [/state\s+bank\s+of\s+india|\bSBIN0|\bSBI\b/i, 'State Bank of India'],
  [/hdfc\s+bank|\bHDFC0/i, 'HDFC Bank'],
  [/icici\s+bank|\bICIC0/i, 'ICICI Bank'],
  [/kotak/i, 'Kotak Mahindra Bank'],
  [/yes\s+bank|\bYESB0/i, 'Yes Bank'],
  [/citizen\s*credit/i, 'Citizen Credit Co-operative Bank'],
  [/bank\s+of\s+baroda|\bBARB0/i, 'Bank of Baroda'],
  [/punjab\s+national|\bPUNB0/i, 'Punjab National Bank'],
  [/canara/i, 'Canara Bank'],
  [/union\s+bank|\bUBIN0/i, 'Union Bank of India'],
  [/idfc/i, 'IDFC First Bank'],
  [/indusind/i, 'IndusInd Bank'],
];

const ACCOUNT_NO = /(?:a\/c|account)\s*(?:no\.?|number|#)\s*[:.-]?\s*([X*x\d][X*x\d-]{5,24}\d)/i;

const OPENING_PATTERNS: readonly RegExp[] = [
  /opening\s+balance(?:\s+as\s+on\s+[\w\s,-]+?)?\s*[:.-]?\s*(?:INR|Rs\.?|₹)?\s*(-?,?\(?\d[\d,]*\.\d{2}\)?)/i,
  /balance\s+(?:as\s+on|b\/f|brought\s+forward)\s+[\w\s,/-]+?\s*[:.-]\s*(?:INR|Rs\.?|₹)?\s*(-?,?\(?\d[\d,]*\.\d{2}\)?)/i,
  /(?:b\/f|brought\s+forward|opening\s+bal\.?)\s*[:.-]?\s*(?:INR|Rs\.?|₹)?\s*(-?,?\(?\d[\d,]*\.\d{2}\)?)/i,
];
const CLOSING_PATTERN = /closing\s+balance(?:\s+as\s+on\s+[\w\s,-]+?)?\s*[:.-]?\s*(?:INR|Rs\.?|₹)?\s*(-?,?\(?\d[\d,]*\.\d{2}\)?)/i;

const PERIOD_PATTERNS: readonly RegExp[] = [
  /\(\s*from\s*:?\s*([\d/.-]+)\s*to\s*:?\s*([\d/.-]+)\s*\)/i,
  /(?:statement\s+(?:period|from)|period|from)\s*:?\s*(\d{1,2}[\s/.-]+[A-Za-z0-9]{1,9}[\s/.-]+\d{4})\s*(?:to|-|–|till)\s*(\d{1,2}[\s/.-]+[A-Za-z0-9]{1,9}[\s/.-]+\d{4})/i,
];

/** Rows an SBI online statement lists before it cuts off. */
const BANK_ROW_CAP = 299;
const TRUNCATED = /(?:number\s+of\s+transactions?\s+in\s+this\s+statement\s+exceeds|remaining\s+transactions?\s+in\s+the\s+pending)/i;

/** Statement header facts, read from the text of the first pages. */
function headerFacts(lines: ReadonlyArray<{ text: string }>) {
  const head = lines.slice(0, 80).map((l) => l.text);
  const headText = head.join('\n');
  const bank = BANKS.find(([pattern]) => pattern.test(headText))?.[1] ?? null;
  const accountNumber = head.map((t) => t.match(ACCOUNT_NO)?.[1] ?? null).find(Boolean) ?? null;
  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  for (const text of head) {
    for (const pattern of PERIOD_PATTERNS) {
      const m = text.match(pattern);
      if (!m) continue;
      const from = firstDate(m[1]);
      const to = firstDate(m[2]);
      if (from && to) {
        periodFrom = from;
        periodTo = to;
        break;
      }
    }
    if (periodFrom) break;
  }
  return { bank, accountNumber, periodFrom, periodTo };
}

function readLabelled(lines: ReadonlyArray<{ text: string }>, patterns: readonly RegExp[]): number | null {
  for (const { text } of lines) {
    for (const pattern of patterns) {
      const m = text.match(pattern);
      const value = m ? parseMoney(m[1]) : null;
      if (value !== null) return value;
    }
  }
  return null;
}

/** `Dr.` / `Cr.` after a figure: a debit balance is a negative balance of the account. */
function signedByDrCr(text: string, value: number): number {
  return /\bdr\.?\s*$/i.test(text.trim()) && value > 0 ? -value : value;
}

// ------------------------------------------------------------------ The reader

const SERIAL_AND_DATE = /^\s*\d{1,5}\s+\d{1,2}[/.-]\d{1,2}[/.-]\d{4}/;
const DATE_FIRST = /^\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|^\s*\d{1,2}[\s-]+[A-Za-z]{3}[a-z]*[\s,-]+\d{4}/;

export function parseBankStatement(pages: ReadonlyArray<readonly string[]>): ParsedBankStatement {
  const lines = pages.flatMap((page, pageIndex) => page.map((text) => ({ text: text.replace(/\s+/g, ' ').trim(), page: pageIndex + 1 })));
  const facts = headerFacts(lines);
  let opening = readLabelled(lines.slice(0, 120), OPENING_PATTERNS);
  const closingLabelled = readLabelled(lines, [CLOSING_PATTERN]);
  const truncatedNotice = lines.some((l) => TRUNCATED.test(l.text));

  let printedTotals = null as ParsedBankStatement['printedTotals'];
  lines.forEach(({ text }, i) => {
    if (!/transaction\s+total/i.test(text)) return;
    // The figures sit on the label's line, or on the line just before or after it.
    for (const candidate of [text, lines[i - 1]?.text, lines[i + 1]?.text]) {
      if (candidate === undefined || DATE_FIRST.test(candidate)) continue;
      const tokens = moneyTokens(candidate);
      if (tokens.length === 2) {
        printedTotals = { debit: tokens[0].value, credit: tokens[1].value };
        return;
      }
    }
  });

  const explicit = usesExplicitColumns(lines);
  const transactions = explicit ? readExplicitColumns(lines, opening) : readBalanceChain(lines, opening);
  const proved = transactions.filter((t) => t.proved).length;
  // SBI online statements stop at 299 rows and say the rest are in a pending statement. A file that
  // lists more than that (the notice is boilerplate there) is whole; one at or under it is cut off.
  const truncated = truncatedNotice && transactions.length <= BANK_ROW_CAP;

  let closing: number | null = closingLabelled;
  if (closing === null) {
    const last = [...transactions].reverse().find((t) => t.balance !== null);
    closing = last?.balance ?? null;
  }
  let credits = transactions.reduce((sum, t) => sum + t.credit, 0);
  let debits = transactions.reduce((sum, t) => sum + t.debit, 0);
  // An overdrawn account can print its balance with no minus sign, so the arithmetic reads every
  // credit as a debit and the other way round. The bank's own printed totals settle it: when they
  // match the rows only the other way round, the rows are flipped.
  if (
    printedTotals &&
    !sameMoney(credits, debits) &&
    sameMoney(printedTotals.credit, debits) &&
    sameMoney(printedTotals.debit, credits)
  ) {
    for (const row of transactions) {
      [row.credit, row.debit] = [row.debit, row.credit];
      if (row.balance !== null) row.balance = -row.balance;
    }
    [credits, debits] = [debits, credits];
    if (opening !== null) opening = -opening;
    if (closing !== null) closing = -closing;
  }
  const chainEnds =
    opening !== null && closing !== null
      ? sameMoney(opening + credits - debits, closing)
      : false;
  const totalsAgree = printedTotals ? sameMoney(printedTotals.credit, credits) && sameMoney(printedTotals.debit, debits) : true;
  const allProved = transactions.length > 0 && proved === transactions.length;
  // An overdrawn account can print its balance with no sign: then a rise in the balance is a debit,
  // and the arithmetic cannot tell. Without printed totals or DR/CR marks to prove the direction, the
  // statement is not treated as reconciled.
  const drCrMarks = lines.filter((l) => /\d\s+(?:CR|DR)\s+-?[\d.,]/.test(l.text)).length;
  const looksOverdrawn = /cash\s+credit|overdraft|CC|OD/i.test(lines.slice(0, 40).map((l) => l.text).join(' '));
  const signUnproven =
    looksOverdrawn && !printedTotals && drCrMarks < 3 && opening !== null && closing !== null && opening >= 0 && closing >= 0 && !explicit;
  // A proved row with no date cannot be put in a month.
  const undatedRows = transactions.some((t) => t.date === null) && !(facts.periodFrom && facts.periodTo && facts.periodFrom.slice(0, 7) === facts.periodTo.slice(0, 7));
  return {
    ...facts,
    opening,
    closing,
    printedTotals,
    transactions,
    truncated,
    reconciled: allProved && !truncated && !signUnproven && !undatedRows && totalsAgree && (opening === null || closing === null || chainEnds),
    provedRows: proved,
    unprovedRows: transactions.length - proved,
  };
}

/** Debit and Credit printed as two figures on a dated row, one of them `0.00`. */
function usesExplicitColumns(lines: ReadonlyArray<{ text: string }>): boolean {
  let withZero = 0;
  for (const { text } of lines) {
    if (!DATE_FIRST.test(text)) continue;
    const tokens = moneyTokens(text);
    if (tokens.length === 2 && tokens.some((t) => t.value === 0)) withZero += 1;
    if (withZero >= 5) return true;
  }
  return false;
}

/** Balance printed on the row with one amount: the arithmetic decides credit or debit. */
function readBalanceChain(lines: ReadonlyArray<{ text: string; page: number }>, opening: number | null): BankTransaction[] {
  const rows: BankTransaction[] = [];
  let previous = opening;
  for (let i = 0; i < lines.length; i += 1) {
    const { text, page } = lines[i];
    if (/transaction\s+total|opening\s+balance|closing\s+balance|balance\s+as\s+on/i.test(text)) continue;
    const tokens = moneyTokens(text);
    if (tokens.length < 2) continue;
    // The balance is the last figure; the amount is the one before it.
    const balance = signedByDrCr(text, tokens[tokens.length - 1].value);
    const amount = tokens[tokens.length - 2].value;
    if (amount <= 0) continue;
    let credit = 0;
    let debit = 0;
    let isProved = false;
    if (previous !== null) {
      if (sameMoney(previous + amount, balance)) {
        credit = amount;
        isProved = true;
      } else if (sameMoney(previous - amount, balance)) {
        debit = amount;
        isProved = true;
      }
    }
    if (!isProved) {
      if (previous !== null) continue; // a figure pair that does not follow the balance is not a row
      // No opening balance printed: the first pair only seeds the chain, and the next row proves
      // it. The seed row's own direction is unknown, so it is kept as an unproved row with no
      // amount, which keeps the statement from counting as reconciled.
      if (!lookAheadChain(lines, i + 1, balance)) continue;
      rows.push({ date: dateFor(lines, i), credit: 0, debit: 0, balance, page, proved: false });
      previous = balance;
      continue;
    }
    rows.push({ date: dateFor(lines, i), credit, debit, balance, page, proved: true });
    previous = balance;
  }
  return rows;
}

function lookAheadChain(lines: ReadonlyArray<{ text: string }>, from: number, balance: number) {
  for (let i = from; i < Math.min(lines.length, from + 6); i += 1) {
    const tokens = moneyTokens(lines[i].text);
    if (tokens.length < 2) continue;
    const next = tokens[tokens.length - 1].value;
    const amount = tokens[tokens.length - 2].value;
    if (sameMoney(balance + amount, next)) return { dir: 'cr' as const };
    if (sameMoney(balance - amount, next)) return { dir: 'dr' as const };
  }
  return null;
}

/** The date of the row whose figures are on line `index`: on the line, or just after it (Axis). */
function dateFor(lines: ReadonlyArray<{ text: string }>, index: number): string | null {
  // A date inside the description (`Int.Coll:06-01-2026 to ...`) is not the row's date: only a date
  // that starts the line is.
  if (DATE_FIRST.test(lines[index].text)) {
    const own = firstDate(lines[index].text);
    if (own) return own;
  }
  for (let i = index + 1; i < Math.min(lines.length, index + 4); i += 1) {
    if (SERIAL_AND_DATE.test(lines[i].text) || DATE_FIRST.test(lines[i].text)) return firstDate(lines[i].text);
    if (moneyTokens(lines[i].text).length >= 2) break; // the next row's figures: its own date follows it
  }
  for (let i = index - 1; i >= Math.max(0, index - 2); i -= 1) {
    if (DATE_FIRST.test(lines[i].text)) return firstDate(lines[i].text);
  }
  return null;
}

/**
 * Explicit Debit | Credit columns. The credit column is read directly; each row is then proved by
 * finding the running balance (printed apart from the row) that equals the previous balance moved
 * by that row. In a debit-balance account (cash credit) a debit raises the printed figure.
 */
function readExplicitColumns(lines: ReadonlyArray<{ text: string; page: number }>, opening: number | null): BankTransaction[] {
  const rowIndexes: number[] = [];
  lines.forEach((line, i) => {
    if (!DATE_FIRST.test(line.text)) return;
    const tokens = moneyTokens(line.text);
    if (tokens.length >= 2) rowIndexes.push(i);
  });

  const balanceTokenNear = (rowPosition: number): number[] => {
    const start = rowPosition === 0 ? Math.max(0, rowIndexes[0] - 3) : rowIndexes[rowPosition - 1] + 1;
    const end = Math.min(lines.length - 1, (rowIndexes[rowPosition + 1] ?? lines.length) - 1);
    const out: number[] = [];
    for (let i = start; i <= Math.max(start, end); i += 1) {
      const text = lines[i].text;
      const own = i === rowIndexes[rowPosition];
      const tokens = moneyTokens(text);
      // On the row itself the last two figures are Debit and Credit, not a balance.
      const usable = own ? tokens.slice(0, Math.max(0, tokens.length - 2)) : tokens;
      for (const token of usable) out.push(token.value);
    }
    return out;
  };

  const rows: BankTransaction[] = [];
  let previous: number | null = null;
  let debitBalanceAccount: boolean | null = null;
  rowIndexes.forEach((lineIndex, position) => {
    const { text, page } = lines[lineIndex];
    const tokens = moneyTokens(text);
    const debit = tokens[tokens.length - 2].value;
    const credit = tokens[tokens.length - 1].value;
    if (debit < 0 || credit < 0 || (debit > 0 && credit > 0)) return;
    const delta = debit - credit; // + raises a debit balance
    const candidates = balanceTokenNear(position);
    let balance: number | null = null;
    let isProved = false;
    if (previous !== null) {
      const modes = debitBalanceAccount === null ? [true, false] : [debitBalanceAccount];
      for (const mode of modes) {
        const want = mode ? previous + delta : previous - delta;
        const hit = candidates.find((c) => sameMoney(c, want));
        if (hit !== undefined) {
          balance = hit;
          isProved = true;
          debitBalanceAccount = mode;
          break;
        }
      }
    } else if (opening !== null) {
      for (const mode of [true, false]) {
        const want = mode ? opening + delta : opening - delta;
        const hit = candidates.find((c) => sameMoney(c, want));
        if (hit !== undefined) {
          balance = hit;
          isProved = true;
          debitBalanceAccount = mode;
          break;
        }
      }
    } else {
      balance = candidates.find((c) => c > 0) ?? null;
    }
    if (balance === null && previous !== null && !isProved) {
      // The chain is broken here; keep the row, unproved, and re-seed from a balance that follows.
      balance = null;
    }
    rows.push({ date: firstDate(text), credit, debit, balance: balance === null ? null : balance, page, proved: isProved });
    if (balance !== null) previous = balance;
  });

  // Without a printed opening balance the first row cannot be proved from one: it is proved when
  // the second row's balance follows from it, and unproved otherwise.
  if (opening === null && rows.length > 1 && rows[0].balance !== null && rows[1].proved) rows[0].proved = true;
  // A debit-balance account prints positive figures for money owed: report them as negative balances.
  if (debitBalanceAccount === true) {
    for (const row of rows) if (row.balance !== null) row.balance = -row.balance;
  }
  return rows;
}

// ------------------------------------------------------------------ Months

/** Rows grouped by calendar month. Rows with no date take the statement's single month, if it has one. */
export function summariseMonths(statement: ParsedBankStatement): BankMonthSummary[] {
  const fallbackMonth =
    statement.periodFrom && statement.periodTo && statement.periodFrom.slice(0, 7) === statement.periodTo.slice(0, 7)
      ? statement.periodFrom.slice(0, 7)
      : null;
  const byMonth = new Map<string, BankMonthSummary>();
  for (const row of statement.transactions) {
    const month = row.date?.slice(0, 7) ?? fallbackMonth;
    if (!month) continue;
    const entry = byMonth.get(month) ?? { month, credits: 0, debits: 0, closing: null, rows: 0, page: row.page };
    entry.credits += row.credit;
    entry.debits += row.debit;
    entry.rows += 1;
    if (row.balance !== null) entry.closing = row.balance;
    byMonth.set(month, entry);
  }
  return [...byMonth.values()]
    .map((m) => ({ ...m, credits: Math.round(m.credits * 100) / 100, debits: Math.round(m.debits * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Calendar months a statement period fully covers, first to last: used to tell a full month from a part. */
export function monthsCovered(statement: ParsedBankStatement): string[] {
  if (!statement.periodFrom || !statement.periodTo) return [];
  const out: string[] = [];
  let [y, m] = statement.periodFrom.split('-').map(Number);
  const [ty, tm] = statement.periodTo.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}


// ------------------------------------------------------------------ Adapter to the pipeline

import type { RawBankMonth } from './prompt.ts';

const INR = (value: number) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Monthly rows for the pipeline from a statement's transactions. A statement that does not
 * reconcile is still reported, at a confidence below auto-apply, so a reviewer sees it; a capped
 * statement is marked partial and never feeds an average.
 */
export function bankMonthsFromStatement(
  pages: ReadonlyArray<readonly string[]>,
  confidence: number,
  complete = true
): { months: RawBankMonth[]; statement: ParsedBankStatement } {
  const statement = parseBankStatement(pages);
  if (statement.transactions.length === 0) return { months: [], statement };
  const dated = statement.transactions.map((t) => t.date).filter((d): d is string => Boolean(d)).sort();
  const coverFrom = [statement.periodFrom, dated[0]].filter((d): d is string => Boolean(d)).sort()[0] ?? null;
  const coverTo = [statement.periodTo, dated[dated.length - 1]].filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
  const rowConfidence = statement.reconciled ? confidence : Math.min(confidence, 0.6);
  const months: RawBankMonth[] = summariseMonths(statement).map((m) => {
    const monthFirst = `${m.month}-01`;
    const monthLast = lastDayOf(m.month);
    const from = coverFrom && coverFrom > monthFirst ? coverFrom : monthFirst;
    const to = coverTo && coverTo < monthLast ? coverTo : monthLast;
    const closing = m.closing !== null && m.closing >= 0 ? m.closing : null;
    const note = statement.reconciled
      ? 'every row proved by the running balance'
      : statement.truncated
        ? 'statement is cut off at its row cap'
        : 'not every row could be proved';
    return {
      month: m.month,
      totalCredits: m.credits.toFixed(2),
      closingBalance: closing === null ? null : closing.toFixed(2),
      statedUnit: null,
      unitText: null,
      confidence: rowConfidence,
      subjectRef: statement.accountNumber,
      page: m.page,
      sheetName: null,
      cellRef: null,
      snippet: `${statement.bank ?? 'Bank'} statement ${m.month}: credits ${INR(m.credits)}, debits ${INR(m.debits)} over ${m.rows} rows (${note}).`,
      // Only a statement that reconciled end to end skips the printed-figure check.
      reconciled: statement.reconciled,
      coverFrom: from,
      coverTo: to,
      ...(statement.truncated || !complete ? { partial: true } : {}),
    };
  });
  return { months, statement };
}
