import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isZipUpload, readZipEntries, validateUpload } from '../server/documentAi/fileValidation.ts';
import { readDocxLines, readPlainTextLines, renderPdfPagesToPng } from '../server/documentAi/textDocuments.ts';
import { readPdfSource } from '../server/documentAi/spreadsheet.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const signal = () => new AbortController().signal;

describe('Word and text uploads', () => {
  it('accepts a .docx and reads its paragraphs', async () => {
    const bytes = fixture('FICTIONAL-loan-application.docx');
    assert.deepEqual(await validateUpload('application.docx', bytes), { ok: true, kind: 'docx' });
    const lines = await readDocxLines(bytes);
    assert.ok(lines.includes('Applicant: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED'));
    assert.ok(lines.some((line) => line.includes('Rs. 50,00,000')));
  });

  it('refuses an .xlsx renamed to .docx', async () => {
    const result = await validateUpload('sheet.docx', fixture('FICTIONAL-balance-sheet-fy2024-25.xlsx'));
    assert.equal(result.ok, false);
  });

  it('accepts a .txt and drops blank lines', async () => {
    const bytes = fixture('FICTIONAL-itr-acknowledgement.txt');
    assert.deepEqual(await validateUpload('itr.txt', bytes), { ok: true, kind: 'txt' });
    assert.ok(readPlainTextLines(bytes).includes('Assessment Year: 2025-26'));
  });
});

describe('ZIP uploads', () => {
  it('unpacks every document, flattens folders and skips macOS junk', async () => {
    const bytes = fixture('FICTIONAL-borrower-documents.zip');
    assert.equal(isZipUpload('docs.zip', bytes), true);
    const result = await readZipEntries(bytes);
    assert.ok(result.ok);
    const names = result.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, [
      'FICTIONAL-itr-acknowledgement.txt',
      'FICTIONAL-loan-application.docx',
      'FICTIONAL-scanned-gst-return.pdf',
      'notes.exe',
    ]);
    const exe = result.entries.find((entry) => entry.name === 'notes.exe');
    assert.ok(exe);
    assert.equal((await validateUpload(exe.name, exe.bytes)).ok, false, 'each entry is still validated');
  });

  it('is not triggered by an Office file', () => {
    assert.equal(isZipUpload('book.xlsx', fixture('FICTIONAL-balance-sheet-fy2024-25.xlsx')), false);
  });

  it('rejects a damaged ZIP with a clear message', async () => {
    const result = await readZipEntries(Buffer.from('PK\u0003\u0004 broken'));
    assert.equal(result.ok, false);
  });
});

describe('scanned PDFs', () => {
  it('has no text layer, and its page renders to a PNG for the vision model', async () => {
    const bytes = fixture('FICTIONAL-scanned-gst-return.pdf');
    assert.deepEqual(await validateUpload('scan.pdf', bytes), { ok: true, kind: 'pdf' });
    assert.equal((await readPdfSource(bytes, signal())).kind, 'no_text');
    const images = await renderPdfPagesToPng(bytes, signal());
    assert.equal(images.length, 1);
    assert.equal(Buffer.from(images[0], 'base64').subarray(1, 4).toString(), 'PNG');
  });
});
