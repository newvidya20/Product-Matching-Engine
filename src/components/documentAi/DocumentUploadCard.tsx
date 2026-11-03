import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  DOCUMENT_TYPES,
  TERMINAL_JOB_STATUSES,
  type ExtractionErrorCode,
  type ExtractionJob,
  type DocumentType,
  type StoredDocument,
} from '../../types/documentAi';
import { humanize } from './formModel';
import type { UploadItem } from './useDocumentAiForm';

const DATA_NOTE =
  "Uploaded documents are sent to the external AI service configured on this server (OpenRouter or Google Gemini) for processing and may contain personal and financial data, including PAN and bank details. Upload only documents you are authorised to process.";

const ERROR_COPY: Record<ExtractionErrorCode, string> = {
  password_protected: 'This PDF is password protected. Upload an unlocked copy.',
  unreadable_document: 'The document could not be read. Try a clearer copy.',
  llm_not_configured: 'Document reading is not set up on the server yet.',
  llm_rate_limited: 'The AI service is busy. Retry in a minute.',
  llm_quota_exhausted:
    "The AI service's daily free limit is used up. Click Retry tomorrow, or use a paid OpenRouter key or Gemini.",
  llm_timeout: 'Reading took too long. Retry, or split the file.',
  llm_invalid_response: 'The AI returned something unusable. Retry.',
  llm_failed: 'The AI service failed. Retry.',
  interrupted: 'Reading was interrupted. Retry.',
  file_missing: 'The stored file is no longer available.',
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function KindIcon({ kind }: { kind: StoredDocument['kind'] }) {
  const cls = 'w-4 h-4 text-stone-500 shrink-0';
  if (kind === 'xlsx' || kind === 'csv') return <FileSpreadsheet className={cls} aria-hidden="true" />;
  if (kind === 'pdf') return <FileText className={cls} aria-hidden="true" />;
  return <ImageIcon className={cls} aria-hidden="true" />;
}

function StatusChip({ doc }: { doc: StoredDocument }) {
  const base = 'inline-flex items-center gap-1 text-[11px] font-medium';
  switch (doc.status) {
    case 'extracted':
      return (
        <span className={`${base} text-emerald-700`}>
          <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Read
        </span>
      );
    case 'failed':
      return (
        <span className={`${base} text-red-700`}>
          <AlertCircle className="w-3 h-3" aria-hidden="true" /> Failed
        </span>
      );
    case 'extracting':
      return (
        <span className={`${base} text-orange-700`}>
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> Reading
        </span>
      );
    case 'queued':
      return <span className={`${base} text-stone-600`}>Waiting</span>;
    default:
      return <span className={`${base} text-stone-600`}>Uploaded</span>;
  }
}

interface Props {
  documents: StoredDocument[];
  uploads: UploadItem[];
  job: ExtractionJob | null;
  pollTimedOut: boolean;
  notice: string | null;
  loading: boolean;
  onFiles: (files: File[]) => void | Promise<void>;
  onDismissUpload: (key: string) => void;
  onPreview: (doc: StoredDocument) => void;
  onDelete: (doc: StoredDocument) => void;
  onRetry: (documentId: string) => void;
  onChangeType: (documentId: string, type: DocumentType) => void;
  onRefresh: () => void;
}

export function DocumentUploadCard(props: Props) {
  const { documents, uploads, job, pollTimedOut, notice, loading } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const running = Boolean(job && !TERMINAL_JOB_STATUSES.includes(job.status));

  const takeFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    void props.onFiles(Array.from(list));
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="p-6 sm:p-8 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-stone-900 font-display">Upload Documents</h2>
          <p className="text-xs text-stone-500 mt-0.5">
            Add GST returns, bank statements, financial statements, ITR, credit reports and other files. The form is
            filled where the documents state a value clearly; check everything before you submit.
          </p>
        </div>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-700 shrink-0">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            Reading {job ? `${Math.min(job.processed + 1, job.documentIds.length)} of ${job.documentIds.length}` : ''}
          </span>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          takeFiles(e.dataTransfer.files);
        }}
        className={`border-2 border-dashed rounded-xl px-4 py-6 text-center transition-colors ${
          dragging ? 'border-orange-500 bg-orange-50/60' : 'border-stone-300 bg-stone-50/50'
        }`}
      >
        <UploadCloud className="w-6 h-6 mx-auto text-stone-400" aria-hidden="true" />
        <p className="mt-2 text-xs text-stone-600">
          Drop files here, or{' '}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="font-semibold text-orange-700 hover:text-orange-800 underline underline-offset-2 cursor-pointer"
          >
            choose files
          </button>
        </p>
        <p className="mt-1 text-[11px] text-stone-500">PDF, Word, Excel, CSV, TXT, PNG, JPG, WebP or ZIP · up to 50 MB per file, ZIP up to 2 GB · 300 files</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.docx,.txt,.md,.zip"
          onChange={(e) => takeFiles(e.target.files)}
          className="sr-only"
          aria-label="Choose documents to upload"
        />
      </div>

      <p className="text-[11px] text-stone-500 leading-relaxed">{DATA_NOTE}</p>

      {notice && (
        <div role="alert" className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {notice}
        </div>
      )}

      {pollTimedOut && (
        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex flex-wrap items-center gap-2">
          <span>This is taking longer than expected.</span>
          <button
            type="button"
            onClick={props.onRefresh}
            className="inline-flex items-center gap-1 font-semibold underline cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" /> Refresh
          </button>
        </div>
      )}

      {loading && documents.length === 0 && (
        <p className="inline-flex items-center gap-2 text-xs text-stone-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Checking for earlier uploads…
        </p>
      )}

      {(uploads.length > 0 || documents.length > 0) && (
        <ul className="divide-y divide-stone-200 border border-stone-200 rounded-xl bg-white">
          {uploads.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-3 py-2.5">
              {item.status === 'uploading' ? (
                <Loader2 className="w-4 h-4 text-orange-600 animate-spin shrink-0" aria-hidden="true" />
              ) : (
                <AlertCircle
                  className={`w-4 h-4 shrink-0 ${item.status === 'error' ? 'text-red-600' : 'text-stone-400'}`}
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-stone-800 truncate">{item.name}</p>
                <p className={`text-[11px] ${item.status === 'error' ? 'text-red-700' : 'text-stone-500'}`}>
                  {item.status === 'uploading' ? 'Uploading…' : item.message}
                </p>
              </div>
              {item.status !== 'uploading' && (
                <button
                  type="button"
                  onClick={() => props.onDismissUpload(item.key)}
                  aria-label={`Dismiss ${item.name}`}
                  className="p-1.5 text-stone-400 hover:text-stone-700 rounded cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </li>
          ))}

          {documents.map((doc) => (
            <li key={doc.documentId} className="px-3 py-2.5 space-y-1.5">
              <div className="flex items-start gap-3">
                <KindIcon kind={doc.kind} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-stone-800 break-words">{doc.originalName}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-stone-500">
                    <span>{formatSize(doc.sizeBytes)}</span>
                    <StatusChip doc={doc} />
                    {doc.fileDeletedAt && <span>File removed</span>}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {!doc.fileDeletedAt && (
                    <button
                      type="button"
                      onClick={() => props.onPreview(doc)}
                      aria-label={`Preview ${doc.originalName}`}
                      className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg cursor-pointer"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => props.onDelete(doc)}
                    aria-label={`Delete ${doc.originalName}`}
                    className="p-2 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="pl-7 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {doc.status !== 'uploaded' && doc.status !== 'queued' && doc.status !== 'extracting' && (
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-stone-600">
                    Type
                    <select
                      value={doc.documentType ?? 'other'}
                      disabled={running || Boolean(doc.fileDeletedAt)}
                      onChange={(e) => props.onChangeType(doc.documentId, e.target.value as DocumentType)}
                      className="px-2 py-1 text-[11px] bg-white border border-stone-300 rounded-md focus:outline-none focus:border-orange-600 disabled:opacity-50"
                    >
                      {DOCUMENT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {humanize(type)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {doc.status === 'failed' && (
                  <>
                    <span className="text-[11px] text-red-700">
                      {doc.errorCode ? ERROR_COPY[doc.errorCode] : 'Reading failed.'}
                    </span>
                    {doc.errorCode !== 'password_protected' && !doc.fileDeletedAt && (
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => props.onRetry(doc.documentId)}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-700 hover:text-orange-800 disabled:opacity-50 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden="true" /> Retry
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
