/**
 * Server-computed values (docs/contracts.md section 4.5). Pure. Each uses stated inputs only, and
 * yields nothing rather than a guess when its inputs are missing or disagree.
 * The GST mapping keeps its source status, so it is a mirror step in merge.ts, not a rule here.
 */
import { getFieldDefinition } from '../../src/documentAi/fieldMap.ts';
import type {
  BankMonthlyTotal,
  DerivationRuleId,
  DocumentExtractionSuccess,
  ExtractedField,
  FieldValue,
  GstReturnPeriodTotal,
  SourceCheck,
  SourceRef,
} from '../../src/types/documentAi.ts';
import {
  currencyEqual,
  isFinancialYearLabel,
  normalizeComparableString,
  periodEndDate,
  previousFinancialYear,
} from './validators.ts';

const isEligible = (candidate: ExtractedField) => candidate.status !== 'rejected_validation';

/** An input a derived value may rest on: it carries no doubt of its own (a prior-year copy is fine). */
const isSoundInput = (candidate: ExtractedField) =>
  candidate.sourceCheck !== 'failed' &&
  candidate.reasons.every((reason) => reason === 'superseded_period' || reason === 'low_confidence') &&
  candidate.confidence >= 0.7;

interface DerivedInput {
  fieldId: string;
  ruleId: DerivationRuleId;
  value: FieldValue;
  fromCandidateIds: string[];
  confidence: number;
  source: SourceRef;
  period: string | null;
  subjectRef?: string | null;
  discriminator?: number;
  /** Merge caps on this, so an input that could not be checked stays visible on the result. */
  sourceCheck?: SourceCheck;
}

function derivedCandidate(input: DerivedInput): ExtractedField {
  return {
    candidateId: `${input.source.documentId}:${input.fieldId}:d${input.discriminator ?? 0}`,
    fieldId: input.fieldId,
    value: input.value,
    rawValue: String(input.value),
    confidence: input.confidence,
    source: input.source,
    status: 'needs_verification',
    reasons: ['derived_value'],
    period: input.period,
    subjectRef: input.subjectRef ?? null,
    derivation: { ruleId: input.ruleId, fromCandidateIds: input.fromCandidateIds },
    ...(input.sourceCheck ? { sourceCheck: input.sourceCheck } : {}),
  };
}

function ofField(candidates: ExtractedField[], fieldId: string): ExtractedField[] {
  return candidates.filter((candidate) => candidate.fieldId === fieldId && isEligible(candidate));
}

/** Full years, rounded down to the nearest 0.5. Null if the date is after today. */
export function vintageYears(establishedOn: string, today: string): number | null {
  const [fromYear, fromMonth, fromDay] = establishedOn.split('-').map(Number);
  const [toYear, toMonth, toDay] = today.split('-').map(Number);
  let months = (toYear - fromYear) * 12 + (toMonth - fromMonth);
  if (toDay < fromDay) months -= 1;
  return months < 0 ? null : Math.floor(months / 6) * 0.5;
}

function deriveVintage(candidates: ExtractedField[], today: string): ExtractedField[] {
  const fieldId = 'businessVintageYears';
  if (ofField(candidates, fieldId).length > 0) return [];
  const dates = ofField(candidates, 'identity.dateOfEstablishment').filter(isSoundInput);
  if (dates.length === 0 || new Set(dates.map((date) => date.value)).size > 1) return [];
  const years = vintageYears(String(dates[0].value), today);
  if (years === null) return [];
  return [
    derivedCandidate({
      fieldId,
      ruleId: 'vintage_from_establishment_date',
      value: years,
      fromCandidateIds: dates.map((date) => date.candidateId),
      confidence: Math.min(...dates.map((date) => date.confidence)),
      source: dates[0].source,
      period: null,
    }),
  ];
}

/** The one PAT stated for a period. Null when candidates disagree: that is a conflict, not an input. */
function agreedAmount(group: ExtractedField[]): number | null {
  const values = group.map((candidate) => candidate.value as number);
  return values.every((value) => currencyEqual(value, values[0])) ? values[0] : null;
}

function deriveProfitability(candidates: ExtractedField[]): ExtractedField[] {
  const pats = ofField(candidates, 'financialProfile.netProfitAfterTax').filter(
    (candidate) =>
      typeof candidate.value === 'number' &&
      isFinancialYearLabel(candidate.period) &&
      !candidate.reasons.includes('part_year_period')
  );
  if (pats.length === 0) return [];

  const latestPeriod = pats.reduce((latest, candidate) =>
    (periodEndDate(candidate.period) ?? '') > (periodEndDate(latest.period) ?? '') ? candidate : latest
  ).period;
  const latestGroup = pats.filter((candidate) => candidate.period === latestPeriod);
  const latest = agreedAmount(latestGroup);
  if (latest === null) return [];

  const priorPeriod = previousFinancialYear(latestPeriod);
  const priorGroup = pats.filter((candidate) => candidate.period === priorPeriod);
  const prior = priorGroup.length > 0 ? agreedAmount(priorGroup) : null;
  if (latest > 0 && priorGroup.length > 0 && prior === null) return [];

  let value: string;
  if (latest < 0) value = 'loss_making';
  else if (latest === 0) value = 'breakeven_or_early';
  else value = prior !== null && prior > 0 ? 'profitable_2plus_years' : 'profitable_1_year';

  const inputs = latest > 0 ? [...latestGroup, ...priorGroup] : latestGroup;
  // A doubtful input (not found in the text, wrong source...) means the derived value would rest on a doubt.
  if (inputs.some((input) => !isSoundInput(input) && !input.reasons.includes('superseded_period'))) return [];
  // A positive figure beside loss wording may really be a loss, so it decides nothing.
  if (inputs.some((input) => input.reasons.includes('loss_wording'))) return [];
  return [
    derivedCandidate({
      fieldId: 'profitabilityStatus',
      ruleId: 'profitability_from_pat',
      value,
      fromCandidateIds: inputs.map((input) => input.candidateId),
      // The candidates of one year agree (agreedAmount), so a year is as sure as its surest reading.
      confidence: Math.min(
        Math.max(...latestGroup.map((input) => input.confidence)),
        ...(latest > 0 && priorGroup.length > 0 ? [Math.max(...priorGroup.map((input) => input.confidence))] : [])
      ),
      source: latestGroup[0].source,
      period: latestPeriod,
    }),
  ];
}

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

interface BankMetric {
  fieldId: string;
  read: (row: BankMonthlyTotal) => number | null;
}

const BANK_METRICS: readonly BankMetric[] = [
  { fieldId: 'financialProfile.averageMonthlyBankingCredits', read: (row) => row.totalCredits },
  { fieldId: 'financialProfile.averageMonthlyBankingBalance', read: (row) => row.closingBalance },
];

/** Latest months an average is taken over. */
const BANK_AVERAGE_MONTHS = 12;
/** A statement fragment reaching within this many days of a month's ends counts as touching them (no transactions on a holiday). */
const MONTH_EDGE_DAYS = 3;
const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/**
 * One account's figure for one month, or null when no complete, agreeing figure exists. A capped
 * (partial) statement is never used. A statement covering the whole month stands alone; fragments
 * (an SBI month downloaded in two halves) count only when they run on from each other and together
 * span the month. Whole-month statements and fragment sets must agree, or the month is dropped.
 */
function monthFigure(
  rows: BankMonthlyTotal[],
  month: string,
  read: (row: BankMonthlyTotal) => number | null,
  combine: 'sum' | 'last' = 'sum'
): { amount: number; rows: BankMonthlyTotal[] } | 'contradictory' | null {
  const first = dayNumber(`${month}-01`);
  const last = dayNumber(lastDayOfMonth(month));
  const usable = rows.filter((row) => !row.partial);
  const spans = (row: BankMonthlyTotal) => (row.coverFrom && row.coverTo ? [dayNumber(row.coverFrom), dayNumber(row.coverTo)] : null);
  const whole = usable.filter((row) => {
    const span = spans(row);
    return !span || (span[0] <= first + MONTH_EDGE_DAYS && span[1] >= last - MONTH_EDGE_DAYS);
  });
  const options: Array<{ amount: number; rows: BankMonthlyTotal[] }> = [];
  for (const row of whole) {
    const amount = read(row);
    if (amount !== null) options.push({ amount, rows: [row] });
  }
  const pieces = usable
    .filter((row) => !whole.includes(row) && spans(row))
    .sort((a, b) => (spans(a)![0] - spans(b)![0]));
  if (pieces.length >= 2) {
    let reach = first - 1;
    let ok = true;
    for (const piece of pieces) {
      const [from, to] = spans(piece)!;
      // Fragments must run on from each other: a gap loses days, an overlap would count them twice.
      if (reach === first - 1 ? from > first + MONTH_EDGE_DAYS : from !== reach + 1) ok = false;
      reach = Math.max(reach, to);
    }
    const amounts = pieces.map(read);
    if (ok && reach >= last - MONTH_EDGE_DAYS && amounts.every((a): a is number => a !== null)) {
      options.push({ amount: combine === 'sum' ? amounts.reduce((sum, a) => sum + a, 0) : amounts[amounts.length - 1], rows: pieces });
    }
  }
  if (options.length === 0) return null;
  if (options.some((option) => !currencyEqual(option.amount, options[0].amount))) return 'contradictory';
  return options[0];
}

function deriveBankAverage(
  metric: BankMetric,
  candidates: ExtractedField[],
  rows: BankMonthlyTotal[]
): ExtractedField[] {
  if (ofField(candidates, metric.fieldId).length > 0) return [];
  const definition = getFieldDefinition(metric.fieldId);

  const bySubject = new Map<string, BankMonthlyTotal[]>();
  for (const row of rows) {
    const key = row.subjectRef ? normalizeComparableString(row.subjectRef) : '';
    bySubject.set(key, [...(bySubject.get(key) ?? []), row]);
  }

  // Each account's complete months.
  const accounts: Array<Map<string, { amount: number; rows: BankMonthlyTotal[] }>> = [];
  for (const subjectRows of bySubject.values()) {
    const months = new Map<string, { amount: number; rows: BankMonthlyTotal[] }>();
    for (const month of new Set(subjectRows.map((row) => row.month))) {
      const figure = monthFigure(subjectRows.filter((row) => row.month === month), month, metric.read, metric.fieldId.endsWith('Balance') ? 'last' : 'sum');
      if (figure === 'contradictory' || figure === null) continue;
      if (figure.amount < 0 && definition?.signPolicy !== 'signed') continue;
      months.set(month, figure);
    }
    if (months.size > 0) accounts.push(months);
  }
  if (accounts.length === 0) return [];

  // Several accounts: the borrower's turnover is what passes through all of them, so only months
  // every account has are used, and the accounts' figures for a month are added.
  const common = [...accounts[0].keys()].filter((month) => accounts.every((account) => account.has(month))).sort();
  const chosen = common.slice(-BANK_AVERAGE_MONTHS);
  if (chosen.length < 3) return [];
  const monthly = chosen.map((month) => accounts.reduce((sum, account) => sum + account.get(month)!.amount, 0));
  const mean = monthly.reduce((sum, amount) => sum + amount, 0) / monthly.length;
  const usedRows = chosen.flatMap((month) => accounts.flatMap((account) => account.get(month)!.rows));
  const lastRow = accounts[0].get(chosen[chosen.length - 1])!.rows[0];
  const note =
    accounts.length > 1
      ? `Average of the combined monthly ${metric.fieldId.endsWith('Credits') ? 'credits' : 'closing balances'} of ${accounts.length} accounts over ${chosen.length} months (${chosen[0]} to ${chosen[chosen.length - 1]}). Includes any transfers between the borrower's own accounts: review before relying on it.`
      : `Average of ${chosen.length} complete months (${chosen[0]} to ${chosen[chosen.length - 1]}) from the bank statement.`;
  return [
    derivedCandidate({
      fieldId: metric.fieldId,
      ruleId: 'average_monthly_from_bank_table',
      value: Math.round(mean),
      fromCandidateIds: usedRows.map((row) => `${row.source.documentId}:bank:${row.month}`),
      // Several accounts add transfers between them: kept below auto-apply so a person looks at it.
      confidence: accounts.length > 1 ? Math.min(0.8, ...usedRows.map((row) => row.confidence)) : Math.min(...usedRows.map((row) => row.confidence)),
      source: { ...lastRow.source, snippet: note.slice(0, 300) },
      period: lastDayOfMonth(chosen[chosen.length - 1]),
      subjectRef: accounts.length > 1 ? null : lastRow.subjectRef,
      discriminator: 0,
      sourceCheck: usedRows.some((row) => row.sourceCheck === 'failed') ? 'failed' : undefined,
    }),
  ];
}

// ------------------------------------------------------------------ GSTR-3B months

const GST_ANNUAL = 'financialProfile.gstAnnualTurnover';
const GST_SUMMARY = 'gst.monthlyOutwardSupplies';
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTH = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const SUMMARY_MAX = 500;
const SNIPPET_MAX = 300;

/** Rupees to whole paise, so sums are exact. */
const toPaise = (rupees: number) => Math.round(rupees * 100);

/** The counted turnover of one return: Table 3.1 (a) + (b) + (c), in paise. (d) and (e) are never counted. */
function returnTurnoverPaise(period: GstReturnPeriodTotal): number {
  return toPaise(period.outwardTaxable) + toPaise(period.zeroRated) + toPaise(period.nilExempt);
}

/** 12345678 paise as `1,23,456.78`, Indian grouping. */
export function formatInrPaise(paise: number): string {
  const whole = Math.abs(paise);
  const digits = String(Math.floor(whole / 100));
  const last3 = digits.slice(-3);
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${paise < 0 ? '-' : ''}${head ? `${head},${last3}` : last3}.${String(whole % 100).padStart(2, '0')}`;
}

const monthIndex = (month: string) => Number(month.slice(5, 7)) - 1;
const shortMonth = (month: string) => `${SHORT_MONTH[monthIndex(month)]} ${month.slice(0, 4)}`;
const longMonth = (month: string) => `${LONG_MONTH[monthIndex(month)]} ${month.slice(0, 4)}`;
const periodLabel = (months: string[]) =>
  months.length === 1 ? shortMonth(months[0]) : `${SHORT_MONTH[monthIndex(months[0])]}-${shortMonth(months[months.length - 1])}`;

/** The twelve YYYY-MM months of `FY 2025-26`, April to March. */
function fyMonths(financialYear: string): string[] {
  const start = Number(financialYear.slice(3, 7));
  return Array.from({ length: 12 }, (_, i) => {
    const n = ((i + 3) % 12) + 1;
    return `${n >= 4 ? start : start + 1}-${String(n).padStart(2, '0')}`;
  });
}

/** Two readings of the same return (the same file uploaded twice under two names) are one return. */
function sameReturn(a: GstReturnPeriodTotal, b: GstReturnPeriodTotal): boolean {
  return (
    a.months.join() === b.months.join() &&
    toPaise(a.outwardTaxable) === toPaise(b.outwardTaxable) &&
    toPaise(a.zeroRated) === toPaise(b.zeroRated) &&
    toPaise(a.nilExempt) === toPaise(b.nilExempt)
  );
}

const maskGstin = (gstin: string) => `GSTIN XXXX${gstin.slice(-4)}`;

/**
 * GSTR-3B returns, per GSTIN and financial year. Never adds up across GSTINs, and never a part year:
 * - every FY with any month read gets a review-only summary naming the months read, the missing
 *   months, and any month two returns disagree about;
 * - only when all 12 months of the FY are covered, each by exactly one return (two copies of the same
 *   return count once; a different return for a month already covered is a conflict), is the sum of
 *   (a)+(b)+(c) offered as gstAnnualTurnover. It is always derived_value, never auto-applied, and a
 *   GST turnover stated directly for that FY wins.
 */
function deriveGstFromReturns(candidates: ExtractedField[], periods: GstReturnPeriodTotal[]): ExtractedField[] {
  if (periods.length === 0) return [];
  const direct = ofField(candidates, GST_ANNUAL).filter((candidate) => candidate.derivation === undefined);
  const groups = new Map<string, GstReturnPeriodTotal[]>();
  for (const period of periods) {
    const key = `${period.gstin ?? ''}|${period.financialYear}`;
    groups.set(key, [...(groups.get(key) ?? []), period]);
  }
  const gstins = new Set(periods.map((period) => period.gstin ?? ''));
  const derived: ExtractedField[] = [];
  let discriminator = 0;

  for (const group of groups.values()) {
    const { financialYear, gstin } = group[0];
    const distinct: GstReturnPeriodTotal[] = [];
    for (const period of group) if (!distinct.some((kept) => sameReturn(kept, period))) distinct.push(period);

    const coveredBy = new Map<string, GstReturnPeriodTotal[]>();
    for (const period of distinct) {
      for (const month of period.months) coveredBy.set(month, [...(coveredBy.get(month) ?? []), period]);
    }
    const all = fyMonths(financialYear);
    const missing = all.filter((month) => !coveredBy.has(month));
    const disputed = all.filter((month) => (coveredBy.get(month)?.length ?? 0) > 1);
    const ordered = [...distinct].sort((a, b) => a.months[0].localeCompare(b.months[0]));
    const latest = ordered[ordered.length - 1];
    const lastMonth = [...coveredBy.keys()].sort().pop() as string;
    const subjectRef = gstin ? maskGstin(gstin) : null;
    const fromCandidateIds = ordered.map((p) => `${p.source.documentId}:gst:${p.months.join('+')}`);
    const confidence = Math.min(...ordered.map((p) => p.confidence));
    const complete = missing.length === 0 && disputed.length === 0;

    const whose = gstins.size > 1 && gstin ? ` (${maskGstin(gstin)})` : '';
    const status = complete
      ? 'all 12 months read; their total is offered as GST Annual Turnover for review.'
      : `${all.length - missing.length} of 12 months read, so nothing is added up.` +
        (missing.length > 0 ? ` Missing: ${missing.map(longMonth).join(', ')}.` : '') +
        (disputed.length > 0 ? ` Returns disagree for: ${disputed.map(longMonth).join(', ')}.` : '');
    let text = `${financialYear}${whose}: ${status} Read:`;
    for (const period of ordered) {
      const item = ` ${periodLabel(period.months)} ${formatInrPaise(returnTurnoverPaise(period))};`;
      if (text.length + item.length > SUMMARY_MAX - 2) {
        text += ' …';
        break;
      }
      text += item;
    }
    derived.push(
      derivedCandidate({
        fieldId: GST_SUMMARY,
        ruleId: 'gst_monthly_returns_summary',
        value: text.replace(/;$/, '.'),
        fromCandidateIds,
        confidence,
        source: {
          ...latest.source,
          snippet:
            'Each amount: GSTR-3B Table 3.1 total taxable value of (a) outward taxable + (b) zero rated + (c) nil rated and exempted, as printed. Excluded: (d) inward supplies on reverse charge, (e) non-GST supplies.'.slice(
              0,
              SNIPPET_MAX
            ),
        },
        period: lastDayOfMonth(lastMonth),
        subjectRef,
        discriminator: discriminator++,
      })
    );

    if (!complete || direct.some((candidate) => candidate.period === financialYear)) continue;
    const totalPaise = ordered.reduce((sum, period) => sum + returnTurnoverPaise(period), 0);
    const listed = ordered.map((p) => periodLabel(p.months)).join(', ');
    derived.push(
      derivedCandidate({
        fieldId: GST_ANNUAL,
        ruleId: 'annual_from_gst_monthly_returns',
        value: totalPaise / 100,
        fromCandidateIds,
        confidence,
        source: {
          ...latest.source,
          snippet: `Sum of GSTR-3B Table 3.1 (a)+(b)+(c) total taxable value for ${financialYear} from ${ordered.length} returns: ${listed}. Excludes (d) reverse charge and (e) non-GST.`.slice(
            0,
            SNIPPET_MAX
          ),
        },
        period: financialYear,
        subjectRef,
        discriminator: discriminator++,
      })
    );
  }
  return derived;
}

/** `candidates` are settled and merged across the session. A direct candidate always wins. */
export function deriveCandidates(
  candidates: ExtractedField[],
  documents: DocumentExtractionSuccess[],
  today: string
): ExtractedField[] {
  const rows = documents.flatMap((document) => document.bankMonthlyTotals);
  const gstPeriods = documents.flatMap((document) => document.gstReturnPeriods ?? []);
  return [
    ...deriveGstFromReturns(candidates, gstPeriods),
    ...deriveVintage(candidates, today),
    ...deriveProfitability(candidates),
    ...BANK_METRICS.flatMap((metric) => deriveBankAverage(metric, candidates, rows)),
  ];
}
