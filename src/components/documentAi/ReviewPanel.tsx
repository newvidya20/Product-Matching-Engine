import React, { useState } from 'react';
import { DOCUMENT_AI_THRESHOLDS } from '../../types/documentAi';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, ShieldAlert, X } from 'lucide-react';
import type {
  EditedFieldEntry,
  AppliedFieldEntry,
  ExtractedField,
  FieldReasonCode,
  FieldResult,
  SessionWarning,
} from '../../types/documentAi';
import {
  REQUIRED_FIELDS,
  getFieldDefinition,
  toFormValue,
  type FieldDefinition,
} from '../../documentAi/fieldMap';
import { ConflictBadge, AiBadge, VerifyBadge, sourceLabel } from './FieldShell';
import { formatFieldValue, isFormBacked, readField, type FormState } from './formModel';

const REASON_COPY: Record<FieldReasonCode, string> = {
  low_confidence: 'The reading was not confident',
  validation_failed: 'The value did not pass checks',
  value_not_in_snippet: 'The value was not found in the quoted text',
  unexpected_source_type: 'Not the usual kind of document for this value',
  derived_value: 'Worked out from other values',
  injection_suspected: 'The document contained suspicious instructions',
  identity_mismatch: 'The document seems to belong to a different borrower',
  multiple_subjects: 'More than one account or person was found',
  values_differ: 'Documents show different values',
  non_inr_currency: 'The amount is not in rupees',
  ambiguous_unit: 'The unit (lakh, crore, thousand) is unclear',
  period_unknown: 'The financial year is not stated',
  superseded_period: 'From an older period',
  fallback_source: 'Taken from a secondary source',
  not_in_source: 'Not found in the text of the file itself',
  enum_review_required: 'This choice always needs a person to confirm it',
  enum_no_evidence: 'The quoted text does not clearly support this choice',
  loss_wording: 'The row mentions a loss, so check the sign',
  unit_mismatch: 'The unit differs from the document',
  non_inr_unit: 'The figures may not be in rupees',
  part_year_period: 'This covers part of a year, not a full year',
};

const WARNING_COPY: Record<SessionWarning['code'], string> = {
  identity_mismatch:
    'Some documents appear to belong to a different borrower. Their values are marked Please verify.',
  injection_suspected:
    'A document contained text that looks like instructions to the AI. It was ignored and its values need checking.',
  multiple_subjects: 'More than one account or person was found for some values. Nothing was added up.',
};

const SECTION_TITLES: Record<string, string> = {
  '01': '01 Company',
  '02': '02 Funding',
  '03': '03 Turnover and credit',
  '04': '04 Financials',
  '05': '05 Collateral and purpose',
};

interface ReviewPanelProps {
  form: FormState;
  fields: Record<string, FieldResult>;
  warnings: SessionWarning[];
  edited: Record<string, EditedFieldEntry>;
  applied: Record<string, AppliedFieldEntry>;
  isDismissed: (fieldId: string) => boolean;
  acceptCandidate: (
    fieldId: string,
    candidateId: string,
    origin?: 'accepted_document_value' | 'resolved_conflict'
  ) => void;
  acceptReviewOnlyFieldIds?: readonly string[];
  dismiss: (fieldId: string) => void;
  hasDocuments: boolean;
  busy: boolean;
}

function Reasons({ reasons }: { reasons: FieldReasonCode[] }) {
  const visible = reasons.filter((r) => r !== 'values_differ' && r !== 'superseded_period');
  if (visible.length === 0) return null;
  return (
    <ul className="text-[11px] text-stone-500 list-disc pl-4 space-y-0.5">
      {visible.map((reason) => (
        <li key={reason}>{REASON_COPY[reason] ?? reason}</li>
      ))}
    </ul>
  );
}

/** Confidence as a plain label plus the percentage, never colour alone. */
function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const [label, tone] =
    value >= DOCUMENT_AI_THRESHOLDS.highConfidenceFrom
      ? ['High', 'bg-emerald-50 text-emerald-800 border-emerald-200']
      : value >= DOCUMENT_AI_THRESHOLDS.mediumConfidenceFrom
        ? ['Medium', 'bg-amber-50 text-amber-800 border-amber-200']
        : ['Low', 'bg-red-50 text-red-700 border-red-200'];
  return (
    <span
      title={`Reading confidence ${pct}%`}
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold leading-none whitespace-nowrap ${tone}`}
    >
      {label} confidence · {pct}%
    </span>
  );
}

function SourceText({ field, defaultOpen = false }: { field: Pick<ExtractedField, 'source'>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!field.source.snippet) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-800 cursor-pointer"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Source text
      </button>
      {open && (
        // Rendered as plain text on purpose: document text is untrusted.
        <p className="mt-1 px-2 py-1.5 text-[11px] font-mono bg-stone-50 border border-stone-200 rounded whitespace-pre-wrap break-words text-stone-700">
          {field.source.snippet}
        </p>
      )}
    </div>
  );
}

function ItemShell({
  definition,
  badge,
  children,
}: {
  definition: FieldDefinition;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="px-3 py-2.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-semibold text-stone-800">{definition.label}</span>
        {badge}
      </div>
      {children}
    </li>
  );
}

export function ReviewPanel(props: ReviewPanelProps) {
  const {
    form,
    fields,
    warnings,
    edited,
    applied,
    isDismissed,
    acceptCandidate,
    acceptReviewOnlyFieldIds = [],
    dismiss,
    hasDocuments,
    busy,
  } = props;
  const [showApplied, setShowApplied] = useState(false);

  if (!hasDocuments) return null;

  const stillNeeded = REQUIRED_FIELDS.filter((definition) => {
    const value = readField(form, definition).trim();
    if (value === '') return true;
    const isDefault = value === (definition.defaultValue ?? '');
    return isDefault && !(definition.fieldId in edited) && !(definition.fieldId in applied);
  });

  const attention: Array<{ definition: FieldDefinition; result: FieldResult }> = [];
  const differs: Array<{ definition: FieldDefinition; result: FieldResult }> = [];
  const reviewOnly: Array<{ definition: FieldDefinition; result: FieldResult }> = [];
  const filled: Array<{ definition: FieldDefinition; result: FieldResult }> = [];

  for (const result of Object.values(fields)) {
    const definition = getFieldDefinition(result.fieldId);
    if (!definition) continue;
    if (!isFormBacked(definition)) {
      reviewOnly.push({ definition, result });
      continue;
    }
    if (definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose) continue;
    const isEdited = result.fieldId in edited;
    if (isEdited) {
      const hasValue = result.value !== null && (result.status === 'auto_applied' || result.status === 'needs_verification');
      if (hasValue && toFormValue(definition, result.value!) !== readField(form, definition)) {
        differs.push({ definition, result });
      } else if (result.status === 'conflict' && !isDismissed(result.fieldId)) {
        attention.push({ definition, result });
      }
      continue;
    }
    if (result.status === 'auto_applied') {
      if (result.fieldId in applied) filled.push({ definition, result });
    } else if (!isDismissed(result.fieldId)) {
      attention.push({ definition, result });
    }
  }

  const bySection = (a: { definition: FieldDefinition }, b: { definition: FieldDefinition }) =>
    a.definition.section.localeCompare(b.definition.section);
  attention.sort(bySection);

  return (
    <section
      aria-label="Review Extracted Data"
      className="border border-orange-200 bg-orange-50/30 rounded-xl divide-y divide-orange-100"
    >
      <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <ClipboardList className="w-4 h-4 text-orange-700" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-stone-900 font-display">Review Extracted Data</h3>
        <span className="text-xs text-stone-500">
          {filled.length} auto-filled · {attention.length + reviewOnly.filter(({ result }) => result.status !== 'auto_applied').length} to check
          {busy ? ' · reading documents…' : ''}
        </span>
      </div>

      {warnings.length > 0 && (
        <div className="px-4 sm:px-5 py-3 space-y-1.5">
          {warnings.map((warning, index) => (
            <p key={`${warning.code}-${index}`} className="flex items-start gap-2 text-xs text-red-800">
              <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{WARNING_COPY[warning.code]}</span>
            </p>
          ))}
        </div>
      )}

      {stillNeeded.length > 0 && (
        <div className="px-4 sm:px-5 py-3 space-y-1.5">
          <h4 className="text-xs font-semibold text-stone-800">Not found in the documents</h4>
          <p className="text-[11px] text-stone-500">
            {busy
              ? 'Documents are still being read, so this list may shrink.'
              : 'These were not found, so the form is incomplete until you enter them. They are never guessed.'}
          </p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {stillNeeded.map((definition) => (
              <li
                key={definition.fieldId}
                className="px-2 py-1 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded"
              >
                <span className="font-medium">{definition.label}</span>
                <span className="block text-amber-800">Not found - enter manually</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <div>
          <h4 className="px-4 sm:px-5 pt-3 text-xs font-semibold text-stone-800">Needs your attention</h4>
          <ul className="mt-2 divide-y divide-orange-100/70 bg-white/60">
            {attention.map(({ definition, result }) => {
              const writable = isFormBacked(definition);
              const wrongPurpose =
                definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose;
              if (result.status === 'conflict') {
                return (
                  <ItemShell key={result.fieldId} definition={definition} badge={<ConflictBadge />}>
                    <p className="text-[11px] text-stone-500">
                      {SECTION_TITLES[definition.section]} · documents disagree. Neither value has been
                      applied to the form. Pick one, or type your own in the form.
                    </p>
                    {wrongPurpose && (
                      <p className="text-[11px] text-amber-800">
                        This question belongs to a different funding purpose and cannot be applied to the current form.
                      </p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {result.candidates
                        .filter((c) => c.value !== null && c.status !== 'rejected_validation')
                        .map((candidate) => (
                          <div
                            key={candidate.candidateId}
                            className="rounded-lg border border-stone-200 bg-white p-2 space-y-1"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-mono tabular-nums font-semibold text-stone-900 break-all">
                                {formatFieldValue(definition, candidate.value)}
                              </span>
                              {result.suggestedCandidateId === candidate.candidateId && (
                                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-stone-100 text-stone-700">
                                  Suggested source
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-stone-500 break-words">
                              {sourceLabel({ source: candidate.source })}
                              {candidate.period ? ` · ${candidate.period}` : ''}
                            </p>
                            <ConfidenceBadge value={candidate.confidence} />
                            <SourceText field={candidate} defaultOpen />
                            {writable && !wrongPurpose && candidate.value !== null && candidate.status !== 'rejected_validation' && (
                              <button
                                type="button"
                                onClick={() => acceptCandidate(result.fieldId, candidate.candidateId, 'resolved_conflict')}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded cursor-pointer"
                              >
                                <Check className="w-3 h-3" aria-hidden="true" />
                                Use this value
                              </button>
                            )}
                          </div>
                        ))}
                    </div>
                  </ItemShell>
                );
              }

              const invalid = result.status === 'rejected_validation';
              const candidate = result.candidates[0];
              return (
                <ItemShell key={result.fieldId} definition={definition} badge={<VerifyBadge invalid={invalid} />}>
                  {invalid ? (
                    <p className="text-xs text-stone-700 break-words">
                      Read as <span className="font-mono">{candidate?.rawValue ?? '—'}</span>, which is not a valid
                      value. Please type the correct one in the form.
                    </p>
                  ) : (
                    <p className="text-xs text-stone-700 break-words">
                      <span className="font-mono tabular-nums font-semibold">
                        {formatFieldValue(definition, result.value)}
                      </span>{' '}
                      <span className="text-stone-500">from {sourceLabel(result)}</span>
                    </p>
                  )}
                  {!invalid && <ConfidenceBadge value={result.confidence} />}
                  {wrongPurpose && (
                    <p className="text-[11px] text-amber-800">
                      This question belongs to a different funding purpose and cannot be applied to the current form.
                    </p>
                  )}
                  <Reasons reasons={result.reasons} />
                  {(() => {
                    const shown =
                      result.candidates.find((c) => c.candidateId === result.suggestedCandidateId) ??
                      result.candidates[0];
                    return shown ? <SourceText field={shown} defaultOpen /> : null;
                  })()}
                  {!invalid && writable && !wrongPurpose && (() => {
                    const candidateId = result.suggestedCandidateId ?? result.candidates[0]?.candidateId;
                    return candidateId ? (
                      <button
                        type="button"
                        onClick={() => acceptCandidate(result.fieldId, candidateId, 'accepted_document_value')}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded cursor-pointer"
                      >
                        <Check className="w-3 h-3" aria-hidden="true" />
                        Accept into form
                      </button>
                    ) : null;
                  })()}
                </ItemShell>
              );
            })}
          </ul>
        </div>
      )}

      {differs.length > 0 && (
        <div>
          <h4 className="px-4 sm:px-5 pt-3 text-xs font-semibold text-stone-800">You changed these</h4>
          <p className="px-4 sm:px-5 text-[11px] text-stone-500">
            Your entries are never overwritten. A document shows something different.
          </p>
          <ul className="mt-2 divide-y divide-orange-100/70 bg-white/60">
            {differs.map(({ definition, result }) => (
              <ItemShell key={result.fieldId} definition={definition}>
                <p className="text-xs text-stone-700 break-words">
                  Document says{' '}
                  <span className="font-mono tabular-nums font-semibold">
                    {formatFieldValue(definition, result.value)}
                  </span>{' '}
                  <span className="text-stone-500">({sourceLabel(result)})</span>
                </p>
                <p className="text-[11px] text-stone-500 break-words">
                  Your entry in the form:{' '}
                  <span className="font-mono tabular-nums font-semibold text-stone-800">
                    {readField(form, definition) || '—'}
                  </span>
                </p>
                <ConfidenceBadge value={result.confidence} />
                {(() => {
                  const shown =
                    result.candidates.find((c) => c.candidateId === result.suggestedCandidateId) ??
                    result.candidates[0];
                  return shown ? <SourceText field={shown} /> : null;
                })()}
                <span className="inline-flex items-center gap-1.5 rounded bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-700 border border-stone-200">
                  Form stays editable; document value is kept as a reference
                </span>
              </ItemShell>
            ))}
          </ul>
        </div>
      )}

      {reviewOnly.length > 0 && (
        <div>
          <h4 className="px-4 sm:px-5 pt-3 text-xs font-semibold text-stone-800">For reference only</h4>
          <p className="px-4 sm:px-5 text-[11px] text-stone-500">
            Shown to help you check the file. They are never automatically applied to the assessment.
          </p>
          <ul className="mt-2 divide-y divide-orange-100/70 bg-white/60">
            {reviewOnly.map(({ definition, result }) => {
              const canAccept = acceptReviewOnlyFieldIds.includes(result.fieldId);
              const candidates = result.candidates.filter((candidate) => candidate.value !== null && candidate.status !== 'rejected_validation');
              return (
                <ItemShell
                  key={result.fieldId}
                  definition={definition}
                  badge={result.status !== 'auto_applied' ? <VerifyBadge /> : undefined}
                >
                  {result.status === 'conflict' ? (
                    <div className="space-y-2">
                      <p className="text-[11px] text-stone-500">Documents disagree. Pick the stated value to use for eligibility.</p>
                      {candidates.map((candidate) => (
                        <div key={candidate.candidateId} className="rounded-lg border border-stone-200 bg-white p-2 space-y-1">
                          <p className="text-xs text-stone-700">
                            <span className="font-mono">{String(candidate.value)}</span>{' '}
                            <span className="text-stone-500">from {sourceLabel({ source: candidate.source })}</span>
                          </p>
                          <ConfidenceBadge value={candidate.confidence} />
                          <SourceText field={candidate} defaultOpen />
                          {canAccept && (
                            <button
                              type="button"
                              onClick={() => acceptCandidate(result.fieldId, candidate.candidateId, 'resolved_conflict')}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded cursor-pointer"
                            >
                              <Check className="w-3 h-3" aria-hidden="true" />
                              Use for eligibility
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-stone-700 break-words">
                        <span className="font-mono">{result.value === null ? '—' : String(result.value)}</span>{' '}
                        <span className="text-stone-500">from {sourceLabel(result)}</span>
                      </p>
                      {result.status !== 'auto_applied' && <ConfidenceBadge value={result.confidence} />}
                      {(() => {
                        const shown =
                          result.candidates.find((candidate) => candidate.candidateId === result.suggestedCandidateId) ??
                          candidates[0];
                        return shown ? <SourceText field={shown} defaultOpen /> : null;
                      })()}
                      {canAccept && candidates[0] && (
                        <button
                          type="button"
                          onClick={() => acceptCandidate(result.fieldId, candidates[0].candidateId)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded cursor-pointer"
                        >
                          <Check className="w-3 h-3" aria-hidden="true" />
                          Use for eligibility
                        </button>
                      )}
                    </>
                  )}
                </ItemShell>
              );
            })}
          </ul>
        </div>
      )}

      {filled.length > 0 && (
        <div className="px-4 sm:px-5 py-3">
          <button
            type="button"
            onClick={() => setShowApplied((v) => !v)}
            aria-expanded={showApplied}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-800 cursor-pointer"
          >
            {showApplied ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Auto-filled ({filled.length})
          </button>
          {showApplied && (
            <ul className="mt-2 space-y-1.5">
              {filled.sort(bySection).map(({ definition, result }) => (
                <li key={result.fieldId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <AiBadge />
                  <span className="font-medium text-stone-800">{definition.label}</span>
                  <span className="font-mono tabular-nums text-stone-700 break-all">
                    {formatFieldValue(definition, result.value)}
                  </span>
                  <span className="text-[11px] text-stone-500 break-words">{sourceLabel(result)}</span>
                  <ConfidenceBadge value={result.confidence} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {attention.length === 0 && differs.length === 0 && stillNeeded.length === 0 && !busy && (
        <p className="px-4 sm:px-5 py-3 text-xs text-stone-600 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-stone-400" aria-hidden="true" />
          Nothing else to check. Please still read the auto-filled values before you submit.
        </p>
      )}
    </section>
  );
}
