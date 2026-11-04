/**
 * Eligibility engine, rules validation and input validation.
 * Contract: docs/eligibility-contracts.md sections 2 to 5.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CriterionResult,
  EligibilityCriterionId,
  EligibilityInput,
  EligibilityResult,
  EligibilityRuleConfig,
  NumericCriterionRule,
} from '../src/types/eligibility.ts';
import { evaluateEligibility, severityFor } from '../server/eligibility/engine.ts';
import { indianGrouping, round2 } from '../server/eligibility/format.ts';
import { validateEligibilityInput } from '../server/eligibility/inputSchema.ts';
import { hashRules, validateRuleConfig } from '../server/eligibility/rules.ts';
import { defaultRules, passingInput } from './helpers/eligibility.ts';

const RULES = defaultRules();
const HASH = hashRules(RULES);

function run(overrides: Partial<EligibilityInput> = {}, rules: EligibilityRuleConfig = RULES): EligibilityResult {
  return evaluateEligibility(passingInput(overrides), rules, { rulesHash: HASH, now: new Date('2026-11-03T00:00:00Z') });
}

function crit(result: EligibilityResult, id: EligibilityCriterionId): CriterionResult {
  const c = result.criteria.find((r) => r.criterionId === id);
  assert.ok(c, `expected a result row for ${id}`);
  return c;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The five criteria disabled by the user's decision (kept in the file for later). */
const DISABLED_IDS: EligibilityCriterionId[] = ['gst_turnover', 'gst_compliance', 'existing_emi_foir', 'current_ratio', 'interest_coverage'];

/** The seed with every criterion enabled, to keep testing the engine logic of the disabled ones. */
const ALL_ON = (() => {
  const r = clone(RULES);
  for (const id of DISABLED_IDS) r.criteria[id].enabled = true;
  return r;
})();

/** Skips other than the disabled-by-default ones. */
const nonDefaultSkips = (r: EligibilityResult) => r.skipped.filter((s) => !(s.reason === 'disabled' && DISABLED_IDS.includes(s.criterionId)));

/** DSCR = operating cash flow / principal, with EMI 0. */
const dscrOf = (ocf: number) => run({ operatingCashFlow: ocf, annualScheduledPrincipalRepayments: 100, existingMonthlyEmi: 0 });

describe('seed rules file', () => {
  it('equals the JSON in contract section 5.2 exactly', () => {
    const doc = readFileSync(fileURLToPath(new URL('../docs/eligibility-contracts.md', import.meta.url)), 'utf-8');
    const block = /### 5\.2[\s\S]*?```json\r?\n([\s\S]*?)```/.exec(doc);
    assert.ok(block);
    assert.deepEqual(RULES, JSON.parse(block[1]));
  });

  it('is valid', () => {
    assert.deepEqual(validateRuleConfig(RULES), []);
  });
});

describe('four outcomes', () => {
  it('ELIGIBLE when every row passes', () => {
    const r = run();
    assert.equal(r.outcome, 'ELIGIBLE');
    assert.equal(r.counts.passed, r.criteria.length);
    assert.equal(r.criteria.length, 9); // 14 defined, 5 disabled
    assert.deepEqual(
      r.skipped.map((s) => [s.criterionId, s.reason]),
      DISABLED_IDS.map((id) => [id, 'disabled'])
    );
    assert.deepEqual(r.missingMandatoryInputs, []);
    assert.deepEqual(r.missingOptionalInputs, []);
    assert.equal(r.rulesVersion, RULES.rulesVersion);
    assert.equal(r.rulesHash, HASH);
    assert.match(r.outcomeReason, /^Eligible:/);
  });

  it('CONDITIONALLY_ELIGIBLE when a mandatory criterion is in its conditional band', () => {
    const r = run({ businessVintageYears: 2.5 });
    assert.equal(crit(r, 'business_vintage').status, 'conditional');
    assert.equal(crit(r, 'business_vintage').severity, 'condition');
    assert.equal(r.outcome, 'CONDITIONALLY_ELIGIBLE');
  });

  it('INCOMPLETE_DOCUMENTS when a mandatory input is missing', () => {
    const r = run({ personalCibilScore: null, averageMonthlyBankingCredits: null });
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.equal(crit(r, 'personal_cibil').status, 'missing');
    assert.equal(crit(r, 'personal_cibil').severity, 'action_required');
    assert.equal(crit(r, 'personal_cibil').actualDisplay, 'Not provided');
    assert.equal(crit(r, 'personal_cibil').sourceField, null);
    assert.deepEqual(r.missingMandatoryInputs, ['personalCibilScore', 'averageMonthlyBankingCredits']);
    // banking_turnover_ratio (non-mandatory) also misses credits, but it is already asked for as mandatory
    assert.deepEqual(r.missingOptionalInputs, []);
    assert.equal(
      r.outcomeReason,
      'Incomplete documents: Personal CIBIL score and Average monthly banking credits are not provided (mandatory).'
    );
  });

  it('NOT_ELIGIBLE when a mandatory criterion fails', () => {
    const r = run({ businessVintageYears: 1 });
    assert.equal(r.outcome, 'NOT_ELIGIBLE');
    assert.equal(crit(r, 'business_vintage').severity, 'blocker');
    assert.match(r.outcomeReason, /^Not eligible: .*below the minimum of 2 years \(mandatory\)\.$/);
  });
});

describe('outcome precedence', () => {
  it('a failed mandatory wins over a missing mandatory, and the missing input is still listed', () => {
    const r = run({ businessVintageYears: 1, personalCibilScore: null });
    assert.equal(r.outcome, 'NOT_ELIGIBLE');
    assert.deepEqual(r.missingMandatoryInputs, ['personalCibilScore']);
  });

  it('a missing mandatory wins over conditional and non-mandatory failures', () => {
    const r = run({ personalCibilScore: null, businessVintageYears: 2.5, totalOutsideLiabilities: 99_000_000 });
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
  });

  it('a missing non-mandatory input never gives ELIGIBLE', () => {
    const r = run({ totalOutsideLiabilities: null });
    assert.equal(crit(r, 'tol_tnw').status, 'missing');
    assert.equal(crit(r, 'tol_tnw').severity, 'condition');
    assert.equal(r.outcome, 'CONDITIONALLY_ELIGIBLE');
    assert.deepEqual(r.missingOptionalInputs, ['totalOutsideLiabilities']);
    assert.deepEqual(r.missingMandatoryInputs, []);
  });

  it('a failed non-mandatory criterion gives CONDITIONALLY_ELIGIBLE, not NOT_ELIGIBLE', () => {
    const r = run({ totalOutsideLiabilities: 20_000_000 }); // 5.00
    assert.equal(crit(r, 'tol_tnw').status, 'failed');
    assert.equal(crit(r, 'tol_tnw').severity, 'condition');
    assert.equal(r.outcome, 'CONDITIONALLY_ELIGIBLE');
  });

  it('severity follows the fixed table', () => {
    assert.equal(severityFor('failed', true), 'blocker');
    assert.equal(severityFor('missing', true), 'action_required');
    assert.equal(severityFor('conditional', true), 'condition');
    assert.equal(severityFor('passed', true), 'none');
    assert.equal(severityFor('failed', false), 'condition');
    assert.equal(severityFor('missing', false), 'condition');
    assert.equal(severityFor('conditional', false), 'condition');
    assert.equal(severityFor('passed', false), 'none');
  });
});

describe('applicability and skips', () => {
  it('null entityType makes an entity-limited criterion missing on entityType', () => {
    const r = run({ entityType: null });
    const cmr = crit(r, 'commercial_cmr');
    assert.equal(cmr.status, 'missing');
    assert.deepEqual(cmr.missingInputs, ['entityType']);
    assert.deepEqual(r.missingOptionalInputs, ['entityType']);
    assert.equal(r.outcome, 'CONDITIONALLY_ELIGIBLE');
  });

  it('an entity type not in the list skips the criterion', () => {
    const r = run({ entityType: 'proprietorship', commercialCmrRank: null });
    assert.ok(!r.criteria.some((c) => c.criterionId === 'commercial_cmr'));
    assert.deepEqual(nonDefaultSkips(r), [{ criterionId: 'commercial_cmr', reason: 'entity_type_not_applicable' }]);
    assert.equal(r.outcome, 'ELIGIBLE');
  });

  it('skipWhen skips on a matching value, and a null field does not match', () => {
    const r1 = run({ commercialCreditReportStatus: 'not_applicable', commercialCmrRank: null });
    assert.deepEqual(nonDefaultSkips(r1), [{ criterionId: 'commercial_cmr', reason: 'skip_when_matched' }]);

    const r2 = run({ gstComplianceStatus: 'not_applicable', gstAnnualTurnover: null }, ALL_ON);
    assert.deepEqual(
      r2.skipped.map((s) => [s.criterionId, s.reason]),
      [
        ['gst_turnover', 'skip_when_matched'],
        ['gst_compliance', 'skip_when_matched'],
      ]
    );

    const r3 = run({ gstComplianceStatus: null }, ALL_ON);
    assert.equal(crit(r3, 'gst_compliance').status, 'missing');
    assert.equal(crit(r3, 'gst_turnover').status, 'passed');

    const r4 = run({ commercialCreditReportStatus: null });
    assert.equal(crit(r4, 'commercial_cmr').status, 'passed');
  });

  it('a disabled criterion is skipped and not a result row', () => {
    const rules = clone(RULES);
    rules.criteria.business_vintage.enabled = false;
    const r = run({ businessVintageYears: null }, rules);
    assert.ok(!r.criteria.some((c) => c.criterionId === 'business_vintage'));
    assert.deepEqual(nonDefaultSkips(r), [{ criterionId: 'business_vintage', reason: 'disabled' }]);
    assert.equal(r.outcome, 'ELIGIBLE');
  });

  it('criteria disabled in the seed are skipped, and their null inputs are never asked for', () => {
    const r = run({
      gstAnnualTurnover: null,
      gstComplianceStatus: null,
      ebitda: null,
      ebit: null,
      currentAssets: null,
      currentLiabilities: null,
      interestExpense: null,
    });
    for (const id of DISABLED_IDS) {
      assert.ok(!r.criteria.some((c) => c.criterionId === id), `${id} is not a result row`);
      assert.ok(r.skipped.some((s) => s.criterionId === id && s.reason === 'disabled'), `${id} is skipped as disabled`);
    }
    assert.equal(r.outcome, 'ELIGIBLE');
    assert.deepEqual(r.missingMandatoryInputs, []);
    assert.deepEqual(r.missingOptionalInputs, []);
    assert.equal(r.counts.missing, 0);
    assert.doesNotMatch(r.outcomeReason, /GST|EBITDA|EBIT|Current|Interest/);
  });

  it('a disabled criterion whose value would fail never affects the outcome', () => {
    const r = run({ gstComplianceStatus: 'not_compliant', currentAssets: 1, existingMonthlyEmi: 0, ebitda: -1 });
    assert.equal(r.outcome, 'ELIGIBLE');
  });
});

describe('DSCR (section 4.1)', () => {
  it('computed with the project formula: operating cash flow / (principal + EMI x 12)', () => {
    const r = run();
    const d = crit(r, 'dscr');
    // 36 lakh / (6 lakh + 1 lakh x 12) = 2.00
    assert.equal(d.actual, 2);
    assert.equal(d.actualDisplay, '2.00');
    assert.equal(d.sourceField, 'derived:dscr');
    assert.deepEqual(d.inputsUsed.map((u) => u.field), ['operatingCashFlow', 'annualScheduledPrincipalRepayments', 'existingMonthlyEmi']);
    assert.equal(r.derived.dscr, 2);
    assert.equal(r.derived.dscrBasis, 'computed');
  });

  it('profit, depreciation, amortisation and interest do not feed DSCR', () => {
    const d = crit(run({ netProfitAfterTax: null, depreciation: null, amortization: null, interestExpense: null }), 'dscr');
    assert.equal(d.status, 'passed');
    assert.equal(d.actual, 2);
  });

  it('existing monthly EMI is in the denominator (x 12)', () => {
    assert.equal(crit(run({ existingMonthlyEmi: 0 }), 'dscr').actual, 6); // 36 / 6
    assert.equal(crit(run({ existingMonthlyEmi: 250_000 }), 'dscr').actual, 1); // 36 / (6 + 30)
  });

  it('missing when a required input is null and no stated DSCR; dscrStated is not listed', () => {
    const r = run({ operatingCashFlow: null });
    const d = crit(r, 'dscr');
    assert.equal(d.status, 'missing');
    assert.deepEqual(d.missingInputs, ['operatingCashFlow']);
    assert.equal(r.derived.dscr, null);
    assert.equal(r.derived.dscrBasis, null);
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.match(r.outcomeReason, /Operating cash flow is not provided \(mandatory\)/);
  });

  it('lists every null required input', () => {
    const d = crit(run({ operatingCashFlow: null, annualScheduledPrincipalRepayments: null, existingMonthlyEmi: null }), 'dscr');
    assert.deepEqual(d.missingInputs, ['operatingCashFlow', 'annualScheduledPrincipalRepayments', 'existingMonthlyEmi']);
  });

  it('principal repayments or EMI null is missing, never treated as 0', () => {
    for (const key of ['annualScheduledPrincipalRepayments', 'existingMonthlyEmi'] as const) {
      const d = crit(run({ [key]: null }), 'dscr');
      assert.equal(d.status, 'missing');
      assert.deepEqual(d.missingInputs, [key]);
    }
  });

  it('a key absent from a stored input is read as missing, never computed as undefined', () => {
    const legacy = passingInput() as unknown as Record<string, unknown>;
    delete legacy.operatingCashFlow;
    const r = evaluateEligibility(legacy as unknown as EligibilityInput, RULES, { rulesHash: HASH });
    assert.equal(crit(r, 'dscr').status, 'missing');
    assert.deepEqual(crit(r, 'dscr').missingInputs, ['operatingCashFlow']);
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
  });

  it('stated DSCR is used only when not computable, and is capped at conditional', () => {
    const r = run({ operatingCashFlow: null, dscrStated: 1.5 });
    const d = crit(r, 'dscr');
    assert.equal(d.status, 'conditional');
    assert.equal(d.severity, 'condition');
    assert.equal(d.actual, 1.5);
    assert.match(d.reason, /^Stated DSCR, not computed; verify from financials/);
    assert.equal(r.derived.dscrBasis, 'stated');
    assert.equal(r.outcome, 'CONDITIONALLY_ELIGIBLE');

    const computedWins = run({ dscrStated: 0.5 });
    assert.equal(crit(computedWins, 'dscr').actual, 2);
    assert.equal(computedWins.derived.dscrBasis, 'computed');
  });

  it('stated DSCR of 1.00 or below fails', () => {
    for (const stated of [1, 0.9]) {
      const r = run({ existingMonthlyEmi: null, dscrStated: stated });
      assert.equal(crit(r, 'dscr').status, 'failed');
      assert.equal(r.outcome, 'NOT_ELIGIBLE');
    }
  });

  it('denominator 0 (principal 0 and EMI 0) passes with no number', () => {
    const r = run({ annualScheduledPrincipalRepayments: 0, existingMonthlyEmi: 0 });
    const d = crit(r, 'dscr');
    assert.equal(d.status, 'passed');
    assert.equal(d.actual, null);
    assert.equal(d.actualDisplay, 'No existing debt service');
    assert.equal(r.derived.dscr, null);
  });

  it('strictly above 1.00, compared on the value rounded half away from zero', () => {
    assert.equal(crit(dscrOf(101), 'dscr').status, 'passed'); // 1.01
    assert.equal(crit(dscrOf(100), 'dscr').status, 'failed'); // 1.00
    assert.equal(crit(dscrOf(100.4), 'dscr').status, 'failed'); // 1.004 -> 1.00
    assert.equal(crit(dscrOf(100.4), 'dscr').actual, 1);
    assert.equal(crit(dscrOf(100.5), 'dscr').status, 'passed'); // 1.005 -> 1.01
    assert.equal(crit(dscrOf(100.5), 'dscr').actual, 1.01);
    assert.equal(crit(dscrOf(-50), 'dscr').status, 'failed');
  });

  it('expected text and outcome reason', () => {
    assert.equal(crit(run(), 'dscr').expected, 'Above 1.00');
    const r = dscrOf(92);
    assert.equal(r.outcome, 'NOT_ELIGIBLE');
    assert.match(r.outcomeReason, /0\.92 is not above 1\.00 \(it must be strictly above 1\.00\) \(mandatory\)\.$/);
  });
});

describe('zero and negative denominators (section 4)', () => {
  it('banking credits 0 fails banking_credits_vs_requested', () => {
    const r = run({ averageMonthlyBankingCredits: 0 });
    const c = crit(r, 'banking_credits_vs_requested');
    assert.equal(c.status, 'failed');
    assert.equal(c.actual, null);
    assert.equal(c.actualDisplay, 'No banking credits');
    assert.equal(r.derived.requestedToMonthlyCreditsMultiple, null);
    assert.equal(r.outcome, 'NOT_ELIGIBLE');
  });

  it('revenue 0 makes the banking turnover ratio conditional', () => {
    const r = run({ annualRevenue: 0 });
    const c = crit(r, 'banking_turnover_ratio');
    assert.equal(c.status, 'conditional');
    assert.equal(c.actualDisplay, 'Revenue reported as 0; check figures');
    assert.equal(r.derived.bankingTurnoverRatioPercent, null);
  });

  it('TNW zero or negative fails TOL/TNW, never a passing negative ratio', () => {
    for (const tnw of [0, -1_000_000]) {
      const r = run({ tangibleNetWorth: tnw });
      const c = crit(r, 'tol_tnw');
      assert.equal(c.status, 'failed');
      assert.equal(c.actualDisplay, 'Net worth is zero or negative');
      assert.equal(r.derived.tolTnw, null);
    }
  });

  it('FOIR: EMI 0 passes as 0% whatever EBITDA is; EBITDA <= 0 with EMI fails', () => {
    for (const ebitda of [-500_000, 0, 3_000_000]) {
      const c = crit(run({ existingMonthlyEmi: 0, ebitda }, ALL_ON), 'existing_emi_foir');
      assert.equal(c.status, 'passed');
      assert.equal(c.actual, 0);
      assert.equal(c.actualDisplay, '0%');
    }
    for (const ebitda of [0, -1]) {
      const r = run({ existingMonthlyEmi: 10_000, ebitda }, ALL_ON);
      assert.equal(crit(r, 'existing_emi_foir').status, 'failed');
      assert.equal(crit(r, 'existing_emi_foir').actualDisplay, 'EBITDA does not cover any EMI');
      assert.equal(r.derived.foirPercent, null);
    }
  });

  it('current liabilities 0 and interest 0 pass', () => {
    const c = crit(run({ currentLiabilities: 0 }, ALL_ON), 'current_ratio');
    assert.equal(c.status, 'passed');
    assert.equal(c.actualDisplay, 'No current liabilities');
    const i = crit(run({ interestExpense: 0 }, ALL_ON), 'interest_coverage');
    assert.equal(i.status, 'passed');
    assert.equal(i.actualDisplay, 'No interest expense');
  });
});

describe('threshold boundaries', () => {
  it('number_max at passAt and conditionalTo (requested / monthly credits)', () => {
    const status = (requested: number) =>
      crit(run({ requestedAmount: requested, averageMonthlyBankingCredits: 100 }), 'banking_credits_vs_requested').status;
    assert.equal(status(300), 'passed'); // 3.00
    assert.equal(status(300.4), 'passed'); // 3.004 -> 3.00
    assert.equal(status(300.5), 'conditional'); // 3.005 -> 3.01
    assert.equal(status(400), 'conditional'); // 4.00
    assert.equal(status(400.5), 'failed'); // 4.005 -> 4.01
  });

  it('CIBIL score band (user core rule: 750+ eligible, 700 to 749 conditional, below 700 fails)', () => {
    const status = (s: number) => crit(run({ personalCibilScore: s }), 'personal_cibil').status;
    assert.equal(status(750), 'passed');
    assert.equal(status(749), 'conditional');
    assert.equal(status(700), 'conditional');
    assert.equal(status(699), 'failed');
    assert.equal(crit(run(), 'personal_cibil').expected, 'At least 750 (700 to 749 is conditional)');
  });

  it('CMR rank below 7 (strict, no band) and text', () => {
    const status = (n: number) => crit(run({ commercialCmrRank: n }), 'commercial_cmr').status;
    assert.equal(status(1), 'passed');
    assert.equal(status(6), 'passed');
    assert.equal(status(7), 'failed');
    assert.equal(status(10), 'failed');
    assert.equal(crit(run({ commercialCmrRank: 6.5 }), 'commercial_cmr').status, 'passed'); // no validation: still below 7
    assert.equal(crit(run(), 'commercial_cmr').expected, 'Below 7');
    assert.equal(crit(run({ commercialCmrRank: 7 }), 'commercial_cmr').reason, 'Commercial CMR rank 7 is not below 7 (it must be below 7).');
  });

  it('enum classification', () => {
    assert.equal(crit(run({ profitabilityStatus: 'profitable_1_year' }), 'profitability').status, 'conditional');
    assert.equal(crit(run({ profitabilityStatus: 'breakeven_or_early' }), 'profitability').status, 'conditional');
    assert.equal(run({ profitabilityStatus: 'loss_making' }).outcome, 'NOT_ELIGIBLE');
    assert.equal(crit(run({ gstComplianceStatus: 'not_compliant' }, ALL_ON), 'gst_compliance').status, 'failed');
  });

  it('annual turnover in rupees with Indian grouping', () => {
    const c = crit(run(), 'annual_turnover');
    assert.equal(c.actualDisplay, '₹ 2,00,00,000');
    assert.equal(c.sourceField, 'financialProfile.annualRevenue');
    assert.equal(crit(run({ annualRevenue: 5_000_000 }), 'annual_turnover').status, 'passed');
    assert.equal(crit(run({ annualRevenue: 4_999_999.99 }), 'annual_turnover').status, 'conditional');
    assert.equal(crit(run({ annualRevenue: 2_500_000 }), 'annual_turnover').status, 'conditional');
    assert.equal(crit(run({ annualRevenue: 2_499_999 }), 'annual_turnover').status, 'failed');
  });

  it('thresholds come from the rules, not code', () => {
    const rules = clone(RULES);
    const vintage = rules.criteria.business_vintage as NumericCriterionRule;
    vintage.passAt = 10;
    vintage.conditionalTo = null;
    const c = crit(run({ businessVintageYears: 9 }, rules), 'business_vintage');
    assert.equal(c.status, 'failed');
    assert.equal(c.expected, 'At least 10 years');
  });
});

describe('nothing mandatory evaluated (rule 2a)', () => {
  const mandatoryIds = (rules: EligibilityRuleConfig) =>
    (Object.keys(rules.criteria) as EligibilityCriterionId[]).filter((id) => rules.criteria[id].mandatory);

  it('every mandatory criterion skipped by entity type gives INCOMPLETE_DOCUMENTS, not ELIGIBLE', () => {
    const rules = clone(RULES);
    for (const id of mandatoryIds(rules)) rules.criteria[id].appliesToEntityTypes = ['llp'];
    assert.deepEqual(validateRuleConfig(rules), []);
    const r = run({}, rules); // private_limited; every non-mandatory row passes
    assert.ok(r.criteria.length > 0);
    assert.ok(r.criteria.every((c) => !c.mandatory && c.status === 'passed'));
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.deepEqual(r.missingMandatoryInputs, []);
    assert.match(r.outcomeReason, /^Incomplete documents: no mandatory criterion could be evaluated \(.*Business vintage: not applicable to this entity type.*\), so eligibility cannot be confirmed\.$/);
  });

  it('also when a non-mandatory row is conditional or failed', () => {
    const rules = clone(RULES);
    for (const id of mandatoryIds(rules)) rules.criteria[id].appliesToEntityTypes = ['llp'];
    assert.equal(run({ totalOutsideLiabilities: 20_000_000 }, rules).outcome, 'INCOMPLETE_DOCUMENTS'); // tol_tnw failed
    assert.equal(run({ businessVintageYears: 2.5, totalOutsideLiabilities: null }, rules).outcome, 'INCOMPLETE_DOCUMENTS');
  });

  it('every mandatory criterion skipped by skipWhen gives INCOMPLETE_DOCUMENTS', () => {
    const rules = clone(RULES);
    // Only profitability stays mandatory and enabled; it is skipped when GST is not_applicable (a rules choice).
    for (const id of mandatoryIds(rules)) if (id !== 'profitability') rules.criteria[id].enabled = false;
    rules.criteria.profitability.skipWhen = { field: 'gstComplianceStatus', values: ['not_applicable'] };
    assert.deepEqual(validateRuleConfig(rules), []);
    const r = run({ gstComplianceStatus: 'not_applicable' }, rules);
    assert.ok(r.skipped.some((s) => s.criterionId === 'profitability' && s.reason === 'skip_when_matched'));
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.match(r.outcomeReason, /Profitability track record: skipped by its skip condition/);
    assert.ok(!/Business vintage/.test(r.outcomeReason), 'disabled criteria are not named');
  });

  it('zero result rows gives INCOMPLETE_DOCUMENTS', () => {
    const rules = clone(RULES);
    for (const id of Object.keys(rules.criteria) as EligibilityCriterionId[]) {
      if (rules.criteria[id].mandatory) rules.criteria[id].appliesToEntityTypes = ['llp'];
      else rules.criteria[id].enabled = false;
    }
    assert.deepEqual(validateRuleConfig(rules), []);
    const r = run({}, rules);
    assert.equal(r.criteria.length, 0);
    assert.equal(r.outcome, 'INCOMPLETE_DOCUMENTS');
    assert.match(r.outcomeReason, /^Incomplete documents: no criterion could be evaluated/);
  });
});

describe('bureau score (section 4.2)', () => {
  it('is compared exactly, never rounded: 699.995 is not 700, 749.995 is not 750', () => {
    const c = crit(run({ personalCibilScore: 699.995 }), 'personal_cibil'); // engine called without validation
    assert.equal(c.status, 'failed');
    assert.equal(crit(run({ personalCibilScore: 749.995 }), 'personal_cibil').status, 'conditional');
    assert.equal(c.actual, 699.995);
    assert.equal(c.actualDisplay, '699.995');
    assert.equal(crit(run({ personalCibilScore: null, promoterCibilScore: 649.999 }), 'personal_cibil').status, 'failed');
  });

  it('validation rejects a non-integer score', () => {
    for (const key of ['personalCibilScore', 'promoterCibilScore'] as const) {
      const bad = validateEligibilityInput(passingInput({ [key]: 699.995 }));
      assert.equal(bad.ok, false);
      assert.deepEqual(!bad.ok && bad.fields, [key]);
      assert.equal(validateEligibilityInput(passingInput({ [key]: 700 })).ok, true);
    }
  });

  it('uses the lower of personal and promoter scores and names it', () => {
    const c = crit(run({ personalCibilScore: 760, promoterCibilScore: 720 }), 'personal_cibil');
    assert.equal(c.actual, 720);
    assert.equal(c.status, 'conditional');
    assert.equal(c.sourceField, 'financialProfile.promoterCibilScore');
  });

  it('uses the promoter score alone when personal is null', () => {
    const c = crit(run({ personalCibilScore: null, promoterCibilScore: 780 }), 'personal_cibil');
    assert.equal(c.status, 'passed');
    assert.equal(c.sourceField, 'financialProfile.promoterCibilScore');
  });

  it('commercial CMR never feeds the bureau score', () => {
    const c = crit(run({ personalCibilScore: null, commercialCmrRank: 1 }), 'personal_cibil');
    assert.equal(c.status, 'missing');
    assert.deepEqual(c.missingInputs, ['personalCibilScore']);
  });
});

describe('rounding and formatting', () => {
  it('rounds half away from zero at 2 dp', () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(-1.005), -1.01);
    assert.equal(round2(2.675), 2.68);
    assert.equal(round2(1.244), 1.24);
  });

  it('groups digits the Indian way', () => {
    assert.equal(indianGrouping(4_800_000), '48,00,000');
    assert.equal(indianGrouping(123_456_789), '12,34,56,789');
    assert.equal(indianGrouping(999), '999');
    assert.equal(indianGrouping(1234.5), '1,234.50');
  });
});

describe('rules validation (section 5.3)', () => {
  const invalidWith = (mutate: (r: Record<string, any>) => void) => {
    const r = clone(RULES) as unknown as Record<string, any>;
    mutate(r);
    return validateRuleConfig(r).length > 0;
  };

  it('rejects a wrong schema version, missing or extra criteria and a wrong kind', () => {
    assert.ok(invalidWith((r) => (r.schemaVersion = 2)));
    assert.ok(invalidWith((r) => delete r.criteria.dscr));
    assert.ok(invalidWith((r) => (r.criteria.extra = clone(r.criteria.dscr))));
    assert.ok(invalidWith((r) => (r.criteria.dscr.kind = 'number_max')));
  });

  it('rejects non-finite numbers and inverted bands', () => {
    assert.ok(invalidWith((r) => (r.criteria.dscr.passAt = 'x')));
    assert.ok(invalidWith((r) => (r.criteria.dscr.conditionalTo = 1.5)));
    assert.ok(invalidWith((r) => (r.criteria.tol_tnw.conditionalTo = 2)));
    assert.ok(!invalidWith((r) => (r.criteria.dscr.conditionalTo = null)));
  });

  it('validates the strict (exclusive) bound', () => {
    assert.ok(invalidWith((r) => (r.criteria.dscr.strict = 'yes')));
    assert.ok(invalidWith((r) => (r.criteria.dscr.conditionalTo = 0.9))); // strict needs no band
    assert.ok(invalidWith((r) => (r.criteria.profitability.strict = true)));
    assert.ok(!invalidWith((r) => (r.criteria.tol_tnw.strict = false)));
    assert.ok(!invalidWith((r) => delete r.criteria.dscr.strict));
  });

  it('requires every enum value in exactly one list or skipWhen', () => {
    assert.ok(invalidWith((r) => (r.criteria.profitability.fail = [])));
    assert.ok(invalidWith((r) => r.criteria.profitability.pass.push('loss_making')));
    assert.ok(invalidWith((r) => r.criteria.profitability.pass.push('not_provided')));
    assert.ok(invalidWith((r) => (r.criteria.gst_compliance.skipWhen = null)));
  });

  it('requires at least one enabled mandatory criterion', () => {
    assert.ok(
      invalidWith((r) => {
        for (const c of Object.values(r.criteria) as Array<Record<string, unknown>>) c.mandatory = false;
      })
    );
  });

  it('hash is stable under key order', () => {
    assert.equal(hashRules({ b: 1, a: [2, { d: 1, c: 2 }] }), hashRules({ a: [2, { c: 2, d: 1 }], b: 1 }));
    assert.notEqual(hashRules({ a: [1, 2] }), hashRules({ a: [2, 1] }));
    assert.match(HASH, /^[0-9a-f]{64}$/);
  });
});

describe('input validation (section 3)', () => {
  const fieldsOf = (raw: unknown) => {
    const r = validateEligibilityInput(raw);
    return r.ok ? [] : r.fields;
  };

  it('accepts a full input and nulls', () => {
    assert.deepEqual(fieldsOf(passingInput()), []);
    assert.deepEqual(fieldsOf(passingInput({ netProfitAfterTax: -1, tangibleNetWorth: -5, ebit: -2 })), []);
  });

  it('rejects missing and extra keys', () => {
    const missing = passingInput() as unknown as Record<string, unknown>;
    delete missing.dscrStated;
    assert.deepEqual(fieldsOf(missing), ['dscrStated']);
    assert.deepEqual(fieldsOf({ ...passingInput(), creditScore: 700 }), ['creditScore']);
  });

  it('rejects out-of-range or wrong-typed values without coercion', () => {
    assert.deepEqual(fieldsOf(passingInput({ requestedAmount: 0 })), ['requestedAmount']);
    assert.deepEqual(fieldsOf(passingInput({ personalCibilScore: -1 })), ['personalCibilScore']);
    assert.deepEqual(fieldsOf(passingInput({ personalCibilScore: 0 })), ['personalCibilScore']);
    assert.deepEqual(fieldsOf(passingInput({ requestedTenureMonths: 12.5 })), ['requestedTenureMonths']);
    assert.deepEqual(fieldsOf(passingInput({ commercialCmrRank: 11 })), ['commercialCmrRank']);
    assert.deepEqual(fieldsOf(passingInput({ depreciation: -1 })), ['depreciation']);
    assert.deepEqual(fieldsOf(passingInput({ dscrStated: 101 })), ['dscrStated']);
    assert.deepEqual(fieldsOf({ ...passingInput(), annualRevenue: '1000' }), ['annualRevenue']);
    assert.deepEqual(fieldsOf({ ...passingInput(), annualRevenue: Number.NaN }), ['annualRevenue']);
    assert.deepEqual(fieldsOf({ ...passingInput(), profitabilityStatus: 'not_provided' }), ['profitabilityStatus']);
    assert.deepEqual(fieldsOf({ ...passingInput(), entityType: 'company' }), ['entityType']);
  });
});
