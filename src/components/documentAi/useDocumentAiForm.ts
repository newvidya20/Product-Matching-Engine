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
const POLL_GIVE_UP_MS = 10 * 60 * 1000;

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
  const pendingRef = useRef<PendingEdits>(emptyPending());
  const flushTimer = useRef<number | null>(null);
  const flushChain = useRef<Promise<void>>(Promise.resolve());
  const flushAttempts = useRef(0);
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
      try {
        await documentAiClient.putEdits(sessionIdRef.current, request);
        flushAttempts.current = 0;
      } catch {
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
        if (flushAttempts.current <= 5 && mountedRef.current) {
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
    const out = applyFieldResults({
      form: formRef.current,
      fields,
      editedFieldIds: new Set(Object.keys(editedRef.current)),
      applied: appliedRef.current,
    });
    if (out.form !== formRef.current) commitForm(() => out.form);
    appliedRef.current = out.applied;
    const pending = pendingRef.current;
    for (const entry of out.setApplied) {
      pending.setApplied[entry.fieldId] = entry;
      pending.clearApplied.delete(entry.fieldId);
    }
    for (const id of out.clearApplied) {
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
      docStateRef.current = state;
      sessionExistsRef.current = true;
      // Server copy first, then anything not yet flushed on top of it.
      const pending = pendingRef.current;
      const edited = { ...state.edits.editedFields, ...editedRef.current, ...pending.setEdited };
      for (const id of pending.clearEdited) delete edited[id];
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
    const state = await documentAiClient.getSession(sessionIdRef.current);
    if (state && mountedRef.current) hydrate(state, true);
    return state;
  }, [hydrate]);

  const startExtraction = useCallback(
    async (documentIds?: string[], force = false) => {
      try {
        const { job: started } = await documentAiClient.startExtraction(sessionIdRef.current, {
          ...(documentIds ? { documentIds } : {}),
          ...(force ? { force: true } : {}),
        });
        if (!mountedRef.current) return;
        setJob(started);
        setPollTimedOut(false);
        await refreshSession().catch(() => undefined);
        beginPolling(started.jobId);
      } catch (error) {
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
      const handle = { jobId, startedAt: Date.now(), timer: null as number | null, failures: 0 };
      pollRef.current = handle;
      const tick = async () => {
        if (pollRef.current !== handle || !mountedRef.current) return;
        const elapsed = Date.now() - handle.startedAt;
        try {
          const { job: latest } = await documentAiClient.getJob(sessionIdRef.current, jobId);
          if (pollRef.current !== handle || !mountedRef.current) return;
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

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        if (editingAssessment) {
          const found = await documentAiClient.findSession(editingAssessment.id).catch(() => null);
          if (cancelled) return;
          if (found?.session) {
            sessionIdRef.current = found.session.sessionId;
            setSessionIdState(found.session.sessionId);
          }
        }
        const state = await documentAiClient.getSession(sessionIdRef.current);
        if (cancelled) return;
        if (state) {
          // Saved values win on reopen: the first hydrate must not apply anything.
          skipApplyRef.current = isEditing;
          hydrate(state, true);
          skipApplyRef.current = false;
          if (editingAssessment && !state.session.assessmentId) {
            void documentAiClient.linkSession(state.session.sessionId, editingAssessment.id).catch(() => undefined);
          }
          if (state.activeJob && !TERMINAL_JOB_STATUSES.includes(state.activeJob.status)) {
            setJob(state.activeJob);
            beginPolling(state.activeJob.jobId);
          }
        }
        if (editingAssessment) {
          // Anything already on the saved draft counts as the person's own.
          const form = formRef.current;
          let changed = false;
          for (const definition of FIELD_DEFINITIONS) {
            if (!definition.extractable || !isFormBacked(definition)) continue;
            if (definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose) continue;
            if (definition.fieldId in editedRef.current || definition.fieldId in appliedRef.current) continue;
            if (readField(form, definition) !== (definition.defaultValue ?? '')) {
              markEdited(definition.fieldId, 'preexisting_value');
              changed = true;
            }
          }
          if (changed) bump();
        }
      } catch (error) {
        if (!cancelled) setNotice(errorMessage(error));
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      stopPolling();
      void flushEdits();
    };
    // Runs once per mount: the editing assessment cannot change without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const loadDemo = useCallback(
    (demo: FormState) => {
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
    [bump, commitForm, dropEditState, markEdited]
  );

  const reset = useCallback(
    (blank: FormState) => {
      stopPolling();
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      const next = newSessionId();
      sessionIdRef.current = next;
      if (!isEditing) writeStoredSession(next);
      sessionExistsRef.current = false;
      pendingRef.current = emptyPending();
      editedRef.current = {};
      appliedRef.current = {};
      docStateRef.current = null;
      extractAgainRef.current = false;
      commitForm(() => blank);
      setSessionIdState(next);
      setDocState(null);
      setJob(null);
      setUploads([]);
      setDismissed({});
      setNotice(null);
      setPollTimedOut(false);
      bump();
    },
    [bump, commitForm, isEditing, stopPolling]
  );

  /** Call before saving: flushes edits, and says whether the session should be linked. */
  const prepareForSave = useCallback(async (): Promise<{ documentSessionId?: string }> => {
    await flushEdits();
    return sessionExistsRef.current ? { documentSessionId: sessionIdRef.current } : {};
  }, [flushEdits]);

  /** After a save. Links as a fallback (the server also links from the body) and clears the stored session. */
  const afterSave = useCallback(async (assessmentId: string) => {
    writeStoredSession(null);
    const linked = docStateRef.current?.session.assessmentId;
    if (sessionExistsRef.current && linked !== assessmentId) {
      await documentAiClient.linkSession(sessionIdRef.current, assessmentId).catch(() => undefined);
    }
  }, []);

  // --------------------------------------------------------------- Documents

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);
      const existing = docStateRef.current?.documents.filter((d) => !d.fileDeletedAt) ?? [];
      let count = existing.length;
      let totalBytes = existing.reduce((sum, d) => sum + d.sizeBytes, 0);
      let uploaded = 0;
      for (const file of files) {
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
          const response = await documentAiClient.uploadDocument(sessionIdRef.current, {
            fileName: file.name,
            base64,
          });
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
          setUploads((items) =>
            items.map((i) => (i.key === key ? { ...i, status: 'error', message: errorMessage(error) } : i))
          );
        }
      }
      if (!mountedRef.current) return;
      if (sessionExistsRef.current) {
        await refreshSession().catch((error) => setNotice(errorMessage(error)));
        void flushEdits();
      }
      if (uploaded > 0) await startExtraction();
    },
    [flushEdits, refreshSession, startExtraction]
  );

  const dismissUpload = useCallback((key: string) => {
    setUploads((items) => items.filter((i) => i.key !== key));
  }, []);

  const removeDocument = useCallback(
    async (documentId: string, mode: DeleteDocumentMode) => {
      const response = await documentAiClient.deleteDocument(sessionIdRef.current, documentId, mode);
      if (!mountedRef.current) return;
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
        for (const id of ids) delete applied[id];
        appliedRef.current = applied;
      }
      hydrate(response.state, true);
    },
    [commitForm, hydrate]
  );

  const changeDocumentType = useCallback(
    async (documentId: string, documentType: DocumentType) => {
      try {
        const state = await documentAiClient.updateDocument(sessionIdRef.current, documentId, { documentType });
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
      const state = await refreshSession();
      if (state?.activeJob && !TERMINAL_JOB_STATUSES.includes(state.activeJob.status)) {
        setJob(state.activeJob);
        beginPolling(state.activeJob.jobId);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [beginPolling, refreshSession]);

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
