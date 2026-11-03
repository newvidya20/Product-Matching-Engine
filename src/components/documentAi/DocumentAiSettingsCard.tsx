import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Save } from 'lucide-react';
import { DocumentAiError, documentAiClient, promptForAccessCode } from '../../api/documentAiClient';
import {
  DOCUMENT_AI_RETENTION_RANGE,
  DOCUMENT_AI_THRESHOLDS,
  type AuthStatusResponse,
  type DocumentAiSettingsResponse,
} from '../../types/documentAi';
import { DocumentAccessGate } from './DocumentAccessGate';

const DATA_NOTE =
  "Uploaded documents are sent to the external AI service configured on this server (OpenRouter or Google Gemini) for processing and may contain personal and financial data, including PAN and bank details. Upload only documents you are authorised to process.";

interface Props {
  user?: { email?: string; displayName?: string } | null;
}

export function DocumentAiSettingsCard({ user }: Props) {
  const [data, setData] = useState<DocumentAiSettingsResponse | null>(null);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState('0.85');
  const [retention, setRetention] = useState('30');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [settings, status] = await Promise.all([
        documentAiClient.getSettings(),
        documentAiClient.getAuthStatus(),
      ]);
      setData(settings);
      setAuth(status);
      setLocked(false);
      setEnabled(settings.settings.enabled);
      setThreshold(String(settings.settings.autoApplyThreshold));
      setRetention(String(settings.settings.retentionDays));
    } catch (err) {
      if (err instanceof DocumentAiError && err.code === 'unauthenticated') setLocked(true);
      else setError(err instanceof Error ? err.message : 'Could not load Document AI settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = auth?.actor?.role === 'admin';
  const thresholdValue = Number(threshold);
  const retentionValue = Number(retention);
  const thresholdValid =
    Number.isFinite(thresholdValue) &&
    thresholdValue >= DOCUMENT_AI_THRESHOLDS.minAutoApply &&
    thresholdValue <= DOCUMENT_AI_THRESHOLDS.maxAutoApply;
  const retentionValid =
    Number.isInteger(retentionValue) &&
    retentionValue >= DOCUMENT_AI_RETENTION_RANGE.min &&
    retentionValue <= DOCUMENT_AI_RETENTION_RANGE.max;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!thresholdValid || !retentionValid) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await documentAiClient.updateSettings({
        enabled,
        autoApplyThreshold: Math.round(thresholdValue * 100) / 100,
        retentionDays: retentionValue,
      });
      setData(next);
      setSuccess('Document AI settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Document AI settings.');
    } finally {
      setSaving(false);
    }
  };

  const unlock = async () => {
    if (await promptForAccessCode()) await load();
  };

  const readOnly = !isAdmin || saving;
  const inputCls =
    'w-full px-3 py-2 text-sm border border-stone-300 rounded-lg disabled:bg-stone-50 disabled:text-stone-500';

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="max-w-3xl bg-white border border-stone-200 rounded-xl p-5 space-y-5"
    >
      <DocumentAccessGate user={user} />
      <div>
        <h2 className="text-base font-semibold text-stone-900 font-display">Document AI</h2>
        <p className="text-xs text-stone-500 mt-0.5">
          Reads uploaded borrower documents and fills the New Assessment form. Values are never guessed, and anything
          unclear is left for a person to check.
        </p>
      </div>

      {locked && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-stone-50 border border-stone-200 p-4 text-xs text-stone-700">
          <KeyRound className="w-4 h-4 text-stone-500" aria-hidden="true" />
          <span>Enter the access code to view or change Document AI settings.</span>
          <button
            type="button"
            onClick={() => void unlock()}
            className="px-3 py-1.5 font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer"
          >
            Enter access code
          </button>
        </div>
      )}

      {!locked && !data && !error && (
        <p className="inline-flex items-center gap-2 text-xs text-stone-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}

      {error && (
        <div role="alert" className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800">
          {error}
        </div>
      )}

      {data && (
        <>
          {!data.llmConfigured && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                No AI provider key (OPENROUTER_API_KEY or GEMINI_API_KEY) is configured on the server. Files can be uploaded but will not be read until an admin
                sets it.
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-stone-700 select-none">
              <input
                type="checkbox"
                checked={data.disabledByEnv ? false : enabled}
                disabled={readOnly || data.disabledByEnv}
                onChange={(e) => setEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-stone-300 text-orange-600 focus:ring-orange-500 disabled:opacity-50"
              />
              Turn on Document AI
            </label>
            {data.disabledByEnv && (
              <p className="text-[11px] text-stone-500">
                Turned off by the server setting DOCUMENT_AI_ENABLED=false, which overrides this toggle.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1.5">
              <span className="block text-xs font-medium text-stone-700">Auto-fill confidence</span>
              <input
                type="number"
                inputMode="decimal"
                min={DOCUMENT_AI_THRESHOLDS.minAutoApply}
                max={DOCUMENT_AI_THRESHOLDS.maxAutoApply}
                step="0.01"
                value={threshold}
                disabled={readOnly}
                onChange={(e) => setThreshold(e.target.value)}
                className={inputCls}
              />
              <span className="block text-[11px] text-stone-500">
                From {DOCUMENT_AI_THRESHOLDS.minAutoApply.toFixed(2)} to {DOCUMENT_AI_THRESHOLDS.maxAutoApply.toFixed(2)}.
                Values below this are shown as suggestions, not filled in.
              </span>
              {!thresholdValid && !readOnly && (
                <span className="block text-[11px] text-red-700">Enter a value within that range.</span>
              )}
            </label>
            <label className="space-y-1.5">
              <span className="block text-xs font-medium text-stone-700">Keep uploaded files for (days)</span>
              <input
                type="number"
                inputMode="numeric"
                min={DOCUMENT_AI_RETENTION_RANGE.min}
                max={DOCUMENT_AI_RETENTION_RANGE.max}
                step="1"
                value={retention}
                disabled={readOnly}
                onChange={(e) => setRetention(e.target.value)}
                className={inputCls}
              />
              <span className="block text-[11px] text-stone-500">
                {DOCUMENT_AI_RETENTION_RANGE.min} to {DOCUMENT_AI_RETENTION_RANGE.max} days. Saved assessment values are
                not affected.
              </span>
              {!retentionValid && !readOnly && (
                <span className="block text-[11px] text-red-700">Enter a whole number of days within that range.</span>
              )}
            </label>
          </div>

          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-xs leading-relaxed text-amber-900">
            {DATA_NOTE}
          </div>

          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={saving || !thresholdValid || !retentionValid}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg disabled:opacity-50 cursor-pointer"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Save className="w-3.5 h-3.5" aria-hidden="true" />}
                {saving ? 'Saving...' : 'Save Document AI Settings'}
              </button>
              {success && <span className="text-xs text-emerald-700">{success}</span>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
              <span>Only an admin can change these settings.</span>
              <button
                type="button"
                onClick={() => void unlock()}
                className="px-3 py-1.5 font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
              >
                Unlock as admin
              </button>
            </div>
          )}
        </>
      )}
    </form>
  );
}
