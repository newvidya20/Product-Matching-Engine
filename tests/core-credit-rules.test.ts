/**
 * The user's five core credit rules (src/utils/coreCreditRules.ts) and the Eligibility Check's seed rules file.
 * 1. CIBIL: 750+ eligible, 700 to 749 conditional, below 700 not eligible. 2. CMR below 7. 3. TOL/TNW at most 4.00.
 * 4. DSCR strictly above 1.00. 5. Banking turnover at least 80%. Missing is flagged, never assumed.
 * FICTIONAL borrower values.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CriterionResult,
  EligibilityCriterionId,
  EligibilityInput,
  EligibilityResult,
  NumericCriterionRule,
} from '../src/types/eligibility.ts';
import {
  BANKING_TURNOVER_MIN_PERCENT,
  CIBIL_CONDITIONAL_MIN,
  CIBIL_ELIGIBLE_MIN,
  CMR_APPLIES_TO_ENTITY_TYPES,
  CMR_RANK_BELOW,
  CMR_REPORT_NOT_APPLICABLE,
  DSCR_ABOVE,
  TOL_TNW_MAX,
  classifyBankingTurnover,
  classifyCibil,
  classifyCmr,
  classifyDscr,
  classifyTolTnw,
} from '../src/utils/coreCreditRules.ts';
import { calculateFinancialRatios } from '../src/utils/financialMetrics.ts';
import { evaluateEligibility } from '../server/eligibility/engine.ts';
import { hashRules, validateRuleConfig } from '../server/eligibility/rules.ts';
import { defaultRules, passingInput } from './helpers/eligibility.ts';

const RULES = defaultRules();
const HASH = hashRules(RULES);
const numeric = (id: EligibilityCriterionId) => RULES.criteria[id] as NumericCriterionRule;

function run(overrides: Partial<EligibilityInput> = {}): EligibilityResult {
  return evaluateEligibility(passingInput(overrides), RULES, { rulesHash: HASH, now: new Date('2026-11-04T00:00:00Z') });
}

function crit(result: EligibilityResult, id: EligibilityCriterionId): CriterionResult {
  const c = result.criteria.find((r) => r.criterionId === id);
  assert.ok(c, `expected a result row for ${id}`);
  return c;
}

const status = (overrides: Partial<EligibilityInput>, id: EligibilityCriterionId) => crit(run(overrides), id).status;

describe('seed rules file equals the core rule constants', () => {
  it('is valid', () => {
    assert.deepEqual(validateRuleConfig(RULES), []);
  });

  it('personal_cibil: pass at 750, conditional from 700', () => {
    const r = numeric('personal_cibil');
    assert.equal(r.enabled, true);
    assert.equal(r.kind, 'number_min');
    assert.equal(r.unit, 'score');
    assert.equal(r.passAt, CIBIL_ELIGIBLE_MIN);
    assert.equal(r.conditionalTo, CIBIL_CONDITIONAL_MIN);
    assert.ok(!r.strict);
  });

  it('commercial_cmr: strictly below 7, no band, same applicability', () => {
    const r = numeric('commercial_cmr');
    assert.equal(r.enabled, true);
    assert.equal(r.kind, 'number_max');
    assert.equal(r.unit, 'rank');
    assert.equal(r.passAt, CMR_RANK_BELOW);
    assert.equal(r.strict, true);
    assert.equal(r.conditionalTo, null);
    assert.deepEqual(r.appliesToEntityTypes, [...CMR_APPLIES_TO_ENTITY_TYPES]);
    assert.deepEqual(r.skipWhen, { field: 'commercialCreditReportStatus', values: [CMR_REPORT_NOT_APPLICABLE] });
  });

  it('tol_tnw: at most 4, no band', () => {
    const r = numeric('tol_tnw');
    assert.equal(r.enabled, true);
    assert.equal(r.kind, 'number_max');
    assert.equal(r.passAt, TOL_TNW_MAX);
    assert.equal(r.conditionalTo, null);
    assert.ok(!r.strict);
  });

  it('dscr: strictly above 1, no band', () => {
    const r = numeric('dscr');
    assert.equal(r.enabled, true);
    assert.equal(r.kind, 'number_min');
    assert.equal(r.passAt, DSCR_ABOVE);
    assert.equal(r.strict, true);
    assert.equal(r.conditionalTo, null);
  });

  it('banking_turnover_ratio: at least 80%, no band', () => {
    const r = numeric('banking_turnover_ratio');
    assert.equal(r.enabled, true);
    assert.equal(r.kind, 'number_min');
    assert.equal(r.unit, 'percent');
    assert.equal(r.passAt, BANKING_TURNOVER_MIN_PERCENT);
    assert.equal(r.conditionalTo, null);
    assert.ok(!r.strict);
  });

  it('rationale says each is a user core rule', () => {
    for (const id of ['personal_cibil', 'commercial_cmr', 'tol_tnw', 'dscr', 'banking_turnover_ratio'] as const) {
      assert.match(RULES.criteria[id].rationale, /^User core rule:/);
    }
  });

  it('enabled set is the user decision: five core rules plus four kept defaults', () => {
    const enabled = (Object.keys(RULES.criteria) as EligibilityCriterionId[]).filter((id) => RULES.criteria[id].enabled).sort();
    assert.deepEqual(enabled, [
      'annual_turnover',
      'banking_credits_vs_requested',
      'banking_turnover_ratio',
      'business_vintage',
      'commercial_cmr',
      'dscr',
      'personal_cibil',
      'profitability',
      'tol_tnw',
    ]);
  });
});

describe('core rule helpers', () => {
  it('classifyCibil', () => {
    assert.equal(classifyCibil(750), 'eligible');
    assert.equal(classifyCibil(749), 'conditional');
    assert.equal(classifyCibil(700), 'conditional');
    assert.equal(classifyCibil(699), 'not_eligible');
    assert.equal(classifyCibil(null), 'missing');
    assert.equal(classifyCibil(undefined), 'missing');
  });

  it('classifyCmr', () => {
    assert.equal(classifyCmr(6), 'satisfied');
    assert.equal(classifyCmr(7), 'not_satisfied');
    assert.equal(classifyCmr(null), 'missing');
  });

  it('classifyTolTnw', () => {
    assert.equal(classifyTolTnw(4), 'satisfied');
    assert.equal(classifyTolTnw(4.01), 'not_satisfied');
    assert.equal(classifyTolTnw(-1), 'not_satisfied');
    assert.equal(classifyTolTnw(null), 'missing');
  });

  it('classifyDscr', () => {
    assert.equal(classifyDscr(1.01), 'satisfied');
    assert.equal(classifyDscr(1), 'not_satisfied');
    assert.equal(classifyDscr(null), 'missing');
  });

  it('classifyBankingTurnover', () => {
    assert.equal(classifyBankingTurnover(80), 'satisfied');
    assert.equal(classifyBankingTurnover(79.99), 'not_satisfied');
    assert.equal(classifyBankingTurnover(Number.NaN), 'missing');
  });
});

describe('Eligibility Check boundaries for the five core rules', () => {
  it('CIBIL 750 / 749 / 700 / 699 / missing', () => {
    assert.equal(status({ personalCibilScore: 750 }, 'personal_cibil'), 'passed');
    assert.equal(status({ personalCibilScore: 749 }, 'personal_cibil'), 'conditional');
    assert.equal(status({ personalCibilScore: 700 }, 'personal_cibil'), 'conditional');
    assert.equal(status({ personalCibilScore: 699 }, 'personal_cibil'), 'failed');
    const missing = crit(run({ personalCibilScore: null, promoterCibilScore: null }), 'personal_cibil');
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.missingInputs, ['personalCibilScore']);
  });

  it('CMR 6 / 7 / missing', () => {
    assert.equal(status({ commercialCmrRank: 6 }, 'commercial_cmr'), 'passed');
    assert.equal(status({ commercialCmrRank: 7 }, 'commercial_cmr'), 'failed');
    const missing = crit(run({ commercialCmrRank: null }), 'commercial_cmr');
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.missingInputs, ['commercialCmrRank']);
  });

  it('TOL/TNW 4.00 / 4.01 / TNW 0 / TNW negative / missing', () => {
    assert.equal(status({ totalOutsideLiabilities: 400, tangibleNetWorth: 100 }, 'tol_tnw'), 'passed'); // 4.00
    assert.equal(status({ totalOutsideLiabilities: 401, tangibleNetWorth: 100 }, 'tol_tnw'), 'failed'); // 4.01
    assert.equal(status({ totalOutsideLiabilities: 400.4, tangibleNetWorth: 100 }, 'tol_tnw'), 'passed'); // 4.004 -> 4.00
    for (const tnw of [0, -100]) {
      const c = crit(run({ totalOutsideLiabilities: 100, tangibleNetWorth: tnw }), 'tol_tnw');
      assert.equal(c.status, 'failed');
      assert.equal(c.actualDisplay, 'Net worth is zero or negative');
    }
    const missing = crit(run({ tangibleNetWorth: null }), 'tol_tnw');
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.missingInputs, ['tangibleNetWorth']);
  });

  it('DSCR 1.00 / 1.01 / 1.004 / 1.005 / missing inputs / zero debt service / missing EMI', () => {
    const dscr = (ocf: number) => crit(run({ operatingCashFlow: ocf, annualScheduledPrincipalRepayments: 100, existingMonthlyEmi: 0 }), 'dscr');
    assert.equal(dscr(100).status, 'failed'); // 1.00
    assert.equal(dscr(101).status, 'passed'); // 1.01
    assert.equal(dscr(100.4).status, 'failed'); // 1.004 rounds to 1.00
    assert.equal(dscr(100.5).status, 'passed'); // 1.005 rounds half away from zero to 1.01
    const allMissing = crit(run({ operatingCashFlow: null, annualScheduledPrincipalRepayments: null, existingMonthlyEmi: null }), 'dscr');
    assert.equal(allMissing.status, 'missing');
    assert.deepEqual(allMissing.missingInputs, ['operatingCashFlow', 'annualScheduledPrincipalRepayments', 'existingMonthlyEmi']);
    const zero = crit(run({ annualScheduledPrincipalRepayments: 0, existingMonthlyEmi: 0 }), 'dscr');
    assert.equal(zero.status, 'passed');
    assert.equal(zero.actualDisplay, 'No existing debt service');
    const noEmi = crit(run({ existingMonthlyEmi: null }), 'dscr');
    assert.equal(noEmi.status, 'missing');
    assert.deepEqual(noEmi.missingInputs, ['existingMonthlyEmi']);
  });

  it('banking turnover 79.99 / 80 / missing', () => {
    // credits x 12 / revenue x 100
    assert.equal(status({ averageMonthlyBankingCredits: 666_600, annualRevenue: 10_000_000 }, 'banking_turnover_ratio'), 'failed'); // 79.99
    assert.equal(status({ averageMonthlyBankingCredits: 666_667, annualRevenue: 10_000_000 }, 'banking_turnover_ratio'), 'passed'); // 80.00
    assert.equal(crit(run({ averageMonthlyBankingCredits: 666_600, annualRevenue: 10_000_000 }), 'banking_turnover_ratio').actual, 79.99);
    const missing = crit(run({ averageMonthlyBankingCredits: null }), 'banking_turnover_ratio');
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.missingInputs, ['averageMonthlyBankingCredits']);
    assert.equal(status({ annualRevenue: null }, 'banking_turnover_ratio'), 'missing');
  });
});

describe('four outcomes under the core rules', () => {
  it('ELIGIBLE: every core rule satisfied', () => {
    assert.equal(run().outcome, 'ELIGIBLE');
  });

  it('CONDITIONALLY_ELIGIBLE: CIBIL 700 to 749', () => {
    const r = run({ personalCibilScore: 720 });
    assert.equal(r.outcome, 'CONDITIONALLY_ELIGIBLE');
    assert.match(r.outcomeReason, /720 is below 750 but at least 700 \(conditional band\)/);
  });

  it('INCOMPLETE_DOCUMENTS: a mandatory core input missing (CIBIL, or DSCR inputs)', () => {
    assert.equal(run({ personalCibilScore: null }).outcome, 'INCOMPLETE_DOCUMENTS');
    const r = run({ operatingCashFlow: null });
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.deepEqual(r.missingMandatoryInputs, ['operatingCashFlow']);
  });

  it('NOT_ELIGIBLE: CIBIL below 700 or DSCR 1.00 or below (mandatory)', () => {
    assert.equal(run({ personalCibilScore: 699 }).outcome, 'NOT_ELIGIBLE');
    assert.equal(run({ operatingCashFlow: 1_800_000 }).outcome, 'NOT_ELIGIBLE'); // 18 / 18 = 1.00
  });

  it('CMR, TOL/TNW and banking turnover are non-mandatory: a failure gives CONDITIONALLY_ELIGIBLE', () => {
    assert.equal(run({ commercialCmrRank: 7 }).outcome, 'CONDITIONALLY_ELIGIBLE');
    assert.equal(run({ totalOutsideLiabilities: 16_040_000 }).outcome, 'CONDITIONALLY_ELIGIBLE'); // 4.01
    assert.equal(run({ averageMonthlyBankingCredits: 1_300_000 }).outcome, 'CONDITIONALLY_ELIGIBLE'); // 78%
  });
});

describe('calculateFinancialRatios DSCR and banking turnover (existing formulas, safe missing)', () => {
  it('DSCR = operatingCashFlow / (principal + EMI x 12) when all three are given', () => {
    assert.equal(calculateFinancialRatios({ operatingCashFlow: 3_600_000, annualScheduledPrincipalRepayments: 600_000, existingMonthlyEmi: 100_000 }).dscr, 2);
    assert.equal(calculateFinancialRatios({ operatingCashFlow: 600_000, annualScheduledPrincipalRepayments: 600_000, existingMonthlyEmi: 0 }).dscr, 1);
  });

  it('DSCR is null when principal or EMI is missing, never computed as if 0', () => {
    assert.equal(calculateFinancialRatios({ operatingCashFlow: 1_000, annualScheduledPrincipalRepayments: 500 }).dscr, null);
    assert.equal(calculateFinancialRatios({ operatingCashFlow: 1_000, existingMonthlyEmi: 50 }).dscr, null);
    assert.equal(calculateFinancialRatios({ annualScheduledPrincipalRepayments: 500, existingMonthlyEmi: 50 }).dscr, null);
  });

  it('zero debt service gives null, never Infinity or NaN', () => {
    const r = calculateFinancialRatios({ operatingCashFlow: 1_000, annualScheduledPrincipalRepayments: 0, existingMonthlyEmi: 0 });
    assert.equal(r.dscr, null);
  });

  it('banking turnover with revenue 0 gives null, never Infinity', () => {
    assert.equal(calculateFinancialRatios({ averageMonthlyBankingCredits: 100, annualRevenue: 0 }).bankingTurnoverRatio, null);
    assert.equal(calculateFinancialRatios({ averageMonthlyBankingCredits: 100, annualRevenue: 1_500 }).bankingTurnoverRatio, 80);
  });

  it('every ratio is finite or null for zero and negative denominators', () => {
    const r = calculateFinancialRatios({
      annualRevenue: 0,
      currentLiabilities: 0,
      tangibleNetWorth: 0,
      shareholdersEquity: 0,
      interestExpense: 0,
      previousAnnualRevenue: 0,
      averageMonthlyBankingCredits: 10,
      totalOutsideLiabilities: 10,
      currentAssets: 10,
      operatingCashFlow: 10,
      annualScheduledPrincipalRepayments: -5,
      existingMonthlyEmi: 0,
    });
    for (const v of Object.values(r)) assert.ok(v === null || Number.isFinite(v));
  });
});
