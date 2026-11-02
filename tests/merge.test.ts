/**
 * Merge tests. Contract: docs/contracts.md sections 4.1 to 4.5 and 5.
 * mergeSessionResults is the contract export of server/documentAi/pipeline.ts (section 2). The merge rules
 * live in server/documentAi/merge.ts behind it. Expected to fail until extraction-engineer's merge lands.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DocumentExtractionSuccess,
  FieldResult,
  MergeSessionInput,
  MergeSessionOutput,
} from '../src/types/documentAi.ts';
import { mergeSessionResults } from '../server/documentAi/pipeline.ts';
import { getFieldDefinition } from '../src/documentAi/fieldMap.ts';
import {
  TODAY,
  buildGstin,
  candidate,
  documentId,
  successDocument,
  type CandidateSpec,
} from './helpers/documentAi.ts';

const REVENUE = 'financialProfile.annualRevenue';
const PREVIOUS_REVENUE = 'financialProfile.previousAnnualRevenue';
const GST_TURNOVER = 'financialProfile.gstAnnualTurnover';
const TURNOVER_MIRROR = 'annualTurnoverOrIncome';
const PAT = 'financialProfile.netProfitAfterTax';
const PERSONAL_CIBIL = 'financialProfile.personalCibilScore';
const PROMOTER_CIBIL = 'financialProfile.promoterCibilScore';
const CREDIT_SCORE_MIRROR = 'creditScore';
const BANK_OD_UTILISATION = 'financialProfile.ccOdUtilisation';
const GSTIN = 'identity.gstin';
const PAN = 'identity.pan';

function run(documents: DocumentExtractionSuccess[], overrides: Partial<MergeSessionInput> = {}): MergeSessionOutput {
  return mergeSessionResults({
    documents,
    editedFieldIds: [],
    autoApplyThreshold: 0.85,
    today: TODAY,
    ...overrides,
  });
}

function result(output: MergeSessionOutput, fieldId: string): FieldResult {
  const found = output.fields[fieldId];
  assert.ok(found, `expected a field result for ${fieldId}`);
  return found;
}

function cand(spec: CandidateSpec) {
  return candidate(spec);
}

const DOC_STATEMENT = documentId(1);
const DOC_STATEMENT_B = documentId(2);
const DOC_GST = documentId(3);
const DOC_CREDIT = documentId(4);
const DOC_REG = documentId(5);
const DOC_GST_CERT = documentId(6);
const DOC_LOAN = documentId(7);
const DOC_BANK_A = documentId(8);
const DOC_BANK_B = documentId(9);
const DOC_PAN = documentId(10);
const DOC_CREDIT_B = documentId(12);

describe('thresholds (contract 4.1)', () => {
  const revenue = (confidence: number) =>
    successDocument(DOC_STATEMENT, 'financial_statement', [
      cand({
        documentId: DOC_STATEMENT,
        documentType: 'financial_statement',
        fieldId: REVENUE,
        value: 12500000,
        rawValue: '1,25,00,000',
        confidence,
      }),
    ]);

  it('auto-applies at exactly the default threshold of 0.85', () => {
    const r = result(run([revenue(0.85)]), REVENUE);
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.value, 12500000);
  });

  it('marks a candidate just below the threshold needs_verification with low_confidence', () => {
    const r = result(run([revenue(0.84)]), REVENUE);
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('low_confidence'));
    assert.equal(r.value, 12500000);
  });

  it('uses the threshold passed in, not a constant', () => {
    assert.equal(result(run([revenue(0.75)], { autoApplyThreshold: 0.7 }), REVENUE).status, 'auto_applied');
    const strict = result(run([revenue(0.85)], { autoApplyThreshold: 0.9 }), REVENUE);
    assert.equal(strict.status, 'needs_verification');
    assert.ok(strict.reasons.includes('low_confidence'));
  });

  it('keeps a candidate at exactly 0.50 and marks it needs_verification', () => {
    const r = result(run([revenue(0.5)]), REVENUE);
    assert.equal(r.status, 'needs_verification');
  });

  it('drops a candidate below 0.50 so no field result is stored', () => {
    // The PAT candidate in the same document is a positive control: it must survive.
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000', confidence: 0.49 }),
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: PAT, value: 300000, rawValue: '3,00,000', confidence: 0.95, n: 1 }),
      ]),
    ]);
    assert.ok(output.fields[PAT], 'control: a 0.95 candidate in the same document is kept');
    assert.equal(output.fields[REVENUE], undefined);
  });
});

describe('dropped candidates (contract 4.2 rule 1)', () => {
  // Each test keeps a valid candidate in the same document as a positive control, so an empty merge cannot pass.
  const control = () =>
    cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: PAT, value: 300000, rawValue: '3,00,000', n: 9 });

  it('drops unknown field IDs silently', () => {
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: 'madeUp.field', value: 1 }),
        control(),
      ]),
    ]);
    assert.ok(output.fields[PAT], 'control field must be present');
    assert.equal(output.fields['madeUp.field'], undefined);
  });

  it('drops fields the document must not decide: assignedOfficer and advisorNotes', () => {
    const output = run([
      successDocument(DOC_REG, 'registration_certificate', [
        cand({
          documentId: DOC_REG,
          documentType: 'registration_certificate',
          fieldId: 'assignedOfficer',
          value: 'Employee A',
          rawValue: 'Employee A',
          snippet: 'Employee A',
        }),
        cand({
          documentId: DOC_REG,
          documentType: 'registration_certificate',
          fieldId: 'advisorNotes',
          value: 'Strong',
          rawValue: 'Strong',
          snippet: 'Strong',
        }),
        cand({
          documentId: DOC_REG,
          documentType: 'registration_certificate',
          fieldId: 'applicantLabel',
          value: 'Sample Fictional Traders Private Limited',
          n: 9,
        }),
      ]),
    ]);
    assert.ok(output.fields.applicantLabel, 'control field must be present');
    assert.equal(output.fields.assignedOfficer, undefined);
    assert.equal(output.fields.advisorNotes, undefined);
  });

  it('drops a model-returned value for a mirror field; only the primary is asked', () => {
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({
          documentId: DOC_STATEMENT,
          documentType: 'financial_statement',
          fieldId: TURNOVER_MIRROR,
          value: 13200000,
          rawValue: '1,32,00,000',
        }),
        control(),
      ]),
    ]);
    assert.ok(output.fields[PAT], 'control field must be present');
    assert.equal(output.fields[TURNOVER_MIRROR], undefined);
  });
});

describe('validation (contract 4.2 rule 3)', () => {
  it('rejects a value the validator could not parse, showing rawValue but no value', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({
            documentId: DOC_STATEMENT,
            documentType: 'financial_statement',
            fieldId: REVENUE,
            value: null,
            rawValue: 'USD 5,000',
            status: 'rejected_validation',
            reasons: ['non_inr_currency'],
          }),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'rejected_validation');
    assert.equal(r.value, null);
  });

  it('rejects a negative value for a non_negative field', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({
            documentId: DOC_STATEMENT,
            documentType: 'financial_statement',
            fieldId: REVENUE,
            value: -500000,
            rawValue: '(5,00,000)',
          }),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'rejected_validation');
    assert.equal(r.value, null);
  });

  it('keeps a negative value for a signed field such as PAT', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({
            documentId: DOC_STATEMENT,
            documentType: 'financial_statement',
            fieldId: PAT,
            value: -1250000,
            rawValue: '(12,50,000)',
            snippet: 'Profit / (Loss) after tax (12,50,000)',
          }),
        ]),
      ]),
      PAT
    );
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.value, -1250000);
  });

  it('rejects a value outside min and max', () => {
    const r = result(
      run([
        successDocument(DOC_CREDIT, 'credit_report', [
          cand({ documentId: DOC_CREDIT, documentType: 'credit_report', fieldId: PERSONAL_CIBIL, value: 950 }),
        ]),
      ]),
      PERSONAL_CIBIL
    );
    assert.equal(r.status, 'rejected_validation');
    assert.equal(r.value, null);
  });

  it('rejects an enum value outside allowedValues', () => {
    const r = result(
      run([
        successDocument(DOC_REG, 'registration_certificate', [
          cand({
            documentId: DOC_REG,
            documentType: 'registration_certificate',
            fieldId: 'entityType',
            value: 'trust',
            snippet: 'Trust registration',
          }),
        ]),
      ]),
      'entityType'
    );
    assert.equal(r.status, 'rejected_validation');
    assert.equal(r.value, null);
  });
});

describe('snippet check (contract 4.2 rule 4)', () => {
  const revenueFrom = (snippet: string) =>
    successDocument(DOC_STATEMENT, 'financial_statement', [
      cand({
        documentId: DOC_STATEMENT,
        documentType: 'financial_statement',
        fieldId: REVENUE,
        value: 1250000,
        rawValue: '12,50,000',
        snippet,
      }),
    ]);

  it('auto-applies when the digits of the value appear in the snippet, ignoring separators', () => {
    assert.equal(result(run([revenueFrom('Total turnover 12,50,000')]), REVENUE).status, 'auto_applied');
  });

  it('marks value_not_in_snippet when the snippet shows a different number', () => {
    const r = result(run([revenueFrom('Total turnover 1,00,000')]), REVENUE);
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('value_not_in_snippet'));
  });

  it('checks strings case-insensitively against the snippet', () => {
    const name = 'FICTIONAL SAMPLE TRADERS PRIVATE LIMITED';
    const ok = run([
      successDocument(DOC_REG, 'registration_certificate', [
        cand({
          documentId: DOC_REG,
          documentType: 'registration_certificate',
          fieldId: 'applicantLabel',
          value: name,
          snippet: name.toLowerCase(),
        }),
      ]),
    ]);
    assert.equal(result(ok, 'applicantLabel').status, 'auto_applied');

    const missing = run([
      successDocument(DOC_REG, 'registration_certificate', [
        cand({
          documentId: DOC_REG,
          documentType: 'registration_certificate',
          fieldId: 'applicantLabel',
          value: name,
          snippet: 'Entirely different wording',
        }),
      ]),
    ]);
    assert.equal(result(missing, 'applicantLabel').status, 'needs_verification');
  });

  it('only requires a non-empty snippet for enums', () => {
    const r = result(
      run([
        successDocument(DOC_REG, 'registration_certificate', [
          cand({
            documentId: DOC_REG,
            documentType: 'registration_certificate',
            fieldId: 'entityType',
            value: 'llp',
            snippet: 'Partnership registration for a limited liability partnership',
          }),
        ]),
      ]),
      'entityType'
    );
    assert.equal(r.status, 'auto_applied');
  });
});

describe('source types and explicit requests (contract 4.2, 4.4)', () => {
  it('marks a value from a document type outside sourceDocumentTypes as unexpected_source_type', () => {
    const r = result(
      run([
        successDocument(DOC_GST, 'gst_return', [
          cand({ documentId: DOC_GST, documentType: 'gst_return', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('unexpected_source_type'));
  });

  it('marks an "other" document as unexpected_source_type', () => {
    const r = result(
      run([
        successDocument(DOC_GST, 'other', [
          cand({ documentId: DOC_GST, documentType: 'other', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('unexpected_source_type'));
  });

  it('never lets an existing sanction letter supply requestedAmount', () => {
    const r = result(
      run([
        successDocument(DOC_LOAN, 'existing_sanction_letter', [
          cand({
            documentId: DOC_LOAN,
            documentType: 'existing_sanction_letter',
            fieldId: 'requestedAmount',
            value: 5000000,
            rawValue: '50,00,000',
            snippet: 'Existing facility sanctioned at Rs. 50,00,000',
          }),
        ]),
      ]),
      'requestedAmount'
    );
    assert.notEqual(r.status, 'auto_applied');
    assert.ok(r.reasons.includes('unexpected_source_type'));
  });

  it('auto-applies a requestedAmount the borrower states in a loan application', () => {
    const r = result(
      run([
        successDocument(DOC_LOAN, 'loan_application', [
          cand({
            documentId: DOC_LOAN,
            documentType: 'loan_application',
            fieldId: 'requestedAmount',
            value: 5000000,
            rawValue: '50,00,000',
            period: null,
            snippet: 'Requested facility amount: Rs. 50,00,000',
          }),
        ]),
      ]),
      'requestedAmount'
    );
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.value, 5000000);
  });
});

describe('injection, period and unit flags (contract 4.2 rule 4)', () => {
  it('flags a document with injection suspected, and raises a warning', () => {
    const output = run([
      successDocument(
        DOC_STATEMENT,
        'financial_statement',
        [cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' })],
        { injectionSuspected: true }
      ),
    ]);
    const r = result(output, REVENUE);
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('injection_suspected'));
    assert.ok(
      output.warnings.some((w) => w.code === 'injection_suspected' && w.documentIds.includes(DOC_STATEMENT)),
      'expected an injection_suspected warning for the document'
    );
  });

  it('marks a periodScoped field with no period as period_unknown', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000', period: null }),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('period_unknown'));
  });

  it('caps a candidate carrying ambiguous_unit at needs_verification and keeps the reason', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({
            documentId: DOC_STATEMENT,
            documentType: 'financial_statement',
            fieldId: REVENUE,
            value: 200000,
            rawValue: '2 lakh',
            reasons: ['ambiguous_unit'],
          }),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('ambiguous_unit'));
  });

  it('marks a derived value needs_verification with derived_value', () => {
    const r = result(
      run([
        successDocument(DOC_REG, 'registration_certificate', [
          cand({
            documentId: DOC_REG,
            documentType: 'registration_certificate',
            fieldId: 'businessVintageYears',
            value: 5,
            rawValue: '5',
            snippet: 'Operating for 5 years',
            period: null,
            derivation: { ruleId: 'vintage_from_establishment_date', fromCandidateIds: [`${DOC_REG}:identity.dateOfEstablishment:0`] },
          }),
        ]),
      ]),
      'businessVintageYears'
    );
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('derived_value'));
  });
});

describe('mirrors and fallbacks (contract 4.5)', () => {
  it('copies an auto-applied primary to the mirror with mirrorOf set', () => {
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
      ]),
    ]);
    const mirror = result(output, TURNOVER_MIRROR);
    assert.equal(mirror.status, 'auto_applied');
    assert.equal(mirror.value, 12500000);
    assert.equal(mirror.mirrorOf, REVENUE);
  });

  it('uses the GST turnover fallback only when the primary is missing, and caps it at needs_verification', () => {
    const r = result(
      run([
        successDocument(DOC_GST, 'gst_return', [
          cand({ documentId: DOC_GST, documentType: 'gst_return', fieldId: GST_TURNOVER, value: 13200000, rawValue: '1,32,00,000' }),
        ]),
      ]),
      TURNOVER_MIRROR
    );
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('fallback_source'));
  });

  it('takes the primary over the fallback when both exist', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
        ]),
        successDocument(DOC_GST, 'gst_return', [
          cand({ documentId: DOC_GST, documentType: 'gst_return', fieldId: GST_TURNOVER, value: 12500000, rawValue: '1,25,00,000' }),
        ]),
      ]),
      TURNOVER_MIRROR
    );
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.mirrorOf, REVENUE);
  });

  it('uses the promoter CIBIL fallback for creditScore only when there is no personal score', () => {
    const fallbackOnly = result(
      run([
        successDocument(DOC_CREDIT, 'credit_report', [
          cand({ documentId: DOC_CREDIT, documentType: 'credit_report', fieldId: PROMOTER_CIBIL, value: 730 }),
        ]),
      ]),
      CREDIT_SCORE_MIRROR
    );
    assert.equal(fallbackOnly.status, 'needs_verification');
    assert.ok(fallbackOnly.reasons.includes('fallback_source'));

    const primaryWins = result(
      run([
        successDocument(DOC_CREDIT, 'credit_report', [
          cand({ documentId: DOC_CREDIT, documentType: 'credit_report', fieldId: PERSONAL_CIBIL, value: 745 }),
          cand({ documentId: DOC_CREDIT, documentType: 'credit_report', fieldId: PROMOTER_CIBIL, value: 730, n: 1 }),
        ]),
      ]),
      CREDIT_SCORE_MIRROR
    );
    assert.equal(primaryWins.value, 745);
    assert.equal(primaryWins.mirrorOf, PERSONAL_CIBIL);
  });
});

describe('conflicts (contract 4.3)', () => {
  const revenueIn = (docId: string, value: number, rawValue: string, confidence = 0.95, n = 0) =>
    cand({ documentId: docId, documentType: 'financial_statement', fieldId: REVENUE, value, rawValue, confidence, n });

  it('agrees within currency tolerance and takes the most precise value', () => {
    // 1,00,00,000 and 1,00,40,000 differ by 40,000, under 0.5% of 1,00,40,000 (50,200).
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [revenueIn(DOC_STATEMENT, 10000000, '1,00,00,000')]),
        successDocument(DOC_STATEMENT_B, 'financial_statement', [revenueIn(DOC_STATEMENT_B, 10040000, '1,00,40,000')]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.value, 10040000);
  });

  it('conflicts when the currency difference exceeds tolerance', () => {
    // 1,00,00,000 and 1,00,60,000 differ by 60,000, over 0.5% of 1,00,60,000 (50,300).
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [revenueIn(DOC_STATEMENT, 10000000, '1,00,00,000')]),
        successDocument(DOC_STATEMENT_B, 'financial_statement', [revenueIn(DOC_STATEMENT_B, 10060000, '1,00,60,000')]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'conflict');
    assert.equal(r.value, null);
    assert.equal(r.candidates.length, 2);
    assert.ok(r.reasons.includes('values_differ'));
  });

  it('conflicts inside a single document as well', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          revenueIn(DOC_STATEMENT, 10000000, '1,00,00,000', 0.95, 0),
          revenueIn(DOC_STATEMENT, 10060000, '1,00,60,000', 0.95, 1),
        ]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'conflict');
    assert.equal(r.value, null);
  });

  it('ignores rejected candidates when looking for conflicts', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [
          cand({
            documentId: DOC_STATEMENT,
            documentType: 'financial_statement',
            fieldId: REVENUE,
            value: null,
            rawValue: 'USD 1,00,000',
            status: 'rejected_validation',
            reasons: ['non_inr_currency'],
          }),
        ]),
        successDocument(DOC_STATEMENT_B, 'financial_statement', [revenueIn(DOC_STATEMENT_B, 10000000, '1,00,00,000')]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.value, 10000000);
  });

  it('keeps agreeing values as needs_verification when any candidate needs verification', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [revenueIn(DOC_STATEMENT, 10000000, '1,00,00,000', 0.95)]),
        successDocument(DOC_STATEMENT_B, 'financial_statement', [revenueIn(DOC_STATEMENT_B, 10000000, '1,00,00,000', 0.8)]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'needs_verification');
    assert.equal(r.value, 10000000);
  });

  it('takes the highest of the agreeing confidences', () => {
    const r = result(
      run([
        successDocument(DOC_STATEMENT, 'financial_statement', [revenueIn(DOC_STATEMENT, 10000000, '1,00,00,000', 0.9)]),
        successDocument(DOC_STATEMENT_B, 'financial_statement', [revenueIn(DOC_STATEMENT_B, 10000000, '1,00,00,000', 0.95)]),
      ]),
      REVENUE
    );
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.confidence, 0.95);
  });

  it('does not conflict across different periods; the latest period wins and the older one is superseded', () => {
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 15000000, rawValue: '1,50,00,000', period: 'FY 2024-25' }),
      ]),
      successDocument(DOC_STATEMENT_B, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT_B, documentType: 'financial_statement', fieldId: REVENUE, value: 10000000, rawValue: '1,00,00,000', period: 'FY 2023-24' }),
      ]),
    ]);
    const r = result(output, REVENUE);
    assert.equal(r.status, 'auto_applied');
    assert.equal(r.value, 15000000);
    const older = r.candidates.find((c) => c.source.documentId === DOC_STATEMENT_B);
    assert.ok(older, 'older candidate kept in the list');
    assert.ok(older.reasons.includes('superseded_period'));
  });

  it('turns an older statement exactly one year back into previousAnnualRevenue', () => {
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 15000000, rawValue: '1,50,00,000', period: 'FY 2024-25' }),
      ]),
      successDocument(DOC_STATEMENT_B, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT_B, documentType: 'financial_statement', fieldId: REVENUE, value: 10000000, rawValue: '1,00,00,000', period: 'FY 2023-24' }),
      ]),
    ]);
    const previous = result(output, PREVIOUS_REVENUE);
    assert.ok(previous.candidates.some((c) => c.value === 10000000), 'expected the FY 2023-24 value as a previous-year candidate');
  });

  it('does not add up or conflict different subjects; it is needs_verification with multiple_subjects', () => {
    const output = run([
      successDocument(DOC_BANK_A, 'bank_statement', [
        cand({ documentId: DOC_BANK_A, documentType: 'bank_statement', fieldId: BANK_OD_UTILISATION, value: 100000, rawValue: '1,00,000', subjectRef: 'XXXX4321' }),
      ]),
      successDocument(DOC_BANK_B, 'bank_statement', [
        cand({ documentId: DOC_BANK_B, documentType: 'bank_statement', fieldId: BANK_OD_UTILISATION, value: 200000, rawValue: '2,00,000', subjectRef: 'XXXX9876' }),
      ]),
    ]);
    const r = result(output, BANK_OD_UTILISATION);
    assert.equal(r.status, 'needs_verification');
    assert.ok(r.reasons.includes('multiple_subjects'));
    assert.notEqual(r.value, 300000, 'subjects must not be added up');
    assert.equal(r.candidates.length, 2);
    assert.ok(output.warnings.some((w) => w.code === 'multiple_subjects' && w.fieldIds.includes(BANK_OD_UTILISATION)));
  });

  it('treats names equal after punctuation, case, and pvt/ltd mapping as agreeing', () => {
    const r = result(
      run([
        successDocument(DOC_REG, 'registration_certificate', [
          cand({ documentId: DOC_REG, documentType: 'registration_certificate', fieldId: 'applicantLabel', value: 'Sample Fictional Traders Pvt. Ltd.' }),
        ]),
        successDocument(DOC_GST_CERT, 'gst_certificate', [
          cand({ documentId: DOC_GST_CERT, documentType: 'gst_certificate', fieldId: 'applicantLabel', value: 'Sample Fictional Traders Private Limited' }),
        ]),
      ]),
      'applicantLabel'
    );
    assert.notEqual(r.status, 'conflict');
    assert.equal(r.status, 'auto_applied');
  });

  it('conflicts on names that differ after normalisation', () => {
    const r = result(
      run([
        successDocument(DOC_REG, 'registration_certificate', [
          cand({ documentId: DOC_REG, documentType: 'registration_certificate', fieldId: 'applicantLabel', value: 'Sample Fictional Traders' }),
        ]),
        successDocument(DOC_GST_CERT, 'gst_certificate', [
          cand({ documentId: DOC_GST_CERT, documentType: 'gst_certificate', fieldId: 'applicantLabel', value: 'Sample Fictional Metals' }),
        ]),
      ]),
      'applicantLabel'
    );
    assert.equal(r.status, 'conflict');
  });

  it('conflicts on enum values that differ', () => {
    const r = result(
      run([
        successDocument(DOC_REG, 'registration_certificate', [
          cand({ documentId: DOC_REG, documentType: 'registration_certificate', fieldId: 'entityType', value: 'private_limited', snippet: 'Private limited' }),
        ]),
        successDocument(DOC_GST_CERT, 'gst_certificate', [
          cand({ documentId: DOC_GST_CERT, documentType: 'gst_certificate', fieldId: 'entityType', value: 'llp', snippet: 'LLP' }),
        ]),
      ]),
      'entityType'
    );
    assert.equal(r.status, 'conflict');
  });

  it('requires an exact match for scores', () => {
    const r = result(
      run([
        successDocument(DOC_CREDIT, 'credit_report', [
          cand({ documentId: DOC_CREDIT, documentType: 'credit_report', fieldId: PERSONAL_CIBIL, value: 745 }),
        ]),
        successDocument(DOC_CREDIT_B, 'credit_report', [
          cand({ documentId: DOC_CREDIT_B, documentType: 'credit_report', fieldId: PERSONAL_CIBIL, value: 746 }),
        ]),
      ]),
      PERSONAL_CIBIL
    );
    assert.equal(r.status, 'conflict');
  });

  it('flags the annual turnover mirror as a conflict when revenue and GST turnover differ beyond tolerance', () => {
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
      ]),
      successDocument(DOC_GST, 'gst_return', [
        cand({ documentId: DOC_GST, documentType: 'gst_return', fieldId: GST_TURNOVER, value: 13200000, rawValue: '1,32,00,000' }),
      ]),
    ]);
    assert.equal(result(output, TURNOVER_MIRROR).status, 'conflict');
    assert.equal(result(output, REVENUE).status, 'auto_applied');
    assert.equal(result(output, GST_TURNOVER).status, 'auto_applied');
  });

  it('does not flag the turnover mirror when revenue and GST turnover agree within tolerance', () => {
    // 1,25,00,000 and 1,25,20,000 differ by 20,000, under 0.5% of 1,25,20,000 (62,600).
    const output = run([
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
      ]),
      successDocument(DOC_GST, 'gst_return', [
        cand({ documentId: DOC_GST, documentType: 'gst_return', fieldId: GST_TURNOVER, value: 12520000, rawValue: '1,25,20,000' }),
      ]),
    ]);
    assert.notEqual(result(output, TURNOVER_MIRROR).status, 'conflict');
  });
});

describe('identity checks (contract 4.4)', () => {
  const GSTIN_X = buildGstin('27', 'AFCCT1234Z');
  const GSTIN_Y = buildGstin('29', 'AAGCB7383J');

  it('flags the minority GSTIN document with identity_mismatch and raises a warning', () => {
    const output = run([
      successDocument(DOC_GST_CERT, 'gst_certificate', [
        cand({ documentId: DOC_GST_CERT, documentType: 'gst_certificate', fieldId: GSTIN, value: GSTIN_X, rawValue: GSTIN_X, snippet: GSTIN_X }),
      ]),
      successDocument(DOC_GST, 'gst_return', [
        cand({ documentId: DOC_GST, documentType: 'gst_return', fieldId: GSTIN, value: GSTIN_X, rawValue: GSTIN_X, snippet: GSTIN_X }),
      ]),
      successDocument(documentId(11), 'gst_certificate', [
        cand({ documentId: documentId(11), documentType: 'gst_certificate', fieldId: GSTIN, value: GSTIN_Y, rawValue: GSTIN_Y, snippet: GSTIN_Y }),
      ]),
    ]);
    const minority = result(output, GSTIN).candidates.find((c) => c.source.documentId === documentId(11));
    assert.ok(minority, 'minority candidate kept');
    assert.ok(minority.reasons.includes('identity_mismatch'));
    assert.ok(
      output.warnings.some((w) => w.code === 'identity_mismatch' && w.documentIds.includes(documentId(11))),
      'expected an identity_mismatch warning naming the minority document'
    );
  });

  it('flags a non-individual PAN (fourth character not P) that differs from the GSTIN PAN', () => {
    const output = run([
      successDocument(DOC_GST_CERT, 'gst_certificate', [
        cand({ documentId: DOC_GST_CERT, documentType: 'gst_certificate', fieldId: GSTIN, value: GSTIN_X, rawValue: GSTIN_X, snippet: GSTIN_X }),
      ]),
      successDocument(DOC_PAN, 'pan_card', [
        cand({ documentId: DOC_PAN, documentType: 'pan_card', fieldId: PAN, value: 'BQRCE7788K', snippet: 'BQRCE7788K' }),
      ]),
    ]);
    const pan = result(output, PAN).candidates.find((c) => c.source.documentId === DOC_PAN);
    assert.ok(pan, 'PAN candidate kept');
    assert.ok(pan.reasons.includes('identity_mismatch'));
  });

  it('does not run the check for an individual PAN (fourth character P), even when it differs', () => {
    const output = run([
      successDocument(DOC_GST_CERT, 'gst_certificate', [
        cand({ documentId: DOC_GST_CERT, documentType: 'gst_certificate', fieldId: GSTIN, value: GSTIN_X, rawValue: GSTIN_X, snippet: GSTIN_X }),
      ]),
      successDocument(DOC_PAN, 'pan_card', [
        cand({ documentId: DOC_PAN, documentType: 'pan_card', fieldId: PAN, value: 'ABCPE1234F', snippet: 'ABCPE1234F' }),
      ]),
    ]);
    const pan = result(output, PAN).candidates.find((c) => c.source.documentId === DOC_PAN);
    assert.ok(pan);
    assert.ok(!pan.reasons.includes('identity_mismatch'));
    assert.ok(!output.warnings.some((w) => w.code === 'identity_mismatch'));
  });
});

describe('edited fields (contract 5)', () => {
  const nameDoc = () =>
    successDocument(DOC_REG, 'registration_certificate', [
      cand({ documentId: DOC_REG, documentType: 'registration_certificate', fieldId: 'applicantLabel', value: 'Sample Fictional Traders' }),
    ]);

  it('marks an edited field overriddenByUser and still lists the document value as a candidate', () => {
    const r = result(run([nameDoc()], { editedFieldIds: ['applicantLabel'] }), 'applicantLabel');
    assert.equal(r.overriddenByUser, true);
    assert.equal(r.candidates[0]?.value, 'Sample Fictional Traders');
  });

  it('does not mark an untouched field overriddenByUser', () => {
    const r = result(run([nameDoc()]), 'applicantLabel');
    assert.equal(r.overriddenByUser, false);
  });

  it('keeps edited state per field: editing revenue does not edit the turnover mirror', () => {
    const docs = [
      successDocument(DOC_STATEMENT, 'financial_statement', [
        cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 12500000, rawValue: '1,25,00,000' }),
      ]),
    ];
    const output = run(docs, { editedFieldIds: [REVENUE] });
    assert.equal(result(output, REVENUE).overriddenByUser, true);
    assert.equal(result(output, TURNOVER_MIRROR).overriddenByUser, false);
  });
});

describe('purity and invariants (contract 2)', () => {
  const mixed = (): DocumentExtractionSuccess[] => [
    successDocument(DOC_STATEMENT, 'financial_statement', [
      cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: REVENUE, value: 10000000, rawValue: '1,00,00,000' }),
      cand({ documentId: DOC_STATEMENT, documentType: 'financial_statement', fieldId: PAT, value: -1250000, rawValue: '(12,50,000)', snippet: 'PAT (12,50,000)' }),
    ]),
    successDocument(DOC_STATEMENT_B, 'financial_statement', [
      cand({ documentId: DOC_STATEMENT_B, documentType: 'financial_statement', fieldId: REVENUE, value: 10060000, rawValue: '1,00,60,000' }),
      cand({ documentId: DOC_STATEMENT_B, documentType: 'financial_statement', fieldId: 'ebitda', value: null, rawValue: 'USD 1', status: 'rejected_validation', reasons: ['non_inr_currency'] }),
    ]),
  ];

  it('returns the same output for the same input, and does not mutate the input', () => {
    const docs = mixed();
    const snapshot = structuredClone(docs);
    const first = run(docs);
    const second = run(docs);
    assert.ok(Object.keys(first.fields).length > 0, 'merge produced no fields, so the comparison is empty');
    assert.deepEqual(first, second);
    assert.deepEqual(docs, snapshot);
  });

  it('keeps value null exactly for conflict and rejected_validation, and only uses known field IDs', () => {
    const output = run(mixed());
    assert.ok(Object.keys(output.fields).length > 0, 'merge produced no fields, so the invariants are untested');
    for (const [fieldId, r] of Object.entries(output.fields)) {
      assert.ok(getFieldDefinition(fieldId), `${fieldId} is not in the field map`);
      assert.equal(r.fieldId, fieldId);
      if (r.status === 'conflict' || r.status === 'rejected_validation') {
        assert.equal(r.value, null, `${fieldId} should have null value`);
      } else {
        assert.notEqual(r.value, null, `${fieldId} should have a value`);
      }
    }
  });
});
