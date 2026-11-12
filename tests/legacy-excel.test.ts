import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { normalizeLegacyExcel } from '../server/documentAi/legacyExcel.ts';
import { validateUpload } from '../server/documentAi/fileValidation.ts';
import { parseSpreadsheet } from '../server/documentAi/spreadsheet.ts';

function makeXls(): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Month', 'EMI'], ['Jan', 185000], ['Feb', 185000]]), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

test('a real .xls is converted to a valid .xlsx that the spreadsheet reader opens', async () => {
  const out = normalizeLegacyExcel('Fictional EMI.xls', makeXls());
  assert.notEqual(out, null);
  assert.notEqual(out, 'unchanged');
  if (out === null || out === 'unchanged') return;
  assert.equal(out.name, 'Fictional EMI.xlsx');
  const v = await validateUpload(out.name, out.bytes);
  assert.equal(v.ok, true);
  const parsed = await parseSpreadsheet(new Uint8Array(out.bytes), 'xlsx');
  assert.equal(parsed.sheets.length, 1);
});

test('non-xls files pass through and a damaged .xls is refused', () => {
  assert.equal(normalizeLegacyExcel('a.pdf', Buffer.from('%PDF-1.4')), 'unchanged');
  assert.equal(normalizeLegacyExcel('bad.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])), null);
});

test('an ".xls" that is really an HTML table (common bank export) is converted too', () => {
  const html = Buffer.from('<html><body><table><tr><td>Lender</td><td>EMI</td></tr><tr><td>Sample Finance</td><td>185000</td></tr></table></body></html>');
  const out = normalizeLegacyExcel('Fictional Debt Profile.xls', html);
  assert.ok(out && out !== 'unchanged');
});
