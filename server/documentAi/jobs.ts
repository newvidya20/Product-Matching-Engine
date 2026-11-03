/**
 * Extraction job queue (docs/contracts.md section 7.6).
 * In-process FIFO, 300 s of work per file, more for a file that may need rendering and OCR
 * (fileWorkBudgetMs). Calls only the exported pipeline signatures.
 *
 * Progress is per document: each StoredDocument moves queued -> extracting -> extracted | failed (with
 * its errorCode) and is saved as it changes, and the job's `processed` count is saved as each file
 * ends. No file can hang: extraction is aborted when its work time runs out (time queued for the
 * shared renderer or OCR worker is not counted, up to MAX_QUEUE_WAIT_MS), and a hard deadline just
 * after the abort settles the file even if a reader ignores it. Any unexpected error still leaves
 * the document in `failed`, never in queued or extracting.
 */
import crypto from 'node:crypto';
import type {
  DocumentActor,
  ExtractionErrorCode,
  ExtractionJob,
  StartExtractionRequest,
  StoredDocument,
} from '../../src/types/documentAi.ts';
import { TERMINAL_JOB_STATUSES } from '../../src/types/documentAi.ts';
import { logActivity } from './activity.ts';
import { extractDocument } from './pipeline.ts';
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

/** Files read at once. Free OpenRouter allows about 20 requests a minute, so 3 stays well inside it. */
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DOCUMENT_AI_CONCURRENCY) || 3));
/** Work time for any file: local reading plus the model's share (pipeline.ts LLM_BUDGET_MS). */
const PER_FILE_TIMEOUT_MS = 300_000;
/** No file is given more work time than this, whatever the budgets add up to. */
const MAX_FILE_WORK_MS = 15 * 60_000;
/**
 * Time queued for a shared reader (the page renderer, an OCR worker) does not count as work, but a
 * file is stopped regardless once its work time plus this much waiting has passed.
 */
const MAX_QUEUE_WAIT_MS = 20 * 60_000;
/** After the abort, how long a file may take to wind down before it is failed regardless. */
const HARD_DEADLINE_GRACE_MS = 10_000;

class HardDeadlineError extends Error {}

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
 * shared reader, so a file is never aborted merely for waiting its turn. `onExpire` aborts the file.
 */
export function startFileTimer(workMs: number, onExpire: () => void, maxWaitMs: number = MAX_QUEUE_WAIT_MS): FileTimer {
  let expired = false;
  let phaseAtExpiry: ExtractionObserver['phase'] | null = null;
  let remaining = workMs;
  let runningSince = Date.now();
  let waits = 0;
  let workTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let rejectHard: (error: Error) => void = () => undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    rejectHard = reject;
  });
  hardDeadline.catch(() => undefined);

  const expire = () => {
    if (expired) return;
    expired = true;
    phaseAtExpiry = observer.phase;
    if (workTimer) clearTimeout(workTimer);
    clearTimeout(absoluteTimer);
    workTimer = null;
    onExpire();
    graceTimer = setTimeout(() => rejectHard(new HardDeadlineError()), HARD_DEADLINE_GRACE_MS);
  };
  workTimer = setTimeout(expire, remaining);
  const absoluteTimer = setTimeout(expire, workMs + maxWaitMs);

  const observer: ExtractionObserver = {
    phase: 'reading',
    queueWaitStarted() {
      waits += 1;
      if (waits === 1 && workTimer && !expired) {
        clearTimeout(workTimer);
        workTimer = null;
        remaining -= Date.now() - runningSince;
      }
    },
    queueWaitEnded() {
      waits = Math.max(0, waits - 1);
      if (waits === 0 && !workTimer && !expired) {
        runningSince = Date.now();
        workTimer = setTimeout(expire, Math.max(0, remaining));
      }
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
      if (workTimer) clearTimeout(workTimer);
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(absoluteTimer);
      workTimer = null;
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

async function processDocument(job: ExtractionJob, documentId: string, actorEmail: string): Promise<void> {
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

  const bytes = await readFileBytes(doc);
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
    const extraction = runObserved(timer.observer, () =>
      extractDocument({
        documentId,
        fileName: doc.originalName,
        kind: doc.kind,
        bytes,
        declaredDocumentType: doc.documentTypeOverridden ? doc.documentType : null,
        today: new Date().toISOString().slice(0, 10),
        signal: controller.signal,
      })
    );
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
        await processDocument(job, documentId, actorEmail);
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
        }
      }
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      await saveJob(job);
    }
  }
}
