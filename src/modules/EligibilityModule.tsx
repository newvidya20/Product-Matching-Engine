import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ClipboardCheck, FilePlus2, Loader2, Play, RefreshCw, Save, Wand2 } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import { PageHeader } from '../components/ui/Primitives';
import { DocumentAccessGate } from '../components/documentAi/DocumentAccessGate';
import { DocumentUploadCard } from '../components/documentAi/DocumentUploadCard';
import { DocumentPreviewDrawer } from '../components/documentAi/DocumentPreviewDrawer';
import { DeleteDocumentDialog } from '../components/documentAi/DeleteDocumentDialog';
import { ReviewPanel } from '../components/documentAi/ReviewPanel';
import { ELIGIBILITY_DOC_FIELD_IDS, eligibilityFieldForDocField } from '../components/eligibility/docFieldMap';
import { buildCandidateOptionsMap, type CandidateOption } from '../components/eligibility/candidateOptions';
import { useDocumentAiForm } from '../components/documentAi/useDocumentAiForm';
import { createBlankForm } from '../components/documentAi/formModel';
import { EligibilityError, eligibilityClient } from '../api/eligibilityClient';
import {
  ELIGIBILITY_INPUT_FIELDS,
  type ContinueEligibilityResponse,
  type EligibilityAssessmentRecord,
  type EligibilityInputField,
  type EligibilityInputSources,
  type EligibilityResult,
  type EligibilityResultSnapshot,
  type EligibilityRecordSummary,
  type EligibilityRulesResponse,
  type PendingVerificationInput,
} from '../types/eligibility';
import { EMPTY_ELIGIBILITY_INPUT } from '../types/eligibility';
import { formToInput, inputToForm, type FormValues } from '../components/eligibility/fieldMeta';
import { EligibilityInputForm, PendingSummary } from '../components/eligibility/EligibilityInputForm';
import { EligibilityResultsView, ResultComparison } from '../components/eligibility/EligibilityResultsView';
import { EligibilityRulesPanel, UnconfirmedRulesBanner } from '../components/eligibility/EligibilityRulesPanel';
import { EligibilityRecordsList } from '../components/eligibility/EligibilityRecordsList';
import type { DeleteDocumentMode, StoredDocument } from '../types/documentAi';

export interface EligibilityModuleProps {
  documentSessionId?: string;
  assessmentId?: string;
  onContinueToAssessment?: (response: ContinueEligibilityResponse) => void;
}

const BTN_PRIMARY =
  'inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
const BTN_SECONDARY =
  'inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
const INPUT =
  'w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600 disabled:bg-stone-100';

const blankValues = (): FormValues => inputToForm({ ...EMPTY_ELIGIBILITY_INPUT });

function snapshotOf(result: EligibilityResult): EligibilityResultSnapshot {
  return {
    outcome: result.outcome,
    rulesVersion: result.rulesVersion,
    rulesHash: result.rulesHash,
    evaluatedAt: result.evaluatedAt,
    counts: result.counts,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function EligibilityModule(props: EligibilityModuleProps = {}) {
  const { documentSessionId: sessionProp, assessmentId: assessmentProp, onContinueToAssessment } = props;
  const { state, navigateTo } = useAppState();

  const [rules, setRules] = useState<EligibilityRulesResponse | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [records, setRecords] = useState<EligibilityRecordSummary[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const [values, setValues] = useState<FormValues>(blankValues);
  const [sources, setSources] = useState<EligibilityInputSources>({});
  const [applicantLabel, setApplicantLabel] = useState('');
  const [pending, setPending] = useState<PendingVerificationInput[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<EligibilityInputField, string>>>({});

  const [assessmentId, setAssessmentId] = useState(assessmentProp ?? '');
  const [sessionId, setSessionId] = useState(sessionProp ?? '');

  const [record, setRecord] = useState<EligibilityAssessmentRecord | null>(null);
  const [preview, setPreview] = useState<EligibilityResult | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmFinal, setConfirmFinal] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<StoredDocument | null>(null);
  const [deleteDoc, setDeleteDoc] = useState<StoredDocument | null>(null);

  const defaultCurrency = state.settings.defaultCurrency;
  const officerDefault = state.currentUser?.displayName || state.currentUser?.email || '';
  const ai = useDocumentAiForm({
    createBlank: () => createBlankForm(defaultCurrency, officerDefault),
    editingAssessment: null,
    defaultCurrency,
  });

  const isFinal = record?.status === 'final';

  const refreshRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      setRecords((await eligibilityClient.listRecords()).records);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    eligibilityClient
      .getRules()
      .then(setRules)
      .catch((err) => setRulesError(errorMessage(err)));
    void refreshRecords();
  }, [refreshRecords]);

  const parsed = useMemo(() => formToInput(values), [values]);

  const dirty = useMemo(() => {
    if (!record) return true;
    if (applicantLabel.trim() !== record.applicantLabel) return true;
    if (assessmentId !== (record.linkedAssessmentId ?? '')) return true;
    if (sessionId.trim() !== (record.documentSessionId ?? '')) return true;
    return ELIGIBILITY_INPUT_FIELDS.some((f) => parsed.input[f] !== record.input[f]);
  }, [record, parsed, applicantLabel, assessmentId, sessionId]);

  const labels = useMemo(() => {
    const out: Record<string, string> = {};
    if (rules) for (const [id, rule] of Object.entries(rules.rules.criteria)) out[id] = rule.label;
    return out;
  }, [rules]);

  // Values the user typed or confirmed from a document: a later re-read of the documents never replaces them.
  const lockedRef = useRef<Partial<Record<EligibilityInputField, string>>>({});

  const handleChange = (field: EligibilityInputField, value: string) => {
    if (value.trim() === '') delete lockedRef.current[field];
    else lockedRef.current[field] = value;
    setValues((current) => ({ ...current, [field]: value }));
    setSources((current) => {
      const next = { ...current };
      if (value.trim() === '') delete next[field];
      else next[field] = { kind: 'manual' };
      return next;
    });
    setFieldErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setPreview(null);
    setConfirmFinal(false);
  };

  /** Returns the parsed input, or null after showing the problems. Nothing is coerced. */
  const validate = (): typeof parsed.input | null => {
    if (Object.keys(parsed.errors).length > 0) {
      setFieldErrors(parsed.errors);
      setError('Fix the highlighted fields, or clear them to mark them as not provided.');
      return null;
    }
    return parsed.input;
  };

  const applyServerError = (err: unknown) => {
    if (err instanceof EligibilityError && err.code === 'invalid_input' && err.fields.length > 0) {
      const next: Partial<Record<EligibilityInputField, string>> = {};
      for (const f of err.fields) {
        if ((ELIGIBILITY_INPUT_FIELDS as readonly string[]).includes(f)) {
          next[f as EligibilityInputField] = 'The server rejected this value. Check the range.';
        }
      }
      setFieldErrors(next);
    }
    setError(errorMessage(err));
  };

  const run = async (name: string, task: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (err) {
      applyServerError(err);
    } finally {
      setBusy(null);
    }
  };

  const loadRecord = (r: EligibilityAssessmentRecord) => {
    lockedRef.current = {};
    setRecord(r);
    setValues(inputToForm(r.input));
    setSources(r.inputSources);
    setApplicantLabel(r.applicantLabel);
    setSessionId(r.documentSessionId ?? '');
    setAssessmentId(r.linkedAssessmentId ?? '');
    setPending([]);
    setPreview(null);
    setFieldErrors({});
    setConfirmFinal(false);
  };

  const doPrefill = useCallback(
    (assessment: string, session: string) =>
      run('prefill', async () => {
        const request = {
          ...(assessment ? { assessmentId: assessment } : {}),
          ...(session.trim() ? { documentSessionId: session.trim() } : {}),
        };
        if (!request.assessmentId && !request.documentSessionId) {
          throw new Error('Choose an assessment or enter a document session ID to prefill from.');
        }
        const res = await eligibilityClient.prefill(request);
        setValues({ ...inputToForm(res.input), ...lockedRef.current });
        setSources(res.inputSources);
        setPending(res.pendingVerification);
        setPreview(null);
        setFieldErrors({});
        if (res.documentSessionId) setSessionId(res.documentSessionId);
        setApplicantLabel((current) => current.trim() || res.applicantLabel || '');
        const filled = ELIGIBILITY_INPUT_FIELDS.filter((f) => res.input[f] !== null).length;
        setNotice(`Prefilled ${filled} of ${ELIGIBILITY_INPUT_FIELDS.length} values. Anything blank is still not provided.`);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Prefill once when the module is opened from an assessment or a document session.
  const autoPrefilled = useRef(false);
  useEffect(() => {
    if (autoPrefilled.current) return;
    if (assessmentProp || sessionProp) {
      autoPrefilled.current = true;
      void doPrefill(assessmentProp ?? '', sessionProp ?? '');
    }
  }, [assessmentProp, sessionProp, doPrefill]);

  useEffect(() => {
    if (!ai.sessionId) return;
    if (sessionId.trim() !== ai.sessionId) setSessionId(ai.sessionId);
    const hasExtractedDoc = ai.documents.some((doc) => doc.status === 'extracted');
    if (ai.docState && (Object.keys(ai.docState.fields).length > 0 || hasExtractedDoc)) {
      void doPrefill(assessmentId, ai.sessionId);
    }
  }, [ai.docState, ai.documents, ai.sessionId, assessmentId, doPrefill, sessionId]);

  /**
   * "Confirm & fill" / "Use this value" in the review list: the person has checked the document value,
   * so it goes into the Eligibility form (and the Document AI form), and is kept across re-reads.
   */
  const confirmDocumentValue = (
    fieldId: string,
    candidateId: string,
    origin?: 'accepted_document_value' | 'resolved_conflict'
  ) => {
    ai.acceptCandidate(fieldId, candidateId, origin);
    const field = eligibilityFieldForDocField(fieldId);
    const result = ai.docState?.fields[fieldId];
    if (!field) {
      // Not an Eligibility input (e.g. a Financials value used later in New Assessment): it is kept in the document form.
      setNotice('Value chosen and saved to the document form. It is not an Eligibility input, so it carries over to New Assessment.');
      return;
    }
    if (!result) return;
    const candidate = result.candidates.find((c) => c.candidateId === candidateId);
    const value = result.status === 'conflict' ? candidate?.value : (result.value ?? candidate?.value);
    if (value === null || value === undefined) return;
    handleChange(field, String(value));
    setSources((current) => ({
      ...current,
      [field]: { kind: 'document_ai', documentSessionId: ai.sessionId ?? '', fieldId },
    }));
    setPending((current) => current.filter((item) => item.field !== field));
    setNotice('Value confirmed and filled in.');
  };

  /** Document values waiting for an OK, by Eligibility field. A conflict has no single value to propose. */
  const proposals = useMemo(() => {
    const out: Partial<Record<EligibilityInputField, string>> = {};
    for (const item of pending) {
      const docId = ELIGIBILITY_DOC_FIELD_IDS[item.field];
      const result = docId ? ai.docState?.fields[docId] : undefined;
      if (result && result.status === 'needs_verification' && result.value !== null && result.value !== undefined) {
        out[item.field] = String(result.value);
      }
    }
    return out;
  }, [pending, ai.docState]);

  /** Every document value per input, for the "N values found" dropdown. */
  const candidateOptions = useMemo(
    () => buildCandidateOptionsMap(ai.docState?.fields ?? {}, values),
    [ai.docState, values]
  );

  /** Dropdown pick: that exact candidate's value, with its own document source. Nothing is guessed. */
  const pickCandidateOption = (field: EligibilityInputField, option: CandidateOption) => {
    if (option.isTotal) {
      // A sum has no single source field, so it is filled as a typed value and said so.
      handleChange(field, option.value);
      setPending((current) => current.filter((item) => item.field !== field));
      setNotice(`Total of ${option.sourceLabel.split(' ')[0]} values from documents`);
      return;
    }
    ai.acceptCandidate(option.docFieldId, option.candidateId, 'resolved_conflict');
    handleChange(field, option.value);
    setSources((current) => ({
      ...current,
      [field]: { kind: 'document_ai', documentSessionId: ai.sessionId ?? '', fieldId: option.docFieldId },
    }));
    setPending((current) => current.filter((item) => item.field !== field));
    setNotice(`Using ${option.label}.`);
  };

  const confirmProposal = (field: EligibilityInputField) => {
    const docId = ELIGIBILITY_DOC_FIELD_IDS[field];
    const result = docId ? ai.docState?.fields[docId] : undefined;
    const candidate =
      result?.candidates.find((c) => c.candidateId === result.suggestedCandidateId) ??
      result?.candidates.find((c) => c.value !== null);
    if (docId && candidate) confirmDocumentValue(docId, candidate.candidateId);
  };

  const handleDeleteDocument = async (documentId: string, mode: DeleteDocumentMode) => {
    await ai.removeDocument(documentId, mode);
  };

  const runCheck = () =>
    run('evaluate', async () => {
      const input = validate();
      if (!input) return;
      setFieldErrors({});
      setPreview((await eligibilityClient.evaluate({ input })).result);
    });

  const save = (status: 'draft' | 'final') =>
    run(status === 'final' ? 'finalize' : 'save', async () => {
      const input = validate();
      if (!input) return;
      const label = applicantLabel.trim();
      if (!label || label.length > 200) {
        throw new Error('Enter an applicant name or label (up to 200 characters) before saving.');
      }
      setFieldErrors({});
      const inputSources: EligibilityInputSources = {};
      for (const f of ELIGIBILITY_INPUT_FIELDS) {
        if (input[f] !== null && sources[f]) inputSources[f] = sources[f];
      }
      const res = record
        ? await eligibilityClient.updateRecord(record.id, {
            applicantLabel: label,
            input,
            inputSources,
            status,
            documentSessionId: sessionId.trim() || null,
            linkedAssessmentId: assessmentId || null,
          })
        : await eligibilityClient.createRecord({
            applicantLabel: label,
            input,
            inputSources,
            status,
            documentSessionId: sessionId.trim() || null,
            linkedAssessmentId: assessmentId || null,
            createdBy: state.currentUser?.displayName || state.currentUser?.email || null,
          });
      loadRecord(res.record);
      // TEMPORARY (requested): finalizing continues to New Assessment whatever the outcome, including when a mandatory
      // criterion is not met. The result stays on the record and its failed criteria are carried as conditions.
      if (status === 'final') {
        try {
          const continuation = await eligibilityClient.continueToAssessment(res.record.id);
          setRecord(continuation.record);
          if (onContinueToAssessment) {
            onContinueToAssessment(continuation);
            setNotice(`Finalized ${res.record.referenceCode} and opened the assessment prefill.`);
            await refreshRecords();
            return;
          }
          setNotice(`Finalized ${res.record.referenceCode}. Continue to New Assessment from the next step.`);
          await refreshRecords();
          return;
        } catch {
          navigateTo('matching-engine');
        }
      }
      setNotice(status === 'final' ? `Finalized ${res.record.referenceCode}.` : `Saved draft ${res.record.referenceCode}.`);
      await refreshRecords();
    });

  const hasUnsavedEdits = record ? dirty : Object.values(values).some((v) => v.trim() !== '') || applicantLabel.trim() !== '';
  const confirmReplace = (what: string): boolean =>
    !hasUnsavedEdits || window.confirm(`You have unsaved changes. ${what} will replace them. Continue?`);

  const openRecord = (id: string) => {
    if (!confirmReplace('Opening another record')) return Promise.resolve();
    return openRecordNow(id);
  };

  const openRecordNow = (id: string) =>
    run('open', async () => {
      loadRecord((await eligibilityClient.getRecord(id)).record);
    });

  const reassess = () =>
    run('reassess', async () => {
      if (!record) return;
      const res = await eligibilityClient.reassess(record.id);
      setRecord(res.record);
      setPreview(null);
      setNotice('Reassessed the saved inputs with the current rules.');
      await refreshRecords();
    });

  const continueToAssessment = () =>
    run('continue', async () => {
      if (!record) return;
      let res: ContinueEligibilityResponse;
      try {
        res = await eligibilityClient.continueToAssessment(record.id);
      } catch (err) {
        if (
          err instanceof EligibilityError &&
          (err.code === 'continue_blocked_incomplete' || err.code === 'continue_blocked_not_eligible')
        ) {
          // The server re-evaluates against the current rules: show its message and the refreshed result.
          setError(err.message);
          try {
            setRecord((await eligibilityClient.getRecord(record.id)).record);
            setPreview(null);
          } catch {
            /* the message above is still shown */
          }
          await refreshRecords();
          return;
        }
        throw err;
      }
      setRecord(res.record);
      await refreshRecords();
      if (onContinueToAssessment) onContinueToAssessment(res);
      else setNotice('Continue is not connected to New Assessment in this view.');
    });

  const newCheck = () => {
    lockedRef.current = {};
    ai.reset(createBlankForm(defaultCurrency, officerDefault));
    setRecord(null);
    setValues(blankValues());
    setSources({});
    setApplicantLabel('');
    setPending([]);
    setPreview(null);
    setFieldErrors({});
    setError(null);
    setNotice(null);
    setConfirmFinal(false);
    setAssessmentId('');
    setSessionId('');
  };

  // The result on screen: a fresh preview, else the saved result.
  const shown = preview ?? record?.result ?? null;
  const shownIsSaved = !preview && !!record;
  const previousSnapshot: EligibilityResultSnapshot | null = preview
    ? record
      ? snapshotOf(record.result)
      : null
    : record?.previousResults[0] ?? null;

  // Continue uses the saved record, never the form, so it needs a saved and unchanged check.
  const outcome = record?.result.outcome;
  let continueBlocked: string | null = null;
  if (!record) continueBlocked = 'Save this check first. Continue uses the saved record.';
  else if (dirty) continueBlocked = 'The form has unsaved changes. Save them, then continue.';
  // The outcome no longer blocks Continue (temporary, requested). The server enforces it again only when
  // ELIGIBILITY_ENFORCE_CONTINUE_GATE=true, and the 409 handler in continueToAssessment still shows its message.

  const working = busy !== null;
  const anyFilled = Object.values(values).some((v) => v.trim() !== '');
  const assessmentOptions = state.assessments;

  return (
    <div className="space-y-6">
      <DocumentAccessGate user={state.currentUser} />
      <PageHeader
        title="Eligibility Check"
        description="Compare a borrower profile against common lender criteria before a full assessment. Missing information is flagged, never assumed, and the decision uses fixed rules, not AI."
        metadataItems={[
          record ? record.referenceCode : 'New check',
          rules ? `Rules ${rules.rules.rulesVersion}` : 'Loading rules',
        ]}
        actions={
          <button type="button" onClick={newCheck} disabled={working} className={BTN_SECONDARY}>
            <FilePlus2 className="w-3.5 h-3.5" aria-hidden="true" />
            New check
          </button>
        }
      />

      <UnconfirmedRulesBanner rules={rules} />
      {rulesError && (
        <div role="alert" className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
          Could not load the eligibility rules. {rulesError}
        </div>
      )}
      {error && (
        <div role="alert" className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="px-4 py-3 bg-stone-100 border border-stone-200 rounded-xl text-xs text-stone-800">
          {notice}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-200">
        <DocumentUploadCard
          documents={ai.documents}
          uploads={ai.uploads}
          job={ai.job}
          pollTimedOut={ai.pollTimedOut}
          notice={ai.notice}
          loading={ai.loadingSession}
          onFiles={ai.uploadFiles}
          onDismissUpload={ai.dismissUpload}
          onPreview={setPreviewDoc}
          onDelete={setDeleteDoc}
          onRetry={(id) => void ai.retryDocument(id)}
          onUnlock={ai.unlockDocument}
          onRetryFailed={() => void ai.retryFailed()}
          onChangeType={() => undefined}
          fieldCountByDocument={ai.docState ? Object.fromEntries(ai.documents.map((d) => [d.documentId, Object.values(ai.docState!.fields).filter((f) => f.candidates.some((c) => c.source.documentId === d.documentId)).length])) : undefined}
          onRefresh={() => void ai.refresh()}
        />
        {ai.documents.length > 0 && (
          <div className="p-4 sm:p-6">
            <ReviewPanel
              form={ai.form}
              fields={ai.docState?.fields ?? {}}
              warnings={ai.docState?.warnings ?? []}
              edited={ai.edited}
              applied={ai.applied}
              isDismissed={ai.fieldContext.isDismissed}
              acceptCandidate={confirmDocumentValue}
              dismiss={ai.dismiss}
              hasDocuments
              busy={ai.isBusy}
            />
          </div>
        )}
      </div>

      <DocumentPreviewDrawer sessionId={ai.sessionId} document={previewDoc} onClose={() => setPreviewDoc(null)} />
      <DeleteDocumentDialog
        document={deleteDoc}
        allowClearFields
        onCancel={() => setDeleteDoc(null)}
        onConfirm={handleDeleteDocument}
      />
      {isFinal && (
        <div className="px-4 py-3 bg-stone-100 border border-stone-300 rounded-xl text-xs text-stone-800">
          This record is final, so the inputs cannot be edited. You can reassess it with the current rules, or start a
          new check.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        <div className="xl:col-span-3 space-y-5">
          <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-stone-900 font-display">Applicant and prefill</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="space-y-1.5 sm:col-span-2">
                <span className="block text-xs font-medium text-stone-700">Applicant name or label</span>
                <input
                  value={applicantLabel}
                  disabled={isFinal}
                  maxLength={200}
                  onChange={(e) => setApplicantLabel(e.target.value)}
                  className={INPUT}
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-xs font-medium text-stone-700">Saved assessment</span>
                <select
                  value={assessmentId}
                  disabled={isFinal}
                  onChange={(e) => setAssessmentId(e.target.value)}
                  className={INPUT}
                >
                  <option value="">None</option>
                  {assessmentId && !assessmentOptions.some((a) => a.id === assessmentId) && (
                    <option value={assessmentId}>{assessmentId}</option>
                  )}
                  {assessmentOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.referenceCode} - {a.applicantLabel}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="block text-xs font-medium text-stone-700">Document session ID</span>
                <input
                  value={sessionId}
                  disabled={isFinal}
                  onChange={(e) => setSessionId(e.target.value)}
                  className={`${INPUT} font-mono`}
                  placeholder="Optional"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={working || isFinal || (!assessmentId && !sessionId.trim())}
                onClick={() => {
                  if (confirmReplace('Prefill')) void doPrefill(assessmentId, sessionId);
                }}
                className={BTN_SECONDARY}
              >
                {busy === 'prefill' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                Prefill from assessment and documents
              </button>
              <p className="text-[11px] text-stone-500">
                Replaces the values below. Each value shows where it came from. Only reviewed document values are used.
              </p>
            </div>
          </section>

          <PendingSummary pending={pending} />

          <EligibilityInputForm
            values={values}
            sources={sources}
            errors={{ ...parsed.errors, ...fieldErrors }}
            pending={pending}
            proposals={proposals}
            onConfirm={confirmProposal}
            disabled={isFinal || working}
            onChange={handleChange}
            candidateOptions={candidateOptions}
            onPickOption={pickCandidateOption}
          />

          <p className="text-[11px] text-stone-500">
            Blank means not provided and is never treated as 0. Enter 0 only when the value really is zero.
          </p>
        </div>

        <div className="xl:col-span-2 space-y-4 xl:sticky xl:top-4">
          <section className="bg-white border border-stone-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void runCheck()} disabled={working || isFinal || !rules} className={BTN_PRIMARY}>
                {busy === 'evaluate' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                Run check
              </button>
              <button
                type="button"
                onClick={() => void save('draft')}
                disabled={working || isFinal}
                className={BTN_SECONDARY}
              >
                {busy === 'save' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {record ? 'Save changes' : 'Save draft'}
              </button>
              {!isFinal &&
                (confirmFinal ? (
                  <span className="inline-flex items-center gap-2 text-xs text-stone-700">
                    Final records cannot be edited.
                    <button type="button" onClick={() => void save('final')} disabled={working} className={BTN_PRIMARY}>
                      Confirm finalize
                    </button>
                    <button type="button" onClick={() => setConfirmFinal(false)} className={BTN_SECONDARY}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmFinal(true)}
                    disabled={working || !anyFilled}
                    className={BTN_SECONDARY}
                  >
                    <ClipboardCheck className="w-3.5 h-3.5" aria-hidden="true" />
                    Finalize
                  </button>
                ))}
              {record && (
                <button type="button" onClick={() => void reassess()} disabled={working} className={BTN_SECONDARY}>
                  {busy === 'reassess' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  Reassess
                </button>
              )}
            </div>
            {record && dirty && !isFinal && (
              <p className="text-[11px] text-amber-800">
                The form differs from the saved record. Reassess uses the saved inputs; save changes to re-evaluate the
                edited ones.
              </p>
            )}

            <div className="border-t border-stone-100 pt-3 space-y-1.5">
              <button
                type="button"
                onClick={() => void continueToAssessment()}
                disabled={working || continueBlocked !== null}
                className={BTN_PRIMARY}
              >
                {busy === 'continue' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                Continue to New Assessment
              </button>
              {continueBlocked ? (
                <p className="text-[11px] text-stone-600">{continueBlocked}</p>
              ) : (
                <p className="text-[11px] text-stone-500">
                  Opens New Assessment with these values. Conditions still apply for a conditional result.
                  {(outcome === 'NOT_ELIGIBLE' || outcome === 'INCOMPLETE_DOCUMENTS') && (
                    <span className="block text-amber-800">
                      This check did not pass every mandatory criterion. You can still continue; the unmet criteria stay on the record.
                    </span>
                  )}
                </p>
              )}
            </div>
          </section>

          {shown ? (
            <>
              {shownIsSaved && dirty && (
                <p className="text-[11px] text-amber-800">
                  This is the saved result. The inputs on the left have changed since.
                </p>
              )}
              <EligibilityResultsView result={shown} saved={shownIsSaved} labels={labels} />
              <ResultComparison previous={previousSnapshot} current={shown} />
            </>
          ) : (
            <div className="bg-white border border-dashed border-stone-300 rounded-xl p-6 text-xs text-stone-500 leading-relaxed">
              Run the check to see passed, failed, conditional and missing criteria. Fields left blank appear as missing,
              never as passed.
            </div>
          )}

          <EligibilityRulesPanel rules={rules} />
        </div>
      </div>

      <EligibilityRecordsList records={records} loading={recordsLoading} activeId={record?.id ?? null} onOpen={(id) => void openRecord(id)} />
    </div>
  );
}
