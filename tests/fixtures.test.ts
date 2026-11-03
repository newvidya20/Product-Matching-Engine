/**
 * Checks the committed fixtures in tests/fixtures/: file signatures, PDF cross-reference offsets,
 * PNG structure, XLSX parts, and that every file is marked FICTIONAL.
 * Regenerate with: node --import tsx tests/fixtures/generate-fixtures.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (name: string) => readFileSync(`${FIXTURE_DIR}${name}`);

const GST_PDF = 'FICTIONAL-gst-return-fy2024-25.pdf';
const BANK_PDF = 'FICTIONAL-bank-statement-may-2025.pdf';
const BALANCE_XLSX = 'FICTIONAL-balance-sheet-fy2024-25.xlsx';
const PAN_PNG = 'FICTIONAL-pan-card.png';

describe('fixture files', () => {
  it('names every fixture with FICTIONAL', () => {
    for (const name of [GST_PDF, BANK_PDF, BALANCE_XLSX, PAN_PNG]) {
      assert.match(name, /^FICTIONAL-/);
    }
  });
});

describe('PDF fixtures', () => {
  for (const name of [GST_PDF, BANK_PDF]) {
    it(`${name} has a PDF header, a trailer, and a valid cross-reference table`, () => {
      const bytes = read(name);
      const text = bytes.toString('latin1');
      assert.ok(text.startsWith('%PDF-'), 'missing %PDF- header');
      assert.ok(text.trimEnd().endsWith('%%EOF'), 'missing %%EOF');

      const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
      assert.ok(Number.isInteger(startxref), 'missing startxref offset');
      assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref does not point at xref');

      // Every in-use entry must point at "<n> 0 obj".
      const entries = [...text.slice(startxref).matchAll(/^(\d{10}) (\d{5}) n $/gm)];
      assert.ok(entries.length > 0, 'no in-use xref entries');
      for (const [index, entry] of entries.entries()) {
        const offset = Number(entry[1]);
        assert.match(text.slice(offset, offset + 12), new RegExp(`^${index + 1} 0 obj`), `xref entry ${index + 1}`);
      }
    });

    it(`${name} states that it is fictional`, () => {
      assert.match(read(name).toString('latin1'), /FICTIONAL/);
    });
  }

  it('keeps the bank statement arithmetic consistent with its printed totals', () => {
    const text = read(BANK_PDF).toString('latin1');
    // Credits 85,000 + 40,000 + 1,15,000 = 2,40,000. Debits 1,25,000 + 1,55,000 = 2,80,000.
    // Opening 2,35,000 + 2,40,000 - 2,80,000 = 1,95,000.
    assert.ok(text.includes('Total credits: 2,40,000.00 Cr'));
    assert.ok(text.includes('Total debits: 2,80,000.00 Dr'));
    assert.ok(text.includes('Closing balance: 1,95,000.00 Cr'));
  });
});

describe('PNG fixture', () => {
  it('has the PNG signature, an IHDR with the expected size, and an IEND at the end', () => {
    const bytes = read(PAN_PNG);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), 480, 'width');
    assert.equal(bytes.readUInt32BE(20), 300, 'height');
    assert.equal(bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii'), 'IEND');
  });
});

describe('XLSX fixture', () => {
  it('is a zip with the parts Excel needs and the two FICTIONAL sheets', async () => {
    const zip = await JSZip.loadAsync(read(BALANCE_XLSX));
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      assert.ok(zip.file(part), `missing ${part}`);
    }
    const workbook = await zip.file('xl/workbook.xml')!.async('string');
    assert.match(workbook, /name="Balance Sheet"/);
    assert.match(workbook, /name="Profit and Loss"/);

    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    assert.match(sheet, /FICTIONAL SAMPLE TRADERS PRIVATE LIMITED/);
    assert.match(sheet, /<v>48000000<\/v>/);
  });

  it('is marked fictional inside the workbook', async () => {
    const zip = await JSZip.loadAsync(read(BALANCE_XLSX));
    const sheet = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    assert.match(sheet, /FICTIONAL/);
  });
});

describe('PDF text layer from a Node Buffer', () => {
  it('reads the fixture when given a Buffer, as the upload pipeline does', async () => {
    const { readFileSync } = await import('node:fs');
    const { readPdfSource } = await import('../server/documentAi/spreadsheet.ts');
    const bytes = readFileSync(new URL('./fixtures/FICTIONAL-gst-return-fy2024-25.pdf', import.meta.url));
    const source = await readPdfSource(bytes, new AbortController().signal);
    assert.equal(source.kind, 'pdf');
    assert.equal(bytes.length > 0, true, 'the caller keeps its bytes for the model');
  });
});
