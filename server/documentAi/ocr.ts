/**
 * Local OCR for scanned PDFs and images (tesseract.js), so a scan is read without any AI request.
 *
 * - Language data is the npm package @tesseract.js-data/eng (a dependency), read from node_modules.
 *   Nothing is downloaded at run time and nothing is cached to disk (cacheMethod 'none'), so the
 *   Render free plan's read-only, ephemeral disk is never touched. If the data or the engine cannot
 *   load, OCR reports itself unavailable and the caller fails the file with unreadable_document.
 * - One worker by default (DOCUMENT_AI_OCR_WORKERS, 1-4): OCR is CPU and memory heavy, and the free
 *   plan has a fraction of one CPU. Callers queue for a worker; the queue honours their abort signal.
 * - Every page has a timeout, and every document a budget. The budget starts once this document has
 *   a worker, so time spent queued behind other files never eats into it. A page that times out is
 *   skipped (its worker is terminated and replaced, so a stuck page can never stall the rest) and the
 *   next page is read while the budget lasts. Idle workers are shut down to free memory.
 * - Time spent waiting for a shared resource (an OCR worker here, the page renderer in
 *   textDocuments.ts) is reported to the file's ExtractionObserver, so jobs.ts can leave it out of
 *   the file's own timer.
 * - Logs nothing: OCR text is document content.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Worker } from 'tesseract.js';

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(max, Math.floor(value)) : fallback;
};

/** Pages read per document. Summary figures sit on the first pages; the rest would cost minutes. */
export const MAX_OCR_PAGES = envInt('DOCUMENT_AI_OCR_MAX_PAGES', 5, 1, 30);
/** One page on the Render free plan (a tenth of a CPU) can take well over a minute. */
export const OCR_PAGE_TIMEOUT_MS = envInt('DOCUMENT_AI_OCR_PAGE_TIMEOUT_MS', 120_000, 1_000, 600_000);
/**
 * A document stops being read after this, keeping the pages already read. Scaled to the page timeout
 * by default, so one slow page still leaves time for the others.
 */
export const OCR_DOCUMENT_BUDGET_MS = envInt(
  'DOCUMENT_AI_OCR_DOCUMENT_BUDGET_MS',
  Math.min(900_000, Math.round(OCR_PAGE_TIMEOUT_MS * 2.5)),
  1_000,
  900_000
);
/** With less budget than this left, the next page is not started. */
const MIN_PAGE_TIME_MS = 2_000;
const OCR_WORKERS = envInt('DOCUMENT_AI_OCR_WORKERS', 1, 1, 4);
const WORKER_START_TIMEOUT_MS = 45_000;
const IDLE_SHUTDOWN_MS = 120_000;
/** Matches the data directory: best_int is the LSTM-only model. */
const OEM_LSTM_ONLY = 1;

export type OcrFailure = 'ocr_unavailable' | 'ocr_timeout' | 'ocr_failed';

/** Fixed message per code; never carries engine or document text. */
export class OcrError extends Error {
  constructor(readonly code: OcrFailure) {
    super(code);
    this.name = 'OcrError';
  }
}

const abortError = () => new DOMException('Extraction was aborted.', 'AbortError');

let resolvedDataPath: string | null | undefined;

/** Directory holding eng.traineddata.gz, or null when the bundled data is missing. */
export function ocrLanguageDataPath(): string | null {
  if (resolvedDataPath !== undefined) return resolvedDataPath;
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    const dir = path.join(root, '4.0.0_best_int');
    resolvedDataPath = existsSync(path.join(dir, 'eng.traineddata.gz')) ? dir : null;
  } catch {
    resolvedDataPath = null;
  }
  return resolvedDataPath;
}

export function isOcrAvailable(): boolean {
  return process.env.DOCUMENT_AI_OCR?.trim().toLowerCase() !== 'off' && ocrLanguageDataPath() !== null;
}

// ------------------------------------------------------------------ Extraction observer

/**
 * Per-file hooks, carried through every await of one extraction by AsyncLocalStorage, so no
 * signature changes. jobs.ts installs one per file; the readers report into it. Holds no content.
 */
export interface ExtractionObserver {
  /** Waiting for a shared resource (OCR worker, page renderer) began and ended. Each start has one end. */
  queueWaitStarted(): void;
  queueWaitEnded(): void;
  /** The step the file is in: reading it locally, or waiting on a model. */
  phase: 'reading' | 'model';
}

const observers = new AsyncLocalStorage<ExtractionObserver>();

/** Runs `run` with `observer` as the current file's observer. */
export function runObserved<T>(observer: ExtractionObserver, run: () => T): T {
  return observers.run(observer, run);
}

export function currentExtractionObserver(): ExtractionObserver | undefined {
  return observers.getStore();
}

/** Marks the file as waiting on a model while `run` runs. */
export async function inModelPhase<T>(run: () => Promise<T>): Promise<T> {
  const observer = observers.getStore();
  if (!observer) return run();
  const previous = observer.phase;
  observer.phase = 'model';
  try {
    return await run();
  } finally {
    observer.phase = previous;
  }
}

// ------------------------------------------------------------------ Worker pool

interface Slot {
  worker: Promise<Worker> | null;
  busy: boolean;
}

const slots: Slot[] = Array.from({ length: OCR_WORKERS }, () => ({ worker: null, busy: false }));
const waiting: Array<() => void> = [];
let idleTimer: NodeJS.Timeout | null = null;

function discardWorker(slot: Slot): void {
  const pending = slot.worker;
  slot.worker = null;
  void pending?.then((worker) => worker.terminate()).catch(() => undefined);
}

/** Rejects with `onTimeout` after `ms`, or an AbortError when `signal` fires. */
function settleWithin<T>(work: Promise<T>, ms: number, signal: AbortSignal, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(onTimeout());
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function startWorker(): Promise<Worker> {
  const langPath = ocrLanguageDataPath();
  if (!langPath) throw new OcrError('ocr_unavailable');
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', OEM_LSTM_ONLY, {
    langPath,
    gzip: true,
    cacheMethod: 'none',
    // Without a handler tesseract.js throws inside its message listener, which would crash the server.
    errorHandler: () => undefined,
  });
  // Keeps the gaps between table columns, so a row's figures stay apart.
  await worker.setParameters({ preserve_interword_spaces: '1' });
  return worker;
}

function workerFor(slot: Slot, signal: AbortSignal): Promise<Worker> {
  if (!slot.worker) {
    const starting = startWorker();
    starting.catch(() => undefined);
    slot.worker = starting;
  }
  const pending = slot.worker;
  return settleWithin(pending, WORKER_START_TIMEOUT_MS, signal, () => new OcrError('ocr_unavailable')).catch(
    (error: unknown) => {
      // A worker that failed or hung while starting is never reused.
      if (slot.worker === pending && !(error instanceof DOMException)) discardWorker(slot);
      throw error instanceof OcrError || error instanceof DOMException ? error : new OcrError('ocr_unavailable');
    }
  );
}

async function acquire(signal: AbortSignal): Promise<Slot> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const observer = observers.getStore();
  let queued = false;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const free = slots.find((slot) => !slot.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      if (!queued) {
        queued = true;
        observer?.queueWaitStarted();
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortError());
        };
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        waiting.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  } finally {
    if (queued) observer?.queueWaitEnded();
  }
}

function release(slot: Slot): void {
  slot.busy = false;
  const next = waiting.shift();
  if (next) {
    next();
    return;
  }
  if (slots.every((s) => !s.busy) && !idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (slots.every((s) => !s.busy)) slots.forEach(discardWorker);
    }, IDLE_SHUTDOWN_MS);
    idleTimer.unref();
  }
}

/** Terminates every worker. For tests and shutdown; a later call starts new ones. */
export async function shutdownOcr(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const pending = slots.map((slot) => slot.worker).filter((worker): worker is Promise<Worker> => worker !== null);
  slots.forEach((slot) => {
    slot.worker = null;
  });
  await Promise.all(pending.map((worker) => worker.then((w) => w.terminate()).catch(() => undefined)));
}

// ------------------------------------------------------------------ Text clean-up

/**
 * OCR reads a grouping comma as a full stop now and then: `1.25,00,000.00`, `3.80.000.00`. A figure
 * with two or more marks before a final `.dd` can hold only one decimal point, the last, so the
 * earlier full stops become commas, but only when that is the one possible reading:
 * - no full stop comes after a comma. A decimal point is never followed by a grouping comma, so
 *   `1.25,00,000.00` is unambiguous; in `1,234.567.89` the first full stop may be the real decimal
 *   point (`1,234.56` and then noise), so it is left exactly as read;
 * - the groups fit exactly one grouping: Indian (first group 1-2 digits, then 2-digit groups, then a
 *   final 3-digit group) or Western (first group 1-3 digits, then only 3-digit groups).
 * Anything else is left untouched.
 */
export function repairOcrFigures(line: string): string {
  return line.replace(/(?<![\d.,])\d{1,3}(?:[.,]\d{2,3}){2,}\.\d{2}(?![\d.,])/g, (figure) => {
    const body = figure.slice(0, -3);
    if (!body.includes('.')) return figure;
    const firstComma = body.indexOf(',');
    if (firstComma >= 0 && body.lastIndexOf('.') > firstComma) return figure;
    const [first, ...groups] = body.split(/[.,]/);
    const last = groups.pop() ?? '';
    const western = first.length <= 3 && last.length === 3 && groups.every((g) => g.length === 3);
    const indian = first.length <= 2 && last.length === 3 && groups.length > 0 && groups.every((g) => g.length === 2);
    if (western === indian) return figure; // neither grouping fits (both never can)
    return `${body.replace(/\./g, ',')}${figure.slice(-3)}`;
  });
}

/** Lines of one page: trimmed, runs of spaces kept as two (a column gap), blanks dropped. */
export function ocrTextToLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => repairOcrFigures(line.replace(/\t/g, '  ').replace(/ {3,}/g, '  ').trim()))
    .filter((line) => line.replace(/[^A-Za-z0-9]/g, '').length > 0);
}

// ------------------------------------------------------------------ Recognition

export interface OcrPagesResult {
  /**
   * Lines per page, in page order, for every page that was attempted: index i is page i + 1. A page
   * that read nothing, or timed out, is an empty array. Pages after the budget ran out are absent.
   */
  pages: string[][];
  /** Pages with no text because they timed out or the document budget ran out first. */
  pagesSkipped: number;
  /** Of those, pages that were started and timed out. */
  pagesTimedOut: number;
}

/**
 * Reads each image (PNG, JPEG, WebP bytes) in order. The document budget starts once a worker is
 * ready for this document, never while it queues. A page that times out is skipped and the next
 * page read while the budget lasts, so the result is whatever text could be read. Rejects with
 * OcrError('ocr_unavailable') when the engine cannot start, and with an AbortError when `signal` fires.
 */
export async function ocrImages(
  images: readonly Uint8Array[],
  signal: AbortSignal,
  options: { pageTimeoutMs?: number; budgetMs?: number } = {}
): Promise<OcrPagesResult> {
  if (!isOcrAvailable()) throw new OcrError('ocr_unavailable');
  const pageTimeoutMs = options.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? OCR_DOCUMENT_BUDGET_MS;
  const pages: string[][] = [];
  let pagesTimedOut = 0;
  const slot = await acquire(signal);
  try {
    // The first worker start is bounded by WORKER_START_TIMEOUT_MS; the budget runs from here.
    await workerFor(slot, signal);
    const deadline = Date.now() + budgetMs;
    for (const image of images) {
      const remaining = Math.min(pageTimeoutMs, deadline - Date.now());
      if (remaining < Math.min(MIN_PAGE_TIME_MS, pageTimeoutMs)) break;
      let worker: Worker;
      try {
        worker = await workerFor(slot, signal);
      } catch (error) {
        // A replacement worker that cannot start ends the reading, keeping the pages already read.
        if (error instanceof OcrError && pages.length > 0) break;
        throw error;
      }
      try {
        const result = await settleWithin(
          worker.recognize(Buffer.from(image)),
          remaining,
          signal,
          () => new OcrError('ocr_timeout')
        );
        pages.push(ocrTextToLines(result.data.text ?? ''));
      } catch (error) {
        // The engine may still be busy with this page: it is terminated, never reused.
        discardWorker(slot);
        if (error instanceof DOMException) throw error;
        if (error instanceof OcrError && error.code === 'ocr_timeout') pagesTimedOut += 1;
        // A slow page, or an image the engine could not decode, reads as nothing; the rest still count.
        pages.push([]);
      }
    }
  } finally {
    release(slot);
  }
  return { pages, pagesSkipped: images.length - pages.length + pagesTimedOut, pagesTimedOut };
}
