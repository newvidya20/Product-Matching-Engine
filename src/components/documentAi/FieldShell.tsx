import React, { createContext, useContext } from 'react';
import { AlertTriangle, Check, GitCompare, Sparkles, X } from 'lucide-react';
import type { AppliedFieldEntry, EditedFieldEntry, FieldResult } from '../../types/documentAi';
import { getFieldDefinition } from '../../documentAi/fieldMap';
import { formatFieldValue } from './formModel';

export interface DocAiFieldContextValue {
  results: Record<string, FieldResult>;
  edited: Record<string, EditedFieldEntry>;
  applied: Record<string, AppliedFieldEntry>;
  isDismissed: (fieldId: string) => boolean;
  /** Writes the candidate's value and records the field as the person's own. One click. */
  acceptCandidate: (fieldId: string, candidateId: string, origin?: 'accepted_document_value' | 'resolved_conflict') => void;
  dismiss: (fieldId: string) => void;
}

const EMPTY: DocAiFieldContextValue = {
  results: {},
  edited: {},
  applied: {},
  isDismissed: () => false,
  acceptCandidate: () => undefined,
  dismiss: () => undefined,
};

export const DocAiFieldContext = createContext<DocAiFieldContextValue>(EMPTY);
export const useDocAiFields = () => useContext(DocAiFieldContext);

export function sourceLabel(result: Pick<FieldResult, 'source'>): string {
  const source = result.source;
  if (!source) return 'document';
  const where = source.page
    ? `p. ${source.page}`
    : source.sheetName
      ? `${source.sheetName}${source.cellRef ? ` ${source.cellRef}` : ''}`
      : source.cellRef ?? '';
  return where ? `${source.fileName}, ${where}` : source.fileName;
}

const badgeBase =
  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none whitespace-nowrap';

export function AiBadge({ title }: { title?: string }) {
  return (
    <span title={title} className={`${badgeBase} bg-orange-50 text-orange-700 border border-orange-200`}>
      <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
      AI
    </span>
  );
}

export function VerifyBadge({ invalid }: { invalid?: boolean }) {
  return (
    <span className={`${badgeBase} bg-amber-50 text-amber-800 border border-amber-300`}>
      <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
      {invalid ? 'Please verify (invalid value)' : 'Please verify'}
    </span>
  );
}

export function ConflictBadge() {
  return (
    <span className={`${badgeBase} bg-red-50 text-red-700 border border-red-200`}>
      <GitCompare className="w-2.5 h-2.5" aria-hidden="true" />
      Conflict
    </span>
  );
}

/**
 * Wraps one form input: label row, AI / verify / conflict badge, and an inline suggestion
 * for `needs_verification` with one-click Accept and Dismiss.
 */
export function FieldShell({
  fieldId,
  label,
  required,
  className = '',
  children,
}: {
  fieldId: string;
  label: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useDocAiFields();
  const result = ctx.results[fieldId];
  const isEdited = fieldId in ctx.edited;
  const isApplied = fieldId in ctx.applied && !isEdited;
  const definition = getFieldDefinition(fieldId);

  let badge: React.ReactNode = null;
  let note: React.ReactNode = null;

  if (isApplied && result?.status === 'auto_applied') {
    badge = <AiBadge title={`Auto-filled from ${sourceLabel(result)}. Edit to override.`} />;
  } else if (result && !isEdited && !ctx.isDismissed(fieldId)) {
    if (result.status === 'needs_verification' && result.value !== null && definition) {
      const candidateId = result.suggestedCandidateId ?? result.candidates[0]?.candidateId;
      badge = <VerifyBadge />;
      note = (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-amber-50/70 border border-amber-200 px-2 py-1.5 text-[11px] text-amber-900">
          <span className="min-w-0 break-words">
            Suggested <strong className="font-semibold">{formatFieldValue(definition, result.value)}</strong>{' '}
            <span className="text-amber-800/80">from {sourceLabel(result)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 ml-auto">
            {candidateId && (
              <button
                type="button"
                onClick={() => ctx.acceptCandidate(fieldId, candidateId)}
                className="inline-flex items-center gap-1 px-2 py-1 font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded cursor-pointer"
              >
                <Check className="w-3 h-3" aria-hidden="true" />
                Use
              </button>
            )}
            <button
              type="button"
              onClick={() => ctx.dismiss(fieldId)}
              aria-label="Dismiss suggestion"
              className="p-1 text-amber-800 hover:bg-amber-100 rounded cursor-pointer"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        </div>
      );
    } else if (result.status === 'conflict') {
      badge = <ConflictBadge />;
      note = (
        <p className="text-[11px] text-red-700">
          Documents disagree. Choose a value in Review Extracted Data, or type your own.
        </p>
      );
    } else if (result.status === 'rejected_validation') {
      badge = <VerifyBadge invalid />;
      note = (
        <p className="text-[11px] text-amber-800">
          A document showed a value that did not pass checks. Please type the correct value.
        </p>
      );
    }
  }

  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="block text-xs font-medium text-stone-700">
          {label} {required && <span className="text-orange-600">*</span>}
        </label>
        {badge}
      </div>
      {children}
      {note}
    </div>
  );
}
