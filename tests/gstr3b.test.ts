/**
 * GSTR-3B and ITR-V read with no AI, the monthly-to-annual GST derivation, the per-job model circuit
 * breaker, the memory gate's diagnostics, and the PDF engine's load time not counting against a file.
 * Fixtures are FICTIONAL and generated in memory (tests/fixtures/generate-gstr3b-fixtures.ts).
 * No request leaves this process: keys are removed, and fetch is a stub that counts and fails.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isGstr3b, periodMonths, readGstr3b } from '../server/documentAi/gstr3b.ts';
import { extractLocally } from '../server/documentAi/localExtractors.ts';
import {
  extractDocument,
  jobModelPaused,
  JOB_MODEL_PAUSE_MS,
  keyFieldsMissing,
  mergeSessionResults,
  noteJobModelFailure,
} from '../server/documentAi/pipeline.ts';
import { FileGate } from '../server/documentAi/jobs.ts';
import { readPdfText, type PdfReadOptions } from '../server/documentAi/spreadsheet.ts';
import { formatInrPaise } from '../server/documentAi/derive.ts';
import type { DocumentExtractionSuccess, GstReturnPeriodTotal } from '../src/types/documentAi.ts';
import {
  buildTextPdf,
  FICTIONAL_GSTIN,
  gstr3bLines,
  itrAcknowledgementLines,
  MONTHS_OF_FY,
  OTHER_FICTIONAL_GSTIN,
  type Gstr3bSpec,
} from './fixtures/generate-gstr3b-fixtures.ts';

const TODAY = '2026-11-04';
const MODEL_ENV = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'DOCUMENT_AI_LLM_FALLBACK', 'DOCUMENT_AI_OCR'];
const savedEnv = Object.fromEntries(MODEL_ENV.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
let fetchCalls = 0;

before(() => {
  for (const key of MODEL_ENV) delete process.env[key];
  process.env.DOCUMENT_AI_OCR = 'off';
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network access is not allowed in this test');
  }) as typeof fetch;
});

beforeEach(() => {
  fetchCalls = 0;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A model looks configured, but fetch is the failing stub: any model call is counted and fails. */
async function withStubModel<T>(run: () => Promise<T>): Promise<T> {
  process.env.OPENROUTER_API_KEY = 'FICTIONAL-not-a-key';
  process.env.LLM_PROVIDER = 'openrouter';
  try {
    return await run();
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_PROVIDER;
  }
}

const spec = (overrides: Partial<Gstr3bSpec> = {}): Gstr3bSpec => ({
  year: '2025-26',
  period: 'April',
  a: '1,00,000.00',
  b: '0.00',
  c: '2500.50',
  ...overrides,
});

async function extractPdf(pages: string[][], jobId?: string) {
  return extractDocument({
    documentId: `doc_${crypto.randomUUID()}`,
    fileName: 'FICTIONAL-return.pdf',
    kind: 'pdf',
    bytes: buildTextPdf(pages),
    declaredDocumentType: null,
    today: TODAY,
    signal: new AbortController().signal,
    jobId,
  });
}

function success(result: Awaited<ReturnType<typeof extractDocument>>): DocumentExtractionSuccess {
  assert.ok(result.ok, `expected success, got ${result.ok ? '' : result.errorCode}`);
  return result as DocumentExtractionSuccess;
}

const merge = (documents: DocumentExtractionSuccess[]) =>
  mergeSessionResults({ documents, editedFieldIds: [], autoApplyThreshold: 0.85, today: TODAY });

// ------------------------------------------------------------------ The reader

describe('GSTR-3B reader (no AI)', () => {
  it('reads Year, Period and Table 3.1 (a), (b), (c), (e) as printed, keeping the lines', () => {
    const { period, fields } = readGstr3b(gstr3bLines(spec({ e: '750.00' })), 0.9);
    assert.ok(period);
    assert.equal(period.yearText, '2025-26');
    assert.equal(period.periodText, 'April');
    assert.equal(period.outwardTaxable, '1,00,000.00');
    assert.equal(period.zeroRated, '0.00');
    assert.equal(period.nilExempt, '2500.50');
    assert.equal(period.nonGst, '750.00');
    assert.equal(period.gstin, FICTIONAL_GSTIN);
    assert.equal(period.page, 1);
    assert.match(period.snippet, /Period April/);
    assert.ok(period.snippet.length <= 300);
    assert.equal(fields.find((f) => f.fieldId === 'applicantLabel')?.rawValue, 'FICTIONAL ZETA TEXTILES PRIVATE LIMITED');
  });

  it('reads a label that wraps with its figures on the second line', () => {
    const { period } = readGstr3b(gstr3bLines(spec({ wrapA: 'figures_second' })), 0.9);
    assert.equal(period?.outwardTaxable, '1,00,000.00');
  });

  it('gives no period when a counted row is missing, its value is a dash, or it is printed twice', () => {
    assert.equal(readGstr3b(gstr3bLines(spec({ c: null })), 0.9).period, null);
    assert.equal(readGstr3b(gstr3bLines(spec({ b: '-' })), 0.9).period, null);
    const twice = gstr3bLines(spec());
    twice[0].splice(14, 0, '(b) Outward taxable supplies (zero rated) 99.00 0.00 - - 0.00');
    assert.equal(readGstr3b(twice, 0.9).period, null);
  });

  it('recognises only the printed title, and needs Year and Period lines', () => {
    const untitled = gstr3bLines(spec());
    untitled[0][0] = 'Summary of GST returns';
    assert.equal(isGstr3b(untitled), false);
    assert.equal(readGstr3b(untitled, 0.9).period, null);
    const noPeriod = gstr3bLines(spec());
    noPeriod[0].splice(3, 1);
    assert.equal(readGstr3b(noPeriod, 0.9).period, null);
  });

  it('maps a month, or a whole FY quarter, and nothing else', () => {
    assert.deepEqual(periodMonths('April', 2025), ['2025-04']);
    assert.deepEqual(periodMonths('March', 2025), ['2026-03']);
    assert.deepEqual(periodMonths('Jan-Mar', 2024), ['2025-01', '2025-02', '2025-03']);
    assert.equal(periodMonths('Apr-May', 2025), null);
    assert.equal(periodMonths('Annual', 2025), null);
  });

  it('formats paise with Indian grouping', () => {
    assert.equal(formatInrPaise(1234567800), '1,23,45,678.00');
    assert.equal(formatInrPaise(50), '0.50');
  });
});

describe('GSTR-3B files never call the AI', () => {
  it('reads a recognised GSTR-3B PDF locally even with a model configured', async () => {
    const result = success(await withStubModel(() => extractPdf(gstr3bLines(spec()))));
    assert.equal(fetchCalls, 0, 'no model call for a GSTR-3B that parsed');
    assert.equal(result.documentType, 'gst_return');
    assert.equal(result.model, 'local-rules');
    assert.equal(result.gstReturnPeriods?.length, 1);
    const [period] = result.gstReturnPeriods!;
    assert.deepEqual(period.months, ['2025-04']);
    assert.equal(period.outwardTaxable, 100000);
    assert.equal(period.nilExempt, 2500.5);
    assert.equal(period.gstin, FICTIONAL_GSTIN);
    assert.ok(result.fields.some((f) => f.fieldId === 'identity.gstin'));
  });

  it('keyFieldsMissing is satisfied by a read period, and by an ITR-V with its PAN', () => {
    const empty = { fields: [], bankMonthlyTotals: [] };
    assert.equal(keyFieldsMissing('gst_return', empty, 1), false);
    assert.equal(keyFieldsMissing('gst_return', empty, 0), true);
    const itr = extractLocally({ documentType: 'itr', content: { kind: 'text', pages: itrAcknowledgementLines() }, fromOcr: false });
    assert.equal(itr.recognisedForm, 'itr_acknowledgement');
    assert.ok(itr.fields.some((f) => f.fieldId === 'identity.pan'));
    assert.equal(itr.fields.find((f) => f.fieldId === 'applicantLabel')?.rawValue, 'FICTIONAL ZETA TEXTILES PRIVATE LIMITED');
    assert.ok(!itr.fields.some((f) => f.fieldId === 'entityType'), 'ITR status is not taken as the entity type');
    assert.equal(keyFieldsMissing('itr', itr), false);
  });

  it('reads an ITR-V PDF locally with no model call', async () => {
    const result = success(await withStubModel(() => extractPdf(itrAcknowledgementLines())));
    assert.equal(fetchCalls, 0);
    assert.equal(result.documentType, 'itr');
  });

  it('reads 24 GSTR-3Bs in seconds', async () => {
    const started = Date.now();
    for (let i = 0; i < 24; i += 1) {
      const year = i < 12 ? '2024-25' : '2025-26';
      success(await extractPdf(gstr3bLines(spec({ year, period: MONTHS_OF_FY[i % 12] }))));
    }
    assert.ok(Date.now() - started < 30_000, 'local reading only');
    assert.equal(fetchCalls, 0);
  });
});

// ------------------------------------------------------------------ Monthly to annual

async function fy(year: string, months: string[], overrides: (month: string) => Partial<Gstr3bSpec> = () => ({})) {
  const documents: DocumentExtractionSuccess[] = [];
  for (const month of months) documents.push(success(await extractPdf(gstr3bLines(spec({ year, period: month, ...overrides(month) })))));
  return documents;
}

describe('GST annual turnover from GSTR-3B months', () => {
  it('derives it only when all 12 months are present, always for review', async () => {
    const docs = await fy('2025-26', MONTHS_OF_FY);
    const merged = merge(docs);
    const annual = merged.fields['financialProfile.gstAnnualTurnover'];
    assert.ok(annual);
    assert.equal(annual.status, 'needs_verification');
    assert.ok(annual.reasons.includes('derived_value'));
    assert.equal(annual.value, 12 * (100000 + 0 + 2500.5));
    const derived = annual.candidates[0];
    assert.equal(derived.period, 'FY 2025-26');
    assert.equal(derived.derivation?.ruleId, 'annual_from_gst_monthly_returns');
    assert.equal(derived.derivation?.fromCandidateIds.length, 12);
    assert.match(derived.source.snippet, /\(a\)\+\(b\)\+\(c\)/);
    assert.match(derived.source.snippet, /Apr 2025.*Mar 2026/);
    assert.match(derived.source.snippet, /Excludes \(d\) reverse charge and \(e\) non-GST/);
    const mirror = merged.fields.annualTurnoverOrIncome;
    assert.notEqual(mirror?.status, 'auto_applied', 'the form never receives it without review');
    assert.ok(merged.fields['gst.monthlyOutwardSupplies']);
  });

  it('never counts (d) reverse charge or (e) non-GST supplies', async () => {
    const docs = await fy('2025-26', MONTHS_OF_FY, () => ({ d: '99999.00', e: '88888.00' }));
    assert.equal(merge(docs).fields['financialProfile.gstAnnualTurnover']?.value, 12 * 102500.5);
  });

  it('with 11 months, adds nothing up and names the missing month in a review-only summary', async () => {
    const docs = await fy('2025-26', MONTHS_OF_FY.filter((m) => m !== 'March'));
    const merged = merge(docs);
    assert.equal(merged.fields['financialProfile.gstAnnualTurnover'], undefined);
    const summary = merged.fields['gst.monthlyOutwardSupplies'];
    assert.ok(summary);
    assert.equal(summary.status, 'needs_verification');
    assert.match(String(summary.value), /11 of 12 months read, so nothing is added up/);
    assert.match(String(summary.value), /Missing: March 2026/);
    assert.match(String(summary.value), /Apr 2025 1,02,500\.50/);
    assert.equal(merged.fields.annualTurnoverOrIncome, undefined);
  });

  it('counts the same return uploaded twice once', async () => {
    const docs = await fy('2025-26', [...MONTHS_OF_FY, 'June']);
    assert.equal(merge(docs).fields['financialProfile.gstAnnualTurnover']?.value, 12 * 102500.5);
  });

  it('treats two different returns for one month as a conflict, not a sum', async () => {
    const docs = [...(await fy('2025-26', MONTHS_OF_FY)), ...(await fy('2025-26', ['June'], () => ({ a: '5,00,000.00' })))];
    const merged = merge(docs);
    assert.equal(merged.fields['financialProfile.gstAnnualTurnover'], undefined);
    assert.match(String(merged.fields['gst.monthlyOutwardSupplies']?.value), /Returns disagree for: June 2025/);
  });

  it('takes quarterly returns covering the year', async () => {
    const docs = await fy('2025-26', ['Apr-Jun', 'Jul-Sep', 'Oct-Dec', 'Jan-Mar']);
    assert.equal(merge(docs).fields['financialProfile.gstAnnualTurnover']?.value, 4 * 102500.5);
  });

  it('never adds up returns of two GSTINs', async () => {
    const half = MONTHS_OF_FY.slice(0, 6);
    const docs = [
      ...(await fy('2025-26', half)),
      ...(await fy('2025-26', MONTHS_OF_FY.slice(6), () => ({ gstin: OTHER_FICTIONAL_GSTIN }))),
    ];
    const merged = merge(docs);
    assert.equal(merged.fields['financialProfile.gstAnnualTurnover'], undefined);
    assert.ok(merged.fields['gst.monthlyOutwardSupplies']?.reasons.includes('multiple_subjects'));
  });

  it('lets a GST turnover stated directly for the same FY win', async () => {
    const docs = await fy('2025-26', MONTHS_OF_FY);
    const annualReturn = success(
      await extractPdf([['GSTR-9 Annual Return', 'Financial Year 2025-26', 'Aggregate turnover 15,00,000.00']])
    );
    const merged = merge([...docs, annualReturn]);
    const annual = merged.fields['financialProfile.gstAnnualTurnover'];
    assert.ok(annual);
    assert.ok(annual.candidates.every((c) => c.derivation === undefined), 'no derived value beside a direct one');
  });

  it('builds nothing from a stored result that has no GST periods', () => {
    const old: DocumentExtractionSuccess = {
      ok: true, documentId: 'doc_00000000-0000-4000-8000-000000000001', documentType: 'gst_return', classificationConfidence: 1,
      fields: [], bankMonthlyTotals: [], injectionSuspected: false, droppedLowConfidence: 0, model: 'local-rules',
    };
    assert.deepEqual(merge([old]).fields, {});
  });

  it('drops a period whose month has not begun', async () => {
    const result = success(await extractPdf(gstr3bLines(spec({ year: '2026-27', period: 'December' }))));
    assert.equal(result.gstReturnPeriods, undefined);
  });

  it('keeps every figure as printed on its GSTR-3B period, with page and snippet', async () => {
    const result = success(await extractPdf(gstr3bLines(spec())));
    const period = result.gstReturnPeriods![0] as GstReturnPeriodTotal;
    assert.equal(period.source.page, 1);
    assert.match(period.source.snippet, /\(a\) Outward taxable supplies/);
  });
});

// ------------------------------------------------------------------ Circuit breaker

describe('per-job model circuit breaker', () => {
  it('opens on a timeout, rate limit or quota failure, for that job only, for 10 minutes', () => {
    const now = 1_000_000;
    noteJobModelFailure('job_a', 'llm_failed', now);
    assert.equal(jobModelPaused('job_a', now), null, 'an ordinary failure does not trip it');
    noteJobModelFailure('job_a', 'llm_timeout', now);
    assert.equal(jobModelPaused('job_a', now + 1), 'llm_timeout');
    assert.equal(jobModelPaused('job_b', now + 1), null);
    assert.equal(jobModelPaused('job_a', now + JOB_MODEL_PAUSE_MS + 1), null);
  });

  it('fails an unreadable-by-rules file at once with the tripping code, without calling the model', async () => {
    const jobId = `job_${crypto.randomUUID()}`;
    noteJobModelFailure(jobId, 'llm_timeout');
    const result = await withStubModel(() => extractPdf([['A FICTIONAL memo with no known layout', 'Nothing labelled here at all, just prose text.']], jobId));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.ok ? null : result.errorCode, 'llm_timeout');
  });

  it('still completes a file with local values while the breaker is open', async () => {
    const jobId = `job_${crypto.randomUUID()}`;
    noteJobModelFailure(jobId, 'llm_rate_limited');
    const result = await withStubModel(() => extractPdf(gstr3bLines(spec()), jobId));
    assert.ok(result.ok);
    assert.equal(fetchCalls, 0);
  });
});

// ------------------------------------------------------------------ Memory gate diagnostics

describe('memory gate diagnostics', () => {
  it('logs one short line when it holds and when it turns a file away, with no document data', async () => {
    const lines: string[] = [];
    const gate = new FileGate({
      concurrency: 2,
      bytesBudget: 1e9,
      largeFileBytes: 1e9,
      heapHighRatio: 0.5,
      rssHighBytes: 0,
      memoryWaitMs: 30,
      pollMs: 5,
      readMemory: () => ({ heapUsed: 200 * 1024 * 1024, heapLimit: 250 * 1024 * 1024, rss: 0 }),
      warn: (line) => lines.push(line),
    });
    const admission = await gate.admit(1234);
    assert.equal(admission.ok, false);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[document-ai\] memory gate holding files: heap 200\/250 MB, 0 running, 1 queued$/);
    assert.match(lines[1], /^\[document-ai\] memory gate turned a file away \(server_busy\): heap 200\/250 MB/);
  });
});

// ------------------------------------------------------------------ PDF engine load time

describe('PDF text read timing', () => {
  const item = (str: string, y: number) => ({ str, transform: [1, 0, 0, 1, 0, y], width: 100, height: 10 });
  const documentOf = (text: string) => ({
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [item(text, 700)] }), cleanup: () => undefined }),
  });
  const engineFor = (promise: Promise<unknown>) =>
    ({ getDocument: () => ({ promise, destroy: async () => undefined }) }) as unknown as Awaited<
      ReturnType<NonNullable<PdfReadOptions['loadEngine']>>
    >;
  const text = 'A FICTIONAL text layer that is long enough to count as digital text for the check.';

  it('does not count the engine load time against the file read timeout', async () => {
    const slowLoad = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return engineFor(Promise.resolve(documentOf(text)));
    };
    const read = await readPdfText(new Uint8Array(4), new AbortController().signal, { loadEngine: slowLoad, timeoutMs: 50 });
    assert.equal(read.source.kind, 'pdf', 'a 150 ms load is not a 50 ms read timeout');
  });

  it('retries a timed-out read once before calling the file unreadable, logging only reason and time', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (line: string) => warnings.push(line));
    let attempts = 0;
    const loadEngine = async () =>
      ({
        getDocument: () => {
          attempts += 1;
          const promise = attempts === 1 ? new Promise(() => undefined) : Promise.resolve(documentOf(text));
          return { promise, destroy: async () => undefined };
        },
      }) as unknown as Awaited<ReturnType<NonNullable<PdfReadOptions['loadEngine']>>>;
    const read = await readPdfText(new Uint8Array(4), new AbortController().signal, { loadEngine, timeoutMs: 30 });
    assert.equal(read.source.kind, 'pdf');
    assert.equal(attempts, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[document-ai\] pdf_read_timeout after \d+ ms, retrying$/);
  });
});
