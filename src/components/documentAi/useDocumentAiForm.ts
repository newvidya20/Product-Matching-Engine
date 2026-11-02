/**
 * Owns the New Assessment form together with its Document AI session (docs/contracts.md sections 5, 7.6, 8).
 *
 * Two rules shape this file:
 *  - The form lives in `formRef` and every change goes through `commitForm`, so the edited map and the
 *    form always agree at the instant a poll result is applied. A result that lands mid-keystroke sees
 *    that keystroke, because `editedRef` is updated in the same synchronous step as the input change.
 *  - Nothing here logs borrower values. Errors are shown from fixed copy or server codes only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentAiError, documentAiClient } from '../../api/documentAiClient';
import {
  DOCUMENT_AI_LIMITS,
  TERMINAL_JOB_STATUSES,
  type AppliedFieldEntry,
  type DeleteDocumentMode,
  type DocumentSessionState,
  type DocumentType,
  type EditOrigin,
  type EditedFieldEntry,
  type ExtractionJob,
  type FieldResult,
  type UpdateEditsRequest,
} from '../../types/documentAi';
import type { BorrowerAssessment } from '../../types/domain';
import {
  FIELD_DEFINITIONS,
  getFieldDefinition,
  toFormValue,
  type FieldDefinition,
} from '../../documentAi/fieldMap';
import { applyFieldResults, dynamicFieldIdsForPurpose } from './applyFieldResults';
import { dropSeededMarksForApplied, type AppliedComparison } from './seedMarks';
import type { DocAiFieldContextValue } from './FieldShell';
import {
  assessmentToForm,
  isFormBacked,
  readField,
  writeField,
  writeFieldById,
  type FormState,
} from './formModel';

const SESSION_STORAGE_KEY = 'lb.docai.activeSession';
const ACCEPTED_EXTENSIONS = ['pdf', 'xlsx', 'csv', 'png', 'jpg', 'jpeg', 'webp'];
const COLLATERAL_DETAIL_IDS = ['collateralType', 'collateralValue', 'collateralDescription'];
const POLL_GIVE_UP_MS = 70 * 60 * 1000;

export interface UploadItem {
  key: string;
  name: string;
  status: 'uploading' | 'error' | 'duplicate';
  message?: string;
}

interface PendingEdits {
  setEdited: Record<string, EditedFieldEntry>;
  clearEdited: Set<string>;
  setApplied: Record<string, AppliedFieldEntry>;
  clearApplied: Set<string>;
}

const emptyPending = (): PendingEdits => ({
  setEdited: {},
  clearEdited: new Set(),
  setApplied: {},
  clearApplied: new Set(),
});

function newSessionId(): string {
  return `ds_${crypto.randomUUID()}`;
}

function readStoredSession(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSession(value: string | null): void {
  try {
    if (value) window.sessionStorage.setItem(SESSION_STORAGE_KEY, value);
    else window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* storage can be blocked; the session then lasts for this page view only */
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const text = String(reader.result ?? '');
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof DocumentAiError) return error.message;
  return 'Something went wrong. Please try again.';
}

function candidateSignature(result: FieldResult | undefined): string {
  return result ? result.candidates.map((c) => c.candidateId).join(',') : '';
}

/** Saved non-default values on a reopened draft count as the person's own. Pure, needs no network. */
function preexistingEntries(form: FormState): EditedFieldEntry[] {
  const at = new Date().toISOString();
  const entries: EditedFieldEntry[] = [];
  for (const definition of FIELD_DEFINITIONS) {
    if (!definition.extractable || !isFormBacked(definition)) continue;
    if (definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose) continue;
    if (readField(form, definition) !== (definition.defaultValue ?? '')) {
      entries.push({ fieldId: definition.fieldId, origin: 'preexisting_value', at });
    }
  }
  return entries;
}

export interface UseDocumentAiFormOptions {
  createBlank: () => FormState;
  editingAssessment: BorrowerAssessment | null;
  defaultCurrency: string;
}

export function useDocumentAiForm({
  createBlank,
  editingAssessment,
  defaultCurrency,
}: UseDocumentAiFormOptions) {
  const isEditing = Boolean(editingAssessment);
  const [form, setForm] = useState<FormState>(() =>
    editingAssessment ? assessmentToForm(editingAssessment, defaultCurrency) : createBlank()
  );
  const formRef = useRef<FormState>(form);
  const editedRef = useRef<Record<string, EditedFieldEntry>>({});
  const appliedRef = useRef<Record<string, AppliedFieldEntry>>({});
  const docStateRef = useRef<DocumentSessionState | null>(null);
  const sessionIdRef = useRef<string>('');
  if (!sessionIdRef.current) {
    sessionIdRef.current = isEditing ? newSessionId() : readStoredSession() || newSessionId();
    if (!isEditing) writeStoredSession(sessionIdRef.current);
  }
  const sessionExistsRef = useRef(false);
  // Bumped whenever the session is swapped, so late results from the old one can be dropped.
  const generationRef = useRef(0);
  const editingRef = useRef<BorrowerAssessment | null>(editingAssessment);
  const lookupDoneRef = useRef(!editingAssessment);
  const loadedRef = useRef(false);
  const loadFailuresRef = useRef(0);
  const loadTimer = useRef<number | null>(null);
  // Fields this page applied itself: the only ones apply logic may later revert.
  const localAppliedRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  // The draft as saved, kept to compare its values with what a document applied.
  const savedFormRef = useRef<FormState | null>(null);
  const pendingRef = useRef<PendingEdits>(emptyPending());
  // Reopened draft: protect saved values straight from the assessment, before any network call.
  if (!seededRef.current) {
    seededRef.current = true;
    if (editingAssessment) {
      savedFormRef.current = formRef.current;
      for (const entry of preexistingEntries(formRef.current)) {
        editedRef.current[entry.fieldId] = entry;
        pendingRef.current.setEdited[entry.fieldId] = entry;
      }
    }
  }
  const flushTimer = useRef<number | null>(null);
  const flushChain = useRef<Promise<void>>(Promise.resolve());
  const flushAttempts = useRef(0);
  // Set only while a save waits on the flush: bounded by a signal and never opens the access-code prompt.
  const flushOptionsRef = useRef<{ signal?: AbortSignal; noUnlock?: boolean }>({});
  const pollRef = useRef<{ jobId: string; startedAt: number; timer: number | null; failures: number } | null>(null);
  const extractAgainRef = useRef(false);
  const mountedRef = useRef(true);
  const skipApplyRef = useRef(false);

  const [, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((n) => n + 1), []);
  const [docState, setDocState] = useState<DocumentSessionState | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [sessionId, setSessionIdState] = useState(sessionIdRef.current);

  // ------------------------------------------------------------ Form commit

  const commitForm = useCallback((updater: (current: FormState) => FormState) => {
    formRef.current = updater(formRef.current);
    setForm(formRef.current);
  }, []);

  // ------------------------------------------------------------- Edits sync

  const flushEdits = useCallback((): Promise<void> => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const run = async () => {
      if (!sessionExistsRef.current) return;
      const pending = pendingRef.current;
      const request: UpdateEditsRequest = {};
      const setEdited = Object.values(pending.setEdited);
      const setApplied = Object.values(pending.setApplied);
      if (setEdited.length) request.setEdited = setEdited;
      if (pending.clearEdited.size) request.clearEdited = [...pending.clearEdited];
      if (setApplied.length) request.setApplied = setApplied;
      if (pending.clearApplied.size) request.clearApplied = [...pending.clearApplied];
      if (Object.keys(request).length === 0) return;
      pendingRef.current = emptyPending();
      const sid = sessionIdRef.current;
      try {
        await documentAiClient.putEdits(sid, request, flushOptionsRef.current);
        flushAttempts.current = 0;
      } catch (error) {
        if (sid !== sessionIdRef.current) return; // the session was swapped; these edits are moot
        if (error instanceof DocumentAiError && error.status === 404) {
          // The session is gone (for example a server restart): treat it as lost and stop retrying.
          // Edits stay in memory, so they remain protected on this page.
          sessionExistsRef.current = false;
        }
        // Put it back without overwriting anything newer, then retry with backoff.
        const next = pendingRef.current;
        for (const entry of setEdited) {
          if (!(entry.fieldId in next.setEdited) && !next.clearEdited.has(entry.fieldId)) {
            next.setEdited[entry.fieldId] = entry;
          }
        }
        for (const entry of setApplied) {
          if (!(entry.fieldId in next.setApplied) && !next.clearApplied.has(entry.fieldId)) {
            next.setApplied[entry.fieldId] = entry;
          }
        }
        for (const id of request.clearEdited ?? []) {
          if (!(id in next.setEdited)) next.clearEdited.add(id);
        }
        for (const id of request.clearApplied ?? []) {
          if (!(id in next.setApplied)) next.clearApplied.add(id);
        }
        flushAttempts.current += 1;
        if (sessionExistsRef.current && flushAttempts.current <= 5 && mountedRef.current) {
          flushTimer.current = window.setTimeout(() => void flushEdits(), 1000 * 2 ** flushAttempts.current);
        }
      }
    };
    flushChain.current = flushChain.current.then(run, run);
    return flushChain.current;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => void flushEdits(), 500);
  }, [flushEdits]);

  /** Synchronous: the edited map is updated before anything else can run. */
  const markEdited = useCallback(
    (fieldId: string, origin: EditOrigin, candidateId?: string) => {
      const entry: EditedFieldEntry = { fieldId, origin, at: new Date().toISOString() };
      if (candidateId) entry.candidateId = candidateId;
      editedRef.current = { ...editedRef.current, [fieldId]: entry };
      pendingRef.current.setEdited[fieldId] = entry;
      pendingRef.current.clearEdited.delete(fieldId);
      scheduleFlush();
    },
    [scheduleFlush]
  );

  const dropEditState = useCallback(
    (fieldIds: string[]) => {
      if (fieldIds.length === 0) return;
      const edited = { ...editedRef.current };
      const applied = { ...appliedRef.current };
      for (const id of fieldIds) {
        if (id in edited) {
          delete edited[id];
          delete pendingRef.current.setEdited[id];
          pendingRef.current.clearEdited.add(id);
        }
        if (id in applied) {
          delete applied[id];
          localAppliedRef.current.delete(id);
          delete pendingRef.current.setApplied[id];
          pendingRef.current.clearApplied.add(id);
        }
      }
      editedRef.current = edited;
      appliedRef.current = applied;
      scheduleFlush();
    },
    [scheduleFlush]
  );

  // ----------------------------------------------------------------- Apply

  const applyNow = useCallback(() => {
    const fields = docStateRef.current?.fields;
    if (!fields) return;
    // A reopened draft stays fully protected until its session has been resolved.
    if (editingRef.current && !loadedRef.current) return;
    const out = applyFieldResults({
      form: formRef.current,
      fields,
      editedFieldIds: new Set(Object.keys(editedRef.current)),
      applied: appliedRef.current,
      revertableFieldIds: localAppliedRef.current,
    });
    if (out.form !== formRef.current) commitForm(() => out.form);
    appliedRef.current = out.applied;
    const pending = pendingRef.current;
    for (const entry of out.setApplied) {
      localAppliedRef.current.add(entry.fieldId);
      pending.setApplied[entry.fieldId] = entry;
      pending.clearApplied.delete(entry.fieldId);
    }
    for (const id of out.clearApplied) {
      localAppliedRef.current.delete(id);
      delete pending.setApplied[id];
      pending.clearApplied.add(id);
    }
    if (out.clearEdited.length) {
      const edited = { ...editedRef.current };
      for (const id of out.clearEdited) {
        delete edited[id];
        delete pending.setEdited[id];
        pending.clearEdited.add(id);
      }
      editedRef.current = edited;
    }
    if (out.setApplied.length || out.clearApplied.length || out.clearEdited.length) scheduleFlush();
    bump();
  }, [bump, commitForm, scheduleFlush]);

  const hydrate = useCallback(
    (state: DocumentSessionState, apply: boolean) => {
      // State for any session other than the current one (e.g. in flight across a Reset) is ignored.
      if (state.session.sessionId !== sessionIdRef.current) return;
      docStateRef.current = state;
      sessionExistsRef.current = true;
      // Server copy first, then anything not yet flushed on top of it.
      const pending = pendingRef.current;
      // A reopen-time guess never overwrites what the server already knows about the field.
      for (const [id, entry] of Object.entries(pending.setEdited)) {
        if (entry.origin === 'preexisting_value' && id in state.edits.editedFields) delete pending.setEdited[id];
      }
      const edited = { ...state.edits.editedFields };
      for (const [id, entry] of Object.entries({ ...editedRef.current, ...pending.setEdited })) {
        if (entry.origin === 'preexisting_value' && id in state.edits.editedFields) continue;
        edited[id] = entry;
      }
      for (const id of pending.clearEdited) delete edited[id];
      // Reopen-time guesses are void for fields a document applied: only explicit delete-and-clear may clear them.
      const comparisons: Record<string, AppliedComparison> = {};
      const savedForm = savedFormRef.current;
      for (const [id, entry] of Object.entries(state.edits.appliedFields)) {
        const definition = getFieldDefinition(id);
        if (!savedForm || !definition || !isFormBacked(definition)) continue;
        const candidate = state.fields[id]?.candidates.find((c) => c.candidateId === entry.candidateId);
        comparisons[id] = {
          applied: candidate?.value ?? null,
          saved: readField(savedForm, definition),
        };
      }
      const droppedSeeds = dropSeededMarksForApplied(
        edited,
        pending.setEdited,
        comparisons,
        new Set(Object.keys(state.edits.editedFields))
      );
      for (const id of droppedSeeds) {
        if (id in state.edits.editedFields) pending.clearEdited.add(id);
      }
      editedRef.current = edited;
      const applied = { ...state.edits.appliedFields, ...pending.setApplied };
      for (const id of pending.clearApplied) delete applied[id];
      appliedRef.current = applied;
      if (mountedRef.current) setDocState(state);
      if (apply && !skipApplyRef.current) applyNow();
      skipApplyRef.current = false;
      bump();
    },
    [applyNow, bump]
  );

  // --------------------------------------------------------------- Polling

  const stopPolling = useCallback(() => {
    if (pollRef.current?.timer) window.clearTimeout(pollRef.current.timer);
    pollRef.current = null;
  }, []);

  const refreshSession = useCallback(async (): Promise<DocumentSessionState | null> => {
    const sid = sessionIdRef.current;
    const state = await documentAiClient.getSession(sid);
    if (sid !== sessionIdRef.current) return null;
    if (state && mountedRef.current) hydrate(state, true);
    return state;
  }, [hydrate]);

  const startExtraction = useCallback(
    async (documentIds?: string[], force = false) => {
      const sid = sessionIdRef.current;
      try {
        const { job: started } = await documentAiClient.startExtraction(sid, {
          ...(documentIds ? { documentIds } : {}),
          ...(force ? { force: true } : {}),
        });
        if (!mountedRef.current || sid !== sessionIdRef.current) return;
        setJob(started);
        setPollTimedOut(false);
        await refreshSession().catch(() => undefined);
        beginPolling(started.jobId);
      } catch (error) {
        if (sid !== sessionIdRef.current) return;
        if (error instanceof DocumentAiError && error.code === 'job_in_progress' && error.jobId) {
          extractAgainRef.current = true;
          setPollTimedOut(false);
          beginPolling(error.jobId);
          return;
        }
        if (mountedRef.current) setNotice(errorMessage(error));
      }
    },
    // beginPolling is declared below and only read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshSession]
  );

  const onJobTerminal = useCallback(async () => {
    try {
      const state = await refreshSession();
      const waiting = state?.documents.some((d) => d.status === 'uploaded' && !d.fileDeletedAt);
      if ((extractAgainRef.current || waiting) && mountedRef.current) {
        extractAgainRef.current = false;
        await startExtraction();
      }
    } catch (error) {
      if (mountedRef.current) setNotice(errorMessage(error));
    }
  }, [refreshSession, startExtraction]);

  const beginPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      const sid = sessionIdRef.current;
      const handle = { jobId, startedAt: Date.now(), timer: null as number | null, failures: 0 };
      pollRef.current = handle;
      const tick = async () => {
        if (pollRef.current !== handle || !mountedRef.current || sid !== sessionIdRef.current) return;
        const elapsed = Date.now() - handle.startedAt;
        try {
          const { job: latest } = await documentAiClient.getJob(sid, jobId);
          if (pollRef.current !== handle || !mountedRef.current || sid !== sessionIdRef.current) return;
          handle.failures = 0;
          setJob(latest);
          if (TERMINAL_JOB_STATUSES.includes(latest.status)) {
            pollRef.current = null;
            await onJobTerminal();
            return;
          }
        } catch {
          handle.failures += 1;
        }
        if (elapsed > POLL_GIVE_UP_MS || handle.failures >= 5) {
          pollRef.current = null;
          if (mountedRef.current) setPollTimedOut(true);
          return;
        }
        handle.timer = window.setTimeout(() => void tick(), elapsed < 30_000 ? 2000 : 5000);
      };
      handle.timer = window.setTimeout(() => void tick(), 1000);
    },
    [onJobTerminal, stopPolling]
  );

  // ----------------------------------------------------------------- Mount

  /**
   * Finds and loads the session. A failed lookup is not "no session": it must not create a second one, so
   * uploads wait until it succeeds, and it is retried here with backoff and again on demand.
   */
  const discardSessionRef = useRef<() => void>(() => undefined);
  const loadSession = useCallback(async (): Promise<boolean> => {
    const generation = generationRef.current;
    const stale = () => !mountedRef.current || generationRef.current !== generation;
    try {
      const assessment = editingRef.current;
      if (assessment && !lookupDoneRef.current) {
        const found = await documentAiClient.findSession(assessment.id);
        if (stale()) return false;
        lookupDoneRef.current = true;
        if (found.session) {
          sessionIdRef.current = found.session.sessionId;
          setSessionIdState(found.session.sessionId);
        }
      }
      const state = await documentAiClient.getSession(sessionIdRef.current);
      if (stale()) return false;
      loadedRef.current = true;
      loadFailuresRef.current = 0;
      if (state && !editingRef.current && state.session.assessmentId) {
        // A new form never resumes a session that already belongs to a saved assessment.
        discardSessionRef.current();
        return true;
      }
      if (state) {
        // Saved values win on reopen: the first hydrate must not apply anything.
        skipApplyRef.current = Boolean(editingRef.current);
        hydrate(state, true);
        skipApplyRef.current = false;
        if (assessment && !state.session.assessmentId) {
          documentAiClient.linkSession(state.session.sessionId, assessment.id).catch((error) => {
            if (mountedRef.current) setNotice(`Could not link the saved draft to its documents. ${errorMessage(error)}`);
          });
        }
        if (state.activeJob && !TERMINAL_JOB_STATUSES.includes(state.activeJob.status)) {
          setJob(state.activeJob);
          beginPolling(state.activeJob.jobId);
        }
      }
      // Marks recorded from the assessment before the session was known can go to the server now.
      scheduleFlush();
      bump();
      return true;
    } catch (error) {
      if (stale()) return false;
      setNotice(errorMessage(error));
      loadFailuresRef.current += 1;
      if (loadFailuresRef.current <= 5) {
        loadTimer.current = window.setTimeout(() => void loadSession(), 2000 * 2 ** loadFailuresRef.current);
      }
      return false;
    } finally {
      if (!stale()) setLoadingSession(false);
    }
  }, [beginPolling, bump, hydrate, scheduleFlush]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSession();
    return () => {
      mountedRef.current = false;
      if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
      stopPolling();
      void flushEdits();
    };
    // Runs once per mount: the editing assessment cannot change without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Loads the session if an earlier attempt failed. True when it is ready to use. */
  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (loadedRef.current) return true;
    if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
    return loadSession();
  }, [loadSession]);

  // ------------------------------------------------------------ Field edits

  /** Single entry point for writing a value and recording who owns it. */
  const setValue = useCallback(
    (fieldId: string, value: string, origin: EditOrigin, candidateId?: string) => {
      const definition = getFieldDefinition(fieldId);
      const before = formRef.current;
      if (definition && isFormBacked(definition)) {
        if (
          definition.target.kind === 'dynamic' &&
          definition.target.purpose !== before.fundingPurpose
        ) {
          return;
        }
        if (COLLATERAL_DETAIL_IDS.includes(fieldId) && before.collateralAvailable !== 'yes' && value !== '') {
          commitForm((f) => ({ ...f, collateralAvailable: 'yes' }));
          markEdited('collateralAvailable', origin === 'typed' ? 'typed' : origin, candidateId);
        }
        commitForm((f) => writeFieldById(f, fieldId, value));
      }
      markEdited(fieldId, origin === 'typed' && value === '' ? 'cleared' : origin, candidateId);
      if (fieldId === 'fundingPurpose' && value !== before.fundingPurpose) {
        dropEditState(dynamicFieldIdsForPurpose(before.fundingPurpose));
        applyNow();
      }
      bump();
    },
    [applyNow, bump, commitForm, dropEditState, markEdited]
  );

  /** For inputs outside the field map (custom attributes, flags, internal notes). */
  const patchForm = useCallback(
    (updater: (current: FormState) => FormState) => {
      commitForm(updater);
    },
    [commitForm]
  );

  const acceptCandidate = useCallback(
    (
      fieldId: string,
      candidateId: string,
      origin: 'accepted_document_value' | 'resolved_conflict' = 'accepted_document_value'
    ) => {
      const result = docStateRef.current?.fields[fieldId];
      const definition = getFieldDefinition(fieldId);
      if (!result || !definition || !isFormBacked(definition)) return;
      if (result.status === 'rejected_validation') return; // type only, no one-click accept
      const candidate = result.candidates.find((c) => c.candidateId === candidateId);
      const value = result.status === 'conflict' ? candidate?.value : (result.value ?? candidate?.value);
      if (value === null || value === undefined) return;
      if (definition.valueType === 'enum' && !definition.allowedValues.includes(String(value))) return;
      setValue(fieldId, toFormValue(definition, value), origin, candidateId);
    },
    [setValue]
  );

  const dismiss = useCallback(
    (fieldId: string) => {
      setDismissed((current) => ({
        ...current,
        [fieldId]: candidateSignature(docStateRef.current?.fields[fieldId]),
      }));
    },
    []
  );

  // ------------------------------------------------------- Demo, reset, save

  /** Swaps in a fresh, unlinked session and drops everything tied to the old one. Form untouched. */
  const resetSession = useCallback(() => {
    generationRef.current += 1;
    stopPolling();
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
    const next = newSessionId();
    sessionIdRef.current = next;
    writeStoredSession(next);
    editingRef.current = null;
    lookupDoneRef.current = true;
    loadedRef.current = true;
    sessionExistsRef.current = false;
    pendingRef.current = emptyPending();
    editedRef.current = {};
    appliedRef.current = {};
    localAppliedRef.current = new Set();
    docStateRef.current = null;
    extractAgainRef.current = false;
    setSessionIdState(next);
    setDocState(null);
    setJob(null);
    setUploads([]);
    setDismissed({});
    setNotice(null);
    setPollTimedOut(false);
    setLoadingSession(false);
  }, [stopPolling]);

  discardSessionRef.current = resetSession;

  /** `detach` leaves the saved record: the form then belongs to a new session and a new assessment. */
  const loadDemo = useCallback(
    (demo: FormState, options: { detach?: boolean } = {}) => {
      if (options.detach) resetSession();
      commitForm(() => demo);
      // The demo replaces everything, so earlier autofill no longer describes the form.
      dropEditState(Object.keys(appliedRef.current).filter((id) => !(id in editedRef.current)));
      for (const definition of FIELD_DEFINITIONS) {
        if (!definition.extractable || !isFormBacked(definition)) continue;
        if (definition.target.kind === 'dynamic' && definition.target.purpose !== demo.fundingPurpose) continue;
        if (readField(demo, definition) !== (definition.defaultValue ?? '')) {
          markEdited(definition.fieldId, 'demo_sample');
        }
      }
      bump();
    },
    [bump, commitForm, dropEditState, markEdited, resetSession]
  );

  const reset = useCallback(
    (blank: FormState) => {
      resetSession();
      commitForm(() => blank);
      bump();
    },
    [bump, commitForm, resetSession]
  );

  /**
   * Call before saving: flushes edits and says whether the session should be linked. It never throws and
   * never blocks the save. If the flush fails the edits stay in memory (protected on this page) and
   * `warning` says document protection could not be stored.
   */
  const prepareForSave = useCallback(async (): Promise<{ documentSessionId?: string; warning?: string }> => {
    let warning: string | undefined;
    const controller = new AbortController();
    let timer = 0;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve();
      }, 5000);
    });
    flushOptionsRef.current = { signal: controller.signal, noUnlock: true };
    try {
      await Promise.race([
        (async () => {
          await flushEdits();
          await flushEdits();
        })(),
        timeout,
      ]);
    } catch {
      /* flushEdits handles its own failures */
    } finally {
      window.clearTimeout(timer);
      flushOptionsRef.current = {};
    }
    const p = pendingRef.current;
    const outstanding =
      Object.keys(p.setEdited).length + Object.keys(p.setApplied).length + p.clearEdited.size + p.clearApplied.size;
    if ((outstanding > 0 || timedOut) && (sessionExistsRef.current || docStateRef.current)) {
      warning =
        'Your changes to the extracted fields could not be stored with the documents. They stay protected on this page only.';
      if (mountedRef.current) setNotice(warning);
    }
    const link = sessionExistsRef.current ? { documentSessionId: sessionIdRef.current } : {};
    return warning ? { ...link, warning } : link;
  }, [flushEdits]);

  /**
   * After a save. Links as a fallback (the server also links from the body) and clears the stored session
   * if it still holds this one. Returns a message when the link failed, since the files would be purged.
   */
  const afterSave = useCallback(async (assessmentId: string): Promise<string | null> => {
    const sid = sessionIdRef.current;
    if (readStoredSession() === sid) writeStoredSession(null);
    const linked = docStateRef.current?.session.assessmentId;
    if (sessionExistsRef.current && linked !== assessmentId) {
      try {
        await documentAiClient.linkSession(sid, assessmentId);
      } catch (error) {
        const message = `Saved, but the uploaded documents could not be linked to this assessment and may be removed. ${errorMessage(error)}`;
        if (mountedRef.current) setNotice(message);
        return message;
      }
    }
    return null;
  }, []);

  // --------------------------------------------------------------- Documents

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);
      if (!(await ensureSession())) {
        setNotice('Could not load the documents for this assessment yet. Try again in a moment.');
        return;
      }
      const sid = sessionIdRef.current;
      const same = () => mountedRef.current && sessionIdRef.current === sid;
      const existing = docStateRef.current?.documents.filter((d) => !d.fileDeletedAt) ?? [];
      let count = existing.length;
      let totalBytes = existing.reduce((sum, d) => sum + d.sizeBytes, 0);
      let uploaded = 0;
      for (const file of files) {
        if (!same()) return; // the session changed (Reset): do not send the rest to the new one
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
        let rejection: string | null = null;
        if (!ACCEPTED_EXTENSIONS.includes(extension)) {
          rejection =
            extension === 'xls'
              ? 'Old .xls files are not supported. Save a copy as .xlsx.'
              : 'Use PDF, XLSX, CSV, PNG, JPG or WebP.';
        } else if (file.size > DOCUMENT_AI_LIMITS.maxFileBytes) {
          rejection = 'Larger than 12 MB.';
        } else if (file.size === 0) {
          rejection = 'The file is empty.';
        } else if (count >= DOCUMENT_AI_LIMITS.maxFilesPerSession) {
          rejection = 'This assessment already has 25 files.';
        } else if (totalBytes + file.size > DOCUMENT_AI_LIMITS.maxSessionBytes) {
          rejection = 'This would pass the 100 MB limit for one assessment.';
        }
        if (rejection) {
          setUploads((items) => [...items, { key, name: file.name, status: 'error', message: rejection! }]);
          continue;
        }
        count += 1;
        totalBytes += file.size;
        setUploads((items) => [...items, { key, name: file.name, status: 'uploading' }]);
        try {
          const base64 = await fileToBase64(file);
          const response = await documentAiClient.uploadDocument(sid, {
            fileName: file.name,
            base64,
          });
          if (!same()) return;
          sessionExistsRef.current = true;
          if (response.duplicate) {
            setUploads((items) =>
              items.map((i) =>
                i.key === key ? { ...i, status: 'duplicate', message: 'Already uploaded for this assessment.' } : i
              )
            );
          } else {
            uploaded += 1;
            setUploads((items) => items.filter((i) => i.key !== key));
          }
        } catch (error) {
          if (!same()) return;
          setUploads((items) =>
            items.map((i) => (i.key === key ? { ...i, status: 'error', message: errorMessage(error) } : i))
          );
        }
      }
      if (!same()) return;
      if (sessionExistsRef.current) {
        await refreshSession().catch((error) => setNotice(errorMessage(error)));
        void flushEdits();
      }
      if (uploaded > 0) await startExtraction();
    },
    [ensureSession, flushEdits, refreshSession, startExtraction]
  );

  const dismissUpload = useCallback((key: string) => {
    setUploads((items) => items.filter((i) => i.key !== key));
  }, []);

  const removeDocument = useCallback(
    async (documentId: string, mode: DeleteDocumentMode) => {
      const sid = sessionIdRef.current;
      const response = await documentAiClient.deleteDocument(sid, documentId, mode);
      if (!mountedRef.current || sid !== sessionIdRef.current) return;
      if (mode === 'file_and_clear_fields') {
        // Blank what this document filled, unless the person has since made it their own.
        const ids = response.clearFieldIds.filter((id) => !(id in editedRef.current));
        commitForm((current) =>
          ids.reduce((acc, id) => {
            const definition = getFieldDefinition(id);
            return definition && isFormBacked(definition)
              ? writeField(acc, definition, definition.defaultValue ?? '')
              : acc;
          }, current)
        );
        const applied = { ...appliedRef.current };
        for (const id of ids) {
          delete applied[id];
          localAppliedRef.current.delete(id);
        }
        appliedRef.current = applied;
      }
      hydrate(response.state, true);
    },
    [commitForm, hydrate]
  );

  const changeDocumentType = useCallback(
    async (documentId: string, documentType: DocumentType) => {
      try {
        const sid = sessionIdRef.current;
        const state = await documentAiClient.updateDocument(sid, documentId, { documentType });
        if (sid !== sessionIdRef.current) return;
        if (mountedRef.current) hydrate(state, true);
        await startExtraction([documentId], true);
      } catch (error) {
        if (mountedRef.current) setNotice(errorMessage(error));
      }
    },
    [hydrate, startExtraction]
  );

  const retryDocument = useCallback(
    (documentId: string) => startExtraction([documentId], true),
    [startExtraction]
  );

  const refresh = useCallback(async () => {
    setPollTimedOut(false);
    try {
      if (!loadedRef.current) {
        await ensureSession();
        return;
      }
      const state = await refreshSession();
      if (state?.activeJob && !TERMINAL_JOB_STATUSES.includes(state.activeJob.status)) {
        setJob(state.activeJob);
        beginPolling(state.activeJob.jobId);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [beginPolling, ensureSession, refreshSession]);

  // ---------------------------------------------------------------- Context

  const fieldContext = useMemo<DocAiFieldContextValue>(
    () => ({
      results: docState?.fields ?? {},
      edited: editedRef.current,
      applied: appliedRef.current,
      isDismissed: (fieldId: string) =>
        fieldId in dismissed && dismissed[fieldId] === candidateSignature(docState?.fields[fieldId]),
      acceptCandidate,
      dismiss,
    }),
    // editedRef/appliedRef change identity on every update, and bump() re-renders after each.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docState, dismissed, acceptCandidate, dismiss, editedRef.current, appliedRef.current]
  );

  const isBusy = Boolean(job && !TERMINAL_JOB_STATUSES.includes(job.status));

  return {
    form,
    formRef,
    sessionId,
    docState,
    documents: docState?.documents ?? [],
    job,
    isBusy,
    pollTimedOut,
    uploads,
    notice,
    setNotice,
    loadingSession,
    isEditing,
    fieldContext,
    edited: editedRef.current,
    applied: appliedRef.current,
    dismissed,
    setValue,
    patchForm,
    acceptCandidate,
    dismiss,
    loadDemo,
    reset,
    prepareForSave,
    afterSave,
    uploadFiles,
    dismissUpload,
    removeDocument,
    changeDocumentType,
    retryDocument,
    refresh,
  };
}

export type DocumentAiForm = ReturnType<typeof useDocumentAiForm>;
export type { FieldDefinition };
