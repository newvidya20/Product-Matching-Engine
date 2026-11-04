/**
 * Eligibility field mapping. Contract: docs/eligibility-contracts.md sections 6 and 7.3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FieldResult, FieldStatus } from '../src/types/documentAi.ts';
import type { BorrowerAssessment } from '../src/types/domain.ts';
import type { EligibilityAssessmentRecord } from '../src/types/eligibility.ts';
import { EMPTY_ELIGIBILITY_INPUT } from '../src/types/eligibility.ts';
import { buildNewAssessmentPrefill, buildPrefill } from '../server/eligibility/prefill.ts';
import { passingInput } from './helpers/eligibility.ts';

const SESSION = 'ds_11111111-2222-4333-8444-555555555555';

function field(fieldId: string, status: FieldStatus, value: string | number | null, mirrorOf: string | null = null): FieldResult {
  return {
    fieldId,
    status,
    value,
    confidence: 0.95,
    source: null,
    reasons: [],
    candidates: [],
    suggestedCandidateId: null,
    mirrorOf,
    overriddenByUser: false,
  };
}

function fields(...list: FieldResult[]): Record<string, FieldResult> {
  return Object.fromEntries(list.map((f) => [f.fieldId, f]));
}

function assessment(overrides: Partial<BorrowerAssessment> = {}): BorrowerAssessment {
  return {
    id: 'asm_fictional_1',
    referenceCode: 'LB-CASE-1001',
    applicantLabel: 'FICTIONAL Traders Pvt Ltd',
    entityType: 'private_limited',
    assignedOfficer: '',
    branchOrDesk: '',
    requestedAmount: 0,
    currency: 'INR',
    requestedTenureMonths: 12,
    annualTurnoverOrIncome: 0,
    collateralAvailable: false,
    collateralDescription: '',
    statedPurpose: '',
    advisorNotes: '',
    customAttributes: [],
    status: 'draft',
    isFictionalDemo: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    latestEvaluation: null,
    ...overrides,
  } as BorrowerAssessment;
}

describe('prefill from a Document AI session', () => {
  it('takes only auto_applied values; others stay null and are listed as pending', () => {
    const out = buildPrefill({
      assessment: null,
      documentSessionId: SESSION,
      sessionFields: fields(
        field('financialProfile.annualRevenue', 'auto_applied', 12_000_000),
        field('financialProfile.netProfitAfterTax', 'needs_verification', 800_000),
        field('financialProfile.ebitda', 'conflict', null),
        field('financialProfile.depreciation', 'rejected_validation', null),
        field('profitabilityStatus', 'needs_verification', 'profitable_2plus_years')
      ),
    });
    assert.equal(out.input.annualRevenue, 12_000_000);
    assert.deepEqual(out.inputSources.annualRevenue, {
      kind: 'document_ai',
      documentSessionId: SESSION,
      fieldId: 'financialProfile.annualRevenue',
    });
    assert.equal(out.input.netProfitAfterTax, null);
    assert.equal(out.input.ebitda, null);
    assert.equal(out.input.depreciation, null);
    assert.equal(out.input.profitabilityStatus, null);
    assert.deepEqual(
      out.pendingVerification.map((p) => [p.field, p.status]),
      [
        ['netProfitAfterTax', 'needs_verification'],
        ['ebitda', 'conflict'],
        ['depreciation', 'rejected_validation'],
        ['profitabilityStatus', 'needs_verification'],
      ]
    );
    assert.equal(out.documentSessionId, SESSION);
  });

  it('never reads mirrors or ratios from a session', () => {
    const out = buildPrefill({
      assessment: null,
      documentSessionId: SESSION,
      sessionFields: fields(
        field('creditScore', 'auto_applied', 760, 'financialProfile.personalCibilScore'),
        field('existingEmiObligations', 'auto_applied', 20_000, 'financialProfile.existingMonthlyEmi'),
        field('annualTurnoverOrIncome', 'auto_applied', 9_000_000, 'financialProfile.annualRevenue'),
        field('gstTaxCompliant', 'auto_applied', 'yes', 'financialProfile.gstComplianceStatus'),
        field('financialProfile.ratios.dscr', 'auto_applied', 1.6)
      ),
    });
    assert.deepEqual(out.input, EMPTY_ELIGIBILITY_INPUT);
    assert.deepEqual(out.inputSources, {});
  });

  it('a session with no state gives all null', () => {
    const out = buildPrefill({ assessment: null, documentSessionId: SESSION, sessionFields: null });
    assert.deepEqual(out.input, EMPTY_ELIGIBILITY_INPUT);
    assert.equal(out.applicantLabel, null);
  });

  it('applicantLabel from a session only when auto_applied', () => {
    const pending = buildPrefill({
      assessment: null,
      documentSessionId: SESSION,
      sessionFields: fields(field('applicantLabel', 'needs_verification', 'FICTIONAL Co')),
    });
    assert.equal(pending.applicantLabel, null);
    const applied = buildPrefill({
      assessment: null,
      documentSessionId: SESSION,
      sessionFields: fields(field('applicantLabel', 'auto_applied', 'FICTIONAL Co')),
    });
    assert.equal(applied.applicantLabel, 'FICTIONAL Co');
  });
});

describe('prefill from a saved assessment', () => {
  it('assessment value wins over a Document AI value; Document AI fills nulls', () => {
    const out = buildPrefill({
      assessment: assessment({ financialProfile: { annualRevenue: 15_000_000 } }),
      documentSessionId: SESSION,
      sessionFields: fields(
        field('financialProfile.annualRevenue', 'auto_applied', 12_000_000),
        field('financialProfile.ebitda', 'auto_applied', 2_000_000)
      ),
    });
    assert.equal(out.input.annualRevenue, 15_000_000);
    assert.deepEqual(out.inputSources.annualRevenue, {
      kind: 'assessment',
      assessmentId: 'asm_fictional_1',
      path: 'financialProfile.annualRevenue',
    });
    assert.equal(out.input.ebitda, 2_000_000);
    assert.equal(out.inputSources.ebitda?.kind, 'document_ai');
    assert.equal(out.applicantLabel, 'FICTIONAL Traders Pvt Ltd');
  });

  it('applies the named rules: requestedAmount 0 is blank, turnover 0 is unknown, EMI 0 is real', () => {
    const out = buildPrefill({
      assessment: assessment({ requestedAmount: 0, annualTurnoverOrIncome: 0, existingEmiObligations: 0 }),
      documentSessionId: null,
      sessionFields: null,
    });
    assert.equal(out.input.requestedAmount, null);
    assert.equal(out.input.annualRevenue, null);
    assert.equal(out.input.existingMonthlyEmi, 0);
    assert.deepEqual(out.inputSources.existingMonthlyEmi, {
      kind: 'assessment',
      assessmentId: 'asm_fictional_1',
      path: 'existingEmiObligations',
    });
  });

  it('uses fallbacks only when the primary is null, and records the fallback path', () => {
    const withFallbacks = buildPrefill({
      assessment: assessment({ creditScore: 710, annualTurnoverOrIncome: 9_000_000, gstTaxCompliant: 'yes' }),
      documentSessionId: null,
      sessionFields: null,
    });
    assert.equal(withFallbacks.input.personalCibilScore, 710);
    assert.equal((withFallbacks.inputSources.personalCibilScore as { path: string }).path, 'creditScore');
    assert.equal(withFallbacks.input.annualRevenue, 9_000_000);
    assert.equal((withFallbacks.inputSources.annualRevenue as { path: string }).path, 'annualTurnoverOrIncome');
    assert.equal(withFallbacks.input.gstComplianceStatus, 'compliant');
    assert.equal((withFallbacks.inputSources.gstComplianceStatus as { path: string }).path, 'gstTaxCompliant');

    const primaries = buildPrefill({
      assessment: assessment({
        creditScore: 710,
        gstTaxCompliant: 'no',
        financialProfile: { personalCibilScore: 745, gstComplianceStatus: 'not_applicable' },
      }),
      documentSessionId: null,
      sessionFields: null,
    });
    assert.equal(primaries.input.personalCibilScore, 745);
    assert.equal(primaries.input.gstComplianceStatus, 'not_applicable');
  });

  it("'not_provided', absent, '' and NaN read as null; ratios.dscr is never read", () => {
    const out = buildPrefill({
      assessment: assessment({
        profitabilityStatus: 'not_provided',
        gstTaxCompliant: 'not_provided',
        businessVintageYears: Number.NaN,
        financialProfile: {
          gstComplianceStatus: 'not_provided',
          commercialCreditReportStatus: 'not_provided',
          ebitda: '' as unknown as number,
          ratios: { dscr: 1.8 },
        } as BorrowerAssessment['financialProfile'],
      }),
      documentSessionId: null,
      sessionFields: null,
    });
    assert.equal(out.input.profitabilityStatus, null);
    assert.equal(out.input.gstComplianceStatus, null);
    assert.equal(out.input.commercialCreditReportStatus, null);
    assert.equal(out.input.businessVintageYears, null);
    assert.equal(out.input.ebitda, null);
    assert.equal(out.input.dscrStated, null);
  });

  it('operating cash flow (DSCR numerator) maps from the assessment and from an auto_applied document value; 0 is real', () => {
    const fromAssessment = buildPrefill({
      assessment: assessment({ financialProfile: { operatingCashFlow: 0 } }),
      documentSessionId: null,
      sessionFields: null,
    });
    assert.equal(fromAssessment.input.operatingCashFlow, 0);
    assert.equal((fromAssessment.inputSources.operatingCashFlow as { path: string }).path, 'financialProfile.operatingCashFlow');

    const fromSession = buildPrefill({
      assessment: null,
      documentSessionId: SESSION,
      sessionFields: fields(field('financialProfile.operatingCashFlow', 'auto_applied', -250_000)),
    });
    assert.equal(fromSession.input.operatingCashFlow, -250_000);

    const absent = buildPrefill({ assessment: assessment(), documentSessionId: null, sessionFields: null });
    assert.equal(absent.input.operatingCashFlow, null);
  });
});

describe('continue prefill (section 7.3)', () => {
  const record = (overrides: Partial<EligibilityAssessmentRecord['input']>): EligibilityAssessmentRecord =>
    ({
      id: 'elg_11111111-2222-4333-8444-555555555555',
      applicantLabel: 'FICTIONAL Co',
      documentSessionId: SESSION,
      input: passingInput(overrides),
    }) as EligibilityAssessmentRecord;

  it('writes mirrors and only non-null inputs', () => {
    const p = buildNewAssessmentPrefill(record({ ebit: null, dscrStated: 1.4, gstComplianceStatus: 'not_compliant' }));
    assert.equal(p.assessment.creditScore, 750);
    assert.equal(p.financialProfile.personalCibilScore, 750);
    assert.equal(p.assessment.existingEmiObligations, 100_000);
    assert.equal(p.financialProfile.existingMonthlyEmi, 100_000);
    assert.equal(p.financialProfile.operatingCashFlow, 3_600_000);
    assert.equal(p.assessment.annualTurnoverOrIncome, 20_000_000);
    assert.equal(p.financialProfile.annualRevenue, 20_000_000);
    assert.equal(p.assessment.gstTaxCompliant, 'no');
    assert.equal(p.financialProfile.gstComplianceStatus, 'not_compliant');
    assert.deepEqual(p.financialProfile.ratios, { dscr: 1.4 });
    assert.equal(p.assessment.entityType, 'private_limited');
    assert.equal(p.assessment.businessVintageYears, 5);
    assert.ok(!('ebit' in p.financialProfile));
    assert.equal(p.documentSessionId, SESSION);
    assert.equal(p.eligibilityRecordId, 'elg_11111111-2222-4333-8444-555555555555');
  });

  it('gstTaxCompliant is yes or no only for compliant / not_compliant, never a guessed no', () => {
    assert.equal(buildNewAssessmentPrefill(record({ gstComplianceStatus: 'compliant' })).assessment.gstTaxCompliant, 'yes');
    assert.equal(buildNewAssessmentPrefill(record({ gstComplianceStatus: 'not_compliant' })).assessment.gstTaxCompliant, 'no');
    const na = buildNewAssessmentPrefill(record({ gstComplianceStatus: 'not_applicable' }));
    assert.ok(!('gstTaxCompliant' in na.assessment), 'not_applicable must not become gstTaxCompliant no');
    assert.equal(na.financialProfile.gstComplianceStatus, 'not_applicable');
    const none = buildNewAssessmentPrefill(record({ gstComplianceStatus: null }));
    assert.ok(!('gstTaxCompliant' in none.assessment));
    assert.ok(!('gstComplianceStatus' in none.financialProfile));
  });

  it('creditScore takes the promoter score when the personal score is null', () => {
    const p = buildNewAssessmentPrefill(record({ personalCibilScore: null, promoterCibilScore: 705 }));
    assert.equal(p.assessment.creditScore, 705);
    assert.ok(!('personalCibilScore' in p.financialProfile));
    assert.equal(p.financialProfile.promoterCibilScore, 705);
  });
});
