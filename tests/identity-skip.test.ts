import assert from 'node:assert/strict';
import test from 'node:test';
import { isIgnoredIdentityFile } from '../server/documentAi/pipeline.ts';

test('identity papers and photos are skipped by name; business documents are not', () => {
  for (const n of ['Alka Chawla Aadhaar card.pdf', 'Alka Chawla PAN Card.jpg', 'Alka Chawla Passport New.pdf', 'Aman Gupta-Pan & Aadhaar Card.pdf', 'Archit Aggarwal-Pan Card.pdf'])
    assert.equal(isIgnoredIdentityFile(n, 'pdf'), true, n);
  assert.equal(isIgnoredIdentityFile('Alka Chawla Pic.jpg', 'jpeg'), true);
  for (const n of ['GSTR3B_092026.pdf', 'Company profile.pdf', 'Pan India sales report.xlsx', 'BOB 0092 statement.pdf', 'CIBIL Report.pdf'])
    assert.equal(isIgnoredIdentityFile(n, 'pdf'), false, n);
  assert.equal(isIgnoredIdentityFile('Pic.pdf', 'pdf'), false);
});
