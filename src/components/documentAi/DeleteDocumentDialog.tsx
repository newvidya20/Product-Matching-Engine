import React, { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { DeleteDocumentMode, StoredDocument } from '../../types/documentAi';

interface Props {
  document: StoredDocument | null;
  /** New Assessment only: History cannot change form state, so it offers file_only. */
  allowClearFields: boolean;
  onCancel: () => void;
  onConfirm: (documentId: string, mode: DeleteDocumentMode) => Promise<void>;
}

export function DeleteDocumentDialog({ document: doc, allowClearFields, onCancel, onConfirm }: Props) {
  const fileAlreadyGone = Boolean(doc?.fileDeletedAt);
  const [mode, setMode] = useState<DeleteDocumentMode>('file_only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(fileAlreadyGone && allowClearFields ? 'file_and_clear_fields' : 'file_only');
    setBusy(false);
    setError(null);
  }, [doc?.documentId, fileAlreadyGone, allowClearFields]);

  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, busy, onCancel]);

  if (!doc) return null;

  const options: Array<{ value: DeleteDocumentMode; title: string; body: string; hidden?: boolean }> = [
    {
      value: 'file_only',
      title: 'Delete the file only',
      body: 'The file is removed. Values already filled in stay, and so do the extracted values and where they came from.',
      hidden: fileAlreadyGone,
    },
    {
      value: 'file_and_clear_fields',
      title: 'Delete the file and clear its fields',
      body: 'The file and its extracted values are removed, and fields it filled go back to blank. Fields you typed or accepted are not touched.',
      hidden: !allowClearFields,
    },
  ];

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(doc.documentId, mode);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the file.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-stone-900/40" onClick={() => !busy && onCancel()} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="docai-delete-title"
        className="relative z-10 w-full max-w-md bg-white border border-stone-200 rounded-xl p-5 space-y-4 shadow-xl"
      >
        <div className="space-y-0.5 min-w-0">
          <h2 id="docai-delete-title" className="text-base font-semibold text-stone-900 font-display">
            Delete document
          </h2>
          <p className="text-xs text-stone-500 break-words">{doc.originalName}</p>
        </div>
        <div role="radiogroup" className="space-y-2">
          {options
            .filter((option) => !option.hidden)
            .map((option) => (
              <label
                key={option.value}
                className={`flex gap-3 p-3 border rounded-lg cursor-pointer ${
                  mode === option.value ? 'border-orange-500 bg-orange-50/50' : 'border-stone-200 hover:bg-stone-50'
                }`}
              >
                <input
                  type="radio"
                  name="docai-delete-mode"
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="mt-0.5 text-orange-600 focus:ring-orange-500"
                />
                <span className="space-y-0.5">
                  <span className="block text-xs font-semibold text-stone-900">{option.title}</span>
                  <span className="block text-[11px] text-stone-600 leading-relaxed">{option.body}</span>
                </span>
              </label>
            ))}
        </div>
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3.5 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
