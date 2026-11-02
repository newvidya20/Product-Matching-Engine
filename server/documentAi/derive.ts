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

/** `candidates` are settled and merged across the session. A direct candidate always wins. */
export function deriveCandidates(
  candidates: ExtractedField[],
  documents: DocumentExtractionSuccess[],
  today: string
): ExtractedField[] {
  const rows = documents.flatMap((document) => document.bankMonthlyTotals);
  return [
    ...deriveVintage(candidates, today),
    ...deriveProfitability(candidates),
    ...BANK_METRICS.flatMap((metric) => deriveBankAverage(metric, candidates, rows)),
  ];
}
