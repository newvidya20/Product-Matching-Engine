/**
 * Safety limits around local OCR and page rendering:
 * - every value from OCR text, the model's included, goes to review (H1);
 * - a rendered page is held to a pixel budget, and rendering is serialised (H2, M7);
 * - the OCR budget starts once a worker is ready, a slow page is skipped, not fatal (M6, M8);
 * - a file's timer pauses while it queues, and a reading timeout is never blamed on the AI (M6, L11).
 * No request leaves this process: keys are removed, and where one is set, fetch is a stub.
 * Fixtures are fictional (tests/fixtures/generate-*.ts).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractDocument, OCR_CONFIDENCE_CAP } from '../server/documentAi/pipeline.ts';
import {
  inModelPhase,
  OCR_DOCUMENT_BUDGET_MS,
  OCR_PAGE_TIMEOUT_MS,
  ocrImages,
  runObserved,
  shutdownOcr,
  type ExtractionObserver,
} from '../server/documentAi/ocr.ts';
import { MAX_RENDER_PIXELS, renderPdfPages, renderScaleFor } from '../server/documentAi/textDocuments.ts';
import { fileWorkBudgetMs, startFileTimer, timeoutCode } from '../server/documentAi/jobs.ts';
import { DOCUMENT_AI_THRESHOLDS, type AcceptedFileKind, type DocumentExtractionResult, type DocumentType } from '../src/types/documentAi.ts';

const MODEL_ENV = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'LLM_PROVIDER', 'DOCUMENT_AI_LLM_FALLBACK', 'DOCUMENT_AI_OCR', 'OPENROUTER_PDF_INPUT'];
const savedEnv = Object.fromEntries(MODEL_ENV.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
const noNetwork = (async () => {
  throw new Error('network access is not allowed in this test');
}) as typeof fetch;

before(() => {
  for (const key of MODEL_ENV) delete process.env[key];
  globalThis.fetch = noNetwork;
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function extract(
  fileName: string,
  kind: AcceptedFileKind,
  bytes: Uint8Array,
  declaredDocumentType: DocumentType | null
): Promise<DocumentExtractionResult> {
  return extractDocument({
    documentId: 'doc_test',
    fileName,
    kind,
    bytes,
    declaredDocumentType,
    today: '2025-11-01',
    signal: new AbortController().signal,
  });
}

function countingObserver(): ExtractionObserver & { started: number; ended: number } {
  return {
    phase: 'reading',
    started: 0,
    ended: 0,
    queueWaitStarted() {
      this.started += 1;
    },
    queueWaitEnded() {
      this.ended += 1;
    },
  };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(image: Buffer): { width: number; height: number } {
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

// ------------------------------------------------------------------ H1

describe('values from OCR text never auto-apply, whoever extracted them (H1)', () => {
  const GST_LINES = [
    'FICTIONAL SAMPLE - ILLUSTRATIVE SCAN, NOT A REAL GST RETURN',
    'Form GSTR-9 Annual Return (FICTIONAL)',
    'Financial year: FY 2024-25',
    'Aggregate turnover: Rs. 2,40,00,000.00',
  ];
  let calls = 0;

  before(() => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key-not-real';
    // A stub model that is sure of itself: it quotes the turnover line as revenue, at 0.95.
    globalThis.fetch = (async () => {
      calls += 1;
      const content = JSON.stringify({
        readable: true,
        suspiciousInstructions: false,
        fields: [
          {
            fieldId: 'financialProfile.annualRevenue',
            rawValue: 'Rs. 2,40,00,000.00',
            confidence: 0.95,
            period: 'FY 2024-25',
            page: 1,
            snippet: 'Aggregate turnover: Rs. 2,40,00,000.00',
          },
        ],
        bankMonthlyTotals: [],
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  after(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = noNetwork;
  });

  it('the cap sits below the lowest auto-apply threshold', () => {
    assert.ok(OCR_CONFIDENCE_CAP < DOCUMENT_AI_THRESHOLDS.minAutoApply);
  });

  it('control: the same model value from a text file is auto-applied', async () => {
    const before = calls;
    const result = await extract('financials.txt', 'txt', Buffer.from(`${GST_LINES.join('\n')}\n`), 'financial_statement');
    assert.ok(result.ok);
    assert.equal(calls, before + 1, 'the model was asked');
    const revenue = result.fields.find((f) => f.fieldId === 'financialProfile.annualRevenue');
    assert.equal(revenue?.value, 24_000_000);
    assert.equal(revenue?.sourceCheck, 'verified');
    assert.equal(revenue?.status, 'auto_applied');
  });

  it('the model value from an OCR-read image is capped and goes to review', async () => {
    const before = calls;
    const result = await extract('financials.webp', 'webp', fixture('FICTIONAL-gst-annual-return-scan.webp'), 'financial_statement');
    assert.ok(result.ok, result.ok ? '' : result.errorCode);
    assert.equal(calls, before + 1, 'the model was asked');
    const revenue = result.fields.find((f) => f.fieldId === 'financialProfile.annualRevenue');
    assert.equal(revenue?.value, 24_000_000);
    assert.equal(revenue?.sourceCheck, 'verified', 'the source check passes against the OCR text');
    assert.ok((revenue?.confidence ?? 1) <= OCR_CONFIDENCE_CAP);
    assert.equal(revenue?.status, 'needs_verification');
    assert.ok(result.fields.every((f) => f.status !== 'auto_applied'));
  });
});

// ------------------------------------------------------------------ H2, M7

describe('page rendering is held to a pixel budget (H2, M7)', () => {
  it('keeps the preferred scale for an ordinary page', () => {
    assert.equal(renderScaleFor(595, 842), 2); // A4 at scale 2: about 2 MP
  });

  it('lowers the scale so a huge page fits the budget', () => {
    const side = 14_400; // the largest page a PDF allows, 200 inches square
    const scale = renderScaleFor(side, side, 4_000_000);
    assert.ok(scale !== null && scale < 2);
    assert.ok(Math.ceil(side * scale) ** 2 <= 4_000_000);
    assert.ok(Math.ceil(side * scale) ** 2 > 3_900_000, 'not shrunk more than needed');
  });

  it('holds the canvas, each side rounded up, inside the budget for awkward sizes', () => {
    for (const [w, h, max] of [
      [612, 1008, 1_000_000],
      [1191, 1684, 4_000_000],
      [3001, 2999, 2_500_000],
      [999.7, 1333.3, 750_001],
    ]) {
      const scale = renderScaleFor(w, h, max);
      assert.ok(scale !== null && scale > 0);
      assert.ok(Math.ceil(w * scale) * Math.ceil(h * scale) <= max, `${w}x${h} within ${max}`);
    }
  });

  it('caps each side of a very long strip', () => {
    const scale = renderScaleFor(100, 40_000, 16_000_000);
    assert.ok(scale !== null);
    assert.ok(Math.ceil(40_000 * scale) <= 8_000);
  });

  it('refuses a page with no usable size', () => {
    assert.equal(renderScaleFor(0, 842), null);
    assert.equal(renderScaleFor(595, Number.NaN), null);
    assert.equal(renderScaleFor(-1, 10), null);
    assert.equal(renderScaleFor(595, 842, 0), null);
  });

  it('defaults to about 4 megapixels, and reads the budget from the environment', () => {
    assert.equal(MAX_RENDER_PIXELS, 4_000_000);
    const root = fileURLToPath(new URL('../', import.meta.url));
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "const m = await import('./server/documentAi/textDocuments.ts'); console.log(m.MAX_RENDER_PIXELS);",
      ],
      { cwd: root, env: { ...process.env, DOCUMENT_AI_RENDER_MAX_PIXELS: '1000000' }, encoding: 'utf8' }
    );
    assert.equal(run.stdout.trim(), '1000000');
  });

  it('renders no more pages than asked, each within the budget', async () => {
    const bytes = fixture('FICTIONAL-scanned-gst-return.pdf');
    const images = await renderPdfPages(bytes, new AbortController().signal, 1);
    assert.equal(images.length, 1);
    const { width, height } = pngSize(images[0]);
    assert.ok(width * height <= MAX_RENDER_PIXELS);
    assert.deepEqual(await renderPdfPages(bytes, new AbortController().signal, 3, 99), [], 'past the last page');
  });

  it('renders one page at a time across files: parallel files queue for the renderer', async () => {
    const bytes = fixture('FICTIONAL-scanned-gst-return.pdf');
    const observers = [countingObserver(), countingObserver(), countingObserver()];
    const results = await Promise.all(
      observers.map((observer) => runObserved(observer, () => renderPdfPages(bytes, new AbortController().signal, 1)))
    );
    assert.ok(results.every((images) => images.length === 1));
    assert.ok(observers.some((o) => o.started > 0), 'at least one file waited its turn');
    assert.ok(observers.every((o) => o.started === o.ended));
  });

  it('an aborted render settles promptly and returns nothing more', async () => {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await renderPdfPages(fixture('FICTIONAL-scanned-gst-return.pdf'), controller.signal, 3), []);
  });
});

// ------------------------------------------------------------------ M6, M8

describe('OCR time limits (M6, M8)', () => {
  const page = fixture('FICTIONAL-credit-report-scan.png');

  it('defaults suit a fraction of a CPU: a long page timeout, and a budget for more than one slow page', () => {
    assert.ok(OCR_PAGE_TIMEOUT_MS >= 120_000);
    assert.ok(OCR_DOCUMENT_BUDGET_MS >= 2 * OCR_PAGE_TIMEOUT_MS);
  });

  it('a page that times out is skipped and the next one still tried; the worker is replaced', async () => {
    const result = await ocrImages([page, page], new AbortController().signal, { pageTimeoutMs: 1, budgetMs: 60_000 });
    assert.equal(result.pages.length, 2, 'both pages were attempted');
    assert.equal(result.pagesTimedOut, 2);
    assert.equal(result.pagesSkipped, 2);
    // The replaced worker reads normally.
    const next = await ocrImages([page], new AbortController().signal);
    assert.ok(next.pages[0].some((line) => /CIBIL/i.test(line)));
  });

  it('the document budget starts once a worker is free, so a queued file still gets its pages', async () => {
    const warm = Date.now();
    await ocrImages([page], new AbortController().signal);
    const onePage = Math.max(200, Date.now() - warm);
    // B's budget is enough for its own page (and above the 2 s floor for starting one), but less
    // than the time it queues behind A's pages: if the budget ran while queued, B would read nothing.
    const budgetMs = Math.round(onePage * 1.5) + 2_500;
    const aPages = Array.from({ length: Math.ceil((budgetMs * 1.5) / onePage) + 1 }, () => page);
    const observer = countingObserver();
    const queuedAt = Date.now();
    let waitedMs = 0;
    const a = ocrImages(aPages, new AbortController().signal).then((result) => {
      waitedMs = Date.now() - queuedAt;
      return result;
    });
    const b = runObserved(observer, () => ocrImages([page], new AbortController().signal, { budgetMs }));
    const [, second] = await Promise.all([a, b]);
    assert.equal(observer.started, 1, 'B waited for the worker');
    assert.equal(observer.ended, 1);
    assert.ok(waitedMs > budgetMs, `B queued ${waitedMs} ms, longer than its ${budgetMs} ms budget`);
    assert.equal(second.pagesSkipped, 0);
    assert.ok(second.pages[0]?.some((line) => /CIBIL/i.test(line)), 'B read its page');
  });
});

// ------------------------------------------------------------------ M6, L11

describe('per-file timer and timeout codes (M6, L11)', () => {
  it('pauses while the file waits for a shared reader', async () => {
    let expiredCount = 0;
    const timer = startFileTimer(150, () => (expiredCount += 1));
    try {
      timer.observer.queueWaitStarted();
      await sleep(300);
      assert.equal(timer.expired, false, 'waiting is not work');
      timer.observer.queueWaitEnded();
      await sleep(300);
      assert.equal(timer.expired, true);
      assert.equal(expiredCount, 1);
    } finally {
      timer.cancel();
    }
  });

  it('counts only work done, across waits', async () => {
    const timer = startFileTimer(250, () => undefined);
    try {
      await sleep(100); // 100 of 250 used
      timer.observer.queueWaitStarted();
      await sleep(300);
      timer.observer.queueWaitEnded();
      await sleep(80); // 180 used
      assert.equal(timer.expired, false);
      await sleep(200);
      assert.equal(timer.expired, true);
    } finally {
      timer.cancel();
    }
  });

  it('still stops a file that waits beyond the wait bound', async () => {
    const timer = startFileTimer(100, () => undefined, 150);
    try {
      timer.observer.queueWaitStarted();
      await sleep(400);
      assert.equal(timer.expired, true);
    } finally {
      timer.cancel();
    }
  });

  it('records the step the file was in when it expired, whatever happens after', async () => {
    const timer = startFileTimer(50, () => undefined);
    try {
      timer.observer.phase = 'model';
      await sleep(150);
      timer.observer.phase = 'reading'; // a model call unwinding after the abort
      assert.equal(timer.phaseAtExpiry, 'model');
    } finally {
      timer.cancel();
    }
  });

  it('a reading (OCR or render) timeout is not reported as an AI timeout', () => {
    assert.equal(timeoutCode('reading'), 'unreadable_document');
    assert.equal(timeoutCode('model'), 'llm_timeout');
  });

  it('marks the model phase only while a model call runs', async () => {
    const observer = countingObserver();
    await runObserved(observer, async () => {
      assert.equal(observer.phase, 'reading');
      await inModelPhase(async () => assert.equal(observer.phase, 'model'));
      assert.equal(observer.phase, 'reading');
      await assert.rejects(inModelPhase(async () => Promise.reject(new Error('x'))));
      assert.equal(observer.phase, 'reading');
    });
  });

  it('gives a file that may need rendering and OCR more work time, within a ceiling', () => {
    const text = fileWorkBudgetMs('txt');
    assert.ok(fileWorkBudgetMs('pdf') >= text + OCR_DOCUMENT_BUDGET_MS || fileWorkBudgetMs('pdf') === 15 * 60_000);
    assert.ok(fileWorkBudgetMs('png') > text);
    for (const kind of ['pdf', 'png', 'jpeg', 'webp', 'txt', 'docx', 'xlsx', 'csv'] as const) {
      assert.ok(fileWorkBudgetMs(kind) <= 15 * 60_000);
    }
  });
});
