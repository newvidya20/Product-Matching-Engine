import React, { useEffect, useState } from 'react';
import { Moon, Save, SunMedium } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import { PageHeader } from '../components/ui/Primitives';
import type { SystemSettings } from '../types/domain';

export function SettingsModule() {
  const { state, saveSettings } = useAppState();
  const [form, setForm] = useState<SystemSettings>(state.settings);

  useEffect(() => {
    setForm(state.settings);
    document.documentElement.setAttribute('data-theme', state.settings.themeMode || 'light');
  }, [state.settings]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', form.themeMode || 'light');
    document.documentElement.style.colorScheme = form.themeMode === 'dark' ? 'dark' : 'light';
  }, [form.themeMode]);

  const update = <K extends keyof SystemSettings>(
    key: K,
    value: SystemSettings[K]
  ) => setForm((current) => ({ ...current, [key]: value }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await saveSettings(form);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace Settings"
        description="Configure the operating preferences for this LoanBazaar workspace and keep the product portfolio aligned with your internal policy view."
        metadataItems={[
          `${state.categories.length} categories`,
          `${state.documents.length} product references`,
        ]}
      />

      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="max-w-3xl bg-white border border-stone-200 rounded-xl p-5 space-y-5"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-stone-700">
              Organization name
            </span>
            <input
              value={form.organizationName}
              onChange={(event) => update('organizationName', event.target.value)}
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-stone-700">
              Internal unit name
            </span>
            <input
              value={form.internalUnitName}
              onChange={(event) => update('internalUnitName', event.target.value)}
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-stone-700">
              Default currency
            </span>
            <input
              value={form.defaultCurrency}
              onChange={(event) =>
                update('defaultCurrency', event.target.value.toUpperCase())
              }
              maxLength={3}
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </label>
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-medium text-stone-700">
            Interface theme
          </span>
          <div className="inline-flex rounded-lg border border-stone-200 bg-stone-100 p-1">
            {(['light', 'dark'] as const).map((mode) => {
              const isActive = form.themeMode === mode;
              const Icon = mode === 'light' ? SunMedium : Moon;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => update('themeMode', mode)}
                  className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-white text-stone-900 shadow-sm'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {mode === 'light' ? 'Light' : 'Dark'}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-xs leading-relaxed text-amber-900">
          Matching compares borrower inputs against the approved product catalogue and
          highlights fit, but it does not replace a formal credit or policy review.
        </div>

        <button
          type="submit"
          disabled={state.isMutating}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {state.isMutating ? 'Saving...' : 'Save Local Settings'}
        </button>
      </form>
    </div>
  );
}
