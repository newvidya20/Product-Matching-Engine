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

import { dropSeededMarksForApplied, nextStoredSession } from '../src/components/documentAi/seedMarks.ts';

describe('seed marks and stored session', () => {
  const entry = (fieldId: string, origin: string) => ({ fieldId, origin, at: 't' }) as never;

  it('drops preexisting marks only for server-applied fields', () => {
    const edited = { a: entry('a', 'preexisting_value'), b: entry('b', 'preexisting_value'), c: entry('c', 'typed') };
    const pending = { a: edited.a, b: edited.b, c: edited.c };
    const dropped = dropSeededMarksForApplied(edited, pending, ['a', 'c']);
    assert.deepEqual(dropped, ['a']);
    assert.deepEqual(Object.keys(edited).sort(), ['b', 'c']);
    assert.deepEqual(Object.keys(pending).sort(), ['b', 'c']);
  });

  it('keeps the existing stored session unless it is empty', () => {
    assert.equal(nextStoredSession('ds_old', 'ds_new'), 'ds_old');
    assert.equal(nextStoredSession(null, 'ds_new'), 'ds_new');
    assert.equal(nextStoredSession('', 'ds_new'), 'ds_new');
  });
});
