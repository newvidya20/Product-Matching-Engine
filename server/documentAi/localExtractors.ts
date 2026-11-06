/**
 * Deterministic extractors: labelled values read straight from text the server read itself (PDF
 * text layer, Word, plain text, local OCR) or from spreadsheet cells. No AI, no quota.
 *
 * Never-guess rules:
 * - A value is reported only when a known label and the figure are both literally on the same line
 *   (or row), and the snippet quoted is that line, so every value traces to its page or cell.
 * - Nothing is summed, averaged, estimated or carried across periods here. Bank averages are worked
 *   out later by derive.ts, the field map's own derivation, from monthly rows printed in the file.
 * - Several figures on a labelled line are paired with period columns only when the counts agree.
 *   An unknown layout gives nothing for that field, which is then flagged missing.
 * - Output is the RawField / RawBankMonth shape the model would return, so the same buildCandidates
 *   and buildBankMonthlyTotals (validators, unit, sign, period and source checks) settle it.
 * Pure: no I/O, no clock, no logging.
 */
import { getFieldDefinition } from '../../src/documentAi/fieldMap.ts';
import type { DocumentType } from '../../src/types/documentAi.ts';
import type { RawBankMonth, RawField } from './prompt.ts';
import type { ParsedSheet } from './spreadsheet.ts';
import { bankMonthsFromStatement } from './bankStatements.ts';
import { readFinancialStatements } from './financialStatements.ts';
import { readProfileForm } from './profileForm.ts';
import { readCompanyIdentity } from './companyIdentity.ts';
import { readCreditReport } from './creditReports.ts';
import { readObligationSheet, readSanctionLetter } from './debtObligations.ts';
import { readGstr3b, type RawGstReturnPeriod } from './gstr3b.ts';
import { normalizeFinancialYear, normalizePeriod, parseDate, type AmountUnit } from './validators.ts';

/** Text read from a text layer: at or above the default auto-apply threshold, so it can apply when every check passes. */
export const LOCAL_TEXT_CONFIDENCE = 0.9;
/** OCR can misread a digit, so its values are always reviewed: below the lowest auto-apply threshold (0.7). */
export const LOCAL_OCR_CONFIDENCE = 0.65;

export type LocalContent =
  | { kind: 'text'; pages: ReadonlyArray<readonly string[]> }
  | { kind: 'sheets'; fileKind: 'xlsx' | 'csv'; sheets: readonly ParsedSheet[] };

export interface LocalExtractionInput {
  documentType: DocumentType;
  content: LocalContent;
  fromOcr: boolean;
  /**
   * False when pages were left unread. A figure with no period of its own then takes none: the
   * unread pages may state another period, so "the document's one period" cannot be known.
   */
  complete?: boolean;
  /**
   * 1-based pages of a PDF read by OCR while its other pages were read from the text layer. A
   * figure on a text page takes the document's one period only when the text pages state it too,
   * never from OCR text alone.
   */
  ocrPages?: ReadonlySet<number>;
}

export interface LocalExtraction {
  fields: RawField[];
  bankMonthlyTotals: RawBankMonth[];
  /** GSTR-3B Table 3.1 periods (gstr3b.ts). Absent or empty when the file is not a GSTR-3B read for certain. */
  gstReturnPeriods?: RawGstReturnPeriod[];
  /**
   * A fixed-layout form recognised by its printed title, whose layout is known to state no more key
   * fields than were read here (an ITR-V prints no turnover or profit), so the model is not asked.
   */
  recognisedForm?: 'gstr3b' | 'itr_acknowledgement';
}

// ------------------------------------------------------------------ ITR-V (acknowledgement)

const ITR_ACK_TITLE = /^indian\s+income\s+tax\s+return\s+acknowledgement\b/i;
const ITR_ACK_NAME = /^name\s+(?![:\-])(.+)$/i;

/**
 * The e-filing ITR-V: `INDIAN INCOME TAX RETURN ACKNOWLEDGEMENT`, then `PAN <pan>` and, on the next
 * line, `Name <name>`. Its figures are taxable income and tax, not turnover or profit, so nothing
 * else is taken. Status (Individual, company) is not read as the entity type: a proprietor files as
 * an individual, so it would misstate a proprietorship.
 */
function readItrAcknowledgement(pages: ReadonlyArray<readonly string[]>, confidence: number): RawField[] | null {
  const lines = pages.flatMap((page, index) => page.map((text) => ({ text: clean(text), page: index + 1 })));
  if (!lines.slice(0, 15).some((line) => ITR_ACK_TITLE.test(line.text))) return null;
  const panIndex = lines.findIndex((line) => /^PAN\s+[A-Z]{5}\d{4}[A-Z]$/.test(line.text));
  const nameLine = panIndex >= 0 ? lines[panIndex + 1] : undefined;
  const name = nameLine?.text.match(ITR_ACK_NAME)?.[1]?.trim();
  if (!nameLine || !name || name.length < 3 || name.length > 120 || !/[A-Za-z]{2}/.test(name) || /\d/.test(name)) return [];
  return [
    {
      fieldId: 'applicantLabel',
      rawValue: name,
      enumValue: null,
      page: nameLine.page,
      sheetName: null,
      cellRef: null,
      snippet: snip(nameLine.text),
      confidence,
      statedUnit: null,
      unitText: null,
      period: null,
      subjectRef: null,
    },
  ];
}

const SNIPPET_MAX = 300;

// ------------------------------------------------------------------ Rules

type ValueKind = 'amount' | 'score' | 'rank' | 'months' | 'pan' | 'gstin' | 'date' | 'text' | 'fy' | 'entity';

interface FieldRule {
  fieldId: string;
  kind: ValueKind;
  /** Matched at the start of the line (after numbering), case-insensitive. */
  label: RegExp;
  /** A line matching this is never used for the field. */
  exclude?: RegExp;
  /** Only these document types; otherwise the field map's own source types decide. */
  only?: readonly DocumentType[];
}

const PREFIX = String.raw`^[\s|>*•·\-–]*(?:(?:\d{1,2}|[ivx]{1,4}|[a-h])[.)]\s+|\((?:\d{1,2}|[ivx]{1,4}|[a-h])\)\s*)?(?:your\s+)?`;
const rule = (fieldId: string, kind: ValueKind, label: string, extra: Partial<FieldRule> = {}): FieldRule => ({
  fieldId,
  kind,
  label: new RegExp(`${PREFIX}(?:${label})`, 'i'),
  ...extra,
});

const NOT_TOTAL_OF_PARTS = /\b(?:non[\s-]*current|other\s+current|previous\s+year|growth|ratio|margin|%)/i;
const PRIOR_PERIOD = /\b(?:preceding|previous|prior|last)\s+(?:financial\s+)?year\b/i;
/** `TOL/TNW: 1.52`, `TOL to TNW ratio`: a ratio of the two, never either amount. */
const LEVERAGE_RATIO = /\bratio\b|%|\b(?:tol|outside\s+liabilities)\s*\/|(?:\/|\bto)\s*(?:tnw|tangible\s+net\s*worth)\b/i;

/** Most specific first: the first rule whose label matches a line takes it. */
const RULES: readonly FieldRule[] = [
  // Identity and names.
  rule('identity.gstin', 'gstin', String.raw`gstin(?:\/uin)?|gst\s*(?:in|identification)\s*(?:no\.?|number)?|gst\s+registration\s+(?:no\.?|number)`),
  rule('identity.pan', 'pan', String.raw`pan(?:\s+(?:no\.?|number))?\b|permanent\s+account\s+number`),
  rule('identity.dateOfEstablishment', 'date',
    String.raw`date\s+of\s+(?:incorporation|registration|liability|commencement(?:\s+of\s+business)?|establishment)`),
  rule('applicantLabel', 'text',
    String.raw`legal\s+name(?:\s+of\s+(?:the\s+)?(?:business|registered\s+person|taxpayer))?|name\s+of\s+(?:the\s+)?(?:business|company|applicant|borrower|firm|entity|taxpayer|assessee)|applicant(?:'s)?(?:\s+name)?|borrower(?:'s)?\s+name|customer(?:'s)?\s+name|company\s+name|account\s+holder(?:'s)?(?:\s+name)?|applicant\s+name|borrower\s+profile|customer\s+profile`),
  rule('applicantLabel', 'text', String.raw`name(?=\s*:)`, { only: ['itr'] }),
  rule('entityType', 'entity',
    String.raw`constitution(?:\s+of\s+(?:the\s+)?business)?|legal\s+status|type\s+of\s+(?:entity|organi[sz]ation|business)|entity\s+type|business\s+type`),

  // Loan application.
  rule('requestedAmount', 'amount',
    String.raw`(?:loan|facility)\s+amount\s+(?:requested|required|applied(?:\s+for)?|sought)|amount\s+(?:requested|required|applied\s+for|sought)|facility\s+requested|requested\s+(?:loan\s+)?amount|loan\s+required`),
  rule('requestedTenureMonths', 'months', String.raw`(?:requested\s+|loan\s+|proposed\s+)?tenure|repayment\s+period`),

  // Credit report.
  rule('financialProfile.promoterCibilScore', 'score', String.raw`promoter(?:'s)?\s+(?:cibil|credit)\s+score`),
  rule('financialProfile.personalCibilScore', 'score',
    String.raw`cibil(?:\s+transunion)?\s+score|transunion\s+cibil\s+score|credit\s+score|bureau\s+score|cibil\s+is|score\s+is`,
    { exclude: /\b(?:cmr|commercial|promoter)\b/i }),
  rule('financialProfile.commercialCmrRank', 'rank',
    String.raw`(?:cibil\s+)?msme\s+rank(?:\s*\(cmr\))?|cmr(?:\s+rank)?|commercial\s+(?:mse\s+)?rank`),
  // `Date of Enquiry` / `Enquiry date` rows list lenders' past enquiries, one per row: never the report date.
  rule('financialProfile.personalCreditReportDate', 'date',
    String.raw`report\s+date|date\s+of\s+(?:report|issue)|report\s+generated\s+on|generated\s+on`),
  rule('financialProfile.existingMonthlyEmi', 'amount',
    String.raw`total\s+(?:existing\s+)?(?:monthly\s+)?emis?\b|existing\s+(?:monthly\s+)?emis?\b|total\s+monthly\s+obligations?|emi\s+obligations?`,
    { exclude: /\b(?:proposed|new\s+loan|after)\b/i }),

  // GST.
  rule('financialProfile.gstAnnualTurnover', 'amount',
    String.raw`(?:aggregate|annual|total)\s+turnover`,
    { exclude: PRIOR_PERIOD, only: ['gst_return'] }),

  // Bank statement limit.
  rule('financialProfile.ccOdSanctionedLimit', 'amount',
    String.raw`(?:sanctioned|approved)\s+limit|(?:cc|od|overdraft|cash\s+credit)\s+limit|limit\s+sanctioned`),

  // Financial statements and ITR.
  rule('financialProfile.financialYearLabel', 'fy',
    String.raw`(?:for\s+the\s+)?(?:financial\s+)?year\s+end(?:ed|ing)|financial\s+year\b|f\.?y\.?\b`,
    { only: ['financial_statement'] }),
  rule('financialProfile.currentAssets', 'amount', String.raw`(?:total\s+)?current\s+assets`, { exclude: NOT_TOTAL_OF_PARTS }),
  rule('financialProfile.currentLiabilities', 'amount', String.raw`(?:total\s+)?current\s+liabilities`, { exclude: NOT_TOTAL_OF_PARTS }),
  rule('financialProfile.totalOutsideLiabilities', 'amount', String.raw`total\s+outside\s+liabilities|\btol\b`,
    { exclude: LEVERAGE_RATIO }),
  rule('financialProfile.totalAssets', 'amount', String.raw`total\s+assets`, { exclude: NOT_TOTAL_OF_PARTS }),
  rule('financialProfile.totalLiabilities', 'amount', String.raw`total\s+liabilities(?!\s+and)`,
    { exclude: /\b(?:equity\s+and|and\s+equity|current|outside)\b/i }),
  rule('financialProfile.tangibleNetWorth', 'amount', String.raw`tangible\s+net\s*worth|\btnw\b`, { exclude: LEVERAGE_RATIO }),
  rule('financialProfile.shareholdersEquity', 'amount',
    String.raw`(?:total\s+)?shareholders['’]?\s+(?:equity|funds)|total\s+equity(?!\s+and)`),
  rule('financialProfile.annualRevenue', 'amount',
    String.raw`(?:total\s+)?revenue\s+from\s+operations|(?:net|gross|total)\s+sales|sales\s+turnover|gross\s+turnover|gross\s+receipts|turnover(?=\s*[:\d(₹]|\s+rs)`,
    { exclude: /\b(?:other\s+income|growth|%|previous\s+year|gst)\b/i, only: ['financial_statement', 'itr'] }),
  rule('financialProfile.netProfitAfterTax', 'amount',
    String.raw`(?:net\s+)?profit\s*(?:\/\s*\(\s*loss\s*\)\s*)?(?:after\s+tax(?:ation)?|for\s+the\s+(?:year|period))|\bpat\b`,
    { exclude: /\bbefore\b/i }),
  rule('financialProfile.ebitda', 'amount', String.raw`ebitda\b`, { exclude: /\bmargin\b|%/i }),
  rule('financialProfile.ebit', 'amount', String.raw`ebit\b(?!da)`, { exclude: /\bmargin\b|%/i }),
  rule('financialProfile.depreciation', 'amount', String.raw`depreciation(?:\s+expenses?)?(?!\s*(?:and|&)\s*amorti)`,
    { exclude: /amorti[sz]ation|accumulated/i }),
  rule('financialProfile.amortization', 'amount', String.raw`amorti[sz]ation(?:\s+expenses?)?`,
    { exclude: /depreciation|accumulated/i }),
  rule('financialProfile.interestExpense', 'amount',
    String.raw`interest\s+(?:expenses?|paid|cost|on\s+borrowings)|finance\s+costs?`,
    { exclude: /\bincome\b|\breceived\b|coverage/i }),
  rule('financialProfile.operatingCashFlow', 'amount',
    String.raw`net\s+cash\s+(?:flow\s+)?(?:generated\s+)?(?:from|used\s+in|(?:from\s+)?\/?\s*\(used\s+in\))\s+operating\s+activities|cash\s+flow\s+from\s+operations`),
];

// ------------------------------------------------------------------ Text helpers

const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const snip = (text: string) => clean(text).slice(0, SNIPPET_MAX);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DATE_TEXT = String.raw`(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?[\s-]+${MONTH_WORD}\.?,?[\s-]+\d{4})`;
const FY_TEXT = String.raw`(?:f\.?\s*y\.?|a\.?\s*y\.?|financial\s+year|assessment\s+year)?\s*:?\s*(?:19|20)\d{2}\s*[-/]\s*(?:\d{4}|\d{2})(?!\d)`;
/** Dates and years: headings and periods, never amounts. */
const STAMP = new RegExp(String.raw`${DATE_TEXT}|${FY_TEXT}|(?<![\d.,])${MONTH_WORD}\.?[\s'-]*(?:19|20)?\d{2}(?![\d.,])`, 'gi');

const AMOUNT = new RegExp(
  String.raw`(?<![A-Za-z0-9.,/-])\(?\s*(?:(?:rs\.?|inr|₹)\s*)?-?\s*\d[\d,]*(?:\.\d+)?\s*\)?(?:\s*\/-)?(?:\s*(?:crores?|crs?|lakhs?|lacs?|mn|millions?|thousands?|cr|dr)\.?(?![A-Za-z]))?`,
  'gi'
);

function blankOut(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

/** Amount tokens in `text`, with dates and periods removed first. */
function amountsIn(text: string): string[] {
  const withoutStamps = blankOut(text, STAMP);
  return [...withoutStamps.matchAll(AMOUNT)].map((m) => m[0].trim()).filter((m) => /\d/.test(m));
}

const BARE_SMALL_INTEGER = /^\d{1,2}(?:\.\d)?$/;

/** A narrative line around a unit phrase has more words than a unit heading ever does. */
const UNIT_HEADING_MAX_OTHER_WORDS = 6;

/**
 * A unit heading: `(Rs. in lakhs)`, `Amount in ₹ crores`, `All figures in lakhs unless otherwise
 * stated`, or `Particulars (in lakhs)  FY 2024-25  FY 2023-24`. The unit phrase must be in brackets,
 * or the line must be short and hold no figure. A narrative sentence (`turnover grew by 12 in lakhs
 * terms over the year`) is never a heading, so it never scales the figures that follow it.
 */
function unitHeaderIn(text: string): { unit: AmountUnit; unitText: string } | null {
  const line = clean(text);
  const match = line.match(
    /(?:(?:rs\.?|inr|₹|rupees|amounts?|figures?)\s*(?:are\s+)?(?:in|in\s+rs\.?|in\s+₹)?\s*(?:'|’)?\s*(lakhs?|lacs?|crores?|thousands?|millions?))|(?:in\s+(lakhs?|lacs?|crores?|thousands?|millions?))\b/i
  );
  if (!match || match.index === undefined) return null;
  const before = line.slice(0, match.index);
  const after = line.slice(match.index + match[0].length);
  const bracketed = /[([]\s*[^()[\]]*$/.test(before) && /^[^()[\]]*[)\]]/.test(after);
  if (!bracketed) {
    const others = blankOut(`${before} ${after}`, STAMP);
    if (/\d/.test(others)) return null; // a figure on the line: a sentence or a row, not a heading
    const words = others.split(/[^A-Za-z]+/).filter((word) => word.length > 1);
    if (words.length > UNIT_HEADING_MAX_OTHER_WORDS) return null;
  }
  const word = (match[1] ?? match[2]).toLowerCase();
  const unit: AmountUnit = word.startsWith('cr')
    ? 'crore'
    : word.startsWith('la')
      ? 'lakh'
      : word.startsWith('th')
        ? 'thousand'
        : 'million';
  return { unit, unitText: match[0].trim() };
}

/** A figure on the line once dates and periods are removed. */
function hasFigure(text: string): boolean {
  return /\d/.test(blankOut(clean(text), STAMP));
}

/**
 * The heading of a new statement or schedule: `Balance Sheet as at 31.03.2025`, `Statement of
 * Profit and Loss`, `Cash Flow Statement`, `Schedule 3`, `Notes to accounts`. Its unit and period
 * columns are its own, so earlier ones stop applying. A line with a figure is a row, not a heading.
 */
const SECTION_HEADING =
  /^(?:(?:standalone|consolidated|audited|unaudited|provisional|abridged)\s+)*(?:balance\s+sheet|statement\s+of\s+(?:profit|income|cash\s+flows?|changes\s+in\s+equity|assets)|profit\s+(?:and|&)\s+loss\s+(?:account|statement)|cash\s+flow\s+statement|trading\s+account|income\s+statement|schedules?\s+[\w.-]+|notes?\s+(?:to|forming\s+part\s+of)\b)/i;

function isSectionHeading(text: string): boolean {
  const line = clean(text).replace(/^[\s|>*•·\-–]+/, '');
  return SECTION_HEADING.test(line) && !/\d/.test(blankOut(line.replace(/^schedules?\s+[\w.-]+/i, ''), STAMP));
}

/** `FY 2024-25` for a statement of the whole year, from labels a document prints about itself. */
function documentPeriodIn(line: string): string | null {
  const text = clean(line);
  const range = text.match(new RegExp(`(${DATE_TEXT})\\s*(?:to|-|–|till|upto)\\s*(${DATE_TEXT})`, 'i'));
  if (range) {
    const from = parseDate(range[1], { today: '9999-12-31' });
    const to = parseDate(range[2], { today: '9999-12-31' });
    if (from.ok && to.ok && from.value.endsWith('-04-01') && to.value.endsWith('-03-31')) {
      if (Number(to.value.slice(0, 4)) === Number(from.value.slice(0, 4)) + 1) return normalizePeriod(to.value, '9999-12-31');
    }
    return null;
  }
  const fy = text.match(new RegExp(`\\b(?:financial\\s+year|f\\.?\\s*y\\.?|assessment\\s+year|a\\.?\\s*y\\.?)\\s*:?\\s*((?:19|20)\\d{2}\\s*[-/]\\s*(?:\\d{4}|\\d{2}))(?!\\d)`, 'i'));
  if (fy) {
    const assessment = /assessment\s+year|a\.?\s*y\./i.test(fy[0]);
    const label = normalizeFinancialYear(`${assessment ? 'AY' : 'FY'} ${fy[1]}`);
    return label.ok ? label.value : null;
  }
  const ended = text.match(new RegExp(`(?:year\\s+end(?:ed|ing)|as\\s+(?:at|on))\\s*:?\\s*(${DATE_TEXT})`, 'i'));
  if (ended) {
    const label = normalizeFinancialYear(`year ended ${ended[1]}`);
    return label.ok ? label.value : null;
  }
  return null;
}

/** A line of period headings: `Particulars  FY 2024-25  FY 2023-24`, `As at 31.03.2025  31.03.2024`. */
function columnPeriodsIn(line: string): string[] | null {
  const text = clean(line);
  if (/\b(?:to|till|upto|from)\b/i.test(text)) return null;
  const stamps = [...text.matchAll(STAMP)].map((m) => m[0]);
  if (stamps.length === 0) return null;
  const rest = blankOut(text, STAMP);
  if (/\d/.test(rest)) return null;
  const startsAsHeading = /^(?:particulars|as\s+at|as\s+on|year\s+ended|for\s+the|description|items?|notes?)\b/i.test(text);
  if (stamps.length < 2 && !startsAsHeading) return null;
  const periods = stamps.map((stamp) => {
    const direct = normalizePeriod(stamp, '9999-12-31');
    if (direct) return direct;
    const asFy = normalizeFinancialYear(stamp);
    return asFy.ok ? asFy.value : null;
  });
  return periods.every((p): p is string => p !== null) ? periods : null;
}

/** A bare year span, `2023-24` or `2023/2024`, with what precedes it. */
const YEAR_SPAN = /(?<![\d./-])((?:19|20)\d{2}\s*[-/]\s*(?:\d{4}|\d{2}))(?![\d./-])/g;
const ASSESSMENT_BEFORE = /(?:assessment\s+year|a\.?\s*y\.?)\s*[:\-]?\s*$/i;

/**
 * The one period a document states, or null when it states none or more than one. Counted: the
 * periods it labels itself with (`For the year ended 31 March 2025`, `FY 2024-25`, a period
 * range), period column headings, and any financial-year span written out (`2023-24`, read as an
 * assessment year where it says so). A heading about a prior period with no figure on it
 * (`Previous year`, `Preceding financial year`) also counts as a second period, even with no year
 * printed. Point dates (a report or filing date) are not periods and are not counted.
 */
export function soleStatedPeriod(texts: Iterable<string>): string | null {
  const periods = new Set<string>();
  let priorPeriodHeading = false;
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    const own = documentPeriodIn(text);
    if (own) periods.add(own);
    for (const column of columnPeriodsIn(text) ?? []) periods.add(column);
    for (const match of text.matchAll(YEAR_SPAN)) {
      const before = text.slice(0, match.index ?? 0);
      const label = normalizeFinancialYear(`${ASSESSMENT_BEFORE.test(before) ? 'AY' : 'FY'} ${match[1]}`);
      if (label.ok) periods.add(label.value);
    }
    if (PRIOR_PERIOD.test(text) && !hasFigure(text)) priorPeriodHeading = true;
    if (periods.size > 1) return null;
  }
  return periods.size === 1 && !priorPeriodHeading ? [...periods][0] : null;
}

// ------------------------------------------------------------------ Value readers

const PAN_TOKEN = /\b([A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z])\b/;
const GSTIN_TOKEN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;

interface ReadValue {
  rawValue: string;
  enumValue?: string;
}

const ENTITY_PHRASES: ReadonlyArray<[string, RegExp]> = [
  ['llp', /\bllp\b|limited\s+liability\s+partnership/i],
  ['private_limited', /\bprivate\s+limited\b|\bpvt\.?\s*ltd\b|\bprivate\s+company\b/i],
  ['public_limited', /\bpublic\s+limited\b|\bpublic\s+company\b/i],
  ['partnership', /\bpartnership\b/i],
  ['proprietorship', /\bproprietor(?:ship)?\b|\bproprietary\s+concern\b/i],
  ['trust_society', /\btrust\b|\bsociety\b/i],
  ['individual', /\bindividual\b/i],
];

function readEntity(rest: string): ReadValue | null {
  const value = rest.replace(/^[\s:.\-–|]+/, '').trim();
  if (!value) return null;
  let found = ENTITY_PHRASES.filter(([, pattern]) => pattern.test(value)).map(([option]) => option);
  // An LLP names a partnership too; it is the more specific reading of the same words.
  if (found.includes('llp')) found = found.filter((option) => option !== 'partnership');
  return found.length === 1 ? { rawValue: value, enumValue: found[0] } : null;
}

/** Reads the value after the label. `rest` is the line after the label; `next` the following line. */
function readValue(kind: ValueKind, rest: string, next: string | undefined, labelText: string): ReadValue | null {
  const afterSeparator = rest.replace(/^[\s:.\-–|=]+/, '');
  switch (kind) {
    case 'pan': {
      const match = afterSeparator.match(PAN_TOKEN) ?? (afterSeparator.trim() === '' ? next?.trim().match(PAN_TOKEN) : null);
      return match ? { rawValue: match[1] } : null;
    }
    case 'gstin': {
      const match = afterSeparator.match(GSTIN_TOKEN);
      return match ? { rawValue: match[1] } : null;
    }
    case 'date': {
      const match = afterSeparator.match(new RegExp(`^(?:[A-Za-z ]{0,20}:\\s*)?(${DATE_TEXT})`, 'i'));
      return match ? { rawValue: match[1] } : null;
    }
    case 'fy': {
      const match = `${labelText}${rest}`.match(
        new RegExp(`((?:for\\s+the\\s+)?(?:financial\\s+)?year\\s+end(?:ed|ing)\\s*:?\\s*${DATE_TEXT}|(?:financial\\s+year|f\\.?\\s*y\\.?)\\s*:?\\s*(?:19|20)\\d{2}\\s*[-/]\\s*(?:\\d{4}|\\d{2}))(?!\\d)`, 'i')
      );
      return match && normalizeFinancialYear(match[1]).ok ? { rawValue: match[1].trim() } : null;
    }
    case 'text': {
      if (!/^\s*[:\-–|]/.test(rest)) return null; // a string needs `Label: value`, never prose
      // A name stops where the next printed label starts (`... Limited A.Y. 2025-26 PAN : ...`).
      const value = afterSeparator
        .split(/\s{2,}|\s\|\s/)[0]
        .replace(/\s+(?:(?:A\.?\s?Y|F\.?\s?Y)\.?(?=[\s:])|(?:PAN|GSTIN|CIN|TAN|DIN|Code)).*$/i, '')
        .trim();
      if (value.length < 3 || value.length > 120 || !/[A-Za-z]{2}/.test(value) || /^\d/.test(value)) return null;
      return { rawValue: value };
    }
    case 'entity':
      return /^\s*[:\-–|]/.test(rest) ? readEntity(afterSeparator) : null;
    case 'score': {
      const cleaned = afterSeparator.replace(/version\s*\d+(?:\.\d+)?/gi, ' ').replace(new RegExp(DATE_TEXT, 'gi'), ' ');
      const scores = [...cleaned.matchAll(/(?<![\d.,])([3-8]\d{2}|900)(?![\d.,])/g)].map((m) => m[1]);
      if (scores.length !== 1) return null;
      // Words between the label and the score are fine; another figure first is not.
      const before = cleaned.slice(0, cleaned.indexOf(scores[0]));
      return /\d/.test(before) ? null : { rawValue: scores[0] };
    }
    case 'rank': {
      const whole = `${labelText}${rest}`;
      const cmr = whole.match(/\bCMR\s*[-–:]?\s*(10|[1-9])(?!\d)/i);
      if (cmr) return { rawValue: cmr[0].replace(/[–]/g, '-').trim() };
      const plain = afterSeparator.match(/^(?:rank\s*:?\s*)?(10|[1-9])(?![\d.,])/i);
      return plain ? { rawValue: plain[1] } : null;
    }
    case 'months': {
      const match = afterSeparator.match(/^(?:[A-Za-z ]{0,15}:?\s*)?(\d{1,3}\s*(?:months?|mths?|years?|yrs?))\b/i);
      return match ? { rawValue: match[1] } : null;
    }
    case 'amount':
      return null; // handled with columns by the caller
  }
}

// ------------------------------------------------------------------ Field extraction (text)

interface Emitted {
  raw: RawField;
  key: string;
}

function fieldAllowed(fieldId: string, documentType: DocumentType, only?: readonly DocumentType[]): boolean {
  const definition = getFieldDefinition(fieldId);
  if (!definition || definition.extractionMode !== 'direct') return false;
  if (only && !only.includes(documentType)) return false;
  return definition.sourceDocumentTypes.includes(documentType);
}

function matchRule(line: string, documentType: DocumentType): { rule: FieldRule; labelEnd: number; labelText: string } | null {
  for (const candidate of RULES) {
    if (!fieldAllowed(candidate.fieldId, documentType, candidate.only)) continue;
    const match = line.match(candidate.label);
    if (!match) continue;
    if (candidate.exclude?.test(line)) continue;
    return { rule: candidate, labelEnd: match[0].length, labelText: match[0] };
  }
  return null;
}

/** Pairs the figures after a label with period columns, or returns null when the layout is unclear. */
function pairAmounts(
  amounts: string[],
  columns: readonly string[] | null,
  documentPeriod: string | null
): Array<{ rawValue: string; period: string | null }> | null {
  let figures = amounts;
  if (columns && figures.length === columns.length + 1 && BARE_SMALL_INTEGER.test(figures[0])) {
    figures = figures.slice(1); // a Schedule III note number
  }
  if (figures.length === 0) return null;
  if (columns && columns.length > 1) {
    return figures.length === columns.length ? figures.map((rawValue, i) => ({ rawValue, period: columns[i] })) : null;
  }
  if (figures.length !== 1) return null;
  return [{ rawValue: figures[0], period: columns?.[0] ?? documentPeriod }];
}

function plausibleAmount(rawValue: string): boolean {
  // A bare 1-2 digit figure with no currency mark is a note number or a count, not an amount.
  return !BARE_SMALL_INTEGER.test(rawValue.replace(/[()\s]/g, ''));
}

function extractFromText(
  documentType: DocumentType,
  pages: ReadonlyArray<readonly string[]>,
  confidence: number,
  complete = true,
  ocrPages: ReadonlySet<number> = new Set()
): Emitted[] {
  const out: Emitted[] = [];
  const lines = pages.flatMap((page, pageIndex) => page.map((text) => ({ text: clean(text), page: pageIndex + 1 })));
  // A figure with no period column of its own takes the document's period only when the document
  // states exactly one; otherwise its period is left unknown (period_unknown, never auto-applied).
  // With some pages read by OCR, the text pages must state that same one period themselves.
  let documentPeriod = complete ? soleStatedPeriod(lines.map((line) => line.text)) : null;
  if (documentPeriod !== null && ocrPages.size > 0) {
    const textOnly = soleStatedPeriod(lines.filter((line) => !ocrPages.has(line.page)).map((line) => line.text));
    if (textOnly !== documentPeriod) documentPeriod = null;
  }

  // Unit and period headings hold for their own page and section only: never carried to the next.
  let columns: string[] | null = null;
  let unit: { unit: AmountUnit; unitText: string } | null = null;
  let statePage = 0;
  lines.forEach(({ text, page }, index) => {
    if (page !== statePage || isSectionHeading(text)) {
      unit = null;
      columns = null;
      statePage = page;
    }
    // A bracketed unit on a row of figures, `Revenue (in lakhs)  1,250.00`, is that row's alone.
    const lineUnit = unitHeaderIn(text);
    if (lineUnit && !hasFigure(text)) unit = lineUnit;
    const rowUnit: { unit: AmountUnit; unitText: string } | null = lineUnit ?? unit;
    const heading = columnPeriodsIn(text);
    if (heading) {
      columns = heading;
      return;
    }
    const matched = matchRule(text, documentType);
    if (!matched) return;
    const { rule: found, labelEnd, labelText } = matched;
    const rest = text.slice(labelEnd);
    const base = {
      fieldId: found.fieldId,
      page,
      sheetName: null,
      cellRef: null,
      snippet: snip(text),
      confidence,
      subjectRef: null,
    };

    if (found.kind === 'amount') {
      const definition = getFieldDefinition(found.fieldId);
      const beforeFigure = blankOut(rest, STAMP).split(/\d/)[0] ?? '';
      if (beforeFigure.length > 60) return; // the figure is not beside its label
      const pairs = pairAmounts(amountsIn(rest), columns, documentPeriod);
      if (!pairs) return;
      for (const pair of pairs) {
        if (!plausibleAmount(pair.rawValue)) continue;
        if (found.fieldId === 'financialProfile.operatingCashFlow' && /used\s+in/i.test(text) && !/^\(|^-/.test(pair.rawValue)) {
          continue; // "used in" with an unsigned figure: the sign is not stated
        }
        out.push({
          key: `${found.fieldId}|${pair.period ?? ''}|${pair.rawValue}`,
          raw: {
            ...base,
            rawValue: pair.rawValue,
            enumValue: null,
            statedUnit: rowUnit?.unit ?? null,
            unitText: rowUnit?.unitText ?? null,
            period: definition?.periodScoped || definition?.annualFlow ? pair.period : null,
          },
        });
      }
      return;
    }

    const next = lines[index + 1]?.page === page ? lines[index + 1].text : undefined;
    const value = readValue(found.kind, rest, next, labelText);
    if (!value) return;
    const usedNext = found.kind === 'pan' && next !== undefined && !rest.match(PAN_TOKEN);
    out.push({
      key: `${found.fieldId}|${value.enumValue ?? value.rawValue}`,
      raw: {
        ...base,
        snippet: snip(usedNext ? `${text} ${next}` : text),
        rawValue: value.rawValue,
        enumValue: value.enumValue ?? null,
        statedUnit: null,
        unitText: null,
        period: null,
      },
    });
    // A CMR rank on the page is the positive evidence that a commercial report is available.
    if (found.kind === 'rank' && fieldAllowed('financialProfile.commercialCreditReportStatus', documentType)) {
      out.push({
        key: 'financialProfile.commercialCreditReportStatus|available',
        raw: {
          ...base,
          fieldId: 'financialProfile.commercialCreditReportStatus',
          rawValue: 'available',
          enumValue: 'available',
          statedUnit: null,
          unitText: null,
          period: null,
        },
      });
    }
  });
  return out;
}

// ------------------------------------------------------------------ Field extraction (sheets)

const NUMERIC_CELL = /^\(?\s*(?:(?:rs\.?|inr|₹)\s*)?-?\s*\d[\d,]*(?:\.\d+)?\s*\)?$/i;

function extractFromSheets(
  documentType: DocumentType,
  fileKind: 'xlsx' | 'csv',
  sheets: readonly ParsedSheet[],
  confidence: number
): Emitted[] {
  const out: Emitted[] = [];
  // As for text: the document's period only when it states exactly one.
  const documentPeriod = soleStatedPeriod(sheets.flatMap((sheet) => sheet.rows.flatMap((row) => row.cells.map((cell) => cell.text))));

  for (const sheet of sheets) {
    const columnPeriod = new Map<number, string>();
    let unit: { unit: AmountUnit; unitText: string } | null = null;
    for (const row of sheet.rows) {
      const labelCell = row.cells.find((cell) => /[A-Za-z]{2}/.test(cell.text));
      // A new statement in the same sheet: its own unit and period columns.
      if (labelCell && isSectionHeading(labelCell.text) && !row.cells.some((c) => NUMERIC_CELL.test(c.text.trim()))) {
        unit = null;
        columnPeriod.clear();
      }
      for (const cell of row.cells) unit = unitHeaderIn(cell.text) ?? unit;
      if (!labelCell) continue;
      const others = row.cells.filter((cell) => cell.column > labelCell.column);

      // A heading row: period labels over the value columns.
      const periods = others.map((cell) => ({ column: cell.column, period: columnPeriodsIn(`Particulars ${cell.text}`)?.[0] ?? null }));
      if (periods.length > 0 && periods.every((p) => p.period !== null) && !others.some((c) => NUMERIC_CELL.test(c.text))) {
        columnPeriod.clear();
        for (const p of periods) columnPeriod.set(p.column, p.period as string);
        continue;
      }

      const matched = matchRule(labelCell.text, documentType);
      if (!matched) continue;
      const { rule: found } = matched;
      const definition = getFieldDefinition(found.fieldId);
      const header = (column: number) => columnPeriod.get(column) ?? null;
      const base = { fieldId: found.fieldId, page: null, sheetName: fileKind === 'xlsx' ? sheet.name : null, confidence, subjectRef: null };

      if (found.kind !== 'amount') {
        // `Label | value` in two cells, or `Label: value` in one.
        const valueCell = others[0];
        const labelText = matched.labelText;
        const rest = valueCell ? `: ${valueCell.text}` : labelCell.text.slice(labelText.length);
        const value = readValue(found.kind, rest, undefined, labelText);
        if (!value) continue;
        const cited = valueCell && valueCell.text.includes(value.rawValue) ? valueCell : labelCell;
        out.push({
          key: `${found.fieldId}|${value.enumValue ?? value.rawValue}`,
          raw: {
            ...base,
            cellRef: cited.ref,
            snippet: snip(cited === labelCell ? labelCell.text : `${labelCell.text} | ${cited.text}`),
            rawValue: value.rawValue,
            enumValue: value.enumValue ?? null,
            statedUnit: null,
            unitText: null,
            period: null,
          },
        });
        continue;
      }

      const figures = others.filter((cell) => NUMERIC_CELL.test(cell.text.trim()));
      if (figures.length === 0) continue;
      const known = figures.filter((cell) => header(cell.column) !== null);
      let picked: Array<{ cell: (typeof figures)[number]; period: string | null }>;
      if (known.length === figures.length) picked = figures.map((cell) => ({ cell, period: header(cell.column) }));
      else if (figures.length === 1 && columnPeriod.size <= 1) picked = [{ cell: figures[0], period: [...columnPeriod.values()][0] ?? documentPeriod }];
      else continue; // figures with no heading: the period is not stated
      for (const { cell, period } of picked) {
        const heading = period ? ` | ${period}` : '';
        out.push({
          key: `${found.fieldId}|${period ?? ''}|${cell.text}`,
          raw: {
            ...base,
            cellRef: cell.ref,
            snippet: snip(`${labelCell.text}${heading} | ${cell.text}`),
            rawValue: cell.text.trim(),
            enumValue: null,
            statedUnit: unit?.unit ?? null,
            unitText: unit?.unitText ?? null,
            period: definition?.periodScoped || definition?.annualFlow ? period : null,
          },
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ Bank statement months

/** `Apr-2025`, `April 2025`, `Apr'25`, `04/2025`, `2025-04` at the start of a row, as YYYY-MM. */
export function readMonth(text: string): string | null {
  const t = clean(text);
  const named = t.match(new RegExp(`^(${MONTH_WORD})\\.?[\\s'’-]*((?:19|20)?\\d{2})(?![\\d/.-])`, 'i'));
  if (named) {
    const month = MONTHS[named[1].slice(0, named[1].toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()];
    const year = named[2].length === 2 ? 2000 + Number(named[2]) : Number(named[2]);
    return month ? `${year}-${String(month).padStart(2, '0')}` : null;
  }
  const numeric = t.match(/^(0?[1-9]|1[0-2])[/-]((?:19|20)\d{2})(?![\d/.-])/);
  if (numeric) return `${numeric[2]}-${numeric[1].padStart(2, '0')}`;
  const iso = t.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])(?![\d-])/);
  return iso ? `${iso[1]}-${iso[2]}` : null;
}

type BankColumn = 'credits' | 'debits' | 'closing' | 'other';

/** Column kinds of a monthly summary heading, in order, after the Month column. */
function bankSummaryColumns(text: string): BankColumn[] | null {
  const t = clean(text).toLowerCase();
  if (!/^month\b|\bmonth\b/.test(t)) return null;
  const after = t.slice(t.indexOf('month') + 5);
  const kinds: BankColumn[] = [];
  const pattern = /no\.?\s*of\s+\w+|count|(?:total\s+)?(?:credits?|deposits?)(?:\s+amount)?|(?:total\s+)?(?:debits?|withdrawals?)(?:\s+amount)?|(?:closing|month[\s-]*end|eod)\s+balance|(?:avg\.?|average|opening|minimum|min\.?|maximum|max\.?)\s+balance|balance/g;
  for (const match of after.matchAll(pattern)) {
    const word = match[0];
    if (/no\.?\s*of|count/.test(word)) kinds.push('other');
    else if (/credit|deposit/.test(word)) kinds.push('credits');
    else if (/debit|withdrawal/.test(word)) kinds.push('debits');
    else if (/closing|month[\s-]*end|eod/.test(word)) kinds.push('closing');
    else kinds.push('other'); // average, opening or a bare "balance": not a closing balance
  }
  return kinds.includes('credits') || kinds.includes('closing') ? kinds : null;
}

const ACCOUNT_NUMBER = /(?:a\/c|account)\s*(?:no\.?|number|#)\s*[:.-]?\s*([X*x\d][X*x\d\s-]{3,24}\d)/i;
const STATEMENT_PERIOD = new RegExp(
  `(?:statement\\s+(?:period|from|for\\s+the\\s+period)|period(?:\\s+of\\s+statement)?|from)\\s*:?\\s*(${DATE_TEXT})\\s*(?:to|-|–|till)\\s*(${DATE_TEXT})`,
  'i'
);

function bankRow(
  month: string,
  credits: string | null,
  closing: string | null,
  location: { page: number | null; sheetName: string | null; cellRef: string | null; snippet: string },
  confidence: number,
  subjectRef: string | null
): RawBankMonth {
  return { ...location, month, totalCredits: credits, closingBalance: closing, statedUnit: null, unitText: null, confidence, subjectRef };
}

function bankMonthsFromText(pages: ReadonlyArray<readonly string[]>, confidence: number, complete = true): RawBankMonth[] {
  // Statements that list their transactions: every row proved by the running balance. One that did
  // not reconcile falls through to a printed summary, which can be checked against the source.
  const read = bankMonthsFromStatement(pages, confidence, complete);
  if (read.months.length > 0 && (read.statement.reconciled || read.statement.truncated)) return read.months;
  const lines = pages.flatMap((page, pageIndex) => page.map((text) => ({ text: clean(text), page: pageIndex + 1 })));
  const subjectRef = lines.map((l) => l.text.match(ACCOUNT_NUMBER)?.[1] ?? null).find(Boolean) ?? null;
  const rows = new Map<string, RawBankMonth>();

  // A monthly summary table printed in the statement.
  let columns: BankColumn[] | null = null;
  for (const { text, page } of lines) {
    const heading = bankSummaryColumns(text);
    if (heading) {
      columns = heading;
      continue;
    }
    if (!columns) continue;
    const month = readMonth(text);
    if (!month) continue;
    const figures = amountsIn(text.replace(/^\S+(?:\s+(?:19|20)?\d{2}(?![\d,.]))?/, (m) => ' '.repeat(m.length)));
    if (figures.length !== columns.length) continue; // the row does not fit the heading
    const credits = columns.indexOf('credits');
    const closing = columns.indexOf('closing');
    if (rows.has(month)) {
      rows.delete(month); // the same month twice: neither is trusted
      continue;
    }
    rows.set(
      month,
      bankRow(
        month,
        credits >= 0 ? figures[credits] : null,
        closing >= 0 ? figures[closing] : null,
        { page, sheetName: null, cellRef: null, snippet: snip(text) },
        confidence,
        subjectRef
      )
    );
  }
  if (rows.size > 0) return [...rows.values()];

  // A statement of one calendar month that prints its own totals.
  const period = lines.map((l) => ({ match: l.text.match(STATEMENT_PERIOD), page: l.page })).find((p) => p.match);
  if (!period?.match) return [];
  const from = parseDate(period.match[1], { today: '9999-12-31' });
  const to = parseDate(period.match[2], { today: '9999-12-31' });
  if (!from.ok || !to.ok || from.value.slice(0, 7) !== to.value.slice(0, 7)) return [];
  const single = (label: RegExp) => {
    const found = lines
      .filter((l) => label.test(l.text))
      .map((l) => ({ ...l, figures: amountsIn(l.text.replace(label, ' ')) }))
      .filter((l) => l.figures.length === 1);
    const values = new Set(found.map((l) => l.figures[0]));
    return values.size === 1 ? { line: found[0], value: found[0].figures[0] } : null;
  };
  const credits = single(/^(?:total\s+(?:credits?|deposits?)(?:\s+amount)?|credits?\s+total)\b\s*:?/i);
  const closing = single(/^closing\s+balance\b\s*:?/i);
  if (!credits && !closing) return [];
  const used = [credits?.line, closing?.line].filter((l): l is NonNullable<typeof l> => Boolean(l));
  return [
    bankRow(
      from.value.slice(0, 7),
      credits?.value ?? null,
      closing?.value ?? null,
      { page: used[0].page, sheetName: null, cellRef: null, snippet: snip(used.map((l) => l.text).join(' | ')) },
      confidence,
      subjectRef
    ),
  ];
}

function bankMonthsFromSheets(fileKind: 'xlsx' | 'csv', sheets: readonly ParsedSheet[], confidence: number): RawBankMonth[] {
  const rows = new Map<string, RawBankMonth>();
  for (const sheet of sheets) {
    let monthColumn = -1;
    let creditsColumn = -1;
    let closingColumn = -1;
    let subjectRef: string | null = null;
    for (const row of sheet.rows) {
      subjectRef = row.cells.map((cell) => cell.text).join(' ').match(ACCOUNT_NUMBER)?.[1] ?? subjectRef;
      const month = row.cells.find((cell) => /^month$/i.test(cell.text.trim()));
      if (month) {
        monthColumn = month.column;
        creditsColumn = row.cells.find((c) => /^(?:total\s+)?(?:credits?|deposits?)(?:\s+amount)?$/i.test(c.text.trim()))?.column ?? -1;
        closingColumn = row.cells.find((c) => /^(?:closing|month[\s-]*end|eod)\s+balance$/i.test(c.text.trim()))?.column ?? -1;
        continue;
      }
      if (monthColumn < 0 || (creditsColumn < 0 && closingColumn < 0)) continue;
      const monthCell = row.cells.find((cell) => cell.column === monthColumn);
      const key = monthCell ? readMonth(monthCell.text) : null;
      if (!key) continue;
      const at = (column: number) => {
        const cell = row.cells.find((c) => c.column === column);
        return cell && NUMERIC_CELL.test(cell.text.trim().replace(/\s*(?:cr|dr)\.?$/i, '')) ? cell : null;
      };
      const credits = creditsColumn >= 0 ? at(creditsColumn) : null;
      const closing = closingColumn >= 0 ? at(closingColumn) : null;
      if (!credits && !closing) continue;
      if (rows.has(key)) {
        rows.delete(key);
        continue;
      }
      rows.set(
        key,
        bankRow(
          key,
          credits?.text.trim() ?? null,
          closing?.text.trim() ?? null,
          {
            page: null,
            sheetName: fileKind === 'xlsx' ? sheet.name : null,
            cellRef: (credits ?? closing)?.ref ?? null,
            snippet: snip(row.cells.map((c) => c.text).join(' | ')),
          },
          confidence,
          subjectRef
        )
      );
    }
  }
  return [...rows.values()];
}

/** Fields the statement reader must find before it replaces the generic scan. */
const STATEMENT_MIN_FIELDS = 6;

// ------------------------------------------------------------------ Entry point

/** Labelled values from the document's own text. Returns nothing for a field it cannot read for certain. */
export function extractLocally(input: LocalExtractionInput): LocalExtraction {
  const { documentType, content, fromOcr, complete = true, ocrPages } = input;
  if (documentType === 'other') return { fields: [], bankMonthlyTotals: [] };
  const confidence = fromOcr ? LOCAL_OCR_CONFIDENCE : LOCAL_TEXT_CONFIDENCE;
  const emitted =
    content.kind === 'text'
      ? extractFromText(documentType, content.pages, confidence, complete, ocrPages)
      : extractFromSheets(documentType, content.fileKind, content.sheets, confidence);

  // A GSTR-3B is read by its own fixed layout: its legal name and its Table 3.1 period.
  const gstr3b =
    documentType === 'gst_return' && content.kind === 'text' ? readGstr3b(content.pages, confidence) : null;
  const generic = emitted.map((e) => e.raw);
  const itrAck =
    documentType === 'itr' && content.kind === 'text' ? readItrAcknowledgement(content.pages, confidence) : null;
  // A lender / EMI table or a sanction letter: totals computed from its rows, proved by the rows themselves.
  const debt =
    documentType !== 'existing_sanction_letter'
      ? []
      : content.kind === 'sheets'
        ? readObligationSheet(content.sheets, confidence)
        : readSanctionLetter(content.pages, confidence);
  // The app's own intake profile (the form printed as label / value rows).
  const profile = documentType === 'loan_application' && content.kind === 'text' ? readProfileForm(content.pages, confidence) : [];
  const profileIds = new Set(profile.map((field) => field.fieldId));
  const identity = content.kind === 'text' ? readCompanyIdentity(content.pages, confidence) : [];
  const credit = documentType === 'credit_report' && content.kind === 'text' ? readCreditReport(content.pages, confidence) : null;
  // A balance sheet / P&L in Schedule III form: read by line name and year column, with unit and totals checked.
  const read =
    documentType === 'financial_statement' && content.kind === 'text' ? readFinancialStatements(content.pages, confidence) : [];
  // A real statement gives many fields at once; a stray figure or two is left to the generic line scan.
  const statements = read.length >= STATEMENT_MIN_FIELDS ? read : [];
  const statementIds = new Set(statements.map((field) => field.fieldId));
  // The statement reader's fields are kept whole: they replace the generic scan's, never merge into them.
  const own = [...(gstr3b?.fields ?? []), ...(itrAck ?? []), ...debt, ...(credit?.fields ?? []), ...identity]
    .filter((field) => !generic.some((g) => g.fieldId === field.fieldId && g.rawValue === field.rawValue))
    .concat(statements)
    .concat(profile);
  const seen = new Set<string>();
  const fields = [
    // Where the dedicated reader found a field, its period-tagged values replace the generic line scan's.
    ...emitted.filter((e) => !statementIds.has(e.raw.fieldId) && !profileIds.has(e.raw.fieldId) && !seen.has(e.key) && seen.add(e.key)).map((e) => e.raw),
    ...own.filter((field) => fieldAllowed(field.fieldId, documentType)),
  ];
  const bankMonthlyTotals =
    documentType !== 'bank_statement'
      ? []
      : content.kind === 'text'
        ? bankMonthsFromText(content.pages, confidence, complete)
        : bankMonthsFromSheets(content.fileKind, content.sheets, confidence);
  const recognisedForm = gstr3b?.period ? 'gstr3b' : itrAck ? 'itr_acknowledgement' : undefined;
  return {
    fields,
    bankMonthlyTotals,
    gstReturnPeriods: gstr3b?.period ? [gstr3b.period] : [],
    ...(recognisedForm ? { recognisedForm } : {}),
  };
}

/** Field IDs the local pass found a value for. */
export function locallyFoundFieldIds(local: LocalExtraction): Set<string> {
  return new Set(local.fields.map((field) => field.fieldId));
}
