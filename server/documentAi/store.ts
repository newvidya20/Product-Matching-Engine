/**
 * Document AI file store (docs/contracts.md section 9).
 * Only server-generated IDs and FILE_KIND_EXTENSION build paths. originalName is never part of a path.
 * Nothing here logs or returns document contents; results/ is borrower data.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_AI_DEFAULT_SETTINGS,
  DOCUMENT_AI_LIMITS,
  DOCUMENT_AI_RETENTION_RANGE,
  DOCUMENT_AI_THRESHOLDS,
  DOCUMENT_ID_PATTERN,
  DOCUMENT_SESSION_ID_PATTERN,
  FILE_KIND_EXTENSION,
  JOB_ID_PATTERN,
  TERMINAL_JOB_STATUSES,
} from '../../src/types/documentAi.ts';
import type {
  AcceptedFileKind,
  DocumentAiSettings,
  DocumentExtractionSuccess,
  DocumentSessionRecord,
  DocumentSessionState,
  DocumentType,
  ExtractionJob,
  MergeSessionOutput,
  SessionEdits,
  StoredDocument,
} from '../../src/types/documentAi.ts';
import { mergeSessionResults } from './pipeline.ts';

// ------------------------------------------------------------------ paths

export function getRoot(): string {
  return path.resolve(process.cwd(), process.env.DOCUMENT_AI_DATA_DIR || 'data/document-ai');
}

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-]*(\.[A-Za-z0-9_\-]+)*$/;

/** Single entry point for path building. Throws on anything unexpected. */
export function safeJoin(...parts: string[]): string {
  const root = getRoot();
  for (const part of parts) {
    if (typeof part !== 'string' || !SEGMENT_PATTERN.test(part) || part.includes('..')) {
      throw new Error('Invalid storage path segment.');
    }
  }
  const resolved = path.resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Storage path escapes root.');
  }
  return resolved;
}

export const isSessionId = (v: unknown): v is string =>
  typeof v === 'string' && DOCUMENT_SESSION_ID_PATTERN.test(v);
export const isDocumentId = (v: unknown): v is string =>
  typeof v === 'string' && DOCUMENT_ID_PATTERN.test(v);
export const isJobId = (v: unknown): v is string =>
  typeof v === 'string' && JOB_ID_PATTERN.test(v);

const BIDI_AND_CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g;

export function sanitizeOriginalName(raw: unknown): string {
  if (typeof raw !== 'string') return 'document';
  let name = raw.slice(raw.lastIndexOf('/') + 1);
  name = name.slice(name.lastIndexOf('\\') + 1);
  name = name.normalize('NFC').replace(BIDI_AND_CONTROL, '').trim();
  const max = DOCUMENT_AI_LIMITS.maxOriginalNameLength;
  if (name.length > max) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, max - ext.length) + ext;
  }
  return name.length > 0 ? name : 'document';
}

// -------------------------------------------------------------- file i/o

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
}

/** Session-scoped files are only written while session.json exists, so a purged session is never recreated. */
function sessionGone(file: string): boolean {
  const rel = path.relative(path.join(getRoot(), 'sessions'), file).split(path.sep);
  if (rel.length < 2 || rel[0] === '..' || path.isAbsolute(rel[0])) return false;
  if (rel.length === 2 && rel[1] === 'session.json') return false;
  return !fs.existsSync(path.join(getRoot(), 'sessions', rel[0], 'session.json'));
}

async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  if (sessionGone(file)) return;
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data, { mode: FILE_MODE });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

const writeJson = (file: string, value: unknown) => atomicWrite(file, JSON.stringify(value, null, 2));

// ------------------------------------------------------------- locking

const locks = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(sessionId, tail);
  void tail.then(() => {
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  });
  return next;
}

// ---------------------------------------------------------------- paths

const sessionDir = (id: string) => safeJoin('sessions', id);
const sessionFile = (id: string) => safeJoin('sessions', id, 'session.json');
const editsFile = (id: string) => safeJoin('sessions', id, 'edits.json');
const provenanceFile = (id: string) => safeJoin('sessions', id, 'provenance.json');
const docFile = (id: string, docId: string) => safeJoin('sessions', id, 'documents', `${docId}.json`);
const resultFile = (id: string, docId: string) => safeJoin('sessions', id, 'results', `${docId}.json`);
const jobFile = (id: string, jobId: string) => safeJoin('sessions', id, 'jobs', `${jobId}.json`);
const bytesFile = (id: string, docId: string, kind: AcceptedFileKind) =>
  safeJoin('sessions', id, 'files', `${docId}.${FILE_KIND_EXTENSION[kind]}`);

// ------------------------------------------------------ assessment index

const assessmentIndex = new Map<string, string>();
let indexBuilt = false;

export async function listSessionIds(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(safeJoin('sessions'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && isSessionId(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function initStore(): Promise<void> {
  assessmentIndex.clear();
  for (const id of await listSessionIds()) {
    const rec = await readJson<DocumentSessionRecord>(sessionFile(id));
    if (rec?.assessmentId) assessmentIndex.set(rec.assessmentId, id);
  }
  indexBuilt = true;
}

async function ensureIndex() {
  if (!indexBuilt) await initStore();
}

// -------------------------------------------------------------- settings

export function isDisabledByEnv(): boolean {
  return (process.env.DOCUMENT_AI_ENABLED || '').trim().toLowerCase() === 'false';
}

export async function getSettings(): Promise<DocumentAiSettings> {
  const stored = await readJson<Partial<DocumentAiSettings>>(safeJoin('settings.json'));
  const th = Number(stored?.autoApplyThreshold);
  const rd = Number(stored?.retentionDays);
  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DOCUMENT_AI_DEFAULT_SETTINGS.enabled,
    autoApplyThreshold:
      Number.isFinite(th) &&
      th >= DOCUMENT_AI_THRESHOLDS.minAutoApply &&
      th <= DOCUMENT_AI_THRESHOLDS.maxAutoApply
        ? th
        : DOCUMENT_AI_DEFAULT_SETTINGS.autoApplyThreshold,
    retentionDays:
      Number.isInteger(rd) && rd >= DOCUMENT_AI_RETENTION_RANGE.min && rd <= DOCUMENT_AI_RETENTION_RANGE.max
        ? rd
        : DOCUMENT_AI_DEFAULT_SETTINGS.retentionDays,
    updatedAt: stored?.updatedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
  };
}

let settingsQueue: Promise<unknown> = Promise.resolve();

export function saveSettings(
  patch: Partial<Pick<DocumentAiSettings, 'enabled' | 'autoApplyThreshold' | 'retentionDays'>>,
  updatedBy: string
): Promise<DocumentAiSettings> {
  const run = async () => {
    const next: DocumentAiSettings = {
      ...(await getSettings()),
      ...patch,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await writeJson(safeJoin('settings.json'), next);
    return next;
  };
  const p = settingsQueue.then(run, run);
  settingsQueue = p.catch(() => undefined);
  return p;
}

export async function isFeatureEnabled(): Promise<boolean> {
  if (isDisabledByEnv()) return false;
  return (await getSettings()).enabled;
}

// -------------------------------------------------------------- sessions

export const getSession = (id: string) => readJson<DocumentSessionRecord>(sessionFile(id));

export async function findSessionByAssessment(assessmentId: string): Promise<DocumentSessionRecord | null> {
  await ensureIndex();
  const id = assessmentIndex.get(assessmentId);
  if (!id) return null;
  const rec = await getSession(id);
  if (!rec || rec.assessmentId !== assessmentId) {
    assessmentIndex.delete(assessmentId);
    return null;
  }
  return rec;
}

async function createSessionUnlocked(sessionId: string, createdBy: string): Promise<{ record: DocumentSessionRecord; created: boolean }> {
  const existing = await getSession(sessionId);
  if (existing) return { record: existing, created: false };
  const now = new Date().toISOString();
  const record: DocumentSessionRecord = {
    sessionId,
    assessmentId: null,
    createdAt: now,
    updatedAt: now,
    linkedAt: null,
    createdBy,
  };
  await writeJson(sessionFile(sessionId), record);
  return { record, created: true };
}

async function touchSession(sessionId: string): Promise<void> {
  const rec = await getSession(sessionId);
  if (rec) await writeJson(sessionFile(sessionId), { ...rec, updatedAt: new Date().toISOString() });
}

export type LinkResult =
  | { ok: true; record: DocumentSessionRecord; changed: boolean }
  | { ok: false; reason: 'session_not_found' | 'session_linked_elsewhere' | 'assessment_has_session' };

export async function linkSessionToAssessment(sessionId: string, assessmentId: string): Promise<LinkResult> {
  await ensureIndex();
  return withSessionLock(sessionId, async () => {
    const rec = await getSession(sessionId);
    if (!rec) return { ok: false as const, reason: 'session_not_found' as const };
    if (rec.assessmentId === assessmentId) return { ok: true as const, record: rec, changed: false };
    if (rec.assessmentId) return { ok: false as const, reason: 'session_linked_elsewhere' as const };
    const other = assessmentIndex.get(assessmentId);
    if (other && other !== sessionId) return { ok: false as const, reason: 'assessment_has_session' as const };
    const now = new Date().toISOString();
    const next = { ...rec, assessmentId, linkedAt: now, detachedAt: null, updatedAt: now };
    await writeJson(sessionFile(sessionId), next);
    assessmentIndex.set(assessmentId, sessionId);
    return { ok: true as const, record: next, changed: true };
  });
}

export async function deleteSessionDir(sessionId: string): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const rec = await getSession(sessionId);
    if (rec?.assessmentId && assessmentIndex.get(rec.assessmentId) === sessionId) {
      assessmentIndex.delete(rec.assessmentId);
    }
    await fsp.rm(sessionDir(sessionId), { recursive: true, force: true });
  });
}

/**
 * Retention: removes a session directory only when session.json is genuinely absent (ENOENT).
 * Any other read error or a parse failure skips the directory. Returns true if removed.
 */
export function removeOrphanSessionDir(sessionId: string): Promise<boolean> {
  return withSessionLock(sessionId, async () => {
    try {
      JSON.parse(await fsp.readFile(sessionFile(sessionId), 'utf-8'));
      return false; // readable and valid: not an orphan
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[document-ai] retention_skipped_unreadable_session');
        return false;
      }
    }
    await fsp.rm(sessionDir(sessionId), { recursive: true, force: true });
    return true;
  });
}

/** Purges the session linked to a deleted assessment. Never throws. */
export async function purgeSessionForAssessment(assessmentId: string): Promise<string | null> {
  try {
    const rec = await findSessionByAssessment(assessmentId);
    if (!rec) return null;
    await deleteSessionDir(rec.sessionId);
    return rec.sessionId;
  } catch {
    return null;
  }
}

/** Unlinks the session of a deleted assessment but leaves its files to retention. Never throws. */
export async function unlinkSessionForAssessment(assessmentId: string): Promise<string | null> {
  try {
    const rec = await findSessionByAssessment(assessmentId);
    if (!rec) return null;
    return await withSessionLock(rec.sessionId, async () => {
      const cur = await getSession(rec.sessionId);
      if (!cur || cur.assessmentId !== assessmentId) return null;
      await writeJson(sessionFile(rec.sessionId), {
        ...cur,
        assessmentId: null,
        linkedAt: null,
        detachedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (assessmentIndex.get(assessmentId) === rec.sessionId) assessmentIndex.delete(assessmentId);
      return rec.sessionId;
    });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- documents

export async function listDocuments(sessionId: string): Promise<StoredDocument[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(safeJoin('sessions', sessionId, 'documents'));
  } catch {
    return [];
  }
  const docs: StoredDocument[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (!isDocumentId(id)) continue;
    const d = await readJson<StoredDocument>(docFile(sessionId, id));
    if (d) docs.push(d);
  }
  return docs.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
}

export const getDocument = (sessionId: string, documentId: string) =>
  readJson<StoredDocument>(docFile(sessionId, documentId));

export type AddDocumentResult =
  | { ok: true; document: StoredDocument; duplicate: boolean; sessionCreated: boolean }
  | { ok: false; status: number; code: 'too_many_files' | 'session_too_large'; message: string };

export async function addDocument(args: {
  sessionId: string;
  actorEmail: string;
  originalName: string;
  kind: AcceptedFileKind;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<AddDocumentResult> {
  const sha256 = crypto.createHash('sha256').update(args.bytes).digest('hex');
  return withSessionLock(args.sessionId, async () => {
    const { created } = await createSessionUnlocked(args.sessionId, args.actorEmail);
    const docs = await listDocuments(args.sessionId);
    const dup = docs.find((d) => d.sha256 === sha256 && !d.fileDeletedAt);
    if (dup) return { ok: true as const, document: dup, duplicate: true, sessionCreated: created };
    const live = docs.filter((d) => !d.fileDeletedAt);
    if (live.length >= DOCUMENT_AI_LIMITS.maxFilesPerSession) {
      return { ok: false as const, status: 400, code: 'too_many_files' as const, message: 'This session already has the maximum number of files.' };
    }
    if (live.reduce((s, d) => s + d.sizeBytes, 0) + args.bytes.byteLength > DOCUMENT_AI_LIMITS.maxSessionBytes) {
      return { ok: false as const, status: 413, code: 'session_too_large' as const, message: 'This session has reached its total size limit.' };
    }
    const documentId = `doc_${crypto.randomUUID()}`;
    const document: StoredDocument = {
      documentId,
      sessionId: args.sessionId,
      originalName: args.originalName,
      kind: args.kind,
      mimeType: args.mimeType,
      sizeBytes: args.bytes.byteLength,
      sha256,
      uploadedAt: new Date().toISOString(),
      uploadedBy: args.actorEmail,
      status: 'uploaded',
      errorCode: null,
      documentType: null,
      documentTypeOverridden: false,
      fileDeletedAt: null,
      fileDeletedReason: null,
    };
    await atomicWrite(bytesFile(args.sessionId, documentId, args.kind), args.bytes);
    await writeJson(docFile(args.sessionId, documentId), document);
    await touchSession(args.sessionId);
    return { ok: true as const, document, duplicate: false, sessionCreated: created };
  });
}

/** Read-modify-write of one document record. Returns null if it does not exist. */
export function updateDocument(
  sessionId: string,
  documentId: string,
  mutate: (d: StoredDocument) => void
): Promise<StoredDocument | null> {
  return withSessionLock(sessionId, async () => {
    const d = await getDocument(sessionId, documentId);
    if (!d) return null;
    mutate(d);
    await writeJson(docFile(sessionId, documentId), d);
    return d;
  });
}

export async function readFileBytes(doc: StoredDocument): Promise<Buffer | null> {
  if (doc.fileDeletedAt) return null;
  try {
    return await fsp.readFile(bytesFile(doc.sessionId, doc.documentId, doc.kind));
  } catch {
    return null;
  }
}

async function removeBytes(doc: StoredDocument): Promise<void> {
  await fsp.rm(bytesFile(doc.sessionId, doc.documentId, doc.kind), { force: true });
}

// --------------------------------------------------------------- results

export const getResult = (sessionId: string, documentId: string) =>
  readJson<DocumentExtractionSuccess>(resultFile(sessionId, documentId));

async function loadAllResults(sessionId: string): Promise<DocumentExtractionSuccess[]> {
  const out: DocumentExtractionSuccess[] = [];
  for (const d of await listDocuments(sessionId)) {
    const r = await getResult(sessionId, d.documentId);
    if (r && r.ok) out.push(r);
  }
  return out;
}

// ----------------------------------------------------------------- edits

const emptyEdits = (): SessionEdits => ({
  editedFields: {},
  appliedFields: {},
  revision: 0,
  updatedAt: new Date(0).toISOString(),
});

export async function getEdits(sessionId: string): Promise<SessionEdits> {
  const e = await readJson<SessionEdits>(editsFile(sessionId));
  return e ? { ...emptyEdits(), ...e } : emptyEdits();
}

// ------------------------------------------------------------ provenance

type Provenance = MergeSessionOutput & { autoApplyThreshold: number };

const today = () => new Date().toISOString().slice(0, 10);

async function remergeUnlocked(sessionId: string): Promise<Provenance> {
  const [results, edits, settings] = await Promise.all([
    loadAllResults(sessionId),
    getEdits(sessionId),
    getSettings(),
  ]);
  const merged = mergeSessionResults({
    documents: results,
    editedFieldIds: Object.keys(edits.editedFields),
    autoApplyThreshold: settings.autoApplyThreshold,
    today: today(),
  });
  const prov: Provenance = { ...merged, autoApplyThreshold: settings.autoApplyThreshold };
  await writeJson(provenanceFile(sessionId), prov);
  return prov;
}

export const remergeSession = (sessionId: string) =>
  withSessionLock(sessionId, () => remergeUnlocked(sessionId));

/** Save one document's extraction result, update the document, and re-merge, all under one lock. */
export function saveResultAndRemerge(
  sessionId: string,
  documentId: string,
  result: DocumentExtractionSuccess,
  mutateDoc: (d: StoredDocument) => void
): Promise<StoredDocument | null> {
  return withSessionLock(sessionId, async () => {
    const d = await getDocument(sessionId, documentId);
    // Deleted (any mode) or expired mid-job: discard. The record outlives a delete, so check the marker.
    if (!d || d.fileDeletedAt) return null;
    await writeJson(resultFile(sessionId, documentId), result);
    mutateDoc(d);
    await writeJson(docFile(sessionId, documentId), d);
    await remergeUnlocked(sessionId);
    return d;
  });
}

export function updateEdits(
  sessionId: string,
  patch: {
    setEdited?: SessionEdits['editedFields'][string][];
    clearEdited?: string[];
    setApplied?: SessionEdits['appliedFields'][string][];
    clearApplied?: string[];
  }
): Promise<SessionEdits> {
  return withSessionLock(sessionId, async () => {
    const edits = await getEdits(sessionId);
    for (const e of patch.setEdited || []) edits.editedFields[e.fieldId] = e;
    for (const id of patch.clearEdited || []) delete edits.editedFields[id];
    for (const a of patch.setApplied || []) edits.appliedFields[a.fieldId] = a;
    for (const id of patch.clearApplied || []) delete edits.appliedFields[id];
    edits.revision += 1;
    edits.updatedAt = new Date().toISOString();
    await writeJson(editsFile(sessionId), edits);
    await remergeUnlocked(sessionId);
    return edits;
  });
}

// ---------------------------------------------------------------- delete

export type DeleteOutcome = { found: false } | { found: true; clearFieldIds: string[] };

export function deleteDocumentFile(
  sessionId: string,
  documentId: string,
  mode: 'file_only' | 'file_and_clear_fields',
  reason: 'user' | 'retention' = 'user'
): Promise<DeleteOutcome> {
  return withSessionLock(sessionId, async () => {
    const doc = await getDocument(sessionId, documentId);
    if (!doc) return { found: false as const };
    await removeBytes(doc);
    if (!doc.fileDeletedAt) {
      doc.fileDeletedAt = new Date().toISOString();
      doc.fileDeletedReason = reason;
    }
    let clearFieldIds: string[] = [];
    if (mode === 'file_and_clear_fields') {
      await fsp.rm(resultFile(sessionId, documentId), { force: true });
      doc.status = doc.status === 'extracted' ? 'uploaded' : doc.status;
      const edits = await getEdits(sessionId);
      const prefix = `${documentId}:`;
      clearFieldIds = Object.values(edits.appliedFields)
        .filter((a) => a.candidateId.startsWith(prefix) && !edits.editedFields[a.fieldId])
        .map((a) => a.fieldId);
      for (const id of clearFieldIds) delete edits.appliedFields[id];
      if (clearFieldIds.length > 0) {
        edits.revision += 1;
        edits.updatedAt = new Date().toISOString();
        await writeJson(editsFile(sessionId), edits);
      }
    }
    await writeJson(docFile(sessionId, documentId), doc);
    if (mode === 'file_and_clear_fields') await remergeUnlocked(sessionId);
    await touchSession(sessionId);
    return { found: true as const, clearFieldIds };
  });
}

/**
 * Retention: bytes and result gone, record kept with reason, re-merged. Edits are left alone.
 * A document already deleted by a user keeps its original reason, but its result is still expired.
 * Returns true if anything was removed.
 */
export function expireDocument(sessionId: string, documentId: string): Promise<boolean> {
  return withSessionLock(sessionId, async () => {
    const doc = await getDocument(sessionId, documentId);
    if (!doc) return false;
    const hadResult = (await getResult(sessionId, documentId)) !== null;
    if (doc.fileDeletedAt && !hadResult) return false;
    await removeBytes(doc);
    await fsp.rm(resultFile(sessionId, documentId), { force: true });
    if (!doc.fileDeletedAt) {
      doc.fileDeletedAt = new Date().toISOString();
      doc.fileDeletedReason = 'retention';
    }
    if (doc.status === 'extracted') doc.status = 'uploaded';
    await writeJson(docFile(sessionId, documentId), doc);
    await remergeUnlocked(sessionId);
    return true;
  });
}

/**
 * Document type override: rewrites the stored result's type (document and every candidate source) so the
 * result never carries the old type, then re-merges (docs/contracts.md section 2).
 */
export function overrideDocumentType(
  sessionId: string,
  documentId: string,
  documentType: DocumentType
): Promise<StoredDocument | null> {
  return withSessionLock(sessionId, async () => {
    const doc = await getDocument(sessionId, documentId);
    if (!doc) return null;
    doc.documentType = documentType;
    doc.documentTypeOverridden = true;
    await writeJson(docFile(sessionId, documentId), doc);
    const result = await getResult(sessionId, documentId);
    if (result && result.ok) {
      result.documentType = documentType;
      for (const f of result.fields) f.source.documentType = documentType;
      await writeJson(resultFile(sessionId, documentId), result);
    }
    await remergeUnlocked(sessionId);
    return doc;
  });
}

// ------------------------------------------------------------------ jobs

export const saveJob = (job: ExtractionJob) =>
  writeJson(jobFile(job.sessionId, job.jobId), job);

export const getJob = (sessionId: string, jobId: string) =>
  readJson<ExtractionJob>(jobFile(sessionId, jobId));

export async function listJobs(sessionId: string): Promise<ExtractionJob[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(safeJoin('sessions', sessionId, 'jobs'));
  } catch {
    return [];
  }
  const jobs: ExtractionJob[] = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !isJobId(n.slice(0, -5))) continue;
    const j = await readJson<ExtractionJob>(jobFile(sessionId, n.slice(0, -5)));
    if (j) jobs.push(j);
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getActiveJob(sessionId: string): Promise<ExtractionJob | null> {
  const jobs = await listJobs(sessionId);
  return jobs.reverse().find((j) => !TERMINAL_JOB_STATUSES.includes(j.status)) || null;
}

// ----------------------------------------------------------------- state

export async function loadSessionState(sessionId: string): Promise<DocumentSessionState | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  let prov = await readJson<Provenance>(provenanceFile(sessionId));
  const settings = await getSettings();
  if (!prov || prov.autoApplyThreshold !== settings.autoApplyThreshold) {
    prov = await remergeSession(sessionId);
  }
  const [documents, edits, activeJob] = await Promise.all([
    listDocuments(sessionId),
    getEdits(sessionId),
    getActiveJob(sessionId),
  ]);
  return { session, documents, fields: prov.fields, warnings: prov.warnings, edits, activeJob };
}

/** Used by tests and boot: true if the root exists and is usable. */
export function rootExists(): boolean {
  return fs.existsSync(getRoot());
}
