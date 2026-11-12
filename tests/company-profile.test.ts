import assert from 'node:assert/strict';
import test from 'node:test';
import { readCompanyProfile } from '../server/documentAi/companyProfile.ts';

const page = ['Company Profile', 'Sample Textiles is a fictional manufacturer.', 'Sales for the last 3 Financial Years', 'Financial Year 21 - 22', '105 Crore ', 'Financial Year 22 - 23', '103 Crore', 'Financial Year 23 – 24', '101 Crore'];

test('reads sales by financial year with the unit, held for review', () => {
  const out = readCompanyProfile([page], 0.9);
  assert.deepEqual(out.map((f) => [f.period, f.rawValue]), [['FY 2021-22', '105 crore'], ['FY 2022-23', '103 crore'], ['FY 2023-24', '101 crore']]);
  assert.ok(out.every((f) => f.confidence <= 0.6));
});

test('a year with no amount, a wrong year pair, or no sales heading reads nothing', () => {
  assert.deepEqual(readCompanyProfile([['Sales for the last years', 'Financial Year 21 - 22', 'Strong growth']], 0.9), []);
  assert.deepEqual(readCompanyProfile([['Sales for the last years', 'Financial Year 21 - 25', '105 Crore']], 0.9), []);
  assert.deepEqual(readCompanyProfile([['Financial Year 21 - 22', '105 Crore']], 0.9), []);
});

test('Word table cells with leading pipes are read', () => {
  const out = readCompanyProfile([['Sales for the last 3 Financial Years', 'Financial Year 21 - 22', '| 105 Crore']], 0.9);
  assert.equal(out.length, 1);
});
