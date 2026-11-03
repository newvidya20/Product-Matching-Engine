import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocally } from '../server/documentAi/localClassifier.ts';

describe('local document classification', () => {
  it('recognises clear titles without the model', () => {
    assert.equal(classifyLocally('Form GSTR-3B summary of outward supplies', 'x.pdf'), 'gst_return');
    assert.equal(classifyLocally('', 'GSTR3B_27BFJPC3507H1ZP_042026.pdf'), 'gst_return');
    assert.equal(classifyLocally('Statement of Account\nOpening Balance 1,000', 'stmt.pdf'), 'bank_statement');
    assert.equal(classifyLocally('ITR-V Acknowledgement Assessment Year 2025-26', 'a.pdf'), 'itr');
    assert.equal(classifyLocally('Balance Sheet as at 31 March 2025 ... Statement of Profit and Loss', 'fs.pdf'), 'financial_statement');
  });

  it('leaves ambiguous or unknown documents to the model', () => {
    assert.equal(classifyLocally('TDS certificate Form 16A', 'TDS FY 2024-25.pdf'), null);
    assert.equal(classifyLocally('GSTR-3B attached to the bank statement, opening balance 10', 'mix.pdf'), null);
    assert.equal(classifyLocally('Some letter', 'scan.pdf'), null);
  });
});
