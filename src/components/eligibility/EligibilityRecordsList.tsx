import React from 'react';
import { Loader2 } from 'lucide-react';
import type { EligibilityRecordSummary } from '../../types/eligibility';
import { OUTCOME_STYLE, formatDateTime } from './fieldMeta';

export function EligibilityRecordsList({
  records,
  loading,
  activeId,
  onOpen,
}: {
  records: EligibilityRecordSummary[] | null;
  loading: boolean;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900 font-display">
        Saved eligibility checks
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-500" aria-hidden="true" />}
      </h3>
      {records && records.length === 0 && <p className="text-xs text-stone-500">No saved checks yet.</p>}
      {records && records.length > 0 && (
        <ul className="divide-y divide-stone-100">
          {records.map((r) => {
            const style = OUTCOME_STYLE[r.outcome];
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  className={`w-full text-left py-2.5 px-2 -mx-2 rounded-lg flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer hover:bg-stone-50 ${
                    r.id === activeId ? 'bg-orange-50' : ''
                  }`}
                >
                  <span className="text-xs font-mono text-stone-500">{r.referenceCode}</span>
                  <span className="text-sm font-medium text-stone-900">{r.applicantLabel}</span>
                  <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${style.badge}`}>
                    {style.label}
                  </span>
                  <span className="text-[11px] text-stone-500 uppercase tracking-wide">{r.status}</span>
                  <span className="text-[11px] text-stone-500 ml-auto">
                    {r.counts.passed} passed · {r.counts.failed} failed · {r.counts.conditional} conditional ·{' '}
                    {r.counts.missing} missing · rules {r.rulesVersion} · {formatDateTime(r.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
