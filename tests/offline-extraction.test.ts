/**
 * The whole pipeline with no AI quota: every accepted format ends in a result (done or failed),
 * scans and images are read by local OCR, and a model that reports its daily quota used up leaves
 * the document complete with its local values. No request leaves this process: model keys are
 * removed, and where a key is set to exercise the fallback, fetch is replaced by a stub.
 * Fixtures are fictional (tests/fixtures/generate-*.ts).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractDocument } from '../server/documentAi/pipeline.ts';
import { shutdownOcr } from '../server/documentAi/ocr.ts';
import type { AcceptedFileKind, DocumentExtractionResult, DocumentType } from '../src/types/documentAi.ts';

const MODEL_ENV = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'DOCUMENT_AI_LLM_FALLBACK', 'DOCUMENT_AI_OCR'];
const savedEnv = Object.fromEntries(MODEL_ENV.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

function clearModelEnv(): void {
  for (const key of MODEL_ENV) delete process.env[key];
}

before(() => {
  clearModelEnv();
  // Any request at all fails the test: nothing here may reach a provider.
  globalThis.fetch = (async () => {
    throw new Error('network access is not allowed in this test');
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await shutdownOcr();
});

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** Fails the test instead of hanging if a file never settles. */
async function extract(
  name: string,
  kind: AcceptedFileKind,
  options: { bytes?: Uint8Array; declared?: DocumentType; signal?: AbortSignal } = {}
): Promise<DocumentExtractionResult> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} did not settle within 60 s`)), 60_000);
  });
  try {
    return await Promise.race([
      extractDocument({
        documentId: 'doc_test',
        fileName: name,
        kind,
        bytes: options.bytes ?? fixture(name),
        declaredDocumentType: options.declared ?? null,
        today: '2025-11-01',
        signal: options.signal ?? new AbortController().signal,
      }),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function success(result: DocumentExtractionResult) {
  assert.ok(result.ok, `expected success, got ${result.ok ? '' : result.errorCode}`);
  return result;
}

const valueOf = (result: ReturnType<typeof success>, fieldId: string, period?: string) =>
  result.fields.find((f) => f.fieldId === fieldId && (period === undefined || f.period === period))?.value;

describe('digital documents with no model configured', () => {
  it('GST return PDF: turnover read from the text layer and verified against it', async () => {
    const result = success(await extract('FICTIONAL-gst-return-fy2024-25.pdf', 'pdf'));
    assert.equal(result.documentType, 'gst_return');
    assert.equal(result.model, 'local-rules');
    const turnover = result.fields.find((f) => f.fieldId === 'financialProfile.gstAnnualTurnover');
    assert.equal(turnover?.value, 12_500_000);
    assert.equal(turnover?.period, 'FY 2024-25');
    assert.equal(turnover?.sourceCheck, 'verified');
    assert.equal(turnover?.status, 'auto_applied');
    assert.equal(turnover?.source.page, 1);
  });

  it('bank statement PDF: one month from its printed totals', async () => {
    const result = success(await extract('FICTIONAL-bank-statement-may-2025.pdf', 'pdf'));
    assert.equal(result.documentType, 'bank_statement');
    assert.deepEqual(
      result.bankMonthlyTotals.map((m) => [m.month, m.totalCredits, m.closingBalance, m.subjectRef]),
      [['2025-05', 240_000, 195_000, 'XXXX4321']]
    );
  });

  it('balance sheet XLSX: values cited by sheet and cell, each with its period', async () => {
    const result = success(await extract('FICTIONAL-balance-sheet-fy2024-25.xlsx', 'xlsx'));
    assert.equal(result.documentType, 'financial_statement');
    assert.equal(valueOf(result, 'financialProfile.annualRevenue', 'FY 2024-25'), 125_000_000);
    assert.equal(valueOf(result, 'financialProfile.annualRevenue', 'FY 2023-24'), 100_000_000);
    assert.equal(valueOf(result, 'financialProfile.depreciation', 'FY 2024-25'), 4_500_000);
    const pat = result.fields.find((f) => f.fieldId === 'financialProfile.netProfitAfterTax' && f.period === 'FY 2024-25');
    assert.equal(pat?.source.sheetName, 'Profit and Loss');
    assert.match(pat?.source.cellRef ?? '', /^[A-Z]+\d+$/);
  });

  it('loan application DOCX: amount, tenure and entity type', async () => {
    const result = success(await extract('FICTIONAL-loan-application.docx', 'docx'));
    assert.equal(result.documentType, 'loan_application');
    assert.equal(valueOf(result, 'requestedAmount'), 5_000_000);
    assert.equal(valueOf(result, 'requestedTenureMonths'), 36);
    assert.equal(valueOf(result, 'entityType'), 'private_limited');
  });

  it('ITR TXT: completes; income that is not revenue is left missing', async () => {
    const result = success(await extract('FICTIONAL-itr-acknowledgement.txt', 'txt'));
    assert.equal(result.documentType, 'itr');
    assert.equal(valueOf(result, 'financialProfile.annualRevenue'), undefined);
  });

  it('two-year statement TXT: a lakh header scales the figures', async () => {
    const result = success(await extract('FICTIONAL-financials-two-years.txt', 'txt'));
    assert.equal(valueOf(result, 'financialProfile.annualRevenue', 'FY 2024-25'), 125_000_000);
    assert.equal(valueOf(result, 'financialProfile.interestExpense', 'FY 2023-24'), 5_000_000);
    assert.equal(valueOf(result, 'financialProfile.ebitda'), undefined, 'one figure under two columns is not guessed');
  });

  it('bank summary CSV: three months from the printed table', async () => {
    const result = success(await extract('FICTIONAL-bank-monthly-summary.csv', 'csv'));
    assert.deepEqual(
      result.bankMonthlyTotals.map((m) => [m.month, m.totalCredits, m.closingBalance]),
      [
        ['2025-01', 520_000, 180_000],
        ['2025-02', 475_000, 150_000],
        ['2025-03', 610_000, 220_000],
      ]
    );
  });
});

describe('scans and images read by local OCR', () => {
  it('scanned PDF: OCR text becomes the source, and values always go to review', async () => {
    const result = success(await extract('FICTIONAL-scanned-gst-return.pdf', 'pdf'));
    assert.equal(result.documentType, 'gst_return');
    assert.equal(result.model, 'local-rules+ocr');
    const turnover = result.fields.find((f) => f.fieldId === 'financialProfile.gstAnnualTurnover');
    assert.equal(turnover?.value, 12_500_000);
    assert.equal(turnover?.sourceCheck, 'verified');
    assert.equal(turnover?.status, 'needs_verification');
    assert.ok(turnover?.reasons.includes('low_confidence'));
  });

  it('PNG credit report: CIBIL score and CMR rank', async () => {
    const result = success(await extract('FICTIONAL-credit-report-scan.png', 'png'));
    assert.equal(result.documentType, 'credit_report');
    assert.equal(valueOf(result, 'financialProfile.personalCibilScore'), 762);
    assert.equal(valueOf(result, 'financialProfile.commercialCmrRank'), 4);
    assert.ok(result.fields.every((f) => f.status !== 'auto_applied'), 'OCR values never auto-apply');
  });

  it('JPEG bank summary: monthly rows read from the image', async () => {
    const result = success(await extract('FICTIONAL-bank-summary-scan.jpg', 'jpeg'));
    assert.equal(result.documentType, 'bank_statement');
    assert.deepEqual(result.bankMonthlyTotals.map((m) => m.month), ['2025-04', '2025-05']);
    assert.ok(result.bankMonthlyTotals.every((m) => m.confidence < 0.7));
  });

  it('WebP GST return: turnover read', async () => {
    const result = success(await extract('FICTIONAL-gst-annual-return-scan.webp', 'webp'));
    assert.equal(valueOf(result, 'financialProfile.gstAnnualTurnover'), 24_000_000);
  });

  it('an image with no text fails as unreadable_document, without hanging', async () => {
    const result = await extract('FICTIONAL-pan-card.png', 'png');
    assert.deepEqual(result, { ok: false, documentId: 'doc_test', errorCode: 'unreadable_document' });
  });

  it('with OCR switched off, a scan with no model is unreadable_document', async () => {
    process.env.DOCUMENT_AI_OCR = 'off';
    try {
      const result = await extract('FICTIONAL-scanned-gst-return.pdf', 'pdf');
      assert.equal(result.ok ? 'ok' : result.errorCode, 'unreadable_document');
    } finally {
      delete process.env.DOCUMENT_AI_OCR;
    }
  });

  it('an abort during OCR settles at once', async () => {
    const controller = new AbortController();
    const pending = extract('FICTIONAL-scanned-gst-return.pdf', 'pdf', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(Date.now() - started < 5_000);
  });
});

describe('other outcomes are always terminal', () => {
  it('a document of unknown type completes with nothing extracted', async () => {
    const result = success(
      await extract('notes.txt', 'txt', { bytes: Buffer.from('FICTIONAL meeting notes\nNothing to see here\n') })
    );
    assert.equal(result.documentType, 'other');
    assert.equal(result.fields.length, 0);
  });

  it('a declared type is honoured, so a user override can unlock local extraction', async () => {
    const bytes = Buffer.from('FICTIONAL\nCIBIL Score: 701\n');
    const result = success(await extract('report.txt', 'txt', { bytes, declared: 'credit_report' }));
    assert.equal(valueOf(result, 'financialProfile.personalCibilScore'), 701);
  });

  it('an empty text file is unreadable_document', async () => {
    const result = await extract('empty.txt', 'txt', { bytes: Buffer.from('\n\n') });
    assert.equal(result.ok ? 'ok' : result.errorCode, 'unreadable_document');
  });

  it('a corrupt spreadsheet is unreadable_document', async () => {
    const result = await extract('broken.xlsx', 'xlsx', { bytes: Buffer.from('PK\u0003\u0004 broken') });
    assert.equal(result.ok ? 'ok' : result.errorCode, 'unreadable_document');
  });

  it('a password-protected PDF is reported as such', async () => {
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF\n', 'latin1');
    const result = await extract('locked.pdf', 'pdf', { bytes });
    assert.equal(result.ok ? 'ok' : result.errorCode, 'password_protected');
  });
});

describe('AI as a fallback only (stubbed provider, no network)', () => {
  const GST_WITHOUT_TURNOVER = Buffer.from(
    'GST Annual Return Summary (FICTIONAL)\nLegal name: FICTIONAL SAMPLE TRADERS PRIVATE LIMITED\nFinancial year: FY 2024-25\n'
  );
  let calls = 0;

  before(() => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key-not-real';
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
  });

  after(() => {
    clearModelEnv();
    globalThis.fetch = (async () => {
      throw new Error('network access is not allowed in this test');
    }) as typeof fetch;
  });

  it('does not ask the model when local extraction found the key fields', async () => {
    const result = success(await extract('FICTIONAL-gst-return-fy2024-25.pdf', 'pdf'));
    assert.equal(calls, 0);
    assert.equal(result.model, 'local-rules');
  });

  it('asks for a missing key field; a used-up daily quota still completes the file with its local values', async () => {
    const result = success(await extract('gst.txt', 'txt', { bytes: GST_WITHOUT_TURNOVER }));
    assert.equal(calls, 1, 'one request, no retries on a daily quota');
    assert.equal(result.documentType, 'gst_return');
    assert.equal(valueOf(result, 'applicantLabel'), 'FICTIONAL SAMPLE TRADERS PRIVATE LIMITED');
    assert.equal(valueOf(result, 'financialProfile.gstAnnualTurnover'), undefined, 'missing stays missing');
  });

  it('after the quota answer, later files are not sent to the model', async () => {
    const result = success(await extract('gst.txt', 'txt', { bytes: GST_WITHOUT_TURNOVER }));
    assert.equal(calls, 1);
    assert.equal(result.model, 'local-rules');
  });
});

describe('a figure whose period the document does not state is never given one (audit E)', () => {
  it('the prior-year figure under an unrecognised heading is period_unknown and never auto-applied', async () => {
    const statement = Buffer.from(
      [
        'Statement of Profit and Loss (FICTIONAL)',
        'For the year ended 31 March 2025',
        'Revenue from operations  1,25,00,000',
        'Notes to accounts',
        'Comparative figures (2023-24)',
        'Revenue from operations  1,00,00,000',
      ].join('\n')
    );
    const result = success(await extract('statement.txt', 'txt', { bytes: statement, declared: 'financial_statement' }));
    const prior = result.fields.find((f) => f.fieldId === 'financialProfile.annualRevenue' && f.value === 10_000_000);
    assert.ok(prior, 'the figure is still listed for review');
    assert.equal(prior.period, null);
    assert.ok(prior.reasons.includes('period_unknown'));
    assert.notEqual(prior.status, 'auto_applied');
    assert.equal(result.model, 'local-rules');
  });
});
