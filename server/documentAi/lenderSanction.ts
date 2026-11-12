/**
 * Lender sanction / welcome letter reader, no AI. One letter states the terms of ONE facility (or a
 * short table of them). Supersets debtObligations.readSanctionLetter.
 *
 * Emits only what is plainly printed:
 *  - financialProfile.ccOdSanctionedLimit: a labelled cash-credit / overdraft limit, or the PROPOSED
 *    column of a facility table. `Rs. 13.00 crore` is emitted as `13.00 crore` (inline unit): the
 *    pipeline converts it exactly (1 crore = 10,000,000; 1 lakh = 100,000) and checks the unit against
 *    the snippet. rupeesExact() below is the same exact conversion, used to compare figures.
 *  - financialProfile.existingMonthlyEmi: one instalment's amount of a monthly-instalment loan
 *    ("instalments of Rs X each", "Amount of each EPI/EMI", "Instalment amount"), never a total.
 *
 * Never-guess rules:
 *  - two different figures for the same field in one letter: none for that field;
 *  - an EXISTING / old column is never read as sanctioned; `from Rs X to Rs Y` lines are skipped;
 *    a figure after `from` / `existing` / `earlier` on a line is the prior limit, not the new one;
 *  - a table figure needs a stated unit header (`Rs. in Crs`); bracketed rows (sub-limits) are skipped;
 *  - an instalment is read only when the frequency is monthly: stated, or proved by the first and
 *    last due dates against the count; `monthly / quarterly` with no proof, quarterly, half-yearly,
 *    "as per schedule" and approximate figures are refused;
 *  - OCR: `Rs` for `Rs.`, but a figure whose commas/periods cannot be read unambiguously is refused.
 * Pure: no I/O, no clock, no logging.
 */
import type { RawField } from './prompt.ts';

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ Amounts

type Unit = 'crore' | 'lakh' | null;

interface Amount {
  /** What is emitted as rawValue: plain digits/commas as printed, or `<number> crore|lakh`. */
  raw: string;
  /** Exact rupees, as a decimal string. */
  rupees: string;
  unit: Unit;
  start: number;
  end: number;
}

const AMOUNT_SRC = String.raw`(?:(?<![a-z])(?:rs|inr)\s*[.:]?\s*|₹\s*|\brupees\s+)(\d[\d,.]*\d|\d)(?:\s*\/\s*-)?(?:\s*(crores?|crs?|cr|lakhs?|lacs?)(?![a-z]))?`;

const GROUPED = /^\d{1,3}(?:,\d{2,3})*,\d{3}(?:\.\d+)?$/;
const DOT_INDIAN = /^\d{1,2}(?:\.\d{2})*\.\d{3}$/;
const DOT_WESTERN = /^\d{1,3}(?:\.\d{3}){2,}$/;

/** The number as plain digits (decimal point kept), or null when the separators cannot be read with certainty. */
function plainNumber(text: string, hasUnit: boolean): { plain: string; printed: string } | null {
  if (text.includes(',')) {
    if (!GROUPED.test(text)) return null;
    return { plain: text.replace(/,/g, ''), printed: text };
  }
  const dots = (text.match(/\./g) ?? []).length;
  if (dots === 0) return { plain: text, printed: text };
  if (dots === 1) {
    // `5.400` with no unit is 5,400 with a misread comma or 5.4 with a stray digit: refuse.
    if (!hasUnit && /\.\d{3}$/.test(text)) return null;
    return { plain: text, printed: text };
  }
  if (DOT_INDIAN.test(text) || DOT_WESTERN.test(text)) {
    const digits = text.replace(/\./g, '');
    return { plain: digits, printed: digits };
  }
  return null;
}

/** Exact rupees for `<number> [crore|lakh]`, by shifting the decimal point (no floating point). */
export function rupeesExact(plain: string, unit: Unit): string {
  const shift = unit === 'crore' ? 7 : unit === 'lakh' ? 5 : 0;
  const [whole, frac = ''] = plain.split('.');
  const padded = frac.padEnd(shift, '0');
  const rupees = (whole + padded.slice(0, shift)).replace(/^0+(?=\d)/, '');
  const rest = padded.slice(shift).replace(/0+$/, '');
  return rest ? `${rupees}.${rest}` : rupees;
}

function findAmounts(text: string): Amount[] | null {
  const found: Amount[] = [];
  for (const match of text.matchAll(new RegExp(AMOUNT_SRC, 'gi'))) {
    const word = match[2]?.toLowerCase() ?? null;
    const unit: Unit = word === null ? null : /^lakh|^lac/.test(word) ? 'lakh' : 'crore';
    // `Rs 50,000 lakhs`: a grouped figure beside a scale word has an unclear unit.
    const number = unit !== null && match[1].includes(',') ? null : plainNumber(match[1], unit !== null);
    // An unreadable figure poisons the line: report that rather than skipping it silently.
    if (!number) return null;
    found.push({
      raw: unit ? `${number.plain} ${unit}` : number.printed,
      rupees: rupeesExact(number.plain, unit),
      unit,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return found;
}

// ------------------------------------------------------------------ Lines and lender

interface Line {
  text: string;
  page: number;
}

const LENDER_WORDS = /\b(?:bank|finance|finserv|fincorp|capital|financial\s+services)\b/i;
const NOT_LENDER = /\b(?:borrower|dear|m\/s|to,|sanctioned|branch|address|regd|registered|cin\b|email|www)\b|\d/i;

function lenderName(pages: ReadonlyArray<readonly string[]>): string | null {
  const head = (pages[0] ?? []).slice(0, 15).map((l) => clean(l));
  for (const line of head) {
    const text = line
      .replace(/^(?:sanction|welcome)\s+letter\s+/i, '')
      .replace(/^for\s+/i, '')
      .trim();
    if (/^(?:co-?operative|ltd|limited|private|pvt)\b/i.test(text)) continue; // a split letterhead line
    if (text.startsWith('(') || /\bscheduled\b/i.test(text)) continue;
    if (text.length < 5 || text.length > 70 || !LENDER_WORDS.test(text) || NOT_LENDER.test(text)) continue;
    if (/\b(?:ltd|limited|bank|pvt|private|india|co-?op)\b/i.test(text)) return text;
  }
  return null;
}

// ------------------------------------------------------------------ CC / OD limit

const CC_LABEL =
  /(?:\b(?:cash\s*credit|overdraft)(?:\s+(?:limit|facility))?|\b(?:cc|od|cc\s*\/\s*od|working\s+capital)\s+(?:limit|facility))\b(?:\s+(?:limit|sanctioned))?/gi;
/** The original reader's labels, kept so this reader never reads less than it did. */
const OLD_LIMIT =
  /\b(?:cash\s+credit|cc|overdraft|od|working\s+capital)\s+limit(?:\s+sanctioned)?\b|\blimit\s+sanctioned\b|\bsanctioned\s+limit\b/i;
const FILLER = String.raw`^(?:[\s:\-–|=]|\b(?:of|is|at|being|sanctioned|limit|amount|upto|up\s+to)\b)*`;
const PRIOR = /(?:from|existing|earlier|previous|present|old|erstwhile)\W+(?:\w+\W+){0,2}$/i;
const NOT_A_LIMIT = /outstanding|utili[sz]|drawn|overdue|drawing\s+power|balance|interest|\bfee\b|charges|margin/i;

interface Hit {
  rupees: string;
  raw: string;
  headline: boolean;
  line: Line;
  quote?: string;
  unitText?: string | null;
}

function ccLineHit(line: Line): Hit | 'unreadable' | null {
  const text = clean(line.text);
  if (!OLD_LIMIT.test(text) && !new RegExp(CC_LABEL.source, 'i').test(text)) return null;
  const amounts = findAmounts(text);
  if (amounts === null) return 'unreadable';
  if (amounts.length === 0) return null;

  // Original rule: exactly one figure on a line carrying one of the old labels, no unit word.
  if (OLD_LIMIT.test(text) && amounts.length === 1 && amounts[0].unit === null) {
    return { rupees: amounts[0].rupees, raw: amounts[0].raw, headline: false, line };
  }
  if (NOT_A_LIMIT.test(text)) return null;
  for (const label of text.matchAll(new RegExp(CC_LABEL.source, 'gi'))) {
    const at = (label.index ?? 0) + label[0].length;
    const tail = text.slice(at);
    const filler = tail.match(new RegExp(FILLER, 'i'))?.[0] ?? '';
    const adjacent = amounts.find((a) => a.start === at + filler.length);
    if (!adjacent) continue;
    const others = amounts.filter((a) => a !== adjacent && !PRIOR.test(text.slice(Math.max(0, a.start - 30), a.start)));
    if (others.length > 0) return null;
    const prefix = text.slice(0, label.index ?? 0).trim();
    const headline = /^(?:\(?[a-z0-9]{1,2}[).\]]?\s+)?(?:(?:nature|type|name)\s+of\s+)?(?:facilit(?:y|ies)|limit|particulars)?[\s:\-–|]*$/i.test(prefix);
    return { rupees: adjacent.rupees, raw: adjacent.raw, headline, line };
  }
  return null;
}

const UNIT_HEADER = /(?:rs\.?|inr|₹)\s*\.?\s*(?:\(?\s*in\s+)?(crores?|crs?|lakhs?|lacs?)\b|\(\s*(?:in\s+)?(?:rs\.?\s*)?(crores?|crs?|lakhs?|lacs?)\s*\)/i;

/** A facility table whose header names a PROPOSED (or sanctioned) column and whose unit is stated. */
function tableHits(lines: Line[]): { hits: Hit[]; refuse: boolean } {
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = clean(`${lines[i].text} ${lines[i + 1]?.text ?? ''}`);
    if (lines[i].page !== (lines[i + 1]?.page ?? lines[i].page)) continue;
    const proposed = head.search(/\b(?:proposed|sanctioned|revised)\b/i);
    if (proposed < 0 || !/\bfacilit(?:y|ies)\b|\bexisting\b/i.test(head)) continue;
    const existing = head.search(/\b(?:existing|present|current)\b/i);
    const columns = existing >= 0 ? 2 : 1;
    const proposedIndex = existing >= 0 && existing > proposed ? 0 : columns - 1;

    const unitLines = lines.slice(Math.max(0, i - 4), i + 2).filter((l) => l.page === lines[i].page);
    const units = new Set<string>();
    let unitText = '';
    for (const l of unitLines) {
      const m = clean(l.text).match(UNIT_HEADER);
      if (m) {
        units.add(/^l/i.test(m[1] ?? m[2]) ? 'lakh' : 'crore');
        unitText = clean(l.text);
      }
    }
    if (units.size !== 1) continue;
    const unit = [...units][0] as 'crore' | 'lakh';

    for (let j = i + 2; j < Math.min(lines.length, i + 16); j++) {
      if (lines[j].page !== lines[i].page) break;
      const row = clean(lines[j].text);
      if (/^total\b|^b\]|non[- ]fund/i.test(row)) break;
      const parsed = row.match(/^(.*?[A-Za-z].*?)((?:\s+\(?\d[\d,]*(?:\.\d+)?\)?)+)\s*$/);
      if (!parsed) continue;
      const label = parsed[1].replace(/^(?:[a-z0-9]{1,2}[).\]]?\s+)/i, '').trim();
      if (!/^(?:cash\s*credit|overdraft|cc|od|cc\s*\/\s*od)\b/i.test(label)) continue;
      const tokens = parsed[2].trim().split(/\s+/);
      if (tokens.length !== columns) continue;
      const token = tokens[proposedIndex];
      if (token.startsWith('(') || !/^\d[\d,]*(?:\.\d+)?$/.test(token)) continue;
      const number = plainNumber(token, true);
      if (!number || Number(number.plain) <= 0) continue;
      hits.push({
        rupees: rupeesExact(number.plain, unit),
        raw: `${number.plain} ${unit}`,
        headline: true,
        line: lines[j],
        quote: `${unitText} | ${row}`,
        unitText,
      });
    }
  }
  return { hits, refuse: false };
}

function readCcLimit(lines: Line[], lender: string | null, confidence: number): RawField[] {
  const hits: Hit[] = tableHits(lines).hits;
  for (const line of lines) {
    const hit = ccLineHit(line);
    if (hit === 'unreadable') return [];
    if (hit) hits.push(hit);
  }
  const headlines = hits.filter((h) => h.headline);
  const used = headlines.length > 0 ? headlines : hits;
  if (used.length === 0 || new Set(used.map((h) => h.rupees)).size !== 1) return [];
  const hit = used[0];
  return [
    {
      fieldId: 'financialProfile.ccOdSanctionedLimit',
      rawValue: hit.raw,
      enumValue: null,
      page: hit.line.page,
      sheetName: null,
      cellRef: null,
      snippet: (hit.quote ?? clean(hit.line.text)).slice(0, 300),
      confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: lender,
    },
  ];
}

// ------------------------------------------------------------------ Instalment (EMI)

const EMI_LABEL =
  /\b(?:amount\s+of\s+each\s+(?:instal+ment|epi|emi)(?:\s*\/\s*(?:emi|epi))?|each\s+instal+ment(?:\s+amount)?|instal+ment\s+amount|emi\s+amount|monthly\s+(?:instal+ment|emi)(?:\s+amount)?)(?=[\s\d^*:\-|(]|$)|^emi(?=\s*[:\-|]|\s*$|\s+(?:rs|inr|₹))/i;
const EMI_PROSE =
  /\b(?:(?:equal\s+)?(?:(?:monthly|quarterly)\s*(?:\/\s*(?:monthly|quarterly)\s*)?)?instal+ments?|emi)\s+of\s+/i;
const EXCLUDED_BEFORE = /(?:first|last|pre|broken|bpi|advance|pemi|total|final|balloon|upto|up\s+to)\W*$/i;
const UNSURE = /approx|tentative|indicative|as\s+per|subject\s+to|maximum|minimum|upto|up\s+to/i;
const SCHEDULE_HEADER = /\bprincipal\b|\bopening\b|\bclosing\b|due\s+date|sr\.?\s*no\b|\binstl/i;
const DATE_LINE = /\b\d{1,2}[/.-](?:\d{1,2}|[a-z]{3})[/.-]\d{2,4}\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type Frequency = 'monthly' | 'other';

function frequencyWords(text: string): Set<Frequency> {
  const found = new Set<Frequency>();
  if (/\bmonthly\b|\bemis?\b/i.test(text)) found.add('monthly');
  if (/\b(?:quarterly|half[- ]?yearly|semi[- ]?annual|yearly|annual|bi-?monthly|bullet)\b/i.test(text)) found.add('other');
  return found;
}

/** First and last `Mon YYYY` in the text, as month counts, when exactly two are printed. */
function monthSpan(text: string): number | null {
  const stamps = [...text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.,/-]*(\d{4})\b/gi)];
  if (stamps.length !== 2) return null;
  const at = (m: RegExpMatchArray) => Number(m[2]) * 12 + MONTHS.indexOf(m[1].toLowerCase());
  return at(stamps[1]) - at(stamps[0]);
}

interface EmiHit {
  rupees: string;
  raw: string;
  line: Line;
  quote: string;
  /** Frequency came from dates, not a plain word: held below auto-apply. */
  proved: boolean;
}

function readEmi(pagesLines: Line[][], lender: string | null, confidence: number): RawField[] {
  const allText = pagesLines.flat().map((l) => clean(l.text)).join('\n');
  // Letter-wide: instalment / repayment lines, for a frequency the label line does not give.
  const letterWide = frequencyWords(
    [...allText.matchAll(/[^\n]*\b(?:instal+ments?|repayments?|emis?|epis?)\b[^\n]*/gi)]
      .map((m) => m[0])
      .filter((s) => !/\bprepay|pre-emi|interest\s+only|broken/i.test(s))
      .join('\n')
  );

  const hits: EmiHit[] = [];
  for (const lines of pagesLines) {
    // A repayment-schedule page lists many dates and amounts: never read instalments from it.
    if (lines.filter((l) => DATE_LINE.test(l.text)).length >= 6) continue;
    for (let i = 0; i < lines.length; i++) {
      const text = clean(lines[i].text);
      const labelled = EMI_LABEL.exec(text);
      // A bare `EMI` line is a table header: only `EMI Rs X` on one line counts.
      if (labelled && /^emi$/i.test(labelled[0].trim()) && !/\d/.test(text.slice(labelled[0].length))) continue;
      const prose = labelled ? null : EMI_PROSE.exec(text);
      const found = labelled ?? prose;
      if (!found) continue;
      const labelStart = found.index ?? 0;
      const labelEnd = labelStart + found[0].length;
      // `first EMI`, `last instalment`, `pre-EMI`, `BPI`: not the regular instalment.
      if (EXCLUDED_BEFORE.test(text.slice(Math.max(0, labelStart - 14), labelStart))) continue;
      if (labelled && SCHEDULE_HEADER.test(lines.slice(Math.max(0, i - 3), i).map((l) => l.text).join(' '))) continue;
      if (UNSURE.test(text.slice(0, labelEnd))) continue;

      // The amount: after the label on its own line, or alone on the first digit-bearing line below
      // (only short digit-free lines such as `Monthly` may sit between).
      // `Amount of each Instalment1^`: a footnote mark after the label is not part of the amount.
      let amountText = text.slice(labelEnd).replace(/^\d{0,2}[\^*†]+\s*/, '');
      let at = i;
      let window = text;
      const local = frequencyWords(text.slice(Math.max(0, labelStart - 40), labelEnd));
      if (!/\d/.test(amountText)) {
        let next: string | null = null;
        for (let k = i + 1; k < Math.min(lines.length, i + 5); k++) {
          const candidate = clean(lines[k].text);
          if (/\d/.test(candidate)) {
            next = candidate;
            at = k;
            break;
          }
          if (candidate.split(' ').length > 14) break;
          frequencyWords(candidate).forEach((f) => local.add(f));
          window += ` ${candidate}`;
        }
        if (next === null) continue;
        amountText = next;
        if (!/^(?:(?:rs|inr)\.?\s*|₹\s*)?[\d,.]+(?:\s*\/\s*-)?$/i.test(amountText)) continue;
      } else if (labelled && !/^[\s:\-–|=)(^*\d]{0,6}(?:(?:rs|inr)\b|₹)/i.test(amountText) && !/^[\s:\-–|=)(^*]*[\d,.]+(?:\s*\/\s*-)?\s*$/.test(amountText)) {
        continue;
      }
      if (UNSURE.test(amountText)) continue;
      const bare = /^\s*[\d,.]+(?:\s*\/\s*-)?\s*$/.test(amountText);
      const amounts = findAmounts(bare ? `Rs ${amountText.trim().replace(/^[\s:\-–|=)(^*]+/, '')}` : amountText);
      // An unreadable figure (`3.41,666.67`) is refused, never repaired.
      if (amounts === null || amounts.length !== 1) continue;
      const amount = amounts[0];
      if (amount.unit !== null || Number(amount.rupees) < 1000) continue;
      if (!bare && at === i && !/^[\s:\-–|=)(\w^*]{0,12}$/.test(amountText.slice(0, amount.start))) continue;

      // Frequency: monthly stated beside it, or proved by the dates, or stated by the letter as a whole.
      const tail = lines.slice(at, at + 3).map((l) => l.text).join(' ');
      const count = (window.match(/(\d{1,3})\s+(?:[a-z]+\s*(?:\/\s*[a-z]+\s+)?)?(?:equal\s+)?instal/i) ?? [])[1];
      const span = prose ? monthSpan(tail) : null;
      let monthly: boolean;
      let proved = false;
      if (local.has('monthly') && local.has('other')) {
        monthly = span !== null && count !== undefined && span === Number(count) - 1;
        proved = monthly;
      } else if (local.size > 0) {
        monthly = local.has('monthly');
      } else {
        monthly = letterWide.has('monthly') && !letterWide.has('other');
      }
      if (!monthly) continue;
      hits.push({
        rupees: amount.rupees,
        raw: amount.raw,
        line: lines[at],
        quote: at === i ? text : `${text} ${clean(lines[at].text)}`,
        proved,
      });
    }
  }
  if (hits.length === 0 || new Set(hits.map((h) => h.rupees)).size !== 1) return [];
  const hit = hits[0];
  return [
    {
      fieldId: 'financialProfile.existingMonthlyEmi',
      rawValue: hit.raw,
      enumValue: null,
      page: hit.line.page,
      sheetName: null,
      cellRef: null,
      snippet: hit.quote.slice(0, 300),
      confidence: hits.some((h) => h.proved) ? Math.min(confidence, 0.8) : confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: lender,
    },
  ];
}

// ------------------------------------------------------------------ Entry point

/**
 * Reads the stated terms of one facility from a lender's sanction / welcome / agreement letter.
 * Rules and refusals are described at the top of the file.
 */
export function readLenderSanction(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] {
  const pagesLines: Line[][] = pages.map((lines, index) =>
    lines.map((text) => ({ text, page: index + 1 })).filter((l) => clean(l.text) !== '')
  );
  const lender = lenderName(pages);
  return [...readCcLimit(pagesLines.flat(), lender, confidence), ...readEmi(pagesLines, lender, confidence)];
}
