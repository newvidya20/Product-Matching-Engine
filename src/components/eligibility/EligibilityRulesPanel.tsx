import React from 'react';
import { ShieldAlert } from 'lucide-react';
import type { EligibilityRulesResponse } from '../../types/eligibility';
import { describeRule, formatDateTime } from './fieldMeta';

export function UnconfirmedRulesBanner({ rules }: { rules: EligibilityRulesResponse | null }) {
  if (!rules || rules.rules.status !== 'editable_default') return null;
  return (
    <div role="alert" className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-900">
      <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5 leading-relaxed">
        <p className="font-semibold">Unconfirmed default criteria</p>
        <p>
          These thresholds are editable defaults based on common lender practice. LoanBazaar credit has not confirmed
          them, so treat every outcome as indicative.
        </p>
      </div>
    </div>
  );
}

export function EligibilityRulesPanel({ rules }: { rules: EligibilityRulesResponse | null }) {
  if (!rules) return null;
  const { rules: config } = rules;
  const entries = Object.entries(config.criteria);
  return (
    <details className="bg-white border border-stone-200 rounded-xl p-4">
      <summary className="cursor-pointer text-sm font-semibold text-stone-900 font-display">
        Criteria used ({entries.filter(([, r]) => r.enabled).length})
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-stone-500">
          Rules version {config.rulesVersion} ({config.status === 'confirmed' ? 'confirmed' : 'unconfirmed default'}
          {config.status === 'confirmed' && config.confirmedBy
            ? ` by ${config.confirmedBy}${config.confirmedAt ? ` on ${formatDateTime(config.confirmedAt)}` : ''}`
            : ''}
          ). Loaded from the server.
        </p>
        <ul className="divide-y divide-stone-100">
          {entries.map(([id, rule]) => (
            <li key={id} className="py-2 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-stone-900">{rule.label}</span>
                <span className="text-stone-500">{rule.mandatory ? 'Mandatory' : 'Optional'}</span>
                {!rule.enabled && <span className="text-stone-500">Turned off</span>}
              </div>
              <p className="text-xs text-stone-700">{describeRule(rule)}</p>
              <p className="text-[11px] text-stone-500">{rule.rationale}</p>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
