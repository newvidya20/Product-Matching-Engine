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
    assert.equal(classifyLocally('Audited Financial Statements for FY 2024-25 and FY 2023-24', 'financials.pdf'), 'financial_statement');
    assert.equal(classifyLocally('March 2026 Provisional Financial Statements with notes to accounts', 'provisional-financials.pdf'), 'financial_statement');
    assert.equal(classifyLocally('CIBIL Report\nScore 762\nCMR Rank: 3', 'cibil.pdf'), 'credit_report');
    assert.equal(classifyLocally('ICRA Credit Rating Report for existing borrowing', 'rating.pdf'), 'credit_report');
    assert.equal(classifyLocally('Sanction Letter and Existing Debt Profile with outstanding balance and repayment schedule', 'debt-profile.pdf'), 'existing_sanction_letter');
    assert.equal(classifyLocally('Purchase Ledger and Sales Ledger', 'ledger.pdf'), 'other');
    assert.equal(classifyLocally('Company Profile and Corporate Presentation', 'pitch-deck.pdf'), 'loan_application');
    assert.equal(classifyLocally('Applicant Name: Meridian Trading Co.\nBorrower profile summary', 'meridian_demo_borrower_profile.pdf'), 'loan_application');
  });

  it('leaves ambiguous or unknown documents to the model', () => {
    assert.equal(classifyLocally('TDS certificate Form 16A', 'TDS FY 2024-25.pdf'), null);
    assert.equal(classifyLocally('GSTR-3B attached to the bank statement, opening balance 10', 'mix.pdf'), null);
    assert.equal(classifyLocally('Some letter', 'scan.pdf'), null);
  });
});
