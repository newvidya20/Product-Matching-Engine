import React from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from 'lucide-react';
import type {
  CriterionResult,
  CriterionStatus,
  EligibilityResult,
  EligibilityResultSnapshot,
  EligibilityInputField,
} from '../../types/eligibility';
import { OUTCOME_STYLE, fieldLabel, fieldSupplier, formatDateTime } from './fieldMeta';

const SECTIONS: {
  status: CriterionStatus;
  title: string;
  empty: string;
  box: string;
  icon: React.ReactNode;
}[] = [
  {
    status: 'failed',
    title: 'Failed',
    empty: 'No criterion failed.',
    box: 'border-red-200 bg-red-50/40',
    icon: <XCircle className="w-4 h-4 text-red-700" aria-hidden="true" />,
  },
  {
    status: 'conditional',
    title: 'Conditional',
    empty: 'No criterion is conditional.',
    box: 'border-amber-200 bg-amber-50/40',
    icon: <AlertTriangle className="w-4 h-4 text-amber-700" aria-hidden="true" />,
  },
  {
    status: 'missing',
    title: 'Missing (not checked)',
    empty: 'No criterion is missing data.',
    box: 'border-stone-300 bg-stone-100/60',
    icon: <CircleHelp className="w-4 h-4 text-stone-600" aria-hidden="true" />,
  },
  {
    status: 'passed',
    title: 'Passed',
    empty: 'No criterion passed.',
    box: 'border-emerald-200 bg-emerald-50/40',
    icon: <CheckCircle2 className="w-4 h-4 text-emerald-700" aria-hidden="true" />,
  },
];

const SEVERITY_LABEL: Record<CriterionResult['severity'], string | null> = {
  blocker: 'Blocker',
  action_required: 'Action required',
  condition: 'Condition',
  none: null,
};

function CriterionRow({ row }: { row: CriterionResult }) {
  const severity = SEVERITY_LABEL[row.severity];
  const missing = row.status === 'missing';
  return (
    <li className="bg-white border border-stone-200 rounded-lg p-3.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-stone-900">{row.label}</span>
        <span
          className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border ${
            row.mandatory ? 'bg-stone-800 text-white border-stone-800' : 'bg-white text-stone-600 border-stone-300'
          }`}
        >
          {row.mandatory ? 'Mandatory' : 'Optional'}
        </span>
        {severity && (
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border bg-orange-50 text-orange-800 border-orange-200">
            {severity}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt className="text-stone-500">Actual</dt>
          <dd className="font-mono tabular-nums text-stone-900">{missing ? 'Not provided' : row.actualDisplay}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-stone-500">Required</dt>
          <dd className="text-stone-900">{row.expected}</dd>
        </div>
      </dl>
      <p className="text-xs text-stone-700 leading-relaxed">{row.reason}</p>
      {missing && row.missingInputs.length > 0 && (
        <ul className="text-xs text-stone-700 list-disc pl-4 space-y-0.5">
          {row.missingInputs.map((field) => (
            <li key={field}>
              <span className="font-medium">{fieldLabel(field)}</span>
              <span className="text-stone-500"> from {fieldSupplier(field)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function InputList({ title, fields, tone }: { title: string; fields: EligibilityInputField[]; tone: string }) {
  if (fields.length === 0) return null;
  return (
    <div className={`rounded-lg border p-3.5 space-y-2 ${tone}`}>
      <h4 className="text-xs font-semibold text-stone-900">{title}</h4>
      <ul className="text-xs text-stone-800 space-y-1">
        {fields.map((field) => (
          <li key={field}>
            <span className="font-medium">{fieldLabel(field)}</span>
            <span className="text-stone-600"> - supplied by {fieldSupplier(field)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Previous result vs this one. Snapshots hold the outcome and counts only. */
export function ResultComparison({
  previous,
  current,
}: {
  previous: EligibilityResultSnapshot | null;
  current: EligibilityResult;
}) {
  if (!previous) return null;
  const prevStyle = OUTCOME_STYLE[previous.outcome];
  const curStyle = OUTCOME_STYLE[current.outcome];
  const changed = previous.outcome !== current.outcome;
  const rulesChanged = previous.rulesVersion !== current.rulesVersion || previous.rulesHash !== current.rulesHash;
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-4 space-y-2.5">
      <h3 className="text-sm font-semibold text-stone-900 font-display">Compared with the previous result</h3>
      <p className="text-xs text-stone-700">
        {changed ? (
          <>
            Outcome changed from <strong>{prevStyle.label}</strong> to <strong>{curStyle.label}</strong>.
          </>
        ) : (
          <>
            Outcome unchanged: <strong>{curStyle.label}</strong>.
          </>
        )}{' '}
        {rulesChanged ? 'The rules changed between the two runs.' : 'The rules are the same.'}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-stone-500">
            <th className="py-1 font-medium"> </th>
            {SECTIONS.map((s) => (
              <th key={s.status} className="py-1 font-medium">
                {s.title.replace(' (not checked)', '')}
              </th>
            ))}
            <th className="py-1 font-medium">Rules</th>
            <th className="py-1 font-medium">Run</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums text-stone-900">
          <tr>
            <td className="py-1 font-sans text-stone-500">Previous</td>
            {SECTIONS.map((s) => (
              <td key={s.status}>{previous.counts[s.status]}</td>
            ))}
            <td>{previous.rulesVersion}</td>
            <td className="font-sans">{formatDateTime(previous.evaluatedAt)}</td>
          </tr>
          <tr>
            <td className="py-1 font-sans text-stone-500">Now</td>
            {SECTIONS.map((s) => (
              <td key={s.status}>{current.counts[s.status]}</td>
            ))}
            <td>{current.rulesVersion}</td>
            <td className="font-sans">{formatDateTime(current.evaluatedAt)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function EligibilityResultsView({
  result,
  saved,
  labels,
}: {
  result: EligibilityResult;
  saved: boolean;
  /** criterionId to label, from the rules response, for skipped criteria. */
  labels?: Partial<Record<string, string>>;
}) {
  const style = OUTCOME_STYLE[result.outcome];
  const grouped = (status: CriterionStatus) => result.criteria.filter((c) => c.status === status);
  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-4 space-y-2 ${style.box}`} role="status">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${style.badge}`}>{style.label}</span>
          <span className="text-[11px] opacity-80">
            {saved ? 'Saved result' : 'Preview, not saved'} · rules {result.rulesVersion} ·{' '}
            {formatDateTime(result.evaluatedAt)}
          </span>
        </div>
        <p className="text-sm font-medium leading-relaxed">{result.outcomeReason}</p>
        <p className="text-xs opacity-80">{style.summary}</p>
        <div className="flex flex-wrap gap-3 text-xs pt-1">
          {SECTIONS.map((s) => (
            <span key={s.status} className="font-medium">
              {s.title.replace(' (not checked)', '')}: {result.counts[s.status]}
            </span>
          ))}
        </div>
      </div>

      {(result.missingMandatoryInputs.length > 0 || result.missingOptionalInputs.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <InputList
            title="Missing mandatory inputs"
            fields={result.missingMandatoryInputs}
            tone="border-stone-400 bg-stone-100"
          />
          <InputList
            title="Missing optional inputs (outcome cannot be Eligible until checked)"
            fields={result.missingOptionalInputs}
            tone="border-stone-300 bg-stone-50"
          />
        </div>
      )}

      {SECTIONS.map((section) => {
        const rows = grouped(section.status);
        return (
          <section key={section.status} className={`rounded-xl border p-4 space-y-3 ${section.box}`}>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900 font-display">
              {section.icon}
              {section.title} ({rows.length})
            </h3>
            {rows.length === 0 ? (
              <p className="text-xs text-stone-500">{section.empty}</p>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => (
                  <CriterionRow key={row.criterionId} row={row} />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {result.skipped.length > 0 && (
        <details className="bg-white border border-stone-200 rounded-xl p-4 text-xs text-stone-700">
          <summary className="cursor-pointer font-medium text-stone-900">
            Not applicable to this borrower ({result.skipped.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {result.skipped.map((s) => {
              const label = labels?.[s.criterionId] ?? s.criterionId.replace(/_/g, ' ');
              const why =
                s.reason === 'disabled'
                  ? 'turned off in the rules'
                  : s.reason === 'entity_type_not_applicable'
                    ? 'does not apply to this entity type'
                    : 'skipped because of a related answer';
              return (
                <li key={s.criterionId}>
                  {label}: {why}. Skipped criteria do not affect the outcome.
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <p className="text-[11px] text-stone-500">
        Decided by fixed rules, not AI. Rules version {result.rulesVersion} (hash {result.rulesHash.slice(0, 10)}).
      </p>
    </div>
  );
}
