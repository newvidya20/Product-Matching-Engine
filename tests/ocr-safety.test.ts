process.env.DOCUMENT_AI_LLM_SCOPE = 'all'; // these tests exercise the model fallback on text files; production keeps those local-only
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
import {
  extractDocument,
  isEncryptedPdf,
  LLM_BUDGET_MS,
  MIN_MODEL_CALL_MS,
  MODEL_WRAP_UP_MS,
  modelCallBudgetMs,
  OCR_CONFIDENCE_CAP,
} from '../server/documentAi/pipeline.ts';
import {
  inModelPhase,
  liveOcrThreadCount,
  OCR_DOCUMENT_BUDGET_MS,
  OCR_PAGE_TIMEOUT_MS,
  OCR_WORKER_START_TIMEOUT_MS,
  OcrError,
  ocrImages,
  ocrPoolForTests,
  ocrStatsForTests,
  runObserved,
  shutdownOcr,
  type ExtractionObserver,
} from '../server/documentAi/ocr.ts';
import { MAX_RENDER_PIXELS, renderPdfPages, renderScaleFor, renderStatsForTests } from '../server/documentAi/textDocuments.ts';
import { extractLocally } from '../server/documentAi/localExtractors.ts';
import {
  FILE_GATE_OPTIONS,
  FileGate,
  fileWorkBudgetMs,
  JOB_CONCURRENCY,
  MAX_QUEUE_WAIT_MS,
  startFileTimer,
  timeoutCode,
  type FileGateOptions,
  type MemoryReading,
} from '../server/documentAi/jobs.ts';
import { PDF_MAX_TEXT_PAGES, readPdfText, type PdfReadOptions } from '../server/documentAi/spreadsheet.ts';
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

// ------------------------------------------------------------------ Render free plan (audit A-D, memory)

/** Rejects instead of hanging when `promise` does not settle in time. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('OCR worker queue hands a free worker on (audit A)', () => {
  it('a waiter aborted after being handed the worker passes it to the next waiter', async () => {
    assert.equal(ocrPoolForTests.slotCount(), 1, 'one worker by default');
    const holder = await ocrPoolForTests.acquire(new AbortController().signal);
    const bController = new AbortController();
    const b = ocrPoolForTests.acquire(bController.signal);
    b.catch(() => undefined);
    const c = ocrPoolForTests.acquire(new AbortController().signal);
    await sleep(0);
    assert.equal(ocrPoolForTests.waitingCount(), 2);
    // The slot goes to B, still busy; B's file is aborted before B resumes.
    ocrPoolForTests.release(holder);
    bController.abort();
    const cSlot = await within(c, 2_000, 'the next waiter');
    await assert.rejects(b, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(ocrPoolForTests.freeSlotCount(), 0, 'C holds the worker');
    ocrPoolForTests.release(cSlot);
    assert.equal(ocrPoolForTests.freeSlotCount(), 1);
    assert.equal(ocrPoolForTests.waitingCount(), 0);
  });

  it('a waiter aborted while queued leaves the queue; the worker is never taken in between', async () => {
    const holder = await ocrPoolForTests.acquire(new AbortController().signal);
    const controller = new AbortController();
    const queued = ocrPoolForTests.acquire(controller.signal);
    queued.catch(() => undefined);
    await sleep(0);
    controller.abort();
    await assert.rejects(queued);
    assert.equal(ocrPoolForTests.waitingCount(), 0);
    ocrPoolForTests.release(holder);
    assert.equal(ocrPoolForTests.freeSlotCount(), 1);
  });
});

describe('a file never waits on the queue for long (audit B)', () => {
  it('waits at most 5 minutes in total by default', () => {
    if (process.env.DOCUMENT_AI_MAX_QUEUE_WAIT_MS === undefined) assert.equal(MAX_QUEUE_WAIT_MS, 5 * 60_000);
  });

  it('adds up every wait: several short waits past the bound stop the file', async () => {
    let expiredCount = 0;
    const timer = startFileTimer(10_000, () => (expiredCount += 1), 200);
    try {
      for (let i = 0; i < 3 && !timer.expired; i += 1) {
        timer.observer.queueWaitStarted();
        await sleep(90);
        timer.observer.queueWaitEnded();
        await sleep(10);
      }
      assert.equal(timer.expired, true, '270 ms waited against a 200 ms bound');
      assert.equal(expiredCount, 1);
    } finally {
      timer.cancel();
    }
  });

  it('running out of waiting time is reported as a reading timeout, never an AI one', async () => {
    const timer = startFileTimer(10_000, () => undefined, 50);
    try {
      timer.observer.phase = 'model';
      timer.observer.queueWaitStarted();
      await sleep(150);
      assert.equal(timer.expired, true);
      assert.equal(timer.phaseAtExpiry, 'reading');
      assert.equal(timeoutCode(timer.phaseAtExpiry ?? 'model'), 'unreadable_document');
    } finally {
      timer.cancel();
    }
  });

  it('reports the work time left, paused while waiting', async () => {
    const timer = startFileTimer(1_000, () => undefined, 10_000);
    try {
      await sleep(100);
      const left = timer.observer.remainingMs?.() ?? -1;
      assert.ok(left <= 920 && left >= 700, `left ${left}`);
      timer.observer.queueWaitStarted();
      await sleep(150);
      const paused = timer.observer.remainingMs?.() ?? -1;
      assert.ok(Math.abs(paused - left) < 60, `still about ${left} while queued, got ${paused}`);
      timer.observer.queueWaitEnded();
    } finally {
      timer.cancel();
    }
  });
});

describe('an OCR worker that does not start is terminated (audit C)', () => {
  const page = fixture('FICTIONAL-credit-report-scan.png');

  it('bounds a start at 60 s by default', () => {
    if (process.env.DOCUMENT_AI_OCR_START_TIMEOUT_MS === undefined) assert.equal(OCR_WORKER_START_TIMEOUT_MS, 60_000);
  });

  it('a start past its bound reports the engine unavailable and its thread is stopped', async () => {
    await ocrImages([page], new AbortController().signal); // loads the library, so the next start spawns at once
    await shutdownOcr();
    await assert.rejects(
      ocrImages([page], new AbortController().signal, { startTimeoutMs: 1 }),
      (error: unknown) => error instanceof OcrError && error.code === 'ocr_unavailable'
    );
    const deadline = Date.now() + 10_000;
    while (liveOcrThreadCount() > 0 && Date.now() < deadline) await sleep(50);
    assert.equal(liveOcrThreadCount(), 0, 'no engine thread left running');
    // A later file starts a fresh worker and reads normally.
    const next = await ocrImages([page], new AbortController().signal);
    assert.equal(liveOcrThreadCount(), 1, 'the spawned thread is tracked');
    assert.ok(next.pages[0].some((line) => /CIBIL/i.test(line)));
  });

  it('with no model, an image whose OCR cannot start is unreadable_document, not a hang', async () => {
    // Same path as a start that timed out: OCR gives nothing, and there is no model to ask.
    process.env.DOCUMENT_AI_OCR = 'off';
    try {
      const result = await within(extract('scan.png', 'png', page, 'credit_report'), 10_000, 'the file');
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.errorCode, 'unreadable_document');
    } finally {
      delete process.env.DOCUMENT_AI_OCR;
    }
  });
});

describe('a slow model never costs a file its local values (audit D)', () => {
  // Revenue is read locally; the other key fields of a statement are missing, so the model is asked.
  const STATEMENT = Buffer.from(
    'Statement of Profit and Loss (FICTIONAL)\nFor the year ended 31 March 2025\nRevenue from operations  1,25,00,000\n'
  );
  let calls = 0;

  before(() => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key-not-real';
    // A model that never answers; it stops only when its signal aborts.
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
  });

  after(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = noNetwork;
  });

  it('the model gets no more than the file has left, less a margin to finish', () => {
    assert.equal(modelCallBudgetMs(undefined), LLM_BUDGET_MS);
    assert.equal(modelCallBudgetMs(10 * LLM_BUDGET_MS), LLM_BUDGET_MS);
    assert.equal(modelCallBudgetMs(60_000), 60_000 - MODEL_WRAP_UP_MS);
    assert.ok(modelCallBudgetMs(MODEL_WRAP_UP_MS) < MIN_MODEL_CALL_MS);
  });

  it('a model that outlasts the file budget times out first, and the file completes with its local values', async () => {
    const controller = new AbortController();
    const workMs = MODEL_WRAP_UP_MS + 2_000;
    const timer = startFileTimer(workMs, () => controller.abort());
    const before = calls;
    try {
      const result = await within(
        runObserved(timer.observer, () =>
          extractDocument({
            documentId: 'doc_test',
            fileName: 'statement.txt',
            kind: 'txt',
            bytes: STATEMENT,
            declaredDocumentType: 'financial_statement',
            today: '2025-11-01',
            signal: controller.signal,
          })
        ),
        workMs + 5_000,
        'the file'
      );
      assert.ok(calls > before, 'the model was asked');
      assert.equal(timer.expired, false, 'the file timer never fired');
      assert.ok(result.ok, result.ok ? '' : result.errorCode);
      const revenue = result.fields.find((f) => f.fieldId === 'financialProfile.annualRevenue');
      assert.equal(revenue?.value, 12_500_000);
    } finally {
      timer.cancel();
    }
  });

  it('with too little time left the model is not called at all, and the file still completes', async () => {
    const before = calls;
    const observer: ExtractionObserver = {
      phase: 'reading',
      queueWaitStarted() {},
      queueWaitEnded() {},
      remainingMs: () => MODEL_WRAP_UP_MS,
    };
    const result = await runObserved(observer, () => extract('statement.txt', 'txt', STATEMENT, 'financial_statement'));
    assert.equal(calls, before);
    assert.ok(result.ok);
    assert.ok(result.fields.some((f) => f.fieldId === 'financialProfile.annualRevenue'));
  });
});

describe('memory: large files and the heap (Render free plan)', () => {
  const low: MemoryReading = { heapUsed: 50, heapLimit: 1_000, rss: 100 };
  const high: MemoryReading = { heapUsed: 900, heapLimit: 1_000, rss: 100 };
  const gate = (overrides: Partial<FileGateOptions> = {}) =>
    new FileGate({
      concurrency: 2,
      bytesBudget: 100,
      largeFileBytes: 50,
      heapHighRatio: 0.65,
      rssHighBytes: 0,
      memoryWaitMs: 150,
      pollMs: 10,
      readMemory: () => low,
      ...overrides,
    });
  const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => (done = true));
    await sleep(30);
    return done;
  };

  it('defaults: 2 files at once, 40 MB in flight, 15 MB runs alone, 80% of the heap, 60 s wait', () => {
    if (process.env.DOCUMENT_AI_CONCURRENCY === undefined) assert.equal(JOB_CONCURRENCY, 2);
    assert.equal(FILE_GATE_OPTIONS.concurrency, JOB_CONCURRENCY);
    if (process.env.DOCUMENT_AI_INFLIGHT_MB === undefined) assert.equal(FILE_GATE_OPTIONS.bytesBudget, 40 * 1024 * 1024);
    if (process.env.DOCUMENT_AI_LARGE_FILE_MB === undefined) assert.equal(FILE_GATE_OPTIONS.largeFileBytes, 15 * 1024 * 1024);
    if (process.env.DOCUMENT_AI_HEAP_HIGH_RATIO === undefined) assert.equal(FILE_GATE_OPTIONS.heapHighRatio, 0.8);
    if (process.env.DOCUMENT_AI_MEMORY_WAIT_MS === undefined) assert.equal(FILE_GATE_OPTIONS.memoryWaitMs, 60_000);
  });

  it('runs no more than its concurrency at once, first come first served', async () => {
    const g = gate();
    const a = await g.admit(10);
    const b = await g.admit(10);
    const c = g.admit(10);
    assert.equal(await settled(c), false);
    assert.ok(a.ok && b.ok);
    a.release();
    const third = await within(c, 1_000, 'third file');
    assert.ok(third.ok);
    b.release();
    third.release();
    assert.equal(g.inFlight, 0);
  });

  it('holds the bytes in flight under its budget, and a large file runs with nothing else', async () => {
    const g = gate();
    const a = await g.admit(30);
    const b = await g.admit(30);
    const big = g.admit(60);
    const small = g.admit(5);
    assert.equal(await settled(big), false, 'a large file waits for the others');
    assert.equal(await settled(small), false, 'nothing jumps the queue');
    assert.ok(a.ok && b.ok);
    a.release();
    assert.equal(await settled(big), false);
    b.release();
    const bigAdmission = await within(big, 1_000, 'large file');
    assert.ok(bigAdmission.ok);
    assert.equal(await settled(small), false, 'nothing runs beside a large file');
    bigAdmission.release();
    const smallAdmission = await within(small, 1_000, 'small file');
    assert.ok(smallAdmission.ok);
    smallAdmission.release();
  });

  it('two files over the byte budget together run one after the other', async () => {
    const g = gate({ largeFileBytes: 80 });
    const a = await g.admit(45);
    const b = g.admit(45);
    assert.equal(await settled(b), true, '90 fits in 100');
    const bAdmission = await b;
    assert.ok(a.ok && bAdmission.ok);
    a.release();
    const c = g.admit(60);
    assert.equal(await settled(c), false, '45 + 60 does not fit in 100');
    bAdmission.release();
    const cAdmission = await within(c, 1_000, 'third file');
    assert.ok(cAdmission.ok);
    cAdmission.release();
  });

  it('turns a file away when the heap stays high with nothing running, rather than risk a crash', async () => {
    const g = gate({ readMemory: () => high });
    const started = Date.now();
    const admission = await within(g.admit(10), 2_000, 'admission');
    assert.equal(admission.ok, false);
    assert.ok(Date.now() - started >= 140, 'waited for memory first');
    assert.equal(g.inFlight, 0);
  });

  it('starts the file once the heap falls within the wait', async () => {
    let reading = high;
    const g = gate({ readMemory: () => reading, memoryWaitMs: 5_000 });
    const pending = g.admit(10);
    assert.equal(await settled(pending), false);
    reading = low;
    const admission = await within(pending, 1_000, 'admission');
    assert.ok(admission.ok);
    admission.release();
  });

  it('with the heap high, runs one file at a time', async () => {
    let reading = low;
    const g = gate({ readMemory: () => reading, memoryWaitMs: 5_000 });
    const first = await g.admit(10);
    reading = high;
    const second = g.admit(10);
    assert.equal(await settled(second), false, 'nothing starts beside a running file while memory is high');
    reading = low;
    const admission = await within(second, 1_000, 'second file');
    assert.ok(first.ok && admission.ok);
    first.release();
    admission.release();
  });

  it('also watches resident memory when a limit is set', async () => {
    const g = gate({ rssHighBytes: 500, readMemory: () => ({ heapUsed: 1, heapLimit: 1_000, rss: 600 }), memoryWaitMs: 50 });
    assert.equal(g.memoryHigh(), true);
    assert.equal((await within(g.admit(1), 1_000, 'admission')).ok, false);
  });

  it('scans a large PDF for encryption a window at a time, catching a mark across a seam', () => {
    const size = 3 * 1024 * 1024;
    assert.equal(isEncryptedPdf(Buffer.alloc(size, 0x20)), false);
    for (const at of [0, 1024 * 1024 - 5, 2 * 1024 * 1024 - 260, size - 16]) {
      const bytes = Buffer.alloc(size, 0x20);
      bytes.write('/Encrypt 12 0 R', at, 'latin1');
      assert.equal(isEncryptedPdf(bytes), true, `mark at ${at}`);
      assert.equal(isEncryptedPdf(new Uint8Array(bytes)), true, `mark at ${at}, plain Uint8Array`);
    }
  });

  it('reads the text of the first pages only, and says how many it read', async () => {
    const item = (str: string) => ({ str, transform: [1, 0, 0, 1, 0, 700], width: 100, height: 10 });
    let pagesOpened = 0;
    let pagesCleaned = 0;
    const document = {
      numPages: 400,
      getPage: async (n: number) => {
        pagesOpened += 1;
        return {
          getTextContent: async () => ({ items: [item(`Page ${n} of a long fictional annual report, text only`)] }),
          cleanup: () => (pagesCleaned += 1),
        };
      },
    };
    let destroyed = 0;
    const task = { promise: Promise.resolve(document), destroy: async () => void (destroyed += 1) };
    const loadEngine = (async () => ({ getDocument: () => task })) as unknown as NonNullable<PdfReadOptions['loadEngine']>;
    const text = await readPdfText(new Uint8Array(4), new AbortController().signal, { loadEngine });
    if (process.env.DOCUMENT_AI_PDF_MAX_TEXT_PAGES === undefined) assert.equal(PDF_MAX_TEXT_PAGES, 150);
    assert.equal(text.totalPages, 400);
    assert.equal(text.pagesRead, PDF_MAX_TEXT_PAGES);
    assert.equal(pagesOpened, PDF_MAX_TEXT_PAGES, 'pages past the cap are never loaded');
    assert.equal(pagesCleaned, pagesOpened, 'every page is cleaned up');
    assert.ok(destroyed >= 1, 'the document is destroyed');
    assert.ok(text.source.kind === 'pdf' && text.source.pages?.length === PDF_MAX_TEXT_PAGES);
  });
});

// ------------------------------------------------------------------ Per-page OCR

/**
 * A fictional PDF built in code: each page is either text (a real text layer) or a scan (a JPEG of
 * the lines, no text layer), so one file can mix both.
 */
async function buildPdf(pages: Array<{ kind: 'text' | 'scan'; lines: string[] }>): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length;
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< >>'); // the page tree, filled in once the pages exist
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const page of pages) {
    if (page.kind === 'text') {
      const ops = ['BT', '/F1 11 Tf', '14 TL', '50 760 Td', ...page.lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`), 'ET'];
      const content = add(stream('', Buffer.from(ops.join('\n'), 'latin1')));
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    } else {
      const canvas = createCanvas(1240, 1754);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1240, 1754);
      ctx.fillStyle = '#111111';
      ctx.font = '34px sans-serif';
      page.lines.forEach((line, i) => ctx.fillText(line, 80, 140 + i * 64));
      const jpeg = canvas.toBuffer('image/jpeg');
      const image = add(stream('/Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', jpeg));
      const content = add(stream('', Buffer.from('q 595 0 0 842 0 0 cm /Im0 Do Q', 'latin1')));
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`));
    }
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const trailer =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%E` + 'OF\n';
  parts.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(parts);
}

describe('PDFs: native text where there is a text layer, OCR only for pages without one', () => {
  const TEXT_PAGE = [
    'FICTIONAL SAMPLE - ILLUSTRATIVE DOCUMENT, NOT A REAL BALANCE SHEET',
    'Balance Sheet of FICTIONAL SAMPLE TRADERS PRIVATE LIMITED',
    'Financial year: FY 2024-25',
    'Tangible net worth: Rs. 80,00,000',
  ];
  const SCAN_PAGE = [
    'FICTIONAL SAMPLE - ILLUSTRATIVE SCAN',
    'Financial year: FY 2024-25',
    'Total outside liabilities: Rs. 45,00,000',
  ];
  const counts = () => ({ ocr: ocrStatsForTests.calls, ocrImages: ocrStatsForTests.images, render: renderStatsForTests.calls });

  it('a digital PDF is read from its text layer: never rendered, never OCR', async () => {
    const before = counts();
    const result = await extract('gst.pdf', 'pdf', fixture('FICTIONAL-gst-return-fy2024-25.pdf'), 'gst_return');
    assert.ok(result.ok, result.ok ? '' : result.errorCode);
    assert.deepEqual(counts(), before);
    assert.equal(result.model, 'local-rules');
    const twoTextPages = await buildPdf([
      { kind: 'text', lines: TEXT_PAGE },
      { kind: 'text', lines: SCAN_PAGE },
    ]);
    const second = await extract('bs.pdf', 'pdf', twoTextPages, 'financial_statement');
    assert.ok(second.ok);
    assert.deepEqual(counts(), before, 'a two-page digital PDF is not rendered or OCR read either');
    const tol = second.fields.find((f) => f.fieldId === 'financialProfile.totalOutsideLiabilities');
    assert.equal(tol?.source.page, 2);
    assert.equal(tol?.confidence, 0.9);
  });

  it('a fully scanned PDF is rendered and read by OCR', async () => {
    const before = counts();
    const result = await extract('scan.pdf', 'pdf', fixture('FICTIONAL-scanned-gst-return.pdf'), 'gst_return');
    assert.ok(result.ok, result.ok ? '' : result.errorCode);
    assert.equal(counts().ocr, before.ocr + 1);
    assert.equal(counts().render, before.render + 1);
    assert.deepEqual(renderStatsForTests.lastPageNumbers, [1]);
    assert.ok(result.fields.every((f) => f.confidence <= OCR_CONFIDENCE_CAP));
  });

  it('a mixed PDF: OCR runs on the scanned page only, the text page keeps its native text', async () => {
    const bytes = await buildPdf([
      { kind: 'text', lines: TEXT_PAGE },
      { kind: 'scan', lines: SCAN_PAGE },
    ]);
    const before = counts();
    const result = await extract('mixed.pdf', 'pdf', bytes, 'financial_statement');
    assert.ok(result.ok, result.ok ? '' : result.errorCode);
    assert.equal(counts().ocr, before.ocr + 1, 'OCR is called once');
    assert.equal(counts().ocrImages, before.ocrImages + 1, 'with one image');
    assert.deepEqual(renderStatsForTests.lastPageNumbers, [2], 'only page 2 is rendered');
    assert.ok(result.model.includes('+ocr'));
    assert.ok(!result.model.includes('+partial'));

    const tnw = result.fields.find((f) => f.fieldId === 'financialProfile.tangibleNetWorth');
    assert.equal(tnw?.value, 8_000_000);
    assert.equal(tnw?.source.page, 1, 'native text keeps its page');
    assert.equal(tnw?.confidence, 0.9, 'a value from the text layer is not capped');
    assert.equal(tnw?.sourceCheck, 'verified');

    const tol = result.fields.find((f) => f.fieldId === 'financialProfile.totalOutsideLiabilities');
    assert.equal(tol?.value, 4_500_000, 'the scanned page is read, not left empty');
    assert.equal(tol?.source.page, 2, 'the OCR text keeps its own page number');
    assert.ok((tol?.confidence ?? 1) <= OCR_CONFIDENCE_CAP, 'a value from an OCR page is capped');
    assert.notEqual(tol?.status, 'auto_applied');
  });

  it('a mixed PDF with OCR switched off keeps its text pages and is marked partial', async () => {
    const bytes = await buildPdf([
      { kind: 'text', lines: TEXT_PAGE },
      { kind: 'scan', lines: SCAN_PAGE },
    ]);
    process.env.DOCUMENT_AI_OCR = 'off';
    try {
      const before = counts();
      const result = await extract('mixed.pdf', 'pdf', bytes, 'financial_statement');
      assert.ok(result.ok);
      assert.deepEqual(counts(), before);
      assert.ok(result.model.includes('+partial'));
      assert.ok(result.fields.some((f) => f.fieldId === 'financialProfile.tangibleNetWorth'));
      assert.ok(!result.fields.some((f) => f.fieldId === 'financialProfile.totalOutsideLiabilities'));
    } finally {
      delete process.env.DOCUMENT_AI_OCR;
    }
  });

  it('a text page never takes its period from OCR text alone', () => {
    const pages = [['Tangible net worth: Rs. 80,00,000'], ['Financial year: FY 2023-24', 'Notes']];
    const read = (ocrPages?: Set<number>) =>
      extractLocally({ documentType: 'financial_statement', content: { kind: 'text', pages }, fromOcr: false, ocrPages }).fields.find(
        (f) => f.fieldId === 'financialProfile.tangibleNetWorth'
      )?.period;
    assert.equal(read(), 'FY 2023-24', 'control: from a text layer the sole period applies');
    assert.equal(read(new Set([2])), null, 'stated only on an OCR page: left unknown');
  });

  it('spreadsheets, Word and text files are read natively and never reach the renderer or OCR', async () => {
    const before = counts();
    const files: Array<[string, AcceptedFileKind, string, DocumentType]> = [
      ['bs.xlsx', 'xlsx', 'FICTIONAL-balance-sheet-fy2024-25.xlsx', 'financial_statement'],
      ['bank.csv', 'csv', 'FICTIONAL-bank-monthly-summary.csv', 'bank_statement'],
      ['app.docx', 'docx', 'FICTIONAL-loan-application.docx', 'loan_application'],
      ['itr.txt', 'txt', 'FICTIONAL-itr-acknowledgement.txt', 'itr'],
    ];
    for (const [name, kind, file, type] of files) {
      const result = await extract(name, kind, fixture(file), type);
      assert.ok(result.ok, `${name}: ${result.ok ? '' : result.errorCode}`);
      assert.ok(!result.model.includes('+ocr'), name);
    }
    assert.deepEqual(counts(), before);
  });
});
