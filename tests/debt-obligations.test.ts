import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSanctionLetter } from '../server/documentAi/debtObligations.ts';

const read = (...lines: string[]) => readSanctionLetter([lines], 0.9);

test('reads one labelled CC limit', () => {
  assert.equal(read('Cash credit limit sanctioned Rs. 1,30,00,000/-')[0]?.rawValue, '1,30,00,000');
});
test('rejects a line with two amounts', () => {
  assert.deepEqual(read('CC limit enhanced from Rs 30,00,000 to Rs 50,00,000'), []);
});
test('word boundaries: "period limit" is not an OD limit', () => {
  assert.deepEqual(read('Repayment period limit Rs 5,00,000'), []);
});
test('skips a figure followed by a unit word', () => {
  assert.deepEqual(read('Overdraft limit Rs 50,000 lakhs'), []);
});
