/**
 * Local OCR for scanned PDFs and images (tesseract.js), so a scan is read without any AI request.
 *
 * - Language data is the npm package @tesseract.js-data/eng (a dependency), read from node_modules.
 *   Nothing is downloaded at run time and nothing is cached to disk (cacheMethod 'none'), so the
 *   Render free plan's read-only, ephemeral disk is never touched. If the data or the engine cannot
 *   load, OCR reports itself unavailable and the caller fails the file with unreadable_document.
 * - One worker by default (DOCUMENT_AI_OCR_WORKERS, 1-4): OCR is CPU and memory heavy, and the free
 *   plan has a fraction of one CPU. Callers queue for a worker; the queue honours their abort signal,
 *   and a freed worker is handed straight to the next caller, so it never sits idle while files wait.
 * - A worker start is bounded (DOCUMENT_AI_OCR_START_TIMEOUT_MS, 60 s): past it the engine's thread
 *   is terminated, and the file is read without OCR (unreadable_document when no model can help).
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
export const MAX_OCR_PAGES = envInt('DOCUMENT_AI_OCR_MAX_PAGES', 10, 1, 30);
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
/**
 * A worker that has not started within this, from the moment it was asked for, is terminated and
 * the file is read without OCR (with no model to fall back on, it fails as unreadable_document).
 */
export const OCR_WORKER_START_TIMEOUT_MS = envInt('DOCUMENT_AI_OCR_START_TIMEOUT_MS', 60_000, 1_000, 300_000);
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
  /**
   * Work time the file has left before its timer stops it, in ms, if the file has a timer. A model
   * call is cut short before this, so a slow model never costs a file the values it read locally.
   */
  remainingMs?(): number;
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

/** The engine's thread, as far as this module needs it. */
interface Terminable {
  terminate(): unknown;
  once?(event: 'exit', listener: () => void): unknown;
}

/** One worker being started, or started. */
interface WorkerStart {
  ready: Promise<Worker>;
  startedAt: number;
  /** The engine's thread, known from the moment it is spawned, so a start that hangs can be killed. */
  thread: Terminable | null;
  discarded: boolean;
}

interface Slot {
  start: WorkerStart | null;
  busy: boolean;
}

/** Takes the slot it is handed: release() passes a slot on still marked busy. */
type Waiter = (slot: Slot) => void;

const slots: Slot[] = Array.from({ length: OCR_WORKERS }, () => ({ start: null, busy: false }));
const waiting: Waiter[] = [];
let idleTimer: NodeJS.Timeout | null = null;

/** Engine threads spawned and not yet exited, for tests and diagnostics. */
const liveThreads = new Set<Terminable>();

export function liveOcrThreadCount(): number {
  return liveThreads.size;
}

function terminateThread(thread: Terminable | null): void {
  if (!thread) return;
  try {
    void Promise.resolve(thread.terminate()).catch(() => undefined);
  } catch {
    // already gone
  }
}

/**
 * tesseract.js hands out a worker only once it has started, so a start that never settles would
 * leave its thread running with no way to stop it. Its spawn function is wrapped (before the
 * library is first loaded, which is when it is bound) to note each thread as it is created. If the
 * wrapping is not possible, a start that settles late is still terminated then.
 */
let spawnHookTried = false;
let lastSpawned: Terminable | null = null;

function installSpawnHook(): void {
  if (spawnHookTried) return;
  spawnHookTried = true;
  try {
    const require = createRequire(import.meta.url);
    const nodeWorker = require('tesseract.js/src/worker/node/index.js') as {
      spawnWorker?: (options: unknown) => Terminable;
    };
    const original = nodeWorker.spawnWorker;
    if (typeof original !== 'function') return;
    nodeWorker.spawnWorker = (options: unknown) => {
      const thread = original(options);
      lastSpawned = thread;
      liveThreads.add(thread);
      thread.once?.('exit', () => liveThreads.delete(thread));
      return thread;
    };
  } catch {
    // Layout changed: fall back to terminating a late start once it settles.
  }
}

function beginWorkerStart(): WorkerStart {
  const start: WorkerStart = { ready: Promise.resolve(null as unknown as Worker), startedAt: Date.now(), thread: null, discarded: false };
  start.ready = (async () => {
    const langPath = ocrLanguageDataPath();
    if (!langPath) throw new OcrError('ocr_unavailable');
    installSpawnHook();
    const { createWorker } = await import('tesseract.js');
    if (start.discarded) throw new OcrError('ocr_unavailable');
    lastSpawned = null;
    const creating = createWorker('eng', OEM_LSTM_ONLY, {
      langPath,
      gzip: true,
      cacheMethod: 'none',
      // Without a handler tesseract.js throws inside its message listener, which would crash the server.
      errorHandler: () => undefined,
    });
    // The thread is spawned synchronously inside createWorker, before its first await.
    start.thread = lastSpawned;
    lastSpawned = null;
    creating.catch(() => undefined);
    const worker = await creating;
    if (start.discarded) {
      void worker.terminate().catch(() => undefined);
      throw new OcrError('ocr_unavailable');
    }
    // Keeps the gaps between table columns, so a row's figures stay apart.
    await worker.setParameters({ preserve_interword_spaces: '1' });
    return worker;
  })();
  start.ready.catch(() => undefined);
  return start;
}

/** Stops a worker, started or still starting, and frees its slot for a new one. */
function discardWorker(slot: Slot): void {
  const start = slot.start;
  slot.start = null;
  if (!start) return;
  start.discarded = true;
  terminateThread(start.thread);
  start.thread = null;
  void start.ready.then((worker) => worker.terminate()).catch(() => undefined);
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
    }, Math.max(0, ms));
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

/**
 * The slot's worker, starting one if needed. A start is bounded from the moment it began, however
 * many files wait on it: past `startTimeoutMs` it is terminated (thread included) and never reused.
 */
function workerFor(slot: Slot, signal: AbortSignal, startTimeoutMs: number): Promise<Worker> {
  if (!slot.start) slot.start = beginWorkerStart();
  const start = slot.start;
  const left = startTimeoutMs - (Date.now() - start.startedAt);
  return settleWithin(start.ready, left, signal, () => new OcrError('ocr_unavailable')).catch((error: unknown) => {
    // A worker that failed or hung while starting is terminated, never reused. An abort is this
    // file's own: the start goes on for the next file, within the same bound.
    if (slot.start === start && !(error instanceof DOMException)) discardWorker(slot);
    throw error instanceof OcrError || error instanceof DOMException ? error : new OcrError('ocr_unavailable');
  });
}

/**
 * Takes a free slot, or waits in turn for one. A slot is handed to the next waiter still marked
 * busy, so nobody can take it in between; a waiter whose file was aborted after being handed one
 * passes it straight on, so a free worker never sits idle while files queue.
 */
async function acquire(signal: AbortSignal): Promise<Slot> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (signal.aborted) throw abortError();
  const free = slots.find((slot) => !slot.busy);
  if (free) {
    free.busy = true;
    return free;
  }
  const observer = observers.getStore();
  observer?.queueWaitStarted();
  try {
    const slot = await new Promise<Slot>((resolve, reject) => {
      const onAbort = () => {
        const index = waiting.indexOf(wake);
        if (index >= 0) waiting.splice(index, 1);
        reject(abortError());
      };
      const wake: Waiter = (handed) => {
        signal.removeEventListener('abort', onAbort);
        resolve(handed);
      };
      waiting.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (signal.aborted) {
      release(slot); // aborted between the hand-over and now: pass it on
      throw abortError();
    }
    return slot;
  } finally {
    observer?.queueWaitEnded();
  }
}

function release(slot: Slot): void {
  const next = waiting.shift();
  if (next) {
    next(slot); // handed over still busy
    return;
  }
  slot.busy = false;
  if (slots.every((s) => !s.busy) && !idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (slots.every((s) => !s.busy)) slots.forEach(discardWorker);
    }, IDLE_SHUTDOWN_MS);
    idleTimer.unref();
  }
}

/** The slot queue itself, for tests: no worker is started. */
export const ocrPoolForTests = {
  acquire,
  release(slot: unknown): void {
    release(slot as Slot);
  },
  waitingCount: (): number => waiting.length,
  freeSlotCount: (): number => slots.filter((slot) => !slot.busy).length,
  slotCount: (): number => slots.length,
};

/** Terminates every worker. For tests and shutdown; a later call starts new ones. */
export async function shutdownOcr(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const pending = slots.map((slot) => slot.start).filter((start): start is WorkerStart => start !== null);
  slots.forEach((slot) => discardWorker(slot));
  // A start that was cut off mid-way may never settle: wait for each only briefly.
  await Promise.all(
    pending.map((start) =>
      Promise.race([
        start.ready.then((worker) => worker.terminate()).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
      ])
    )
  );
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

/** Calls to ocrImages and images handed to it, so tests can prove a text file never reaches OCR. Counts only. */
export const ocrStatsForTests = { calls: 0, images: 0 };

/**
 * Reads each image (PNG, JPEG, WebP bytes) in order. The document budget starts once a worker is
 * ready for this document, never while it queues. A page that times out is skipped and the next
 * page read while the budget lasts, so the result is whatever text could be read. Rejects with
 * OcrError('ocr_unavailable') when the engine cannot start, and with an AbortError when `signal` fires.
 */
export async function ocrImages(
  images: readonly Uint8Array[],
  signal: AbortSignal,
  options: { pageTimeoutMs?: number; budgetMs?: number; startTimeoutMs?: number } = {}
): Promise<OcrPagesResult> {
  ocrStatsForTests.calls += 1;
  ocrStatsForTests.images += images.length;
  if (!isOcrAvailable()) throw new OcrError('ocr_unavailable');
  const pageTimeoutMs = options.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? OCR_WORKER_START_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? OCR_DOCUMENT_BUDGET_MS;
  const pages: string[][] = [];
  let pagesTimedOut = 0;
  const slot = await acquire(signal);
  try {
    // A worker start is bounded by OCR_WORKER_START_TIMEOUT_MS; the budget runs from here.
    await workerFor(slot, signal, startTimeoutMs);
    const deadline = Date.now() + budgetMs;
    for (const image of images) {
      const remaining = Math.min(pageTimeoutMs, deadline - Date.now());
      if (remaining < Math.min(MIN_PAGE_TIME_MS, pageTimeoutMs)) break;
      let worker: Worker;
      try {
        worker = await workerFor(slot, signal, startTimeoutMs);
      } catch (error) {
        // A replacement worker that cannot start ends the reading, keeping the pages already read.
        if (error instanceof OcrError && pages.length > 0) break;
        throw error;
      }
      try {
        const result = await settleWithin(
          // A view, not a copy: memory is tight on a small instance.
          worker.recognize(Buffer.isBuffer(image) ? image : Buffer.from(image.buffer, image.byteOffset, image.byteLength)),
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
