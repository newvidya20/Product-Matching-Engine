import React, { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { SlideOverDrawer } from '../ui/Primitives';
import { documentAiClient, sessionDocumentFileUrl } from '../../api/documentAiClient';
import type { SpreadsheetPreview, StoredDocument } from '../../types/documentAi';

interface Props {
  sessionId: string;
  document: StoredDocument | null;
  onClose: () => void;
}

function SpreadsheetView({ sessionId, documentId }: { sessionId: string; documentId: string }) {
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    setActive(0);
    documentAiClient
      .getPreview(sessionId, documentId)
      .then((data) => !cancelled && setPreview(data))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Preview failed.'));
    return () => {
      cancelled = true;
    };
  }, [sessionId, documentId]);

  if (error) return <p className="text-xs text-red-700">{error}</p>;
  if (!preview) {
    return (
      <p className="inline-flex items-center gap-2 text-xs text-stone-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading preview…
      </p>
    );
  }
  const sheet = preview.sheets[active];
  return (
    <div className="space-y-3">
      {preview.sheets.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {preview.sheets.map((s, index) => (
            <button
              key={`${s.name}-${index}`}
              type="button"
              onClick={() => setActive(index)}
              className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer ${
                index === active
                  ? 'bg-stone-900 text-white border-stone-900'
                  : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet && (
        <div className="overflow-x-auto border border-stone-200 rounded-lg">
          <table className="min-w-full text-[11px]">
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r} className="border-b border-stone-100 last:border-0">
                  {row.map((cell, c) => (
                    // Cells are plain text; a leading "=" does nothing here.
                    <td key={c} className="px-2 py-1 font-mono text-stone-800 whitespace-pre align-top max-w-[16rem] truncate">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sheet?.truncated && (
        <p className="text-[11px] text-stone-500">Only the first rows and columns are shown. Download for the full file.</p>
      )}
    </div>
  );
}

export function DocumentPreviewDrawer({ sessionId, document: doc, onClose }: Props) {
  const open = Boolean(doc);
  const inline = doc?.kind === 'pdf' || doc?.kind === 'png' || doc?.kind === 'jpeg' || doc?.kind === 'webp';
  const gone = Boolean(doc?.fileDeletedAt);

  return (
    <SlideOverDrawer
      open={open}
      title={doc?.originalName ?? 'Document'}
      subtitle={doc ? `${doc.kind.toUpperCase()} · ${(doc.sizeBytes / 1024).toFixed(0)} KB` : undefined}
      onClose={onClose}
      footer={
        doc && !gone ? (
          <a
            href={sessionDocumentFileUrl(sessionId, doc.documentId, 'attachment')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" /> Download
          </a>
        ) : undefined
      }
    >
      {doc && gone && (
        <p className="text-xs text-stone-600">
          The file was removed{doc.fileDeletedReason === 'retention' ? ' by the retention policy' : ''}. Extracted
          values and their source details are kept.
        </p>
      )}
      {doc && !gone && inline && doc.kind === 'pdf' && (
        <iframe
          title={`Preview of ${doc.originalName}`}
          src={sessionDocumentFileUrl(sessionId, doc.documentId, 'inline')}
          className="w-full h-[70vh] border border-stone-200 rounded-lg bg-stone-50"
        />
      )}
      {doc && !gone && inline && doc.kind !== 'pdf' && (
        <img
          alt={`Preview of ${doc.originalName}`}
          src={sessionDocumentFileUrl(sessionId, doc.documentId, 'inline')}
          className="max-w-full border border-stone-200 rounded-lg"
        />
      )}
      {doc && !gone && !inline && <SpreadsheetView sessionId={sessionId} documentId={doc.documentId} />}
    </SlideOverDrawer>
  );
}
