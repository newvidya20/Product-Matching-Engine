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
  const dates = ofField(candidates, 'identity.dateOfEstablishment');
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
  // A positive figure beside loss wording may really be a loss, so it decides nothing.
  if (inputs.some((input) => input.reasons.includes('loss_wording'))) return [];
  return [
    derivedCandidate({
      fieldId: 'profitabilityStatus',
      ruleId: 'profitability_from_pat',
      value,
      fromCandidateIds: inputs.map((input) => input.candidateId),
      confidence: Math.min(...inputs.map((input) => input.confidence)),
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

  const derived: ExtractedField[] = [];
  let discriminator = 0;
  for (const subjectRows of bySubject.values()) {
    const months = new Map<string, { amount: number; row: BankMonthlyTotal }>();
    let contradictory = false;
    for (const row of subjectRows) {
      const amount = metric.read(row);
      if (amount === null) continue;
      if (amount < 0 && definition?.signPolicy !== 'signed') {
        contradictory = true;
        continue;
      }
      const existing = months.get(row.month);
      if (existing && !currencyEqual(existing.amount, amount)) contradictory = true;
      if (!existing) months.set(row.month, { amount, row });
    }
    if (contradictory || months.size < 3) continue;

    const entries = [...months.entries()].sort(([a], [b]) => a.localeCompare(b));
    const mean = entries.reduce((sum, [, entry]) => sum + entry.amount, 0) / entries.length;
    const [lastMonth, last] = entries[entries.length - 1];
    derived.push(
      derivedCandidate({
        fieldId: metric.fieldId,
        ruleId: 'average_monthly_from_bank_table',
        value: Math.round(mean),
        fromCandidateIds: entries.map(([month, entry]) => `${entry.row.source.documentId}:bank:${month}`),
        confidence: Math.min(...entries.map(([, entry]) => entry.row.confidence)),
        source: last.row.source,
        period: lastDayOfMonth(lastMonth),
        subjectRef: last.row.subjectRef,
        discriminator,
        sourceCheck: entries.some(([, entry]) => entry.row.sourceCheck === 'failed') ? 'failed' : undefined,
      })
    );
    discriminator += 1;
  }
  return derived;
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
