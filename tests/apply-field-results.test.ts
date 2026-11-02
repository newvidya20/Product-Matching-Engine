import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldResults } from '../src/components/documentAi/applyFieldResults.ts';
import { createBlankForm } from '../src/components/documentAi/formModel.ts';
import type { FieldResult } from '../src/types/documentAi.ts';

const result = (fieldId: string, status: string, value: unknown): FieldResult =>
  ({ fieldId, status, value, candidates: [{ candidateId: 'c1' }], suggestedCandidateId: 'c1', reasons: [] }) as unknown as FieldResult;

describe('applyFieldResults review fixes', () => {
  it('does not auto-apply fundingPurpose when a dynamic answer exists', () => {
    const form = { ...createBlankForm('INR'), fundingPurpose: 'working_capital' as const, dynamicPurposeAnswers: { x: 'typed' } };
    const out = applyFieldResults({
      form,
      fields: { fundingPurpose: result('fundingPurpose', 'auto_applied', 'machinery_equipment') },
      editedFieldIds: new Set(),
      applied: {},
    });
    assert.equal(out.form.fundingPurpose, 'working_capital');
    assert.deepEqual(out.form.dynamicPurposeAnswers, { x: 'typed' });
  });

  it('applies fundingPurpose when there are no answers', () => {
    const form = createBlankForm('INR');
    const out = applyFieldResults({
      form,
      fields: { fundingPurpose: result('fundingPurpose', 'auto_applied', 'machinery_equipment') },
      editedFieldIds: new Set(),
      applied: {},
    });
    assert.equal(out.form.fundingPurpose, 'machinery_equipment');
  });

  it('never reverts an applied value this page did not apply itself', () => {
    const form = { ...createBlankForm('INR'), creditScore: '700' };
    const applied = { creditScore: { fieldId: 'creditScore', candidateId: 'c1', at: 'x' } };
    const out = applyFieldResults({
      form,
      fields: {},
      editedFieldIds: new Set(),
      applied,
      revertableFieldIds: new Set(),
    });
    assert.equal(out.form.creditScore, '700');
  });

  it('reverts a value this page applied when its source disappears', () => {
    const form = { ...createBlankForm('INR'), creditScore: '700' };
    const applied = { creditScore: { fieldId: 'creditScore', candidateId: 'c1', at: 'x' } };
    const out = applyFieldResults({
      form,
      fields: {},
      editedFieldIds: new Set(),
      applied,
      revertableFieldIds: new Set(['creditScore']),
    });
    assert.equal(out.form.creditScore, '');
  });
});

import { dropSeededMarksForApplied, sameFieldValue } from '../src/components/documentAi/seedMarks.ts';

describe('seed marks', () => {
  const entry = (fieldId: string, origin: string) => ({ fieldId, origin, at: 't' }) as never;

  it('drops a preexisting mark only when the saved value equals the applied value', () => {
    const edited = { a: entry('a', 'preexisting_value'), b: entry('b', 'preexisting_value'), c: entry('c', 'typed') };
    const pending = { a: edited.a, b: edited.b, c: edited.c };
    const dropped = dropSeededMarksForApplied(edited, pending, {
      a: { applied: 5000000, saved: '5000000' },
      b: { applied: 'x', saved: 'y' },
      c: { applied: 1, saved: '1' },
    });
    assert.deepEqual(dropped, ['a']);
    assert.deepEqual(Object.keys(edited).sort(), ['b', 'c']);
    assert.deepEqual(Object.keys(pending).sort(), ['b', 'c']);
  });

  it('keeps a differing mark and queues it so the server learns it', () => {
    const edited = { a: entry('a', 'preexisting_value') };
    const pending: Record<string, never> = {};
    const dropped = dropSeededMarksForApplied(edited, pending, { a: { applied: 100, saved: '90' } });
    assert.deepEqual(dropped, []);
    assert.ok(edited.a);
    assert.ok(pending.a);
  });

  it('keeps the mark when the applied value is unknown, and skips queueing if the server has it', () => {
    const edited = { a: entry('a', 'preexisting_value'), b: entry('b', 'preexisting_value') };
    const pending: Record<string, never> = {};
    dropSeededMarksForApplied(edited, pending, { a: { applied: null, saved: '1' }, b: { applied: 2, saved: '3' } }, new Set(['b']));
    assert.ok(edited.a && edited.b);
    assert.ok(pending.a);
    assert.equal(pending.b, undefined);
  });

  it('compares numbers by value and text trimmed', () => {
    assert.equal(sameFieldValue('5000000', 5000000), true);
    assert.equal(sameFieldValue('5,000,000', 5000000), true);
    assert.equal(sameFieldValue('5000000.0', 5000000), true);
    assert.equal(sameFieldValue('4999999', 5000000), false);
    assert.equal(sameFieldValue('20%', '20%'), true);
    assert.equal(sameFieldValue(' Acme ', 'Acme'), true);
    assert.equal(sameFieldValue('', 0), false);
    assert.equal(sameFieldValue('a', null), false);
  });
});
