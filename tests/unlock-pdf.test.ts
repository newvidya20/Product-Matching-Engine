import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unlockPdf, MAX_PDF_PASSWORD_LENGTH } from '../server/documentAi/unlockPdf.ts';
import { isEncryptedPdf } from '../server/documentAi/pipeline.ts';
import { readPdfText } from '../server/documentAi/spreadsheet.ts';

// A one-page PDF with fake text, encrypted (AES-256) with the user password below.
const LOCKED = new Uint8Array(fs.readFileSync(new URL('./fixtures/locked-test.pdf', import.meta.url)));
const PASSWORD = 'Secret123';

describe('unlockPdf', () => {
  it('the fixture really is password protected', async () => {
    assert.equal(isEncryptedPdf(LOCKED), true);
    const read = await readPdfText(LOCKED, new AbortController().signal, { maxPages: 1 });
    assert.equal(read.source.kind, 'unreadable');
  });

  it('opens with the right password and the app can then read its text', async () => {
    const res = await unlockPdf(LOCKED, PASSWORD);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(isEncryptedPdf(res.bytes), false);
    const read = await readPdfText(res.bytes, new AbortController().signal, { maxPages: 1 });
    assert.notEqual(read.source.kind, 'unreadable');
    assert.match(JSON.stringify(read.source), /1,23,456\.78/);
  });

  it('refuses a wrong password with a fixed code', async () => {
    assert.deepEqual(await unlockPdf(LOCKED, 'wrong'), { ok: false, reason: 'wrong_password' });
  });

  it('refuses an empty or oversized password without running the engine', async () => {
    assert.deepEqual(await unlockPdf(LOCKED, ''), { ok: false, reason: 'wrong_password' });
    assert.deepEqual(await unlockPdf(LOCKED, 'x'.repeat(MAX_PDF_PASSWORD_LENGTH + 1)), { ok: false, reason: 'wrong_password' });
  });

  it('does not leak the password or file text in the result', async () => {
    const res = await unlockPdf(LOCKED, 'zz-not-the-pass-9');
    assert.deepEqual(res, { ok: false, reason: 'wrong_password' });
    assert.ok(!JSON.stringify(res).includes('zz-not-the-pass-9'));
  });

  it('a file that is not a PDF fails cleanly', async () => {
    const res = await unlockPdf(new Uint8Array([1, 2, 3, 4]), PASSWORD);
    assert.equal(res.ok, false);
  });
});
