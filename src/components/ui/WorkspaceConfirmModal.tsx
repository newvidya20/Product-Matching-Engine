import React, { useEffect } from 'react';
import { FileSpreadsheet, X } from 'lucide-react';

export interface WorkspaceConfirmRequest {
  title: string;
  description: string;
  affectedTarget: string;
  confirmLabel?: string;
  isDestructive?: boolean;
}

export function WorkspaceConfirmModal({
  request,
  onConfirm,
  onCancel,
}: {
  request: WorkspaceConfirmRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onCancel]);

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-stone-900/35"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-confirm-title"
        className="relative z-10 w-full max-w-md bg-white border border-stone-200 rounded-xl overflow-hidden shadow-lg"
      >
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="w-4 h-4 text-orange-600 shrink-0" />
            <h3
              id="workspace-confirm-title"
              className="text-sm font-semibold text-stone-900 font-display"
            >
              {request.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel operation"
            className="p-1 text-stone-400 hover:text-stone-900 rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-xs text-stone-600 leading-relaxed">
          <p>{request.description}</p>
          <div className="p-3 bg-stone-50 border border-stone-200 rounded-lg">
            <div className="text-[11px] text-stone-500">Target Google Workspace Item</div>
            <div className="font-mono text-stone-900 font-medium mt-0.5 break-all">
              {request.affectedTarget}
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 bg-stone-50/80 border-t border-stone-200 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-xs font-semibold text-white rounded-lg cursor-pointer ${
              request.isDestructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-orange-600 hover:bg-orange-700'
            }`}
          >
            {request.confirmLabel || 'Confirm & Update'}
          </button>
        </div>
      </div>
    </div>
  );
}
