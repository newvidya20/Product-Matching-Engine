/**
 * Extraction job queue (docs/contracts.md section 7.6).
 * In-process FIFO, 300 s of work per file, more for a file that may need rendering and OCR
 * (fileWorkBudgetMs). Calls only the exported pipeline signatures.
 *
 * Progress is per document: each StoredDocument moves queued -> extracting -> extracted | failed (with
 * its errorCode) and is saved as it changes, and the job's `processed` count is saved as each file
 * ends. No file can hang: extraction is aborted when its work time runs out (time queued for the
 * shared renderer or OCR worker is not counted), or once it has spent MAX_QUEUE_WAIT_MS in total
 * queued for them (it then fails as unreadable_document, which the user can retry), and a hard
 * deadline just after the abort settles the file even if a reader ignores it. Any unexpected error
 * still leaves the document in `failed`, never in queued or extracting.
 *
 * Sized for the Render free plan (512 MB, a fraction of one CPU): 2 files at a time by default
 * (DOCUMENT_AI_CONCURRENCY), as docs/contracts.md section 7.6 states, and a file's bytes are held
 * only while that file is being read.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import v8 from 'node:v8';
import type {
  DocumentActor,
  ExtractDocumentInput,
  ExtractionErrorCode,
  ExtractionJob,
  StartExtractionRequest,
  StoredDocument,
} from '../../src/types/documentAi.ts';
import { TERMINAL_JOB_STATUSES } from '../../src/types/documentAi.ts';
import { logActivity } from './activity.ts';
import { extractDocument, noteJobModelFailure } from './pipeline.ts';
import { OCR_DOCUMENT_BUDGET_MS, runObserved, type ExtractionObserver } from './ocr.ts';
import { RENDER_DOCUMENT_BUDGET_MS } from './textDocuments.ts';
import {
  getActiveJob,
  getDocument,
  getResult,
  listDocuments,
  listJobs,
  listSessionIds,
  readFileBytes,
  remergeSession,
  saveJob,
  saveResultAndRemerge,
  updateDocument,
} from './store.ts';

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(max, Math.floor(value)) : fallback;
};

/**
 * Files read at once (DOCUMENT_AI_CONCURRENCY, 1-8; default 2, contract section 7.6). Each file
 * holds its bytes, rendered pages and OCR text in memory, so on a 512 MB instance more at once
 * risks running out; 2 also stays well inside free OpenRouter's request rate. Applies to jobs at
 * once and to files at once within a job.
 */
export const JOB_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DOCUMENT_AI_CONCURRENCY) || 2));
const CONCURRENCY = JOB_CONCURRENCY;
/** Work time for any file: local reading plus the model's share (pipeline.ts LLM_BUDGET_MS). */
const PER_FILE_TIMEOUT_MS = 300_000;
/** No file is given more work time than this, whatever the budgets add up to. */
const MAX_FILE_WORK_MS = 15 * 60_000;
/**
 * Time queued for a shared reader (the page renderer, an OCR worker) does not count as work, but a
 * file that has spent this long queued in total (DOCUMENT_AI_MAX_QUEUE_WAIT_MS, default 5 minutes)
 * is stopped and fails as unreadable_document, so it can be retried rather than sit on 'Reading'
 * in front of someone watching the screen.
 */
export const MAX_QUEUE_WAIT_MS = envInt('DOCUMENT_AI_MAX_QUEUE_WAIT_MS', 5 * 60_000, 1_000, 60 * 60_000);
/** After the abort, how long a file may take to wind down before it is failed regardless. */
const HARD_DEADLINE_GRACE_MS = 10_000;

class HardDeadlineError extends Error {}

// ------------------------------------------------------------------ Memory and size gate

const MB = 1024 * 1024;

/** What the gate reads before starting a file. Injected in tests. */
export interface MemoryReading {
  heapUsed: number;
  heapLimit: number;
  rss: number;
}

export function readProcessMemory(): MemoryReading {
  const heap = v8.getHeapStatistics();
  return { heapUsed: heap.used_heap_size, heapLimit: heap.heap_size_limit, rss: process.memoryUsage.rss() };
}

export interface FileGateOptions {
  /** Files at once, across all jobs. */
  concurrency: number;
  /** Sum of the sizes of files being read at once. A file bigger than this runs alone. */
  bytesBudget: number;
  /** A file at least this big runs alone. */
  largeFileBytes: number;
  /** Heap in use above this share of the heap limit counts as high. */
  heapHighRatio: number;
  /** Resident memory above this counts as high; 0 turns the check off. */
  rssHighBytes: number;
  /** With memory high and nothing running, how long the next file waits before it is turned away. */
  memoryWaitMs: number;
  /** How often memory is checked again while a file waits on it. */
  pollMs: number;
  readMemory: () => MemoryReading;
  /** One short diagnostic line (no document data). Defaults to console.warn; tests pass a stub. */
  warn?: (line: string) => void;
}

export type Admission = { ok: true; release(): void } | { ok: false };

interface GateWaiter {
  size: number;
  resolve(admission: Admission): void;
  /** When memory first kept this file out with nothing else running. */
  memoryBlockedSince: number | null;
}

/**
 * Decides when a file may start, so reading cannot run the server out of memory (Node's heap is
 * about 250 MB on a 512 MB instance, and running out kills the process and every job in it):
 * - at most `concurrency` files at once, first come first served;
 * - the sizes of the files being read add up to no more than `bytesBudget`, and a large file
 *   (`largeFileBytes` or more, or over the budget) runs with nothing else;
 * - while memory is high, nothing new starts beside a running file; with nothing running, the
 *   next file waits up to `memoryWaitMs` for memory to fall, and is then turned away (the caller
 *   fails it with a retryable code) rather than risk a crash. GC is never forced.
 */
export class FileGate {
  private running = 0;
  private runningBytes = 0;
  private runningAlone = false;
  private readonly waiting: GateWaiter[] = [];
  private poll: NodeJS.Timeout | null = null;
  /** The gate is holding a file back on memory; logged once per episode, not on every poll. */
  private holdLogged = false;

  constructor(private readonly options: FileGateOptions) {}

  /** Heap used / limit in MB and the queue length. Never anything about a document. */
  private describe(): string {
    let heap = 'heap ?/? MB';
    try {
      const reading = this.options.readMemory();
      heap = `heap ${Math.round(reading.heapUsed / MB)}/${Math.round(reading.heapLimit / MB)} MB`;
    } catch {
      // keep the placeholder
    }
    return `${heap}, ${this.running} running, ${this.waiting.length} queued`;
  }

  private warn(line: string): void {
    try {
      (this.options.warn ?? console.warn)(`[document-ai] ${line}`);
    } catch {
      // diagnostics must never break the gate
    }
  }

  get inFlight(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  memoryHigh(): boolean {
    let reading: MemoryReading;
    try {
      reading = this.options.readMemory();
    } catch {
      return false;
    }
    const { heapHighRatio, rssHighBytes } = this.options;
    const heapHigh = reading.heapLimit > 0 && reading.heapUsed > heapHighRatio * reading.heapLimit;
    const rssHigh = rssHighBytes > 0 && reading.rss > rssHighBytes;
    return heapHigh || rssHigh;
  }

  /** Resolves when the file may start, or with `{ ok: false }` when memory stayed high. */
  admit(sizeBytes: number): Promise<Admission> {
    const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
    return new Promise<Admission>((resolve) => {
      this.waiting.push({ size, resolve, memoryBlockedSince: null });
      this.pump();
    });
  }

  private alone(size: number): boolean {
    return size >= this.options.largeFileBytes || size > this.options.bytesBudget;
  }

  private pump(): void {
    if (this.poll) {
      clearTimeout(this.poll);
      this.poll = null;
    }
    let waitingOnMemory = false;
    while (this.waiting.length > 0) {
      const head = this.waiting[0];
      if (this.running >= this.options.concurrency) break;
      if (this.running > 0) {
        if (this.runningAlone || this.alone(head.size)) break;
        if (this.runningBytes + head.size > this.options.bytesBudget) break;
      }
      if (this.memoryHigh()) {
        if (this.running > 0) {
          waitingOnMemory = true; // one file at a time until memory falls
          break;
        }
        const now = Date.now();
        head.memoryBlockedSince ??= now;
        if (now - head.memoryBlockedSince < this.options.memoryWaitMs) {
          waitingOnMemory = true;
          break;
        }
        this.waiting.shift();
        this.warn(`memory gate turned a file away (server_busy): ${this.describe()}`);
        this.holdLogged = false;
        head.resolve({ ok: false });
        continue;
      }
      this.waiting.shift();
      this.holdLogged = false;
      this.start(head);
    }
    if (waitingOnMemory) {
      if (!this.holdLogged) {
        this.holdLogged = true;
        this.warn(`memory gate holding files: ${this.describe()}`);
      }
      this.poll = setTimeout(() => this.pump(), this.options.pollMs);
      this.poll.unref();
    }
  }

  private start(waiter: GateWaiter): void {
    this.running += 1;
    this.runningBytes += waiter.size;
    const alone = this.alone(waiter.size);
    if (alone) this.runningAlone = true;
    let released = false;
    waiter.resolve({
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.running -= 1;
        this.runningBytes -= waiter.size;
        if (alone) this.runningAlone = false;
        this.pump();
      },
    });
  }
}

/** 90% of the container's memory limit, where Node can see one (cgroups); otherwise off. */
function defaultRssHighBytes(): number {
  const configured = envInt('DOCUMENT_AI_RSS_HIGH_MB', -1, 0, 64 * 1024);
  if (configured >= 0) return configured * MB;
  try {
    const limit = process.constrainedMemory?.() ?? 0;
    return limit > 0 && limit < os.totalmem() ? Math.floor(limit * 0.9) : 0;
  } catch {
    return 0;
  }
}

function envRatio(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

/**
 * The server's gate. Thresholds: DOCUMENT_AI_HEAP_HIGH_RATIO (0.8), DOCUMENT_AI_RSS_HIGH_MB
 * (90% of the container limit, off where there is none), DOCUMENT_AI_MEMORY_WAIT_MS (60 s),
 * DOCUMENT_AI_INFLIGHT_MB (40), DOCUMENT_AI_LARGE_FILE_MB (15).
 */
export const FILE_GATE_OPTIONS: Readonly<FileGateOptions> = {
  concurrency: CONCURRENCY,
  bytesBudget: envInt('DOCUMENT_AI_INFLIGHT_MB', 40, 1, 4096) * MB,
  largeFileBytes: envInt('DOCUMENT_AI_LARGE_FILE_MB', 15, 1, 4096) * MB,
  heapHighRatio: envRatio('DOCUMENT_AI_HEAP_HIGH_RATIO', 0.8),
  rssHighBytes: defaultRssHighBytes(),
  memoryWaitMs: envInt('DOCUMENT_AI_MEMORY_WAIT_MS', 60_000, 0, 30 * 60_000),
  pollMs: 1_000,
  readMemory: readProcessMemory,
};
const fileGate = new FileGate(FILE_GATE_OPTIONS);

/**
 * Work time for one file, sized to what it may need: a PDF may be a scan that is rendered and read
 * by OCR, an image is read by OCR, on top of the base budget. Bounded by MAX_FILE_WORK_MS.
 */
export function fileWorkBudgetMs(kind: StoredDocument['kind']): number {
  const extra =
    kind === 'pdf'
      ? RENDER_DOCUMENT_BUDGET_MS + OCR_DOCUMENT_BUDGET_MS
      : kind === 'png' || kind === 'jpeg' || kind === 'webp'
        ? OCR_DOCUMENT_BUDGET_MS
        : 0;
  return Math.min(MAX_FILE_WORK_MS, PER_FILE_TIMEOUT_MS + extra);
}

interface FileTimer {
  observer: ExtractionObserver;
  /** The file was stopped by its timer (work time or the wait bound ran out). */
  readonly expired: boolean;
  /**
   * The step the file was in when its timer stopped it, taken at that moment: once the abort lands,
   * a model call unwinding resets the observer's phase, so reading it later could misreport.
   */
  readonly phaseAtExpiry: ExtractionObserver['phase'] | null;
  /** Rejects with HardDeadlineError HARD_DEADLINE_GRACE_MS after the timer stops the file. */
  hardDeadline: Promise<never>;
  cancel(): void;
}

/**
 * A timer that runs only while the file is working: it is paused while the file is queued for a
 * shared reader, so a file is never aborted merely for waiting its turn. Waiting is bounded on its
 * own, though: once the file has spent `maxWaitMs` queued in total it is stopped, as a reading
 * timeout. `onExpire` aborts the file.
 */
export function startFileTimer(workMs: number, onExpire: () => void, maxWaitMs: number = MAX_QUEUE_WAIT_MS): FileTimer {
  const startedAt = Date.now();
  let expired = false;
  let phaseAtExpiry: ExtractionObserver['phase'] | null = null;
  let remaining = workMs;
  let runningSince = startedAt;
  let waits = 0;
  let waitedMs = 0;
  let waitingSince = 0;
  let workTimer: NodeJS.Timeout | null = null;
  let waitTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let rejectHard: (error: Error) => void = () => undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    rejectHard = reject;
  });
  hardDeadline.catch(() => undefined);

  const clearRunning = () => {
    if (workTimer) clearTimeout(workTimer);
    if (waitTimer) clearTimeout(waitTimer);
    clearTimeout(absoluteTimer);
    workTimer = null;
    waitTimer = null;
  };
  const expire = (phase?: ExtractionObserver['phase']) => {
    if (expired) return;
    expired = true;
    phaseAtExpiry = phase ?? observer.phase;
    clearRunning();
    onExpire();
    graceTimer = setTimeout(() => rejectHard(new HardDeadlineError()), HARD_DEADLINE_GRACE_MS);
  };
  workTimer = setTimeout(expire, remaining);
  // A backstop: work time and waiting are each bounded, so together they never exceed this.
  const absoluteTimer = setTimeout(expire, workMs + maxWaitMs);

  const observer: ExtractionObserver = {
    phase: 'reading',
    queueWaitStarted() {
      waits += 1;
      if (waits !== 1 || expired) return;
      if (workTimer) {
        clearTimeout(workTimer);
        workTimer = null;
        remaining -= Date.now() - runningSince;
      }
      waitingSince = Date.now();
      // Only reading ever queues: running out of waiting time is never the model's doing.
      waitTimer = setTimeout(() => expire('reading'), Math.max(0, maxWaitMs - waitedMs));
    },
    queueWaitEnded() {
      waits = Math.max(0, waits - 1);
      if (waits !== 0 || expired) return;
      waitedMs += Date.now() - waitingSince;
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      if (!workTimer) {
        runningSince = Date.now();
        workTimer = setTimeout(expire, Math.max(0, remaining));
      }
    },
    remainingMs() {
      if (expired) return 0;
      const work = workTimer ? remaining - (Date.now() - runningSince) : remaining;
      const absolute = startedAt + workMs + maxWaitMs - Date.now();
      return Math.max(0, Math.min(work, absolute));
    },
  };

  return {
    observer,
    get expired() {
      return expired;
    },
    get phaseAtExpiry() {
      return phaseAtExpiry;
    },
    hardDeadline,
    cancel() {
      clearRunning();
      if (graceTimer) clearTimeout(graceTimer);
    },
  };
}

/**
 * The code for a file stopped by its timer. Only a model call that ran out of time is
 * `llm_timeout`; running out of time while rendering or OCR-reading the file is not the AI's doing,
 * and is reported as `unreadable_document` (the server could not read it in time).
 */
export function timeoutCode(phase: ExtractionObserver['phase']): ExtractionErrorCode {
  return phase === 'model' ? 'llm_timeout' : 'unreadable_document';
}

interface QueuedTask {
  job: ExtractionJob;
  actorEmail: string;
}

const queue: QueuedTask[] = [];
const inFlight = new Map<string, AbortController>();

/** Aborts a running extraction for a document that is being deleted. Its result is discarded either way. */
export function abortDocumentExtraction(sessionId: string, documentId: string): void {
  inFlight.get(`${sessionId}:${documentId}`)?.abort();
}
let running = 0;

export class JobInProgressError extends Error {
  constructor(public readonly jobId: string) {
    super('job_in_progress');
  }
}

export async function startExtraction(
  sessionId: string,
  request: StartExtractionRequest,
  actor: DocumentActor
): Promise<ExtractionJob> {
  const active = await getActiveJob(sessionId);
  if (active) throw new JobInProgressError(active.jobId);

  const docs = await listDocuments(sessionId);
  let selected: StoredDocument[];
  if (Array.isArray(request.documentIds) && request.documentIds.length > 0) {
    const wanted = new Set(request.documentIds);
    selected = docs.filter((d) => wanted.has(d.documentId) && !d.fileDeletedAt);
  } else {
    selected = docs.filter((d) => d.status !== 'extracted' && !d.fileDeletedAt);
  }
  if (!request.force) {
    selected = selected.filter((d) => d.status !== 'extracted');
  }

  const job: ExtractionJob = {
    jobId: `job_${crypto.randomUUID()}`,
    sessionId,
    status: 'queued',
    documentIds: selected.map((d) => d.documentId),
    processed: 0,
    errors: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  await saveJob(job);
  for (const d of selected) {
    await updateDocument(sessionId, d.documentId, (x) => {
      x.status = 'queued';
      x.errorCode = null;
    });
  }
  void logActivity({
    type: 'extraction_queued',
    actor: actor.email,
    sessionId,
    jobId: job.jobId,
    counts: { documents: job.documentIds.length },
  });
  queue.push({ job, actorEmail: actor.email });
  setImmediate(pump);
  return job;
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const task = queue.shift()!;
    running += 1;
    void runJob(task)
      .catch(() => undefined)
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

/** Reads one file under its timer's observer. Holds nothing once the extraction settles. */
function extractObserved(observer: ExtractionObserver, input: ExtractDocumentInput) {
  return runObserved(observer, () => extractDocument(input));
}

/**
 * Waits for the file gate, then reads the file. A file the gate turned away (memory stayed high)
 * fails as `server_busy`, which the user can retry, instead of the server running out of memory.
 */
async function admitAndProcess(job: ExtractionJob, documentId: string, actorEmail: string): Promise<void> {
  const doc = await getDocument(job.sessionId, documentId);
  if (!doc || doc.fileDeletedAt) return; // deleted while queued
  const admission = await fileGate.admit(doc.sizeBytes);
  if (!admission.ok) {
    await processDocument(job, documentId, actorEmail, false);
    return;
  }
  try {
    await processDocument(job, documentId, actorEmail, true);
  } finally {
    admission.release();
  }
}

async function processDocument(
  job: ExtractionJob,
  documentId: string,
  actorEmail: string,
  admitted: boolean
): Promise<void> {
  const { sessionId } = job;
  const doc = await getDocument(sessionId, documentId);
  if (!doc || doc.fileDeletedAt) return; // deleted while queued

  // A document deleted mid-job keeps its record; restore a status that matches what is stored.
  const settleDeleted = async () => {
    const hasResult = (await getResult(sessionId, documentId)) !== null;
    await updateDocument(sessionId, documentId, (d) => {
      if (d.status === 'queued' || d.status === 'extracting') d.status = hasResult ? 'extracted' : 'uploaded';
    });
  };

  const fail = async (code: ExtractionErrorCode) => {
    // Decide inside the document lock so a delete committed meanwhile is never overwritten with 'failed'.
    let deleted = false;
    const updated = await updateDocument(sessionId, documentId, (d) => {
      if (d.fileDeletedAt) {
        deleted = true;
        return;
      }
      d.status = 'failed';
      d.errorCode = code;
    });
    if (!updated || deleted) {
      await settleDeleted();
      return; // deleted during the job: not a failure to report
    }
    job.errors.push({ documentId, code });
    // A file stopped by its timer in the model step opens the job's breaker too (pipeline.ts).
    noteJobModelFailure(job.jobId, code);
    void logActivity({
      type: 'extraction_document_failed',
      actor: actorEmail,
      sessionId,
      documentId,
      jobId: job.jobId,
      fileName: doc.originalName,
      code,
    });
  };

  if (!admitted) {
    await fail('server_busy');
    return;
  }

  // Dropped as soon as the reading settles, so a file's bytes are not held while results are saved.
  let bytes: Uint8Array | null = await readFileBytes(doc);
  if (!bytes) {
    await fail('file_missing');
    return;
  }
  await updateDocument(sessionId, documentId, (d) => {
    d.status = 'extracting';
  });

  const controller = new AbortController();
  const flightKey = `${sessionId}:${documentId}`;
  inFlight.set(flightKey, controller);
  const timer = startFileTimer(fileWorkBudgetMs(doc.kind), () => controller.abort());
  try {
    // The pipeline handles a daily model quota itself: the file still completes with what the
    // server read locally, so nothing is failed up front here.
    const extraction = extractObserved(timer.observer, {
      documentId,
      fileName: doc.originalName,
      kind: doc.kind,
      bytes,
      declaredDocumentType: doc.documentTypeOverridden ? doc.documentType : null,
      today: new Date().toISOString().slice(0, 10),
      signal: controller.signal,
      jobId: job.jobId,
    });
    bytes = null; // from here only the pipeline holds the bytes, and only until it settles
    extraction.catch(() => undefined);
    const result = await Promise.race([extraction, timer.hardDeadline]);
    if (!result.ok) {
      await fail(result.errorCode);
      return;
    }
    const saved = await saveResultAndRemerge(sessionId, documentId, result, (d) => {
      d.status = 'extracted';
      d.errorCode = null;
      if (!d.documentTypeOverridden) d.documentType = result.documentType;
    });
    if (!saved) {
      await settleDeleted(); // deleted or expired mid-extraction: result discarded
      return;
    }
    const byStatus: Record<string, number> = {};
    for (const f of result.fields) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    void logActivity({
      type: 'extraction_document_completed',
      actor: actorEmail,
      sessionId,
      documentId,
      jobId: job.jobId,
      fileName: doc.originalName,
      code: result.documentType,
      fieldIds: Array.from(new Set(result.fields.map((f) => f.fieldId))),
      counts: { ...byStatus, dropped: result.droppedLowConfidence },
    });
    if (result.injectionSuspected) {
      void logActivity({
        type: 'injection_suspected',
        actor: actorEmail,
        sessionId,
        documentId,
        jobId: job.jobId,
        fileName: doc.originalName,
      });
    }
  } catch (error) {
    const abortedBefore = controller.signal.aborted;
    controller.abort();
    // A timed-out file is reported by the step it was in; any other abort (a delete) is settled by
    // fail() as a deletion, and is never blamed on the AI.
    const code: ExtractionErrorCode =
      timer.expired || error instanceof HardDeadlineError || abortedBefore
        ? timeoutCode(timer.phaseAtExpiry ?? timer.observer.phase)
        : 'llm_failed';
    await fail(code);
  } finally {
    if (inFlight.get(flightKey) === controller) inFlight.delete(flightKey);
    timer.cancel();
  }
}

/**
 * After an unexpected error (storage, say): a document still queued or extracting is failed, so the
 * UI never shows it as reading forever. Best effort; it must not throw.
 */
async function settleUnfinishedDocument(job: ExtractionJob, documentId: string): Promise<void> {
  try {
    let settled = false;
    await updateDocument(job.sessionId, documentId, (d) => {
      if (d.status === 'queued' || d.status === 'extracting') {
        d.status = 'failed';
        d.errorCode = 'llm_failed';
        settled = true;
      }
    });
    if (settled && !job.errors.some((e) => e.documentId === documentId)) {
      job.errors.push({ documentId, code: 'llm_failed' });
    }
  } catch {
    if (!job.errors.some((e) => e.documentId === documentId)) job.errors.push({ documentId, code: 'llm_failed' });
  }
}

async function runJob(task: QueuedTask): Promise<void> {
  const { job, actorEmail } = task;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  await saveJob(job);
  void logActivity({ type: 'extraction_started', actor: actorEmail, sessionId: job.sessionId, jobId: job.jobId });

  // Several documents of one job at a time; progress is saved as each one finishes.
  const pending = [...job.documentIds];
  const worker = async () => {
    for (let documentId = pending.shift(); documentId !== undefined; documentId = pending.shift()) {
      try {
        await admitAndProcess(job, documentId, actorEmail);
      } catch {
        await settleUnfinishedDocument(job, documentId);
      }
      job.processed += 1;
      await saveJob(job).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  // Results are already merged and saved per document; merge once more before the terminal state.
  await remergeSession(job.sessionId).catch(() => undefined);
  job.status =
    job.errors.length === 0 ? 'completed' : job.errors.length >= job.documentIds.length ? 'failed' : 'completed_with_errors';
  job.finishedAt = new Date().toISOString();
  await saveJob(job);
  void logActivity({
    type: 'extraction_completed',
    actor: actorEmail,
    sessionId: job.sessionId,
    jobId: job.jobId,
    counts: { documents: job.documentIds.length, failed: job.errors.length },
  });
}

/** On boot: queued or running jobs become failed; their unfinished documents fail with `interrupted`. */
export async function recoverInterruptedJobs(): Promise<void> {
  let jobsRecovered = 0;
  let documentsInterrupted = 0;
  for (const sessionId of await listSessionIds()) {
    for (const job of await listJobs(sessionId)) {
      if (TERMINAL_JOB_STATUSES.includes(job.status)) continue;
      const done = new Set(job.errors.map((e) => e.documentId));
      for (const documentId of job.documentIds) {
        const d = await getDocument(sessionId, documentId);
        if (d && (d.status === 'queued' || d.status === 'extracting')) {
          await updateDocument(sessionId, documentId, (x) => {
            x.status = 'failed';
            x.errorCode = 'interrupted';
          });
          if (!done.has(documentId)) job.errors.push({ documentId, code: 'interrupted' });
          documentsInterrupted += 1;
        }
      }
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      await saveJob(job);
      jobsRecovered += 1;
    }
  }
  if (jobsRecovered > 0) {
    // Counts only: a restart (deploy, sleep, out of memory) stopped these mid-way.
    console.warn(`[document-ai] boot recovery: ${jobsRecovered} unfinished job(s) failed, ${documentsInterrupted} document(s) marked interrupted`);
  }
}
