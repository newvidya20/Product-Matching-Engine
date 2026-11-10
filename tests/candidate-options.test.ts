import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateOptions } from '../src/components/eligibility/candidateOptions';
import type { ExtractedField, FieldResult } from '../src/types/documentAi';

function cand(
  fieldId: string,
  n: number,
  value: number | string | null,
  over: { doc?: string; page?: number | null; subject?: string | null; confidence?: number; status?: string } = {}
): ExtractedField {
  const doc = over.doc ?? `doc${n}`;
  return {
    candidateId: `${doc}:${fieldId}:${n}`,
    fieldId,
    value,
    rawValue: String(value),
    confidence: over.confidence ?? 0.9,
    source: {
      documentId: doc,
      fileName: `${doc}.pdf`,
      documentType: 'credit_report',
      page: over.page === undefined ? 1 : over.page,
      sheetName: null,
      cellRef: null,
      snippet: '',
    },
    status: (over.status ?? 'extracted') as ExtractedField['status'],
    reasons: [],
    period: null,
    subjectRef: over.subject ?? null,
  } as ExtractedField;
}

function fields(fieldId: string, candidates: ExtractedField[]): Record<string, FieldResult> {
  return {
    [fieldId]: {
      fieldId,
      status: 'conflict',
      value: null,
      confidence: 0.9,
      source: null,
      reasons: [],
      candidates,
      suggestedCandidateId: null,
      mirrorOf: null,
      overriddenByUser: false,
    } as FieldResult,
  };
}

const SCORE = 'financialProfile.promoterCibilScore';
const EMI = 'financialProfile.existingMonthlyEmi';

test('three promoters give three options, labelled, with no sum', () => {
  const f = fields(SCORE, [
    cand(SCORE, 1, 712, { doc: 'a', subject: 'Promoter A' }),
    cand(SCORE, 2, 713, { doc: 'b', subject: 'Chitra' }),
    cand(SCORE, 3, 756, { doc: 'c', subject: 'Dev' }),
  ]);
  const options = buildCandidateOptions(f, 'promoterCibilScore');
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((o) => o.value).sort(), ['712', '713', '756']);
  assert.equal(options.find((o) => o.value === '712')?.label, '712 - Promoter A (a.pdf p. 1)');
  assert.ok(options.every((o) => !o.isTotal));
});

test('score fields never get a sum, even for distinct sources', () => {
  const f = fields('financialProfile.personalCibilScore', [
    cand('financialProfile.personalCibilScore', 1, 700, { doc: 'a' }),
    cand('financialProfile.personalCibilScore', 2, 710, { doc: 'b' }),
  ]);
  assert.ok(buildCandidateOptions(f, 'personalCibilScore').every((o) => !o.isTotal));
  const rev = fields('financialProfile.annualRevenue', [
    cand('financialProfile.annualRevenue', 1, 100, { doc: 'a' }),
    cand('financialProfile.annualRevenue', 2, 200, { doc: 'b' }),
  ]);
  assert.ok(buildCandidateOptions(rev, 'annualRevenue').every((o) => !o.isTotal));
});

test('EMIs from three documents offer an exact total', () => {
  const f = fields(EMI, [
    cand(EMI, 1, 10000.1, { doc: 'a' }),
    cand(EMI, 2, 20000.2, { doc: 'b' }),
    cand(EMI, 3, 5000, { doc: 'c' }),
  ]);
  const options = buildCandidateOptions(f, 'existingMonthlyEmi');
  assert.equal(options.length, 4);
  const total = options.find((o) => o.isTotal);
  assert.ok(total);
  assert.equal(total.value, '35000.3');
  assert.match(total.label, /Total of all 3 values/);
});

test('EMI readings from the same place are not summed', () => {
  const f = fields(EMI, [cand(EMI, 1, 100, { doc: 'a' }), cand(EMI, 2, 200, { doc: 'a' })]);
  assert.ok(buildCandidateOptions(f, 'existingMonthlyEmi').every((o) => !o.isTotal));
});

test('duplicates are removed and rejected or empty values excluded', () => {
  const f = fields(SCORE, [
    cand(SCORE, 1, 712, { doc: 'a', subject: 'Promoter A' }),
    cand(SCORE, 2, 712, { doc: 'a', subject: 'Promoter A' }),
    cand(SCORE, 3, 999, { doc: 'b', status: 'rejected_validation' }),
    cand(SCORE, 4, null, { doc: 'c' }),
  ]);
  const options = buildCandidateOptions(f, 'promoterCibilScore');
  assert.equal(options.length, 1);
  assert.equal(options[0].value, '712');
});

test('current value sorts first, then confidence', () => {
  const f = fields(SCORE, [
    cand(SCORE, 1, 712, { doc: 'a', confidence: 0.99 }),
    cand(SCORE, 2, 713, { doc: 'b', confidence: 0.5 }),
  ]);
  const options = buildCandidateOptions(f, 'promoterCibilScore', '713');
  assert.equal(options[0].value, '713');
  assert.equal(options[0].isCurrent, true);
});
