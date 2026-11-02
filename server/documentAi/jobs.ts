/**
 * Extraction job queue (docs/contracts.md section 7.6).
 * In-process FIFO, global concurrency 2, 300 s per file. Calls only the exported pipeline signatures.
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

const CONCURRENCY = 2;
const PER_FILE_TIMEOUT_MS = 300_000;

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
    const current = await getDocument(sessionId, documentId);
    if (!current || current.fileDeletedAt) {
      await settleDeleted();
      return; // deleted during the job: not a failure to report
    }
    await updateDocument(sessionId, documentId, (d) => {
      d.status = 'failed';
      d.errorCode = code;
    });
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
  const timer = setTimeout(() => controller.abort(), PER_FILE_TIMEOUT_MS);
  try {
    const result = await extractDocument({
      documentId,
      fileName: doc.originalName,
      kind: doc.kind,
      bytes,
      declaredDocumentType: doc.documentTypeOverridden ? doc.documentType : null,
      today: new Date().toISOString().slice(0, 10),
      signal: controller.signal,
    });
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
  } catch {
    await fail(controller.signal.aborted ? 'llm_timeout' : 'llm_failed');
  } finally {
    if (inFlight.get(flightKey) === controller) inFlight.delete(flightKey);
    clearTimeout(timer);
  }
}

async function runJob(task: QueuedTask): Promise<void> {
  const { job, actorEmail } = task;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  await saveJob(job);
  void logActivity({ type: 'extraction_started', actor: actorEmail, sessionId: job.sessionId, jobId: job.jobId });

  for (const documentId of job.documentIds) {
    try {
      await processDocument(job, documentId, actorEmail);
    } catch {
      job.errors.push({ documentId, code: 'llm_failed' });
    }
    job.processed += 1;
    await saveJob(job);
  }

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
