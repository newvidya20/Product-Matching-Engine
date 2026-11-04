/** The fictional demo borrower really evaluates to CONDITIONALLY_ELIGIBLE under the default rules. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEligibility } from '../server/eligibility/engine.ts';
import { hashRules } from '../server/eligibility/rules.ts';
import { validateEligibilityInput } from '../server/eligibility/inputSchema.ts';
import { defaultRules } from './helpers/eligibility.ts';
import { DEMO_APPLICANT_LABEL, DEMO_ELIGIBILITY_INPUT, demoBorrowerForm } from '../src/components/eligibility/demoData.ts';
import { createBlankForm } from '../src/components/documentAi/formModel.ts';

describe('fictional demo borrower', () => {
  const rules = defaultRules();
  const result = evaluateEligibility(DEMO_ELIGIBILITY_INPUT, rules, { rulesHash: hashRules(rules), now: new Date('2026-11-04T00:00:00Z') });

  it('is conditionally eligible with nothing missing or failed', () => {
    assert.equal(result.outcome, 'CONDITIONALLY_ELIGIBLE');
    assert.deepEqual(result.missingMandatoryInputs, []);
    assert.equal(result.counts.failed, 0);
    assert.ok(result.counts.conditional >= 1);
  });

  it('passes server input validation and is labelled fictional', () => {
    assert.equal(validateEligibilityInput(DEMO_ELIGIBILITY_INPUT).ok, true);
    assert.ok(DEMO_APPLICANT_LABEL.startsWith('[FICTIONAL DEMO]'));
  });

  it('New Assessment demo carries the same numbers in section 04', () => {
    const f = demoBorrowerForm(createBlankForm('INR'), '');
    const p = f.financialProfile;
    assert.equal(f.isFictionalDemo, true);
    assert.equal(p.annualRevenue, '54000000');
    assert.equal(p.personalCibilScore, '735');
    assert.equal(p.commercialCmrRank, '5');
    assert.equal(p.tangibleNetWorth, '18000000');
    assert.equal(p.totalOutsideLiabilities, '54000000');
    assert.equal(p.operatingCashFlow, '7200000');
    assert.equal(p.annualScheduledPrincipalRepayments, '3000000');
    assert.equal(p.existingMonthlyEmi, '185000');
    assert.equal(p.averageMonthlyBankingCredits, '3900000');
    assert.equal(f.creditScore, '735');
  });
});
