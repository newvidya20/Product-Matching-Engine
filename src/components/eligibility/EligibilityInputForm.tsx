import React from 'react';
import type { EligibilityInputField, EligibilityInputSources, PendingVerificationInput } from '../../types/eligibility';
import { FIELD_GROUPS, fieldLabel, sourceLabel, type FormValues } from './fieldMeta';

import type { CandidateOption } from './candidateOptions';

const INPUT =
  'w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600 disabled:bg-stone-100 disabled:text-stone-500';

interface Props {
  values: FormValues;
  sources: EligibilityInputSources;
  /** Client parse errors plus server `invalid_input` fields. */
  errors: Partial<Record<EligibilityInputField, string>>;
  pending: PendingVerificationInput[];
  disabled: boolean;
  /** Document values waiting for a person's OK, by field (shown as text, never filled in unasked). */
  proposals?: Partial<Record<EligibilityInputField, string>>;
  onConfirm?: (field: EligibilityInputField) => void;
  onChange: (field: EligibilityInputField, value: string) => void;
  /** Every document value found per field; a dropdown lists them when there are several. */
  candidateOptions?: Partial<Record<EligibilityInputField, CandidateOption[]>>;
  onPickOption?: (field: EligibilityInputField, option: CandidateOption) => void;
}

export function EligibilityInputForm({
  values,
  sources,
  errors,
  pending,
  disabled,
  proposals = {},
  onConfirm,
  onChange,
  candidateOptions = {},
  onPickOption,
}: Props) {
  const pendingByField = new Map(pending.map((p) => [p.field, p]));
  return (
    <div className="space-y-5">
      {FIELD_GROUPS.map((group) => (
        <section key={group.title} className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-stone-900 font-display">{group.title}</h3>
            <p className="text-xs text-stone-500">{group.description}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {group.fields.map((meta) => {
              const id = `elig-${meta.field}`;
              const value = values[meta.field] ?? '';
              const source = sources[meta.field];
              const held = pendingByField.get(meta.field);
              const error = errors[meta.field];
              return (
                <div key={meta.field} className="space-y-1.5">
                  <label htmlFor={id} className="block text-xs font-medium text-stone-700">
                    {meta.label}
                  </label>
                  {meta.kind === 'enum' ? (
                    <select
                      id={id}
                      value={value}
                      disabled={disabled}
                      onChange={(e) => onChange(meta.field, e.target.value)}
                      className={INPUT}
                    >
                      <option value="">Not provided</option>
                      {meta.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={id}
                      type="text"
                      inputMode="decimal"
                      value={value}
                      disabled={disabled}
                      placeholder="Not provided"
                      onChange={(e) => onChange(meta.field, e.target.value)}
                      aria-invalid={error ? true : undefined}
                      className={`${INPUT} font-mono tabular-nums`}
                    />
                  )}
                  {error && (
                    <p role="alert" className="text-xs text-red-700">
                      {error}
                    </p>
                  )}
                  {meta.hint && !error && <p className="text-[11px] text-stone-500">{meta.hint}</p>}
                  {value !== '' && source && (
                    <p className="text-[11px] text-stone-500">Source: {sourceLabel(source)}</p>
                  )}
                  {(() => {
                    const opts = candidateOptions[meta.field];
                    if (!opts || opts.length === 0) return null;
                    if (opts.length === 1 || !onPickOption) {
                      return (
                        <p className="text-[11px] text-stone-500 break-words">
                          1 value found in documents: {opts[0].label}
                        </p>
                      );
                    }
                    const selected = opts.find((o) => o.isCurrent)?.candidateId ?? '';
                    return (
                      <div className="space-y-1">
                        <label htmlFor={`${id}-options`} className="block text-[11px] font-medium text-stone-600">
                          {opts.length} values found in documents
                        </label>
                        <select
                          id={`${id}-options`}
                          value={selected}
                          disabled={disabled}
                          onChange={(e) => {
                            const picked = opts.find((o) => o.candidateId === e.target.value);
                            if (picked) onPickOption(meta.field, picked);
                          }}
                          className="w-full px-2.5 py-1.5 text-xs bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600 disabled:bg-stone-100 disabled:text-stone-500"
                        >
                          <option value="" disabled>
                            Pick one of the {opts.length} values…
                          </option>
                          {opts.map((o) => (
                            <option key={o.candidateId} value={o.candidateId}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })()}
                  {value === '' && held && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 space-y-1.5">
                      {proposals[meta.field] !== undefined ? (
                        <>
                          <p className="text-[11px] text-amber-900">
                            Read from your documents: <span className="font-mono font-semibold">{proposals[meta.field]}</span>{' '}
                            ({held.status.replace(/_/g, ' ')}). Check it, then confirm to fill it in.
                          </p>
                          {onConfirm && !disabled && (
                            <button
                              type="button"
                              onClick={() => onConfirm(meta.field)}
                              className="inline-flex items-center rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                            >
                              Confirm &amp; fill
                            </button>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-amber-900">
                          The documents disagree on this value ({held.status.replace(/_/g, ' ')}). Pick one in “Review
                          Extracted Data”, or type it.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function PendingSummary({ pending }: { pending: PendingVerificationInput[] }) {
  if (pending.length === 0) return null;
  return (
    <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 leading-relaxed">
      {pending.length} value{pending.length === 1 ? '' : 's'} from documents {pending.length === 1 ? 'is' : 'are'}{' '}
      waiting for your confirmation below and {pending.length === 1 ? 'was' : 'were'} left blank:{' '}
      {pending.map((p) => fieldLabel(p.field)).join(', ')}.
    </div>
  );
}
