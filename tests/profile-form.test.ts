import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readProfileForm } from '../server/documentAi/profileForm.ts';
import { classifyLocally } from '../server/documentAi/localClassifier.ts';

// Fictional data only.
const LINES = [
  'Borrower Intake Profile',
  'Company / Applicant Name Example Components Pvt Ltd',
  'Legal Entity Structure Private Limited Company',
  'Primary Funding Purpose Working Capital & Inventory',
  'Requested Facility Amount (INR) 15000000',
  'Average Debtor / Receivable Cycle',
  '(Days)',
  '60',
  'Latest FY label FY 2025-26 (Apr-Mar)',
  'Annual Revenue (INR) 96000000',
  'PAT (INR) 5400000',
  'Collateral / Security Summary Own shed,',
  'clear title.',
  'Detailed Funding Requirement & Use',
  'Case',
  'Raw material purchase.',
  'Internal Employee Notes Call the promoter.',
];

describe('borrower intake profile reader', () => {
  const fields = readProfileForm([LINES], 0.9);
  const get = (id: string) => fields.find((f) => f.fieldId === id);

  it('is recognised as a loan application despite naming other documents', () => {
    assert.equal(classifyLocally(`${LINES.join('\n')}\nGST returns and bank statements ready`, 'profile.pdf'), 'loan_application');
  });
  it('reads numbers, enums, a wrapped label and a wrapped value', () => {
    assert.equal(get('requestedAmount')?.rawValue, '15000000');
    assert.equal(get('entityType')?.enumValue, 'private_limited');
    assert.equal(get('fundingPurpose')?.enumValue, 'working_capital');
    assert.equal(get('dynamicPurposeAnswers.working_capital.receivableDays')?.rawValue, '60');
    assert.equal(get('collateralDescription')?.rawValue, 'Own shed, clear title.');
  });
  it('gives yearly figures the printed financial year, and stops a note at the next label', () => {
    assert.equal(get('financialProfile.annualRevenue')?.period, 'FY 2025-26');
    assert.equal(get('financialProfile.financialYearLabel')?.rawValue, 'FY 2025-26');
    assert.equal(get('statedPurpose')?.rawValue, 'Raw material purchase.');
  });
  it('returns nothing for a document that shows only a label or two', () => {
    assert.deepEqual(readProfileForm([['Annual Revenue 5', 'Other text']], 0.9), []);
  });
});
