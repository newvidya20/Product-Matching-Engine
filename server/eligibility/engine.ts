/**
 * Deterministic eligibility engine (docs/eligibility-contracts.md sections 2 and 4). No AI, no I/O, no thresholds:
 * every number comes from the rules config passed in. A missing input is reported as missing, never defaulted.
 */
import { CRITERION_DEFINITIONS, ELIGIBILITY_CRITERION_IDS, ELIGIBILITY_INPUT_FIELDS } from '../../src/types/eligibility.ts';
import type {
  CriterionInputUsed,
  CriterionResult,
  CriterionRule,
  CriterionSeverity,
  CriterionStatus,
  EligibilityCriterionId,
  EligibilityDerivedMetrics,
  EligibilityInput,
  EligibilityInputField,
  EligibilityOutcome,
  EligibilityResult,
  EligibilityRuleConfig,
  EnumCriterionRule,
  NumericCriterionRule,
  SkippedCriterion,
} from '../../src/types/eligibility.ts';
import { enumLabel, expectedEnum, expectedNumeric, formatValue, joinAnd, round2 } from './format.ts';
import { INPUT_FIELD_IDS, INPUT_LABELS } from './inputSchema.ts';

// ------------------------------------------------------------ severity

export function severityFor(status: CriterionStatus, mandatory: boolean): CriterionSeverity {
  if (status === 'passed') return 'none';
  if (status === 'conditional') return 'condition';
  if (!mandatory) return 'condition';
  return status === 'failed' ? 'blocker' : 'action_required';
}

// ------------------------------------------------------------ derived metrics

type Ratio = { value: number } | { zero: true } | null;

/** num / den, rounded. null when an input is null; `zero` when the denominator is 0 (or <= 0 where asked). */
function ratio(num: number | null, den: number | null, zeroWhenNonPositive = false): Ratio {
  if (num === null || den === null) return null;
  if (den === 0 || (zeroWhenNonPositive && den < 0)) return { zero: true };
  return { value: round2(num / den) };
}

interface DscrComputation {
  basis: 'computed' | 'stated' | null;
  /** Rounded value, or null when missing or the denominator is 0. */
  value: number | null;
  noDebtService: boolean;
  missing: EligibilityInputField[];
}

/**
 * The project formula (src/utils/financialMetrics.ts calculateFinancialRatios), section 4.1:
 * operatingCashFlow / (annualScheduledPrincipalRepayments + existingMonthlyEmi * 12). Computed only when all three
 * are non-null; 0 is a real value, null is missing and never treated as 0.
 */
function computeDscr(input: EligibilityInput): DscrComputation {
  const required = CRITERION_DEFINITIONS.dscr.requiredInputs;
  const missing = required.filter((f) => input[f] === null);
  if (missing.length === 0) {
    const ocf = input.operatingCashFlow as number;
    const principal = input.annualScheduledPrincipalRepayments as number;
    const emi = input.existingMonthlyEmi as number;
    const denominator = principal + emi * 12; // both validated >= 0, so 0 is the only non-positive case
    if (denominator <= 0) {
      return { basis: 'computed', value: null, noDebtService: true, missing: [] };
    }
    return { basis: 'computed', value: round2(ocf / denominator), noDebtService: false, missing: [] };
  }
  if (input.dscrStated !== null) {
    return { basis: 'stated', value: round2(input.dscrStated), noDebtService: false, missing: [] };
  }
  return { basis: null, value: null, noDebtService: false, missing };
}

const valueOf = (r: Ratio): number | null => (r && 'value' in r ? r.value : null);

export function computeDerived(input: EligibilityInput): EligibilityDerivedMetrics {
  const dscr = computeDscr(input);
  const credits = input.averageMonthlyBankingCredits;
  const emi = input.existingMonthlyEmi;
  let foirPercent: number | null = null;
  if (emi !== null && input.ebitda !== null) {
    if (emi === 0) foirPercent = 0;
    else if (input.ebitda > 0) foirPercent = round2(((emi * 12) / input.ebitda) * 100);
  }
  return {
    dscr: dscr.value,
    dscrBasis: dscr.basis,
    requestedToMonthlyCreditsMultiple: valueOf(ratio(input.requestedAmount, credits)),
    bankingTurnoverRatioPercent:
      credits === null || input.annualRevenue === null || input.annualRevenue === 0
        ? null
        : round2(((credits * 12) / input.annualRevenue) * 100),
    tolTnw: valueOf(ratio(input.totalOutsideLiabilities, input.tangibleNetWorth, true)),
    foirPercent,
    currentRatio: valueOf(ratio(input.currentAssets, input.currentLiabilities)),
    interestCoverage: valueOf(ratio(input.ebit, input.interestExpense)),
  };
}

// ------------------------------------------------------------ classification

function classifyNumeric(rule: NumericCriterionRule, v: number): Exclude<CriterionStatus, 'missing'> {
  if (rule.strict) {
    // Exclusive pass bound, no band (validated in rules.ts). Compared on the rounded value: DSCR 1.004 -> 1.00 fails.
    const passes = rule.kind === 'number_min' ? v > rule.passAt : v < rule.passAt;
    return passes ? 'passed' : 'failed';
  }
  if (rule.kind === 'number_min') {
    if (v >= rule.passAt) return 'passed';
    if (rule.conditionalTo !== null && v >= rule.conditionalTo) return 'conditional';
    return 'failed';
  }
  if (v <= rule.passAt) return 'passed';
  if (rule.conditionalTo !== null && v <= rule.conditionalTo) return 'conditional';
  return 'failed';
}

function classifyEnum(rule: EnumCriterionRule, v: string): Exclude<CriterionStatus, 'missing'> {
  if (rule.pass.includes(v)) return 'passed';
  if (rule.conditional.includes(v)) return 'conditional';
  if (rule.fail.includes(v)) return 'failed';
  // The loader guarantees every value is listed; an unlisted value cannot be called passed.
  return 'failed';
}

function numericReason(label: string, rule: NumericCriterionRule, v: number, status: CriterionStatus): string {
  const f = (x: number) => formatValue(rule.unit, x);
  const shown = f(v);
  const min = rule.kind === 'number_min';
  if (rule.strict) {
    const word = min ? 'above' : 'below';
    return status === 'passed'
      ? `${label} ${shown} is ${word} ${f(rule.passAt)}, as required.`
      : `${label} ${shown} is not ${word} ${f(rule.passAt)} (it must be ${min ? 'strictly above' : 'below'} ${f(rule.passAt)}).`;
  }
  if (status === 'passed') return `${label} ${shown} meets the ${min ? 'minimum' : 'maximum'} of ${f(rule.passAt)}.`;
  if (status === 'conditional') {
    return min
      ? `${label} ${shown} is below ${f(rule.passAt)} but at least ${f(rule.conditionalTo as number)} (conditional band).`
      : `${label} ${shown} is above ${f(rule.passAt)} but at most ${f(rule.conditionalTo as number)} (conditional band).`;
  }
  const limit = rule.conditionalTo ?? rule.passAt;
  return min
    ? `${label} ${shown} is below the minimum of ${f(limit)}.`
    : `${label} ${shown} is above the maximum of ${f(limit)}.`;
}

function enumReason(label: string, rule: EnumCriterionRule, v: string, status: CriterionStatus): string {
  const shown = enumLabel(v);
  if (status === 'passed') return `${label}: ${shown} meets the requirement.`;
  if (status === 'conditional') return `${label}: ${shown} is conditional (required: ${expectedEnum(rule)}).`;
  return `${label}: ${shown} does not meet the requirement (${expectedEnum(rule)}).`;
}

const isAre = (n: number) => (n === 1 ? 'is' : 'are');

function missingReason(fields: EligibilityInputField[]): string {
  return `${joinAnd(fields.map((f) => INPUT_LABELS[f]))} ${isAre(fields.length)} not provided.`;
}

// ------------------------------------------------------------ one criterion

interface RowBase {
  id: EligibilityCriterionId;
  rule: CriterionRule;
}

function used(input: EligibilityInput, fields: readonly EligibilityInputField[]): CriterionInputUsed[] {
  const out: CriterionInputUsed[] = [];
  for (const field of fields) {
    const value = input[field];
    if (value !== null) out.push({ field, value, fieldId: INPUT_FIELD_IDS[field] });
  }
  return out;
}

function row(
  base: RowBase,
  parts: Pick<CriterionResult, 'status' | 'actual' | 'actualDisplay' | 'reason' | 'sourceField' | 'inputsUsed' | 'missingInputs'>
): CriterionResult {
  const { rule } = base;
  return {
    criterionId: base.id,
    label: rule.label,
    expected: rule.kind === 'enum' ? expectedEnum(rule) : expectedNumeric(rule),
    mandatory: rule.mandatory,
    severity: severityFor(parts.status, rule.mandatory),
    ...parts,
  };
}

function missingRow(base: RowBase, fields: EligibilityInputField[], input: EligibilityInput, inputs: readonly EligibilityInputField[]): CriterionResult {
  return row(base, {
    status: 'missing',
    actual: null,
    actualDisplay: 'Not provided',
    reason: missingReason(fields),
    sourceField: null,
    inputsUsed: used(input, inputs),
    missingInputs: fields,
  });
}

/** A value from a zero or non-positive denominator: fixed text, no number (section 4). */
function zeroRow(base: RowBase, status: Exclude<CriterionStatus, 'missing'>, text: string, input: EligibilityInput, actual: number | null = null, display = text): CriterionResult {
  const def = CRITERION_DEFINITIONS[base.id];
  return row(base, {
    status,
    actual,
    actualDisplay: display,
    reason: `${base.rule.label}: ${text}.`,
    sourceField: `derived:${base.id}`,
    inputsUsed: used(input, def.requiredInputs),
    missingInputs: [],
  });
}

function numericRow(base: RowBase, v: number, sourceField: string, inputsUsed: CriterionInputUsed[], note = ''): CriterionResult {
  const rule = base.rule as NumericCriterionRule;
  const status = classifyNumeric(rule, v);
  return row(base, {
    status,
    actual: v,
    actualDisplay: formatValue(rule.unit, v),
    reason: numericReason(rule.label, rule, v, status) + note,
    sourceField,
    inputsUsed,
    missingInputs: [],
  });
}

function evaluateCriterion(base: RowBase, input: EligibilityInput, derived: EligibilityDerivedMetrics): CriterionResult {
  const { id, rule } = base;
  const def = CRITERION_DEFINITIONS[id];
  const derivedSource = `derived:${id}`;

  if (id === 'personal_cibil') {
    const p = input.personalCibilScore;
    const q = input.promoterCibilScore;
    if (p === null && q === null) return missingRow(base, ['personalCibilScore'], input, def.optionalInputs);
    const field: EligibilityInputField = p === null ? 'promoterCibilScore' : q === null ? 'personalCibilScore' : q < p ? 'promoterCibilScore' : 'personalCibilScore';
    const note = p !== null && q !== null ? ' Lower of personal and promoter scores used.' : '';
    // Scores are compared exactly, never rounded: 699.995 is below 700 (section 4.2). Validation also rejects
    // non-integer scores (section 3); this is the second line of defence for direct callers.
    return numericRow(base, input[field] as number, INPUT_FIELD_IDS[field], used(input, def.optionalInputs), note);
  }

  if (id === 'dscr') {
    const d = computeDscr(input);
    if (d.basis === null) return missingRow(base, d.missing, input, def.requiredInputs);
    if (d.basis === 'computed') {
      if (d.noDebtService) return zeroRow(base, 'passed', 'No existing debt service', input);
      return numericRow(base, d.value as number, derivedSource, used(input, def.requiredInputs));
    }
    // Stated: classified as usual, then capped at conditional (section 4.1).
    const r = numericRow(base, d.value as number, INPUT_FIELD_IDS.dscrStated, used(input, ['dscrStated']));
    const status: CriterionStatus = r.status === 'passed' ? 'conditional' : r.status;
    return {
      ...r,
      status,
      severity: severityFor(status, rule.mandatory),
      reason: `Stated DSCR, not computed; verify from financials. ${r.reason}${r.status === 'passed' ? ' Capped at conditional.' : ''}`,
    };
  }

  const missing = def.requiredInputs.filter((f) => input[f] === null);
  if (missing.length) return missingRow(base, missing, input, def.requiredInputs);
  const inputs = used(input, def.requiredInputs);

  switch (id) {
    case 'banking_credits_vs_requested':
      if (input.averageMonthlyBankingCredits === 0) return zeroRow(base, 'failed', 'No banking credits', input);
      return numericRow(base, derived.requestedToMonthlyCreditsMultiple as number, derivedSource, inputs);
    case 'banking_turnover_ratio':
      if (input.annualRevenue === 0) return zeroRow(base, 'conditional', 'Revenue reported as 0; check figures', input);
      return numericRow(base, derived.bankingTurnoverRatioPercent as number, derivedSource, inputs);
    case 'tol_tnw':
      if ((input.tangibleNetWorth as number) <= 0) return zeroRow(base, 'failed', 'Net worth is zero or negative', input);
      return numericRow(base, derived.tolTnw as number, derivedSource, inputs);
    case 'existing_emi_foir':
      if (input.existingMonthlyEmi === 0) return zeroRow(base, 'passed', 'No existing EMI', input, 0, '0%');
      if ((input.ebitda as number) <= 0) return zeroRow(base, 'failed', 'EBITDA does not cover any EMI', input);
      return numericRow(base, derived.foirPercent as number, derivedSource, inputs);
    case 'current_ratio':
      if (input.currentLiabilities === 0) return zeroRow(base, 'passed', 'No current liabilities', input);
      return numericRow(base, derived.currentRatio as number, derivedSource, inputs);
    case 'interest_coverage':
      if (input.interestExpense === 0) return zeroRow(base, 'passed', 'No interest expense', input);
      return numericRow(base, derived.interestCoverage as number, derivedSource, inputs);
    default: {
      // Direct criteria compare the input itself.
      const field = def.requiredInputs[0];
      const value = input[field] as number | string;
      if (rule.kind === 'enum') {
        const v = String(value);
        const status = classifyEnum(rule, v);
        return row(base, {
          status,
          actual: v,
          actualDisplay: enumLabel(v),
          reason: enumReason(rule.label, rule, v, status),
          sourceField: INPUT_FIELD_IDS[field],
          inputsUsed: inputs,
          missingInputs: [],
        });
      }
      // Scores and ranks are counted in whole steps and compared exactly; other direct inputs at 2 dp (section 4).
      const exact = rule.unit === 'score' || rule.unit === 'rank';
      return numericRow(base, exact ? (value as number) : round2(value as number), INPUT_FIELD_IDS[field], inputs);
    }
  }
}

// ------------------------------------------------------------ outcome

const stripDot = (s: string) => s.replace(/\.$/, '');

/**
 * Every row that makes a result CONDITIONALLY_ELIGIBLE under rule 3 of section 2.2: any `conditional` row, and any
 * non-mandatory row that is `failed` or `missing`. Shared by the outcome decision and the continue route.
 */
export function conditionRows(rows: readonly CriterionResult[]): CriterionResult[] {
  return rows.filter((r) => r.status === 'conditional' || (!r.mandatory && (r.status === 'failed' || r.status === 'missing')));
}

const SKIP_TEXT: Record<SkippedCriterion['reason'], string> = {
  disabled: 'disabled',
  entity_type_not_applicable: 'not applicable to this entity type',
  skip_when_matched: 'skipped by its skip condition',
};

function decideOutcome(
  rows: CriterionResult[],
  missingMandatory: EligibilityInputField[],
  skipped: SkippedCriterion[],
  rules: EligibilityRuleConfig
): { outcome: EligibilityOutcome; outcomeReason: string } {
  const failedMandatory = rows.filter((r) => r.mandatory && r.status === 'failed');
  if (failedMandatory.length) {
    return {
      outcome: 'NOT_ELIGIBLE',
      outcomeReason: `Not eligible: ${failedMandatory.map((r) => stripDot(r.reason)).join('; ')} (mandatory).`,
    };
  }
  if (rows.some((r) => r.mandatory && r.status === 'missing')) {
    return {
      outcome: 'INCOMPLETE_DOCUMENTS',
      outcomeReason: `Incomplete documents: ${joinAnd(missingMandatory.map((f) => INPUT_LABELS[f]))} ${isAre(missingMandatory.length)} not provided (mandatory).`,
    };
  }
  // Rule 2a: nothing mandatory was evaluated (every enabled mandatory criterion skipped, or no rows at all), so
  // nothing confirms eligibility. Never ELIGIBLE or CONDITIONALLY_ELIGIBLE on an empty check.
  if (!rows.some((r) => r.mandatory)) {
    const skippedMandatory = skipped.filter((s) => s.reason !== 'disabled' && rules.criteria[s.criterionId].mandatory);
    const detail = skippedMandatory.length
      ? ` (${skippedMandatory.map((s) => `${rules.criteria[s.criterionId].label}: ${SKIP_TEXT[s.reason]}`).join('; ')})`
      : '';
    return {
      outcome: 'INCOMPLETE_DOCUMENTS',
      outcomeReason: rows.length
        ? `Incomplete documents: no mandatory criterion could be evaluated${detail}, so eligibility cannot be confirmed.`
        : `Incomplete documents: no criterion could be evaluated${detail}, so eligibility cannot be confirmed.`,
    };
  }
  const conditions = conditionRows(rows);
  if (conditions.length) {
    const parts = conditions.map((r) => {
      const text = r.status === 'missing' ? `${r.label}: ${stripDot(r.reason)}` : stripDot(r.reason);
      return r.mandatory ? text : `${text} (not mandatory)`;
    });
    return { outcome: 'CONDITIONALLY_ELIGIBLE', outcomeReason: `Conditionally eligible: ${parts.join('; ')}.` };
  }
  return {
    outcome: 'ELIGIBLE',
    outcomeReason: `Eligible: all ${rows.length} ${rows.length === 1 ? 'criterion' : 'criteria'} passed.`,
  };
}

// ------------------------------------------------------------ entry point

export interface EvaluateOptions {
  rulesHash: string;
  now?: Date;
}

export function evaluateEligibility(rawInput: EligibilityInput, rules: EligibilityRuleConfig, opts: EvaluateOptions): EligibilityResult {
  // A key absent from a stored input (a record saved before the key existed, e.g. operatingCashFlow) is not
  // provided: read as null so it is reported missing, never computed as undefined.
  const input = Object.fromEntries(
    ELIGIBILITY_INPUT_FIELDS.map((f) => [f, rawInput[f] === undefined ? null : rawInput[f]])
  ) as unknown as EligibilityInput;
  const derived = computeDerived(input);
  const criteria: CriterionResult[] = [];
  const skipped: SkippedCriterion[] = [];

  for (const id of ELIGIBILITY_CRITERION_IDS) {
    const rule = rules.criteria[id];
    if (!rule.enabled) {
      skipped.push({ criterionId: id, reason: 'disabled' });
      continue;
    }
    if (Array.isArray(rule.appliesToEntityTypes)) {
      if (input.entityType === null) {
        criteria.push(missingRow({ id, rule }, ['entityType'], input, []));
        continue;
      }
      if (!rule.appliesToEntityTypes.includes(input.entityType)) {
        skipped.push({ criterionId: id, reason: 'entity_type_not_applicable' });
        continue;
      }
    }
    if (rule.skipWhen) {
      const v = input[rule.skipWhen.field];
      if (v !== null && rule.skipWhen.values.includes(v)) {
        skipped.push({ criterionId: id, reason: 'skip_when_matched' });
        continue;
      }
    }
    criteria.push(evaluateCriterion({ id, rule }, input, derived));
  }

  const missingMandatoryInputs: EligibilityInputField[] = [];
  const missingOptionalInputs: EligibilityInputField[] = [];
  for (const r of criteria) {
    if (r.mandatory) for (const f of r.missingInputs) if (!missingMandatoryInputs.includes(f)) missingMandatoryInputs.push(f);
  }
  for (const r of criteria) {
    if (!r.mandatory) {
      for (const f of r.missingInputs) {
        if (!missingMandatoryInputs.includes(f) && !missingOptionalInputs.includes(f)) missingOptionalInputs.push(f);
      }
    }
  }

  const counts: Record<CriterionStatus, number> = { passed: 0, failed: 0, conditional: 0, missing: 0 };
  for (const r of criteria) counts[r.status]++;

  const { outcome, outcomeReason } = decideOutcome(criteria, missingMandatoryInputs, skipped, rules);
  return {
    outcome,
    outcomeReason,
    criteria,
    skipped,
    derived,
    missingMandatoryInputs,
    missingOptionalInputs,
    counts,
    rulesVersion: rules.rulesVersion,
    rulesHash: opts.rulesHash,
    evaluatedAt: (opts.now ?? new Date()).toISOString(),
  };
}
