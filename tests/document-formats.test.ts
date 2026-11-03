import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isZipUpload, readZipEntries, validateUpload } from '../server/documentAi/fileValidation.ts';
import {
  MAX_RENDER_PIXELS,
  readDocxLines,
  readPlainTextLines,
  renderPdfPages,
  renderPdfPagesToPng,
  renderScaleFor,
} from '../server/documentAi/textDocuments.ts';
import { runObserved, type ExtractionObserver } from '../server/documentAi/ocr.ts';
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

  it('renders a normal page at scale 2', () => {
    // A4 in points: 595 x 842 at scale 2 is about 2 MP, under the 4 MP default.
    assert.equal(MAX_RENDER_PIXELS, 4_000_000);
    assert.equal(renderScaleFor(595, 842), 2);
  });

  it('lowers the scale of a large page so its canvas stays under the pixel cap', () => {
    for (const [width, height] of [
      [2384, 3370], // A0
      [14400, 14400], // the PDF maximum page size
      [100_000, 50], // a long strip
      [1191, 842],
    ]) {
      const scale = renderScaleFor(width, height);
      assert.ok(scale !== null && scale > 0 && scale <= 2, `${width}x${height}`);
      const pixels = Math.ceil(width * scale) * Math.ceil(height * scale);
      assert.ok(pixels <= MAX_RENDER_PIXELS, `${width}x${height}: ${pixels} pixels`);
      assert.ok(Math.ceil(width * scale) <= 8_000 && Math.ceil(height * scale) <= 8_000);
    }
    const a0 = renderScaleFor(2384, 3370)!;
    assert.ok(Math.ceil(2384 * a0) * Math.ceil(3370 * a0) > MAX_RENDER_PIXELS * 0.95, 'uses most of the allowance');
  });

  it('honours a smaller pixel cap, and refuses a page with no usable size', () => {
    const scale = renderScaleFor(595, 842, 1_000_000)!;
    assert.ok(Math.ceil(595 * scale) * Math.ceil(842 * scale) <= 1_000_000);
    assert.equal(renderScaleFor(0, 842), null);
    assert.equal(renderScaleFor(595, Number.NaN), null);
    assert.equal(renderScaleFor(-1, 10), null);
  });

  it('renders one page at a time across files, reporting the wait to each file', async () => {
    const bytes = fixture('FICTIONAL-scanned-gst-return.pdf');
    let waits = 0;
    let waiting = 0;
    const observer = (): ExtractionObserver => ({
      phase: 'reading',
      queueWaitStarted: () => {
        waits += 1;
        waiting += 1;
      },
      queueWaitEnded: () => {
        waiting -= 1;
      },
    });
    const results = await Promise.all(
      [0, 1, 2].map(() => runObserved(observer(), () => renderPdfPages(bytes, signal())))
    );
    assert.ok(results.every((images) => images.length === 1));
    assert.ok(waits >= 1, 'parallel renders queued for the renderer');
    assert.equal(waiting, 0, 'every wait ended');
  });

  it('an aborted render stops and returns no pages', async () => {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await renderPdfPages(fixture('FICTIONAL-scanned-gst-return.pdf'), controller.signal), []);
  });
});

describe('streamed ZIP reading from disk', () => {
  it('yields each document one at a time and reports skipped files', async () => {
    const { forEachZipEntry } = await import('../server/documentAi/archiveUpload.ts');
    const { fileURLToPath } = await import('node:url');
    const names: string[] = [];
    const skipped: string[] = [];
    const result = await forEachZipEntry(
      fileURLToPath(new URL('./fixtures/FICTIONAL-borrower-documents.zip', import.meta.url)),
      async (entry) => {
        names.push(entry.name);
        assert.ok(entry.bytes.length > 0);
      },
      (fileName) => skipped.push(fileName)
    );
    assert.equal(result.files, 4);
    assert.deepEqual(names.sort(), [
      'FICTIONAL-itr-acknowledgement.txt',
      'FICTIONAL-loan-application.docx',
      'FICTIONAL-scanned-gst-return.pdf',
      'notes.exe',
    ]);
    assert.deepEqual(skipped, [], 'macOS junk is ignored silently');
  });
});
