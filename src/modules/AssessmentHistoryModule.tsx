import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, History, Plus, Search } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import {
  EmptyStatePanel,
  PageHeader,
  SegmentedControl,
  SlideOverDrawer,
} from '../components/ui/Primitives';
import type { BorrowerAssessment } from '../types/domain';
import type {
  DeleteDocumentResponse,
  FindSessionResponse,
  ListDocumentsResponse,
  SpreadsheetPreview,
  StoredDocument,
} from '../types/documentAi';
import {
  formatAssessmentStatus,
  formatDateTime,
  formatEligibilityStatus,
  formatEntityType,
  formatFundingPurpose,
  formatMoney,
  formatShortDate,
} from '../utils/formatters';

type HistoryFilter = 'all' | 'evaluated' | 'draft';

const DOC_AI_BASE = '/api/document-ai';

class DocApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function docApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DOC_AI_BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let message = 'Document request failed.';
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new DocApiError(res.status, message);
  }
  return (await res.json()) as T;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function AttachedDocuments({ assessmentId }: { assessmentId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [accessCode, setAccessCode] = useState('');
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const found = await docApi<FindSessionResponse>(
        `/sessions?assessmentId=${encodeURIComponent(assessmentId)}`
      );
      setNeedsCode(false);
      if (!found.session) {
        setSessionId(null);
        setDocuments([]);
        return;
      }
      setSessionId(found.session.sessionId);
      const list = await docApi<ListDocumentsResponse>(
        `/sessions/${found.session.sessionId}/documents`
      );
      setDocuments(list.documents);
    } catch (err) {
      if (err instanceof DocApiError && err.status === 401) {
        setNeedsCode(true);
      } else {
        setMessage(err instanceof Error ? err.message : 'Unable to load documents.');
      }
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => {
    setConfirmDeleteDocId(null);
    setPreviewDocId(null);
    setPreview(null);
    void load();
  }, [load]);

  const unlock = async () => {
    setMessage(null);
    try {
      await docApi('/auth/session', {
        method: 'POST',
        body: JSON.stringify({ accessCode }),
      });
      setAccessCode('');
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not unlock documents.');
    }
  };

  const base = sessionId ? `${DOC_AI_BASE}/sessions/${sessionId}/documents` : '';

  const togglePreview = async (doc: StoredDocument) => {
    if (previewDocId === doc.documentId) {
      setPreviewDocId(null);
      setPreview(null);
      return;
    }
    setPreviewDocId(doc.documentId);
    setPreview(null);
    try {
      setPreview(
        await docApi<SpreadsheetPreview>(
          `/sessions/${sessionId}/documents/${doc.documentId}/preview`
        )
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Preview unavailable.');
    }
  };

  const deleteFile = async (doc: StoredDocument) => {
    setConfirmDeleteDocId(null);
    try {
      const out = await docApi<DeleteDocumentResponse>(
        `/sessions/${sessionId}/documents/${doc.documentId}?mode=file_only`,
        { method: 'DELETE' }
      );
      setDocuments(out.state.documents);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not delete the file.');
    }
  };

  const linkClass =
    'px-2 py-1 text-[11px] font-medium text-stone-700 hover:bg-stone-100 rounded-md transition-colors cursor-pointer';

  return (
    <div className="pt-4 border-t border-stone-200 space-y-2">
      <div className="font-semibold text-stone-900">Attached Documents</div>
      {needsCode && (
        <div className="space-y-2">
          <p className="text-stone-500">
            Enter the Document AI access code to view attached documents.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unlock();
              }}
              autoComplete="off"
              className="flex-1 px-3 py-1.5 text-xs bg-white border border-stone-200 rounded-lg focus:outline-none focus:border-orange-600"
            />
            <button
              type="button"
              onClick={() => void unlock()}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer"
            >
              Unlock
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-red-600">{message}</p>}
      {!needsCode && loading && <p className="text-stone-500">Loading documents...</p>}
      {!needsCode && !loading && documents.length === 0 && !message && (
        <p className="text-stone-500">No documents are attached to this assessment.</p>
      )}
      {documents.length > 0 && (
        <div className="divide-y divide-stone-200 border-t border-b border-stone-200">
          {documents.map((doc) => {
            const gone = Boolean(doc.fileDeletedAt);
            const isSheet = doc.kind === 'xlsx' || doc.kind === 'csv';
            return (
              <div key={doc.documentId} className="py-2.5 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-stone-900 truncate">
                      {doc.originalName}
                    </div>
                    <div className="text-[11px] text-stone-500">
                      {(doc.documentType || 'unclassified').replace(/_/g, ' ')} ·{' '}
                      {formatBytes(doc.sizeBytes)} · {formatDateTime(doc.uploadedAt)}
                      {gone ? ' · file removed' : ''}
                    </div>
                  </div>
                  {!gone && (
                    <div className="inline-flex items-center gap-1 shrink-0">
                      {isSheet ? (
                        <button
                          type="button"
                          onClick={() => void togglePreview(doc)}
                          className={linkClass}
                        >
                          {previewDocId === doc.documentId ? 'Hide' : 'Preview'}
                        </button>
                      ) : (
                        <a
                          href={`${base}/${doc.documentId}/file?disposition=inline`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={linkClass}
                        >
                          Preview
                        </a>
                      )}
                      <a
                        href={`${base}/${doc.documentId}/file?disposition=attachment`}
                        className={linkClass}
                      >
                        Download
                      </a>
                      {confirmDeleteDocId === doc.documentId ? (
                        <button
                          type="button"
                          onClick={() => void deleteFile(doc)}
                          onBlur={() => setConfirmDeleteDocId(null)}
                          className="px-2 py-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md cursor-pointer"
                        >
                          Confirm Delete File
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDocId(doc.documentId)}
                          className="px-2 py-1 text-[11px] text-stone-400 hover:text-red-600 rounded-md cursor-pointer"
                        >
                          Delete File
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {previewDocId === doc.documentId && (
                  <div className="overflow-x-auto max-h-64 border border-stone-200 rounded-md">
                    {!preview ? (
                      <p className="p-2 text-stone-500">Loading preview...</p>
                    ) : (
                      preview.sheets.map((sheet) => (
                        <div key={sheet.name}>
                          <div className="px-2 py-1 bg-stone-50 text-[11px] font-medium text-stone-600">
                            {sheet.name}
                            {sheet.truncated ? ' (truncated)' : ''}
                          </div>
                          <table className="text-[11px] font-mono">
                            <tbody>
                              {sheet.rows.map((row, r) => (
                                <tr key={r}>
                                  {row.map((cell, c) => (
                                    <td
                                      key={c}
                                      className="px-2 py-0.5 border-t border-stone-100 whitespace-nowrap"
                                    >
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AssessmentHistoryModule() {
  const {
    state,
    navigateTo,
    openAssessmentInEngine,
    openAssessmentForEdit,
    deleteAssessment,
  } = useAppState();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<HistoryFilter>('all');
  const [inspectedRecord, setInspectedRecord] = useState<BorrowerAssessment | null>(
    null
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const isEmployeeOnly = state.currentUser?.role === 'employee';

  const baseRecords = state.assessments.filter((a) => !a.isFictionalDemo);

  const hasQualifiedMatch = (item: BorrowerAssessment) =>
    (item.latestEvaluation?.top3SubProducts ?? []).some(
      (match) => match.suitabilityScore >= 98
    );

  const filteredRecords = baseRecords.filter((item) => {
    if (statusFilter === 'evaluated' && !hasQualifiedMatch(item)) return false;
    if (statusFilter === 'draft' && item.status !== 'draft') return false;
    if (statusFilter !== 'all' && statusFilter !== 'evaluated' && statusFilter !== 'draft') {
      return false;
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      item.referenceCode.toLowerCase().includes(q) ||
      item.applicantLabel.toLowerCase().includes(q) ||
      item.assignedOfficer.toLowerCase().includes(q) ||
      item.branchOrDesk.toLowerCase().includes(q) ||
      (item.industrySector || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Borrower Assessment History"
        description="Review borrower assessments and the matched product outcomes across the portfolio."
        metadataItems={[
          `${state.assessments.length} Total Stored`,
          `${state.assessments.filter((a) => !a.isFictionalDemo).length} Employee Entries`,
          state.workspaceConfig.spreadsheetId
            ? `Synced: ${state.workspaceConfig.spreadsheetTitle}`
            : 'Local Workspace Mode',
        ]}
        actions={
          <>
            {state.workspaceConfig.spreadsheetUrl && (
              <a
                href={state.workspaceConfig.spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <span>Open Sheets Log</span>
                <ExternalLink className="w-3.5 h-3.5 text-stone-400" />
              </a>
            )}
            <button
              type="button"
              onClick={() => navigateTo('new-assessment')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Assessment</span>
            </button>
          </>
        }
      />

      {/* Search & Filters */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search reference code, company, industry, or desk..."
              className="w-full pl-9 pr-3.5 py-2 text-xs bg-white border border-stone-200 rounded-lg focus:outline-none focus:border-orange-600"
            />
          </div>

        </div>

        <SegmentedControl<HistoryFilter>
          options={[
            { value: 'all', label: 'All', count: baseRecords.length },
            {
              value: 'evaluated',
              label: 'Matched',
              count: baseRecords.filter((a) => hasQualifiedMatch(a)).length,
            },
            {
              value: 'draft',
              label: 'Drafts',
              count: baseRecords.filter((a) => a.status === 'draft').length,
            },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      </div>

      {filteredRecords.length === 0 ? (
        <EmptyStatePanel
          icon={<History className="w-6 h-6" />}
          title="No Assessment Records Match Your Filter"
          description="Adjust your search criteria, include fictional demo cases, or create a new borrower intake assessment."
          actionLabel="Create Borrower Assessment"
          onAction={() => navigateTo('new-assessment')}
        />
      ) : (
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50/70 text-[11px] font-medium text-stone-500">
                  <th className="py-3 px-4">Reference</th>
                  <th className="py-3 px-4">Company / Case Label</th>
                  <th className="py-3 px-4">Funding Purpose</th>
                  <th className="py-3 px-4 text-right">Requested Amount</th>
                  <th className="py-3 px-4">Top Match Outcome</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Updated</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 text-xs">
                {filteredRecords.map((item) => {
                  const statusMeta = formatAssessmentStatus(item.status);
                  const isConfirming = confirmDeleteId === item.id;
                  const topMatch =
                    item.latestEvaluation?.top3SubProducts?.find(
                      (match) => match.suitabilityScore >= 98
                    ) ?? null;

                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-stone-50/80 transition-colors"
                    >
                      <td className="py-3 px-4 font-mono tabular-nums text-stone-700 whitespace-nowrap">
                        {item.referenceCode}
                      </td>
                      <td className="py-3 px-4 max-w-[250px]">
                        <div className="font-medium text-stone-900 truncate">
                          {item.applicantLabel}
                        </div>
                        <div className="text-[11px] text-stone-500 flex items-center gap-1.5 truncate">
                          <span>{formatEntityType(item.entityType)}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {item.assignedOfficer}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-stone-600 whitespace-nowrap">
                        <div>{formatFundingPurpose(item.fundingPurpose)}</div>
                        <div className="text-[11px] text-stone-400 font-mono tabular-nums">
                          {item.requestedTenureMonths}m tenure
                          {typeof item.creditScore === 'number'
                            ? ` · Score ${item.creditScore}`
                            : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-stone-900 whitespace-nowrap">
                        {formatMoney(item.requestedAmount, item.currency)}
                      </td>
                      <td className="py-3 px-4 max-w-[230px]">
                        {topMatch ? (
                          <div>
                            <div className="font-medium text-stone-900 truncate">
                              {topMatch.subProductName}
                            </div>
                            <div className="text-[11px] text-stone-500 font-mono tabular-nums truncate">
                              {topMatch.suitabilityScore}% ·{' '}
                              <span
                                className={
                                  formatEligibilityStatus(topMatch.eligibilityStatus)
                                    .textClass
                                }
                              >
                                {
                                  formatEligibilityStatus(topMatch.eligibilityStatus)
                                    .label
                                }
                              </span>
                            </div>
                          </div>
                        ) : item.latestEvaluation ? (
                          <span className="font-medium text-red-600">Unmatched</span>
                        ) : (
                          <span className="text-stone-400">Not evaluated</span>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={statusMeta.textClass}>{statusMeta.label}</span>
                      </td>
                      <td className="py-3 px-4 text-stone-500 whitespace-nowrap tabular-nums">
                        {formatShortDate(item.updatedAt)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setInspectedRecord(item)}
                            className="px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-md transition-colors cursor-pointer"
                          >
                            Details
                          </button>
                          {item.status === 'draft' && (
                            <button
                              type="button"
                              onClick={() => openAssessmentForEdit(item.id)}
                              className="px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-md transition-colors cursor-pointer"
                            >
                              Edit Draft
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openAssessmentInEngine(item.id)}
                            className="px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50 rounded-md transition-colors cursor-pointer"
                          >
                            Match
                          </button>
                          {!isEmployeeOnly &&
                            (isConfirming ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirmDeleteId(null);
                                  void deleteAssessment(item.id);
                                }}
                                onBlur={() => setConfirmDeleteId(null)}
                                className="px-2.5 py-1 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors cursor-pointer"
                              >
                                Confirm Delete
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(item.id)}
                                className="px-2 py-1 text-xs text-stone-400 hover:text-red-600 rounded-md transition-colors cursor-pointer"
                              >
                                Delete
                              </button>
                            ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Assessment Detail Drawer */}
      <SlideOverDrawer
        open={Boolean(inspectedRecord)}
        title={inspectedRecord?.applicantLabel || 'Assessment Details'}
        subtitle={
          inspectedRecord
            ? `${inspectedRecord.referenceCode} · Created ${formatDateTime(
                inspectedRecord.createdAt
              )}`
            : undefined
        }
        onClose={() => setInspectedRecord(null)}
        footer={
          inspectedRecord && (
            <>
              <button
                type="button"
                onClick={() => setInspectedRecord(null)}
                className="px-4 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
              >
                Close
              </button>
              {inspectedRecord.status === 'draft' && (
                <button
                  type="button"
                  onClick={() => {
                    const id = inspectedRecord.id;
                    setInspectedRecord(null);
                    openAssessmentForEdit(id);
                  }}
                  className="px-4 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
                >
                  Edit Draft
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const id = inspectedRecord.id;
                  setInspectedRecord(null);
                  openAssessmentInEngine(id);
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer"
              >
                Open in Matching Engine
              </button>
            </>
          )
        }
      >
        {inspectedRecord && (
          <div className="space-y-6 text-xs">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-stone-500">Record Classification</div>
                <div className="font-medium text-stone-900 mt-0.5">
                  Employee Intake Record
                </div>
              </div>
              <div>
                <div className="text-stone-500">Entity & Sector</div>
                <div className="font-medium text-stone-900 mt-0.5">
                  {formatEntityType(inspectedRecord.entityType)}
                  {inspectedRecord.industrySector
                    ? ` · ${inspectedRecord.industrySector}`
                    : ''}
                </div>
              </div>
              <div>
                <div className="text-stone-500">Requested Facility</div>
                <div className="font-mono tabular-nums font-semibold text-stone-900 mt-0.5">
                  {formatMoney(
                    inspectedRecord.requestedAmount,
                    inspectedRecord.currency
                  )}
                </div>
              </div>
              <div>
                <div className="text-stone-500">Funding Purpose & Tenure</div>
                <div className="font-medium text-stone-900 mt-0.5">
                  {formatFundingPurpose(inspectedRecord.fundingPurpose)} (
                  <span className="font-mono tabular-nums">
                    {inspectedRecord.requestedTenureMonths}m
                  </span>
                  )
                </div>
              </div>
              <div>
                <div className="text-stone-500">Annual Turnover / Income</div>
                <div className="font-mono tabular-nums font-medium text-stone-900 mt-0.5">
                  {formatMoney(
                    inspectedRecord.annualTurnoverOrIncome,
                    inspectedRecord.currency
                  )}
                </div>
              </div>
              <div>
                <div className="text-stone-500">Vintage & Credit Profile</div>
                <div className="font-mono tabular-nums font-medium text-stone-900 mt-0.5">
                  {typeof inspectedRecord.businessVintageYears === 'number'
                    ? `${inspectedRecord.businessVintageYears} yrs`
                    : 'Vintage N/A'}{' '}
                  ·{' '}
                  {typeof inspectedRecord.creditScore === 'number'
                    ? `Score ${inspectedRecord.creditScore}`
                    : 'Score N/A'}
                </div>
              </div>
              <div>
                <div className="text-stone-500">GST & Profitability</div>
                <div className="font-medium text-stone-900 mt-0.5">
                  GST: {inspectedRecord.gstTaxCompliant || 'not_provided'} ·{' '}
                  {inspectedRecord.profitabilityStatus || 'not_provided'}
                </div>
              </div>
              <div>
                <div className="text-stone-500">Assigned Officer & Desk</div>
                <div className="font-medium text-stone-900 mt-0.5">
                  {inspectedRecord.assignedOfficer} · {inspectedRecord.branchOrDesk}
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-stone-200 space-y-2">
              <div className="font-semibold text-stone-900">Collateral & Purpose</div>
              <p className="text-stone-600 leading-relaxed">
                <strong className="text-stone-800">Security:</strong>{' '}
                {inspectedRecord.collateralAvailable
                  ? `${inspectedRecord.collateralType || 'Secured'}${
                      typeof inspectedRecord.collateralValue === 'number'
                        ? ` (${formatMoney(
                            inspectedRecord.collateralValue,
                            inspectedRecord.currency
                          )})`
                        : ''
                    } — ${inspectedRecord.collateralDescription || 'Collateral Available'}`
                  : 'Unsecured Facility Requested'}
              </p>
              <p className="text-stone-600 leading-relaxed">
                <strong className="text-stone-800">Stated Purpose:</strong>{' '}
                {inspectedRecord.statedPurpose || '—'}
              </p>
              {inspectedRecord.advisorNotes && (
                <p className="text-stone-600 leading-relaxed">
                  <strong className="text-stone-800">Advisor Notes:</strong>{' '}
                  {inspectedRecord.advisorNotes}
                </p>
              )}
            </div>

            {inspectedRecord.dynamicPurposeAnswers &&
              Object.keys(inspectedRecord.dynamicPurposeAnswers).length > 0 && (
                <div className="pt-4 border-t border-stone-200 space-y-2">
                  <div className="font-semibold text-stone-900">
                    Purpose-Specific Intake Answers
                  </div>
                  <div className="divide-y divide-stone-200 border-t border-b border-stone-200">
                    {Object.entries(inspectedRecord.dynamicPurposeAnswers).map(
                      ([key, val]) => (
                        <div
                          key={key}
                          className="py-2 flex items-center justify-between gap-4"
                        >
                          <span className="text-stone-500">{key}</span>
                          <span className="font-medium text-stone-900 text-right">
                            {val || '—'}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

            {inspectedRecord.customAttributes.length > 0 && (
              <div className="pt-4 border-t border-stone-200 space-y-2">
                <div className="font-semibold text-stone-900">
                  Custom Intake Attributes
                </div>
                <div className="divide-y divide-stone-200 border-t border-b border-stone-200">
                  {inspectedRecord.customAttributes.map((attr) => (
                    <div
                      key={attr.id}
                      className="py-2 flex items-center justify-between gap-4"
                    >
                      <span className="text-stone-500">{attr.key}</span>
                      <span className="font-medium text-stone-900">{attr.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <AttachedDocuments assessmentId={inspectedRecord.id} />

            <div className="pt-4 border-t border-stone-200 space-y-3">
              <div className="font-semibold text-stone-900">
                Latest Two-Stage Matching Snapshot
              </div>
              {!inspectedRecord.latestEvaluation ? (
                <p className="text-stone-500">
                  Not evaluated yet. Open this case in the Product Matching Engine to run
                  Stage 1 Requirement & Stage 2 Eligibility checks.
                </p>
              ) : (
                <div className="space-y-3 text-stone-600">
                  <div className="font-mono tabular-nums text-stone-800">
                    {inspectedRecord.latestEvaluation.alignedCategoriesCount} categories ·{' '}
                    {inspectedRecord.latestEvaluation.alignedSubProductsCount} eligible
                    sub-products
                  </div>
                  <div className="text-stone-500">
                    Dataset:{' '}
                    {inspectedRecord.latestEvaluation.datasetMode ===
                    'fictional_demo_sandbox'
                      ? 'Fictional Demo Sandbox'
                      : 'Portfolio Match'}{' '}                    · Evaluated{' '}
                    {formatDateTime(inspectedRecord.latestEvaluation.evaluatedAt)}
                  </div>

                  {inspectedRecord.latestEvaluation.top3SubProducts &&
                    inspectedRecord.latestEvaluation.top3SubProducts.length > 0 && (
                      <div className="divide-y divide-stone-200 border-t border-b border-stone-200">
                        {inspectedRecord.latestEvaluation.top3SubProducts.map(
                          (match, idx) => (
                            <div
                              key={match.subProductId}
                              className="py-2.5 flex items-center justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <div className="font-medium text-stone-900 truncate">
                                  #{idx + 1} {match.subProductName}
                                </div>
                                <div className="text-[11px] text-stone-500 truncate">
                                  {match.categoryName}
                                </div>
                              </div>
                              <div className="text-right shrink-0 font-mono tabular-nums">
                                <div className="font-semibold text-stone-900">
                                  {match.suitabilityScore}%
                                </div>
                                <div
                                  className={`text-[11px] ${
                                    formatEligibilityStatus(match.eligibilityStatus)
                                      .textClass
                                  }`}
                                >
                                  {
                                    formatEligibilityStatus(match.eligibilityStatus)
                                      .label
                                  }
                                </div>
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    )}

                  {inspectedRecord.latestEvaluation.aiExplanation && (
                    <p className="pt-1 leading-relaxed text-stone-700">
                      {
                        inspectedRecord.latestEvaluation.aiExplanation
                          .deterministicOutcomeNarrative
                      }
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
