/**
 * Display text for eligibility results (docs/eligibility-contracts.md section 2.4). Pure functions of values and
 * rule config: no thresholds here.
 */
import type { CriterionUnit, EnumCriterionRule, NumericCriterionRule } from '../../src/types/eligibility.ts';

/** Round to 2 decimal places, half away from zero (section 4). toPrecision(15) absorbs binary noise like 1.005. */
export function round2(value: number): number {
  const scaled = Number((Math.abs(value) * 100).toPrecision(15));
  const r = Math.round(scaled) / 100;
  return value < 0 && r !== 0 ? -r : r;
}

/** Indian digit grouping: 4800000 -> 48,00,000. Decimals kept only when non-zero (2 dp). */
export function indianGrouping(value: number): string {
  const neg = value < 0;
  const abs = Math.abs(round2(value));
  const [intPart, decPart] = abs.toFixed(2).split('.');
  let grouped = intPart;
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  const out = decPart === '00' ? grouped : `${grouped}.${decPart}`;
  return neg ? `-${out}` : out;
}

/** 2 dp, trailing zeros dropped: 3 -> '3', 3.5 -> '3.5', 59.99 -> '59.99'. */
const trimmed = (v: number): string => String(round2(v));

export function formatValue(unit: Exclude<CriterionUnit, 'enum'>, value: number): string {
  switch (unit) {
    case 'currency':
      return `₹ ${indianGrouping(value)}`;
    case 'years':
      return `${trimmed(value)} ${round2(value) === 1 ? 'year' : 'years'}`;
    case 'score':
    case 'rank':
      // Compared exactly (never rounded), so shown exactly: 699.995 must not display as 700.
      return String(value);
    case 'ratio':
      return round2(value).toFixed(2);
    case 'multiple':
      return `${round2(value).toFixed(2)}x`;
    case 'percent':
      return `${trimmed(value)}%`;
  }
}

const ENUM_LABELS: Readonly<Record<string, string>> = {
  profitable_2plus_years: 'Profitable 2+ years',
  profitable_1_year: 'Profitable 1 year',
  breakeven_or_early: 'Breakeven or early stage',
  loss_making: 'Loss making',
  compliant: 'Compliant',
  not_compliant: 'Not compliant',
  not_applicable: 'Not applicable',
};

export const enumLabel = (value: string): string => ENUM_LABELS[value] || value;

/** Units counted in whole steps (score 699, rank 7); the rest are compared at 2 dp. */
const STEP: Partial<Record<CriterionUnit, number>> = { score: 1, rank: 1, ratio: 0.01, multiple: 0.01, percent: 0.01 };

/** e.g. 'At least 1.25 (1.10 to 1.24 is conditional)', 'At most 6 (7 is conditional)', 'At least 3 years'. */
export function expectedNumeric(rule: NumericCriterionRule): string {
  const f = (v: number) => formatValue(rule.unit, v);
  const head = `${rule.kind === 'number_min' ? 'At least' : 'At most'} ${f(rule.passAt)}`;
  if (rule.conditionalTo === null || rule.conditionalTo === rule.passAt) return head;
  const step = STEP[rule.unit];
  let band: string;
  if (rule.kind === 'number_min') {
    if (step) {
      const upper = round2(rule.passAt - step);
      band = upper <= rule.conditionalTo ? f(rule.conditionalTo) : `${f(rule.conditionalTo)} to ${f(upper)}`;
    } else band = `${f(rule.conditionalTo)} to below ${f(rule.passAt)}`;
  } else if (step) {
    const lower = round2(rule.passAt + step);
    band = lower >= rule.conditionalTo ? f(rule.conditionalTo) : `${f(lower)} to ${f(rule.conditionalTo)}`;
  } else band = `above ${f(rule.passAt)} to ${f(rule.conditionalTo)}`;
  return `${head} (${band} is conditional)`;
}

const joinOr = (xs: string[]) => xs.join(' or ');

export function expectedEnum(rule: EnumCriterionRule): string {
  const head = joinOr(rule.pass.map(enumLabel));
  if (!rule.conditional.length) return head;
  return `${head} (${joinOr(rule.conditional.map((v) => enumLabel(v).toLowerCase()))} is conditional)`;
}

/** 'A', 'A and B', 'A, B and C'. */
export function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
