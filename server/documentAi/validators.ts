/**
 * Pure validators and normalisers for Document AI (docs/contracts.md section 6).
 * No I/O, no clock, no env. Nothing here throws, and nothing logs.
 */
import type { AmountUnit, DocumentType, FieldValue, SourceCheck } from '../../src/types/documentAi.ts';
import type { FieldDefinition, NumericUnit, SignPolicy } from '../../src/documentAi/fieldMap.ts';
import { DOCUMENT_AI_THRESHOLDS } from '../../src/types/documentAi.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; code: string };
export type { AmountUnit };

export const AMOUNT_UNITS: readonly AmountUnit[] = ['rupees', 'thousand', 'lakh', 'crore', 'million'];

const UNIT_MULTIPLIER: Record<AmountUnit, number> = {
  rupees: 1,
  thousand: 1e3,
  lakh: 1e5,
  million: 1e6,
  crore: 1e7,
};

const fail = (code: string): { ok: false; code: string } => ({ ok: false, code });

/** NFKC, every dash-like character to '-', NBSP and friends to a plain space. */
function cleanText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- PAN, GSTIN

const PAN_PATTERN = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/;
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function validatePan(raw: string): Validated<string> {
  if (typeof raw !== 'string') return fail('invalid_format');
  const value = raw.toUpperCase().replace(/\s+/g, '');
  return PAN_PATTERN.test(value) ? { ok: true, value } : fail('invalid_format');
}

function gstinCheckCharacter(gstin: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GSTIN_ALPHABET.indexOf(gstin[i]) * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

export function validateGstin(raw: string): Validated<string> {
  if (typeof raw !== 'string') return fail('invalid_format');
  const value = raw.toUpperCase().replace(/\s+/g, '');
  if (!GSTIN_PATTERN.test(value)) return fail('invalid_format');
  const state = Number(value.slice(0, 2));
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) return fail('invalid_state_code');
  if (!validatePan(gstinEmbeddedPan(value)).ok) return fail('invalid_pan_segment');
  if (gstinCheckCharacter(value) !== value[14]) return fail('invalid_checksum');
  return { ok: true, value };
}

/** The PAN inside a GSTIN: characters 3 to 12. */
export function gstinEmbeddedPan(gstin: string): string {
  return gstin.slice(2, 12);
}

// ------------------------------------------------------------------- Amounts

const FOREIGN_CURRENCY =
  /[$€£¥]|(?<![A-Za-z])(USD|EUR|GBP|AED|SGD|JPY|CAD|AUD|CHF|CNY|HKD|SAR|NZD|ZAR|QAR|KWD|OMR)(?![A-Za-z])/i;
/** Any other three-letter code in front of a number, e.g. `THB 500`. */
const LEADING_CURRENCY_CODE = /^\(?-?\s*(?!INR)[A-Za-z]{3}\.?\s*[\d(]/i;
const CURRENCY_PREFIX = /^(?:₹|INR|Rs\.?|Re\.?)\s*/i;
const CURRENCY_SUFFIX = /(?<=[\d)\s])(?:₹|INR|Rs\.?|Re\.?)$/i;
const EMPTY_AMOUNT = /^(?:nil|n\.?\/?a\.?|none|null|not available|not applicable)$/i;

/** Trailing inline units, longest spellings first. */
const INLINE_UNITS: ReadonlyArray<{ pattern: RegExp; unit: AmountUnit }> = [
  { pattern: /(?<=[\d)\s.])(?:crores?|crs?)\.?$/i, unit: 'crore' },
  { pattern: /(?<=[\d)\s.])(?:lakhs?|lacs?|l)\.?$/i, unit: 'lakh' },
  { pattern: /(?<=[\d)\s.])(?:millions?|mn)\.?$/i, unit: 'million' },
  { pattern: /(?<=[\d)\s.])(?:thousands?|k)\.?$/i, unit: 'thousand' },
  { pattern: /\s*['‘’]000$/, unit: 'thousand' },
];

const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;
/** Indian or western grouping. The last group is always 3 digits, which is what rejects `12,5`. */
const GROUPED_NUMBER = /^\d{1,3}(?:,\d{2,3})*,\d{3}(?:\.\d+)?$/;
const DECIMAL_ONLY = /^\.\d+$/;

function parsePlainNumber(text: string): number | null {
  if (!PLAIN_NUMBER.test(text) && !GROUPED_NUMBER.test(text) && !DECIMAL_ONLY.test(text)) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

type IndianAmountResult =
  | { ok: true; value: number; ambiguousUnit: boolean; inlineUnit: AmountUnit | null }
  | { ok: false; code: string };

/** Below this, a financial statement figure with no stated unit could be in rupees or in lakh. */
const STATEMENT_UNIT_FLOOR = 100_000;

export function parseIndianAmount(
  raw: string,
  ctx: { statedUnit?: AmountUnit | null; documentType: DocumentType; amountNature?: 'limit' }
): IndianAmountResult {
  if (typeof raw !== 'string') return fail('invalid_number');
  let text = cleanText(raw);
  if (!text) return fail('empty_value');
  if (FOREIGN_CURRENCY.test(text) || LEADING_CURRENCY_CODE.test(text)) return fail('non_inr_currency');
  if (EMPTY_AMOUNT.test(text)) return fail('empty_value');

  const isBank = ctx.documentType === 'bank_statement';
  let negative = false;
  let bankMarkerSeen = false;
  let inlineUnit: AmountUnit | null = null;

  // Marks can nest in either order: `(Rs. 1.25 Cr)`, `Rs. (1,234)/-`, `(1.25) Cr`. Peel until stable.
  for (let changed = true; changed; ) {
    changed = false;
    const before = text;

    text = text.replace(/\s*\/-$/, '').trim();
    text = text.replace(CURRENCY_PREFIX, '').replace(CURRENCY_SUFFIX, '').trim();

    const parens = text.match(/^\((.*)\)$/);
    if (parens) {
      negative = true;
      text = parens[1].trim();
    }
    if (text.startsWith('-')) {
      negative = true;
      text = text.slice(1).trim();
    }
    if (text.endsWith('-')) {
      negative = true;
      text = text.slice(0, -1).trim();
    }

    if (isBank && !bankMarkerSeen) {
      if (/(?<=[\d)\s])dr\.?$/i.test(text)) {
        negative = true;
        bankMarkerSeen = true;
        text = text.replace(/\s*dr\.?$/i, '').trim();
      } else if (ctx.amountNature !== 'limit' && /(?<=[\d)\s])cr\.?$/i.test(text)) {
        // The credit marker, not crore. `Crs` and `Crore` fall through and stay units, as does
        // any Cr on a limit: a sanctioned limit is not a balance or a transaction.
        bankMarkerSeen = true;
        text = text.replace(/\s*cr\.?$/i, '').trim();
      }
    }

    if (inlineUnit === null) {
      for (const { pattern, unit } of INLINE_UNITS) {
        if (pattern.test(text)) {
          inlineUnit = unit;
          text = text.replace(pattern, '').trim();
          break;
        }
      }
    }

    changed = text !== before;
  }

  if (!text) return fail('empty_value');
  const magnitude = parsePlainNumber(text);
  if (magnitude === null) return fail('invalid_number');

  const statedUnit = ctx.statedUnit ?? null;
  const multiplier = UNIT_MULTIPLIER[inlineUnit ?? statedUnit ?? 'rupees'];
  const scaled = Number((magnitude * multiplier).toFixed(2));
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) return fail('out_of_range');

  const unitsDisagree = inlineUnit !== null && statedUnit !== null && inlineUnit !== statedUnit;
  const unitless = inlineUnit === null && statedUnit === null && magnitude !== 0;
  const unitlessDecimal =
    unitless &&
    magnitude < 1000 &&
    text.includes('.') &&
    ctx.documentType !== 'bank_statement' &&
    ctx.documentType !== 'gst_return';
  const unitlessStatementFigure =
    unitless && ctx.documentType === 'financial_statement' && magnitude < STATEMENT_UNIT_FLOOR;
  // `50,00,000.00 Cr` beside a limit on a bank statement may still be a credit marker. Say so.
  const limitMaybeMarked =
    isBank && ctx.amountNature === 'limit' && inlineUnit === 'crore' && magnitude >= STATEMENT_UNIT_FLOOR;

  return {
    ok: true,
    // `(0.00)` must not become -0.
    value: negative && scaled !== 0 ? -scaled : scaled,
    ambiguousUnit: unitsDisagree || unitlessDecimal || unitlessStatementFigure || limitMaybeMarked,
    inlineUnit,
  };
}

/** Section 6.3 step 8: applied after parsing, once the field is known. */
export function applySignPolicy(value: number, policy: SignPolicy | undefined): Validated<number> {
  if (policy === 'signed') return { ok: true, value };
  if (policy === 'expense_magnitude') return { ok: true, value: Math.abs(value) };
  return value < 0 ? fail('negative_not_allowed') : { ok: true, value };
}

// --------------------------------------------------------------------- Dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function toIsoDate(year: number, month: number, day: number): string | null {
  if (year < 1800 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseDate(raw: string, ctx: { today: string; allowFuture?: boolean }): Validated<string> {
  if (typeof raw !== 'string') return fail('invalid_date');
  const text = cleanText(raw);
  let iso: string | null = null;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const numeric = text.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/);
  const named = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]+)\.?,?[\s-]+(\d{4})$/);

  if (isoMatch) {
    iso = toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  } else if (numeric) {
    iso = toIsoDate(Number(numeric[4]), Number(numeric[3]), Number(numeric[1]));
  } else if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    iso = month ? toIsoDate(Number(named[3]), month, Number(named[1])) : null;
  }

  if (!iso) return fail('invalid_date');
  if (!ctx.allowFuture && iso > ctx.today) return fail('future_date');
  return { ok: true, value: iso };
}

const FY_LABEL = /^FY (\d{4})-(\d{2})$/;

function fyLabel(startYear: number): string {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function normalizeFinancialYear(raw: string): Validated<string> {
  if (typeof raw !== 'string') return fail('invalid_financial_year');
  const text = cleanText(raw);

  const span = text.match(
    /^(?:(f\.?\s*y\.?|financial\s+year)|(a\.?\s*y\.?|assessment\s+year))?[\s:.-]*(\d{4})\s*[-/]\s*(\d{4}|\d{2})$/i
  );
  if (span) {
    const first = Number(span[3]);
    const second = Number(span[4]);
    const consecutive = span[4].length === 4 ? second === first + 1 : second === (first + 1) % 100;
    if (!consecutive || first < 1900 || first > 2200) return fail('invalid_financial_year');
    return { ok: true, value: fyLabel(span[2] ? first - 1 : first) };
  }

  const yearEnd = text.match(
    /^(?:for\s+the\s+)?(?:(?:financial\s+)?year\s+end(?:ed|ing)|fye|as\s+(?:at|on))\s*(?:on\s*)?[:,-]?\s*(.+)$/i
  );
  if (yearEnd) {
    const date = parseDate(yearEnd[1], { today: '9999-12-31' });
    if (!date.ok) return fail('invalid_financial_year');
    // A December year end is not an Indian FY, and picking one would be a guess.
    if (!date.value.endsWith('-03-31')) return fail('non_march_year_end');
    return { ok: true, value: fyLabel(Number(date.value.slice(0, 4)) - 1) };
  }

  return fail('invalid_financial_year');
}

/**
 * A candidate's period: 'FY 2024-25', or a date for point-in-time data. Null when unreadable,
 * which the merge treats as period_unknown. A bare 31 March is the close of that FY.
 */
export function normalizePeriod(raw: string | null | undefined, today: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const fy = normalizeFinancialYear(raw);
  if (fy.ok) return fy.value;
  const date = parseDate(raw, { today, allowFuture: true });
  if (!date.ok) return null;
  return date.value.endsWith('-03-31') ? fyLabel(Number(date.value.slice(0, 4)) - 1) : date.value;
}

/** Last day of a period as YYYY-MM-DD, comparable as a string. */
export function periodEndDate(period: string | null): string | null {
  if (!period) return null;
  const fy = period.match(FY_LABEL);
  if (fy) return `${Number(fy[1]) + 1}-03-31`;
  return /^\d{4}-\d{2}-\d{2}$/.test(period) ? period : null;
}

export function previousFinancialYear(period: string | null): string | null {
  const fy = period?.match(FY_LABEL);
  return fy ? fyLabel(Number(fy[1]) - 1) : null;
}

export function isFinancialYearLabel(period: string | null): boolean {
  return period !== null && FY_LABEL.test(period);
}

// ------------------------------------------------------------ Other numerics

export function parsePercent(raw: string): Validated<number> {
  if (typeof raw !== 'string') return fail('invalid_percent');
  const text = cleanText(raw).replace(/\s*(?:%|percent|per\s*cent|pct)\.?$/i, '').trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return fail('invalid_percent');
  const value = Number(text);
  return Number.isFinite(value) ? { ok: true, value: value === 0 ? 0 : value } : fail('invalid_percent');
}

const UNIT_SUFFIX: Partial<Record<NumericUnit, RegExp>> = {
  days: /\s*days?$/i,
  months: /\s*(?:months?|mths?|mos?)\.?$/i,
  years: /\s*(?:years?|yrs?)\.?$/i,
  count: /\s*(?:facilit(?:y|ies)|lenders?|accounts?|loans?)$/i,
  rank: /^cmr[\s:-]*/i,
};

const WHOLE_UNITS: readonly NumericUnit[] = ['score', 'rank', 'months', 'days', 'count'];

/** Score, rank, days, months, years, count. The only conversion is a tenure stated in years. */
export function parseMeasure(raw: string, unit: NumericUnit | undefined): Validated<number> {
  if (typeof raw !== 'string') return fail('invalid_number');
  let text = cleanText(raw);
  let multiplier = 1;
  if (unit === 'months' && /\s*(?:years?|yrs?)\.?$/i.test(text)) {
    text = text.replace(/\s*(?:years?|yrs?)\.?$/i, '');
    multiplier = 12;
  }
  const suffix = unit ? UNIT_SUFFIX[unit] : undefined;
  if (suffix) text = text.replace(suffix, '').trim();
  const sign = text.startsWith('-') ? -1 : 1;
  const magnitude = parsePlainNumber(text.replace(/^-\s*/, ''));
  if (magnitude === null) return fail('invalid_number');
  const value = magnitude * multiplier;
  if (unit && WHOLE_UNITS.includes(unit) && !Number.isInteger(value)) return fail('invalid_number');
  return { ok: true, value: value === 0 ? 0 : sign * value };
}

// ------------------------------------------------------- Equality (section 4.3)

export function currencyEqual(a: number, b: number): boolean {
  const { currencyAbsoluteTolerance, currencyRelativeTolerance } = DOCUMENT_AI_THRESHOLDS;
  const tolerance = Math.max(
    currencyAbsoluteTolerance,
    currencyRelativeTolerance * Math.max(Math.abs(a), Math.abs(b))
  );
  return Math.abs(a - b) <= tolerance;
}

export function normalizeComparableString(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\bpvt\b/g, 'private')
    .replace(/\bltd\b/g, 'limited')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fieldValuesEqual(definition: FieldDefinition, a: FieldValue, b: FieldValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return definition.unit === 'currency' ? currencyEqual(a, b) : a === b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return definition.valueType === 'enum' ? a === b : normalizeComparableString(a) === normalizeComparableString(b);
  }
  return false;
}

/** Significant digits, for "takes the most precise value" within tolerance. */
export function significantDigits(value: FieldValue): number {
  if (typeof value !== 'number') return 0;
  const digits = Math.abs(value).toString().replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length;
}

// --------------------------------------------------------------- Snippet check

function numericTokens(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((token) => {
    const plain = token.replace(/,/g, '');
    // The decimal point stays, so 1.25 is never "found" in 12.5.
    return plain.includes('.') ? plain.replace(/\.?0+$/, '') : plain;
  });
}

/**
 * Section 4.2 rule 4. The check runs on rawValue, because the value may be scaled: `(12.50)` in
 * lakh is -1250000 but the page prints 12.50. Whole tokens, so 12 is not "found" inside 1250.
 */
export function rawValueInSnippet(rawValue: string, snippet: string, valueType: 'number' | 'string'): boolean {
  if (valueType === 'number') {
    const wanted = numericTokens(rawValue);
    if (wanted.length === 0) return false;
    const present = new Set(numericTokens(snippet));
    return wanted.every((token) => present.has(token));
  }
  const fold = (text: string) => cleanText(text).toLowerCase();
  const needle = fold(rawValue);
  return needle.length > 0 && fold(snippet).includes(needle);
}

// ------------------------------------------------------------- Unit evidence

const UNIT_WORDS: ReadonlyArray<{ pattern: RegExp; unit: AmountUnit }> = [
  { pattern: /^(?:crores?|crs?)$/i, unit: 'crore' },
  { pattern: /^(?:lakhs?|lacs?|l)$/i, unit: 'lakh' },
  { pattern: /^(?:millions?|mn)$/i, unit: 'million' },
  { pattern: /^(?:thousands?|k)$/i, unit: 'thousand' },
];

const ADJACENT_UNIT = /(\d[\d,]*(?:\.\d+)?)\)?\s*(crores?|crs?|lakhs?|lacs?|l|millions?|mn|thousands?|k)\b/gi;

/**
 * Units printed directly after one of these figures. With `creditMarker`, a bare Cr is the bank
 * statement's credit marker and says nothing about the unit.
 */
function adjacentUnits(text: string, tokens: readonly string[], creditMarker: boolean): AmountUnit[] {
  const units: AmountUnit[] = [];
  for (const [, figure, word] of cleanText(text).matchAll(ADJACENT_UNIT)) {
    if (!numericTokens(figure).some((token) => tokens.includes(token))) continue;
    if (creditMarker && /^cr$/i.test(word)) continue;
    const unit = UNIT_WORDS.find((entry) => entry.pattern.test(word))?.unit;
    if (unit) units.push(unit);
  }
  return units;
}

/** Scaled units named anywhere in header text. A lone `L` or `K` is not a header. */
function headerUnits(text: string): AmountUnit[] {
  const clean = cleanText(text).replace(/[‘’`]/g, "'");
  const units: AmountUnit[] = [];
  if (/\b(?:crores?|crs?)\b/i.test(clean)) units.push('crore');
  if (/\b(?:lakhs?|lacs?)\b/i.test(clean)) units.push('lakh');
  if (/\b(?:millions?|mn)\b/i.test(clean)) units.push('million');
  if (/\bthousands?\b|(?<![\d,.])'?000s?\b/i.test(clean)) units.push('thousand');
  return units;
}

/** Section 6.3: the unit the server is about to apply must not contradict the page. */
export function unitAgreesWithSnippet(input: {
  rawValue: string;
  inlineUnit: AmountUnit | null;
  statedUnit: AmountUnit | null;
  snippet: string;
  creditMarker: boolean;
}): boolean {
  const { rawValue, inlineUnit, statedUnit, snippet, creditMarker } = input;
  const adjacent = adjacentUnits(snippet, numericTokens(rawValue), creditMarker);
  if (inlineUnit !== null) {
    if (adjacent.includes(inlineUnit)) return true;
    return adjacent.length === 0 && headerUnits(snippet).includes(inlineUnit);
  }
  // No inline unit, yet the page prints one: the model dropped it, or the header is contradicted.
  if (statedUnit === null) return adjacent.length === 0;
  return adjacent.length === 0 || adjacent.includes(statedUnit);
}

/** A stated unit counts only if the quoted header says the same. */
export function unitTextSupports(statedUnit: AmountUnit, unitText: string | null | undefined): boolean {
  if (!unitText) return false;
  const scaled = headerUnits(unitText);
  if (scaled.length > 0) return scaled.includes(statedUnit);
  return statedUnit === 'rupees' && /₹|\b(?:rs|re|inr|rupees?)\b/i.test(cleanText(unitText));
}

const FOREIGN_CODES = /(?<![A-Za-z])(?:USD|EUR|GBP|AED|SGD|JPY|CAD|AUD|CHF|CNY|HKD|SAR|NZD|ZAR|QAR|KWD|OMR)(?![A-Za-z])/;
const FOREIGN_WORDS = /[$€£¥]|\b(?:dollars?|euros?|pounds?\s+sterling|dirhams?|yen)\b/i;

/** Case-sensitive codes: `Aud.` and `Sar` turn up in Indian documents and are not currencies. */
export function hasForeignUnit(text: string): boolean {
  return FOREIGN_CODES.test(text) || FOREIGN_WORDS.test(text);
}

// -------------------------------------------------------------- Wording checks

/** The name of a statement says nothing about the figure. A row label does. */
const STATEMENT_TITLE = /statement\s+of\s+profit\s*(?:and|&)\s*loss|profit\s*(?:and|&)\s*loss\s+(?:account|a\/c|statement)/gi;
const LOSS_WORDING = /\b(?:loss(?:es)?|deficit|deficiency|negative|shortfall|erosion|eroded|debit\s+balance)\b/i;

/** Schedule III rows such as "Profit / (Loss) after tax": the brackets mark the convention, not a loss. */
const PROFIT_OR_LOSS_ROW = /\bprofit\s*\/?\s*\(\s*loss\s*\)|\(\s*loss\s*\)\s*\/?\s*profit\b/gi;

export function hasLossWording(text: string): boolean {
  return LOSS_WORDING.test(cleanText(text).replace(STATEMENT_TITLE, ' ').replace(PROFIT_OR_LOSS_ROW, ' '));
}

const PART_YEAR_WORDING = new RegExp(
  [
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven)[\s-]+months?\b`,
    String.raw`\b(?!12\b)\d{1,2}[\s-]*months?\s+(?:ended|ending|to)\b`,
    String.raw`\b(?:[369]m|q[1-4]|h[12])\b`,
    String.raw`\bhalf[\s-]*year(?:ly)?\b`,
    String.raw`\bquarter\s+(?:ended|ending)\b`,
    String.raw`\bquarterly\s+(?:results?|figures?|statement)\b`,
    String.raw`\b(?:ytd|year[\s-]+to[\s-]+date)\b`,
    String.raw`\b(?:part[\s-]+year|stub\s+period|period\s+(?:ended|ending))\b`,
    String.raw`\binterim\s+(?:period|results?|financials?|statements?)\b`,
    String.raw`\bapr(?:il)?\s*(?:to|-)\s*(?:jun|sep|dec|may|jul|aug|oct|nov|jan|feb)`,
  ].join('|'),
  'i'
);

export function hasPartYearWording(text: string): boolean {
  return PART_YEAR_WORDING.test(cleanText(text));
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${normalizeComparableString(text)} `.includes(` ${normalizeComparableString(phrase)} `);
}

/** The evidence keywords of `value` found in `text`. Empty when none, or when a `none` phrase is there. */
export function findEnumEvidence(definition: FieldDefinition, value: FieldValue, text: string): string[] {
  const rule = definition.enumEvidence?.[String(value)];
  if (!rule) return [];
  if (rule.none?.some((phrase) => containsPhrase(text, phrase))) return [];
  return rule.any.filter((phrase) => containsPhrase(text, phrase));
}

// ---------------------------------------------- Check against server-read text

export interface SourceRow {
  sheetName: string;
  cells: ReadonlyArray<{ ref: string; text: string }>;
}

/**
 * What the server itself read from a file. `no_text` has nothing to check against: an image or a
 * scanned PDF. `unreadable` is a PDF the parser gave up on, and fails closed, so that a file built
 * to break the parser cannot escape the check.
 */
export type DocumentSource =
  | { kind: 'no_text' }
  | { kind: 'unreadable' }
  | { kind: 'cells'; rows: readonly SourceRow[] }
  | { kind: 'pdf'; lines: readonly string[] };

export interface SourceQuery {
  valueType: 'number' | 'string' | 'enum';
  rawValue: string;
  value: FieldValue | null;
  snippet: string;
  unitText: string | null;
  sheetName: string | null;
  cellRef: string | null;
  inlineUnit: AmountUnit | null;
  creditMarker: boolean;
  /** Enum only: the evidence keywords found in the snippet, which must really be in the file. */
  evidence: readonly string[];
  /** Signed fields only: return the row's text, for the loss wording check. */
  wantRowLabel: boolean;
}

export interface SourceFinding {
  check: SourceCheck;
  rowLabel: string | null;
}

export type SourceVerifier = (query: SourceQuery) => SourceFinding;

const MAX_ROW_LABEL = 300;
const NOT_VERIFIED: SourceFinding = { check: 'failed', rowLabel: null };

/** Case and whitespace insensitive: PDF text breaks lines where the model's quote does not. */
function compact(text: string): string {
  return cleanText(text).toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, '');
}

function textMatches(query: SourceQuery, haystack: string): boolean {
  const wanted = [query.rawValue, query.value === null ? '' : String(query.value)].map(compact).filter(Boolean);
  return wanted.some((needle) => haystack.includes(needle));
}

/** A figure printed with another unit beside it is not the figure the model reported. */
function unitsAllow(query: SourceQuery, text: string, tokens: readonly string[]): boolean {
  if (query.inlineUnit === null) return true;
  const adjacent = adjacentUnits(text, tokens, query.creditMarker);
  return adjacent.length === 0 || adjacent.includes(query.inlineUnit);
}

function joinLabel(parts: readonly string[]): string | null {
  return [...new Set(parts)].join(' | ').slice(0, MAX_ROW_LABEL) || null;
}

function cellVerifier(rows: readonly SourceRow[]): SourceVerifier {
  const indexed = rows.flatMap((row, rowIndex) =>
    row.cells.map((cell) => ({
      rowIndex,
      sheetName: row.sheetName,
      ref: cell.ref,
      text: cell.text,
      tokens: new Set(numericTokens(cell.text)),
      compacted: compact(cell.text),
    }))
  );
  const wholeText = indexed.map((cell) => cell.text).join(' ');

  return (query) => {
    const unitText = query.unitText === null ? null : compact(query.unitText);
    if (unitText !== null && !indexed.some((cell) => cell.compacted.includes(unitText))) return NOT_VERIFIED;
    if (query.valueType === 'enum' && query.evidence.length > 0) {
      return query.evidence.some((phrase) => containsPhrase(wholeText, phrase))
        ? { check: 'verified', rowLabel: null }
        : NOT_VERIFIED;
    }

    const tokens = numericTokens(query.rawValue);
    const holdsValue = (cell: (typeof indexed)[number]) =>
      query.valueType === 'number'
        ? tokens.length > 0 && tokens.every((token) => cell.tokens.has(token)) && unitsAllow(query, cell.text, tokens)
        : textMatches(query, cell.compacted);
    const cited = indexed.filter(
      (cell) =>
        (query.sheetName === null || cell.sheetName === query.sheetName) &&
        (query.cellRef === null || cell.ref === query.cellRef)
    );
    // The cell it cites, when that holds the value. Otherwise any visible cell: the raw value must
    // still be somewhere a reviewer can see it, and a hidden row is not in `rows` at all.
    const citedMatches = cited.filter(holdsValue);
    const found = citedMatches.length > 0 ? citedMatches : indexed.filter(holdsValue);
    if (found.length === 0) return NOT_VERIFIED;
    if (!query.wantRowLabel) return { check: 'verified', rowLabel: null };

    const foundRows = new Set(found.map((cell) => cell.rowIndex));
    const labels = indexed.filter((cell) => foundRows.has(cell.rowIndex) && /[A-Za-z]/.test(cell.text));
    return { check: 'verified', rowLabel: joinLabel(labels.map((cell) => cell.text)) };
  };
}

function pdfVerifier(lines: readonly string[]): SourceVerifier {
  const wholeText = lines.join(' ');
  const compacted = compact(wholeText);
  const tokens = new Set(numericTokens(wholeText));

  return (query) => {
    if (query.unitText !== null && !compacted.includes(compact(query.unitText))) return NOT_VERIFIED;
    if (
      query.valueType === 'enum' &&
      query.evidence.length > 0 &&
      !query.evidence.some((phrase) => containsPhrase(wholeText, phrase))
    ) {
      return NOT_VERIFIED;
    }
    const rawTokens = numericTokens(query.rawValue);
    if (![...rawTokens, ...numericTokens(query.snippet)].every((token) => tokens.has(token))) return NOT_VERIFIED;
    if (query.valueType === 'number' && rawTokens.length === 0) return NOT_VERIFIED;
    if (query.valueType === 'string' && !textMatches(query, compacted)) return NOT_VERIFIED;

    const rowLines = lines.filter((line) => {
      const lineTokens = numericTokens(line);
      return rawTokens.length > 0 && rawTokens.every((token) => lineTokens.includes(token));
    });
    if (!unitsAllow(query, rowLines.join(' '), rawTokens)) return NOT_VERIFIED;
    return { check: 'verified', rowLabel: query.wantRowLabel ? joinLabel(rowLines) : null };
  };
}

/** Section 4.2: checks a candidate against text the server read, never against the model's quote. */
export function createSourceVerifier(source: DocumentSource): SourceVerifier {
  switch (source.kind) {
    case 'cells':
      return cellVerifier(source.rows);
    case 'pdf':
      return pdfVerifier(source.lines);
    case 'unreadable':
      return () => NOT_VERIFIED;
    default:
      return () => ({ check: 'no_text', rowLabel: null });
  }
}
