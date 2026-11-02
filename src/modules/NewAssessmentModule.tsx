import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Beaker, ChevronDown, ChevronRight, Plus, RotateCcw, Save, Send, Trash2 } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import { PageHeader, SegmentedControl } from '../components/ui/Primitives';
import type {
  BorrowerAssessment,
  EntityStructureType,
  FundingPurposeCategory,
  ProfitabilityStatus,
} from '../types/domain';
import type { DeleteDocumentMode, StoredDocument } from '../types/documentAi';
import {
  FINANCIAL_FIELDS_NEEDING_INPUT,
  dynamicFieldsForPurpose,
  getFieldDefinition,
} from '../documentAi/fieldMap';
import {
  buildAssessmentPayload,
  createBlankForm,
  humanize,
  isFormBacked,
  readField,
  type FormState,
} from '../components/documentAi/formModel';
import { DocAiFieldContext, FieldShell } from '../components/documentAi/FieldShell';
import { useDocumentAiForm } from '../components/documentAi/useDocumentAiForm';
import { DocumentAccessGate } from '../components/documentAi/DocumentAccessGate';
import { DocumentUploadCard } from '../components/documentAi/DocumentUploadCard';
import { DocumentPreviewDrawer } from '../components/documentAi/DocumentPreviewDrawer';
import { DeleteDocumentDialog } from '../components/documentAi/DeleteDocumentDialog';
import { ReviewPanel } from '../components/documentAi/ReviewPanel';

const INPUT =
  'w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600';
const INPUT_MONO = `${INPUT} font-mono tabular-nums`;
const INPUT_SMALL =
  'w-full px-3 py-2 text-xs bg-stone-50/70 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600';

/** Section 04 inputs shown up front. Everything else in the field map lives under "More financial details". */
const MAIN_FINANCIAL_FIELD_IDS = [
  'financialProfile.financialYearLabel',
  'financialProfile.dataSource',
  'financialProfile.annualRevenue',
  'financialProfile.previousAnnualRevenue',
  'financialProfile.netProfitAfterTax',
  'financialProfile.ebitda',
  'financialProfile.ebit',
  'financialProfile.interestExpense',
  'financialProfile.currentAssets',
  'financialProfile.currentLiabilities',
  'financialProfile.tangibleNetWorth',
  'financialProfile.totalOutsideLiabilities',
  'financialProfile.ratios.dscr',
  'financialProfile.personalCibilScore',
  'financialProfile.commercialCmrRank',
  'financialProfile.averageMonthlyBankingCredits',
  'financialProfile.gstAnnualTurnover',
];

const MORE_FINANCIAL_FIELD_IDS = FINANCIAL_FIELDS_NEEDING_INPUT.map((d) => d.fieldId);

const SIGNED_DECIMAL = /^-?\d*\.?\d*$/;

function UnresolvedWarning({ count }: { count: number }) {
  return (
    <div role="alert" className="px-4 py-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-900 font-medium">
      {count} extracted {count === 1 ? 'value is' : 'values are'} still unchecked (conflicts or Please verify).
      Review {count === 1 ? 'it' : 'them'} above, or select Submit again to continue anyway.
    </div>
  );
}

export function NewAssessmentModule() {
  const { state } = useAppState();
  // editingAssessmentId is added to AppStateContext by the storage branch (docs/contracts.md section 8).
  const editingId = state.editingAssessmentId;
  const editing = useMemo(
    () => (editingId ? state.assessments.find((a) => a.id === editingId) ?? null : null),
    // Resolved once per mount: the form must not be rebuilt when the list refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editingId]
  );
  // Reset and Populate Demo leave the saved record. The form keeps its key so the new content survives.
  const [detachedKey, setDetachedKey] = useState<string | null>(null);
  useEffect(() => {
    if (editingId) setDetachedKey(null);
  }, [editingId]);
  const key = !editingId && detachedKey ? detachedKey : editing?.id ?? 'new';
  return <AssessmentForm key={key} editingAssessment={editing} onDetach={() => setDetachedKey(key)} />;
}

function AssessmentForm({
  editingAssessment,
  onDetach,
}: {
  editingAssessment: BorrowerAssessment | null;
  onDetach: () => void;
}) {
  const { state, createAssessment, updateAssessment, openAssessmentInEngine, navigateTo, notify } = useAppState();
  const officerDefault = state.currentUser?.displayName || state.currentUser?.email || '';
  const defaultCurrency = state.settings.defaultCurrency;

  const ai = useDocumentAiForm({
    createBlank: () => createBlankForm(defaultCurrency, officerDefault),
    editingAssessment,
    defaultCurrency,
  });
  const form = ai.form;
  const { setValue, patchForm } = ai;

  const [validationError, setValidationError] = useState<string | null>(null);
  const [unresolvedWarning, setUnresolvedWarning] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ id: string; referenceCode: string } | null>(
    editingAssessment ? { id: editingAssessment.id, referenceCode: editingAssessment.referenceCode } : null
  );
  const savedIdRef = useRef<string | null>(editingAssessment?.id ?? null);
  // Bumped on every detach (Reset, Populate Demo) so a save started earlier never binds the form to its record.
  const detachGenRef = useRef(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<StoredDocument | null>(null);
  const [deleteDoc, setDeleteDoc] = useState<StoredDocument | null>(null);

  const dynamicFields = dynamicFieldsForPurpose(form.fundingPurpose);

  // Open the extra financial inputs by themselves when Document AI fills one, so the value is visible.
  const appliedKey = Object.keys(ai.applied).join('|');
  useEffect(() => {
    if (MORE_FINANCIAL_FIELD_IDS.some((id) => id in ai.applied)) setMoreOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey]);

  const unresolvedCount = useMemo(() => {
    const fields = ai.docState?.fields ?? {};
    let count = 0;
    for (const result of Object.values(fields)) {
      if (result.status === 'auto_applied') continue;
      const definition = getFieldDefinition(result.fieldId);
      if (!definition || !isFormBacked(definition)) continue;
      if (definition.target.kind === 'dynamic' && definition.target.purpose !== form.fundingPurpose) continue;
      if (result.fieldId in ai.edited) continue;
      if (ai.fieldContext.isDismissed(result.fieldId)) continue;
      count += 1;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.docState, ai.edited, ai.dismissed, form.fundingPurpose]);

  useEffect(() => {
    setUnresolvedWarning((current) => (current !== null && current !== unresolvedCount ? null : current));
  }, [unresolvedCount]);

  // ------------------------------------------------------------- Actions

  /** Leaves the saved record: the next Save creates a new one and the heading stops saying Edit Draft. */
  const detachFromSaved = (): boolean => {
    detachGenRef.current += 1;
    const wasSaved = savedIdRef.current !== null;
    savedIdRef.current = null;
    setSaved(null);
    if (state.editingAssessmentId) {
      // SET_MODULE clears editingAssessmentId; re-selecting this module is the only exposed way.
      onDetach();
      navigateTo(state.activeModule);
    }
    return wasSaved;
  };

  const handleLoadFictionalSample = () => {
    setValidationError(null);
    const detach = detachFromSaved();
    const blank = createBlankForm(defaultCurrency, officerDefault);
    ai.loadDemo(
      {
      ...blank,
      applicantLabel: '[FICTIONAL DEMO] Deccan Precision Engineering LLP',
      entityType: 'llp',
      industrySector: 'Industrial Machinery & Precision Components',
      businessVintageYears: '8',
      gstTaxCompliant: 'yes',
      fundingPurpose: 'machinery_equipment',
      dynamicPurposeAnswers: {
        equipmentCondition: 'New Domestic Equipment',
        supplierQuotationReady: 'Yes',
        borrowerMarginPercent: '20%',
      },
      assignedOfficer: officerDefault || 'M. Joshi (Demo Desk)',
      branchOrDesk: 'West Zone — Pune Desk',
      requestedAmount: '12500000',
      requestedTenureMonths: '60',
      annualTurnoverOrIncome: '54000000',
      creditScore: '760',
      existingEmiObligations: '185000',
      profitabilityStatus: 'profitable_2plus_years',
      collateralAvailable: 'yes',
      collateralType: 'Industrial Shed & Equipment',
      collateralValue: '21000000',
      collateralDescription:
        'Fictional sample industrial shed & machinery collateral record for workflow testing.',
      statedPurpose: 'Fictional sample intake: automated CNC assembly line acquisition.',
      advisorNotes: 'Populate the borrower profile to test product fit analysis against the approved catalogue.',
      isFictionalDemo: true,
      },
      { detach }
    );
  };

  const handleReset = () => {
    setValidationError(null);
    setUnresolvedWarning(null);
    detachFromSaved();
    ai.reset(createBlankForm(defaultCurrency, officerDefault));
  };

  const handleAddCustomAttribute = () =>
    patchForm((prev) => ({
      ...prev,
      customAttributes: [...prev.customAttributes, { id: `ca-${Date.now()}`, key: '', value: '' }],
    }));

  const handleUpdateCustomAttribute = (id: string, field: 'key' | 'value', val: string) =>
    patchForm((prev) => ({
      ...prev,
      customAttributes: prev.customAttributes.map((item) => (item.id === id ? { ...item, [field]: val } : item)),
    }));

  const handleRemoveCustomAttribute = (id: string) =>
    patchForm((prev) => ({
      ...prev,
      customAttributes: prev.customAttributes.filter((item) => item.id !== id),
    }));

  const submitForm = async (asDraft: boolean) => {
    setValidationError(null);
    const current: FormState = ai.formRef.current;

    if (!current.applicantLabel.trim()) {
      setValidationError('Enter the company or applicant name before saving.');
      return;
    }
    const parsedAmount = Number(current.requestedAmount);
    if (!asDraft && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
      setValidationError('Enter a valid requested facility amount greater than zero.');
      return;
    }
    const parsedTenure = Number(current.requestedTenureMonths);
    if (!Number.isFinite(parsedTenure) || parsedTenure <= 0) {
      setValidationError('Enter a valid requested tenure in months.');
      return;
    }
    // Unchecked extractions never block Save Draft. Submit asks twice.
    if (!asDraft && unresolvedCount > 0 && unresolvedWarning !== unresolvedCount) {
      setUnresolvedWarning(unresolvedCount);
      return;
    }

    const startedGen = detachGenRef.current;
    // Never blocks the save: a Document AI failure only produces a notice.
    const { warning, ...link } = await ai.prepareForSave();
    if (warning) notify('error', warning);
    // Built after the flush, from the ref, so edits made while it ran are saved.
    const payload: Partial<BorrowerAssessment> = {
      ...buildAssessmentPayload(ai.formRef.current, asDraft),
      ...link,
    };

    const existingId = savedIdRef.current;
    if (existingId) {
      const updated = await updateAssessment(existingId, payload);
      if (!updated) return;
      if (detachGenRef.current !== startedGen) return;
      void ai.afterSave(updated.id).then((message) => message && notify('error', message));
      if (!asDraft) openAssessmentInEngine(updated.id);
      return;
    }

    // createAssessment(payload, true) navigates away and unmounts this module, so nothing after it
    // may rely on component state. Everything below uses refs and module-level calls only.
    const created = await createAssessment(payload, !asDraft);
    if (!created) return;
    // Reset or Populate Demo ran while the create was in flight: the record exists, but this form is no longer it.
    if (detachGenRef.current !== startedGen) return;
    savedIdRef.current = created.id;
    void ai.afterSave(created.id).then((message) => message && notify('error', message));
    setSaved({ id: created.id, referenceCode: created.referenceCode });
  };

  const handleDelete = async (documentId: string, mode: DeleteDocumentMode) => {
    await ai.removeDocument(documentId, mode);
  };

  // ------------------------------------------------------ Field renderers
  // Plain functions (not components) so inputs keep focus across renders.

  const textField = (
    fieldId: string,
    label: React.ReactNode,
    opts: {
      value: string;
      placeholder?: string;
      className?: string;
      required?: boolean;
      mono?: boolean;
      small?: boolean;
      disabled?: boolean;
      type?: 'text' | 'number';
      min?: number;
      max?: number;
      step?: string;
      onChange?: (value: string) => void;
    }
  ) => (
    <FieldShell fieldId={fieldId} label={label} required={opts.required} className={opts.className}>
      <input
        type={opts.type ?? 'text'}
        min={opts.min}
        max={opts.max}
        step={opts.type === 'number' ? opts.step ?? 'any' : undefined}
        disabled={opts.disabled}
        value={opts.value}
        onChange={(e) => (opts.onChange ?? ((v) => setValue(fieldId, v, 'typed')))(e.target.value)}
        placeholder={opts.placeholder}
        className={`${opts.small ? INPUT_SMALL : opts.mono ? INPUT_MONO : INPUT} ${
          opts.disabled ? 'disabled:bg-stone-50 disabled:text-stone-400' : ''
        }`}
      />
    </FieldShell>
  );

  const selectField = (
    fieldId: string,
    label: React.ReactNode,
    value: string,
    options: Array<{ value: string; label: string }>,
    opts: { required?: boolean; className?: string; small?: boolean; blankLabel?: string } = {}
  ) => (
    <FieldShell fieldId={fieldId} label={label} required={opts.required} className={opts.className}>
      <select
        value={value}
        onChange={(e) => setValue(fieldId, e.target.value, 'typed')}
        className={opts.small ? INPUT_SMALL : INPUT}
      >
        {opts.blankLabel !== undefined && <option value="">{opts.blankLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );

  /** Section 04 inputs, driven entirely by the field map so labels, limits and sign rules have one source. */
  const financialField = (fieldId: string) => {
    const definition = getFieldDefinition(fieldId);
    if (!definition) return null;
    const value = readField(form, definition);
    const label =
      definition.unit === 'currency' ? `${definition.label} (${form.currency})` : definition.label;

    if (definition.valueType === 'enum') {
      return (
        <div key={fieldId}>
          {selectField(
            fieldId,
            label,
            value || definition.defaultValue || '',
            definition.allowedValues.map((v) => ({ value: v, label: humanize(v) }))
          )}
        </div>
      );
    }
    if (definition.valueType === 'string') {
      return (
        <div key={fieldId}>
          {textField(fieldId, label, {
            value,
            placeholder: fieldId.endsWith('financialYearLabel') ? 'e.g., FY 2024-25' : undefined,
          })}
        </div>
      );
    }
    // Numbers: signed fields stay text while typing so "-" survives; the rest are number inputs
    // whose min and max come from the definition.
    if (definition.signPolicy === 'signed') {
      return (
        <div key={fieldId}>
          {textField(fieldId, label, {
            value,
            mono: true,
            onChange: (next) => SIGNED_DECIMAL.test(next) && setValue(fieldId, next, 'typed'),
          })}
        </div>
      );
    }
    return (
      <div key={fieldId}>
        {textField(fieldId, label, {
          value,
          mono: true,
          type: 'number',
          min: definition.min ?? 0,
          max: definition.max,
        })}
      </div>
    );
  };

  const stillCollateralOff = form.collateralAvailable === 'no';

  return (
    <DocAiFieldContext.Provider value={ai.fieldContext}>
      <div className="space-y-6">
        <DocumentAccessGate user={state.currentUser} />
        <PageHeader
          title={saved ? `Edit Draft ${saved.referenceCode}` : 'New Borrower Assessment'}
          description="Capture company profile, funding purpose with dynamic questions, business turnover & vintage, credit profile, financials, and collateral availability."
          metadataItems={[
            'Dynamic Purpose Intake',
            state.workspaceConfig.spreadsheetId ? 'Saves to Borrower_Assessments Sheet' : 'Local Workspace Storage',
            'Incomplete Fields Flagged Safely',
          ]}
          actions={
            <>
              <button
                type="button"
                onClick={handleLoadFictionalSample}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-300 hover:bg-amber-100/80 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Beaker className="w-3.5 h-3.5 text-amber-700" />
                <span>Populate Fictional Demo Borrower</span>
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-stone-600 bg-white border border-stone-200 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </>
          }
        />

        {validationError && (
          <div role="alert" className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 font-medium">
            {validationError}
          </div>
        )}

        {/* Document AI: upload, file list, review */}
        <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-200">
          <DocumentUploadCard
            documents={ai.documents}
            uploads={ai.uploads}
            job={ai.job}
            pollTimedOut={ai.pollTimedOut}
            notice={ai.notice}
            loading={ai.loadingSession}
            onFiles={ai.uploadFiles}
            onDismissUpload={ai.dismissUpload}
            onPreview={setPreviewDoc}
            onDelete={setDeleteDoc}
            onRetry={(id) => void ai.retryDocument(id)}
            onChangeType={(id, type) => void ai.changeDocumentType(id, type)}
            onRefresh={() => void ai.refresh()}
          />
          {ai.documents.length > 0 && (
            <div className="p-4 sm:p-6">
              <ReviewPanel
                form={form}
                fields={ai.docState?.fields ?? {}}
                warnings={ai.docState?.warnings ?? []}
                edited={ai.edited}
                applied={ai.applied}
                isDismissed={ai.fieldContext.isDismissed}
                acceptCandidate={ai.acceptCandidate}
                dismiss={ai.dismiss}
                hasDocuments
                busy={ai.isBusy}
              />
            </div>
          )}
        </div>

        <DocumentPreviewDrawer sessionId={ai.sessionId} document={previewDoc} onClose={() => setPreviewDoc(null)} />
        <DeleteDocumentDialog
          document={deleteDoc}
          allowClearFields
          onCancel={() => setDeleteDoc(null)}
          onConfirm={handleDelete}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm(false);
          }}
          className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-200"
        >
          {/* Section 1: Company & Business Details */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-stone-900 font-display">01. Company & Business Details</h2>
                <p className="text-xs text-stone-500 mt-0.5">
                  Legal entity structure, industry sector, operating vintage, and handling officer.
                </p>
              </div>

              <label className="inline-flex items-center gap-2 text-xs font-medium text-stone-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.isFictionalDemo}
                  onChange={(e) => patchForm((prev) => ({ ...prev, isFictionalDemo: e.target.checked }))}
                  className="w-4 h-4 rounded border-stone-300 text-orange-600 focus:ring-orange-500"
                />
                <span>Label as Fictional Demo Record</span>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {textField('applicantLabel', 'Company / Applicant Name', {
                value: form.applicantLabel,
                required: true,
                className: 'md:col-span-2',
                placeholder: 'e.g.,Registered Enterprise or Individual Borrower Name',
              })}

              {selectField(
                'entityType',
                'Legal Entity Structure',
                form.entityType,
                [
                  { value: 'individual', label: 'Individual Applicant' },
                  { value: 'proprietorship', label: 'Sole Proprietorship' },
                  { value: 'partnership', label: 'Partnership Firm' },
                  { value: 'llp', label: 'Limited Liability Partnership (LLP)' },
                  { value: 'private_limited', label: 'Private Limited Company' },
                  { value: 'public_limited', label: 'Public Limited Company' },
                  { value: 'trust_society', label: 'Trust / Society' },
                ] satisfies Array<{ value: EntityStructureType; label: string }>
              )}

              {textField('industrySector', 'Industry / Business Sector', {
                value: form.industrySector,
                placeholder: 'e.g., Manufacturing, Healthcare, Logistics, Retail',
              })}

              {textField('businessVintageYears', 'Business Operating Vintage (Years)', {
                value: form.businessVintageYears,
                type: 'number',
                min: 0,
                max: 200,
                mono: true,
                placeholder: 'Leave blank if unknown',
              })}

              {selectField('gstTaxCompliant', 'GST / Tax Registration Compliant', form.gstTaxCompliant, [
                { value: 'not_provided', label: 'Not Verified Yet' },
                { value: 'yes', label: 'Yes — Active & Compliant' },
                { value: 'no', label: 'No / Exempt' },
              ])}

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-stone-700">Assigned LoanBazaar Employee</label>
                <input
                  type="text"
                  value={form.assignedOfficer}
                  onChange={(e) => patchForm((prev) => ({ ...prev, assignedOfficer: e.target.value }))}
                  placeholder="Employee Name / Email"
                  className={INPUT}
                />
              </div>

              <div className="md:col-span-2 space-y-1.5">
                <label className="block text-xs font-medium text-stone-700">Branch / Advisory Desk</label>
                <input
                  type="text"
                  value={form.branchOrDesk}
                  onChange={(e) => patchForm((prev) => ({ ...prev, branchOrDesk: e.target.value }))}
                  placeholder="e.g., Central Advisory Desk"
                  className={INPUT}
                />
              </div>
            </div>
          </div>

          {/* Section 2: Funding Purpose, Amount & Dynamic Questions */}
          <div className="p-6 sm:p-8 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-stone-900 font-display">
                02. Funding Purpose, Amount & Dynamic Requirements
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Questions adapt automatically based on the selected financing purpose for Stage 1 Requirement Matching.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {selectField(
                'fundingPurpose',
                'Primary Funding Purpose',
                form.fundingPurpose,
                [
                  { value: 'working_capital', label: 'Working Capital & Inventory' },
                  { value: 'machinery_equipment', label: 'Machinery & Equipment Purchase' },
                  { value: 'commercial_property', label: 'Commercial Property / Expansion' },
                  { value: 'invoice_discounting', label: 'Invoice / Bill Discounting' },
                  { value: 'debt_consolidation', label: 'Debt Consolidation / Refinance' },
                  { value: 'project_expansion', label: 'Project / Infrastructure Finance' },
                  { value: 'trade_import_export', label: 'Trade / Import-Export Finance' },
                  { value: 'general_business', label: 'General Business Requirement' },
                ] satisfies Array<{ value: FundingPurposeCategory; label: string }>,
                { required: true }
              )}

              {textField('requestedAmount', `Requested Facility Amount (${form.currency})`, {
                value: form.requestedAmount,
                required: true,
                type: 'number',
                min: 0,
                mono: true,
                placeholder: 'e.g., 5000000',
              })}

              {textField('requestedTenureMonths', 'Requested Tenure (Months)', {
                value: form.requestedTenureMonths,
                required: true,
                type: 'number',
                min: 1,
                max: 480,
                mono: true,
                placeholder: 'e.g., 60',
              })}
            </div>

            {dynamicFields.length > 0 && (
              <div className="pt-4 border-t border-stone-200/80 space-y-3">
                <div className="text-xs font-semibold text-amber-800">Purpose-Specific Intake Questions</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {dynamicFields.map((definition) => {
                    const value = readField(form, definition);
                    return (
                      <div key={definition.fieldId}>
                        {definition.allowedValues.length > 0
                          ? selectField(
                              definition.fieldId,
                              definition.label,
                              value,
                              definition.allowedValues.map((o) => ({ value: o, label: o })),
                              { small: true, blankLabel: 'Not specified yet' }
                            )
                          : textField(definition.fieldId, definition.label, {
                              value,
                              small: true,
                              placeholder: definition.placeholder,
                            })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Section 3: Turnover, Credit Profile & Financial Information */}
          <div className="p-6 sm:p-8 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-stone-900 font-display">
                03. Turnover, Credit Profile & Financial Information
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Leave unknown metrics blank—the matching engine will flag missing mandatory inputs rather than guessing
                eligibility.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
              {textField('annualTurnoverOrIncome', `Annual Turnover / Income (${form.currency})`, {
                value: form.annualTurnoverOrIncome,
                type: 'number',
                min: 0,
                mono: true,
                placeholder: 'e.g., 25000000',
              })}
              {textField('creditScore', 'Credit Bureau Score (CIBIL / Commercial)', {
                value: form.creditScore,
                type: 'number',
                min: 300,
                max: 900,
                mono: true,
                placeholder: 'e.g., 740 (or leave blank)',
              })}
              {selectField(
                'profitabilityStatus',
                'Profitability Track Record',
                form.profitabilityStatus,
                [
                  { value: 'not_provided', label: 'Not Provided Yet' },
                  { value: 'profitable_2plus_years', label: 'Profitable (Last 2+ Years)' },
                  { value: 'profitable_1_year', label: 'Profitable (Last 1 Year)' },
                  { value: 'breakeven_or_early', label: 'Break-Even / Early Stage' },
                  { value: 'loss_making', label: 'Net Loss Reported' },
                ] satisfies Array<{ value: ProfitabilityStatus; label: string }>
              )}
              {textField('existingEmiObligations', `Existing Monthly EMI (${form.currency})`, {
                value: form.existingEmiObligations,
                type: 'number',
                min: 0,
                mono: true,
                placeholder: 'e.g., 85000',
              })}
            </div>
          </div>

          {/* Section 4: Financial Assessment & Credit Signals */}
          <div className="p-6 sm:p-8 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-stone-900 font-display">
                04. Financial Assessment & Credit Signals
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Capture the latest completed FY and key credit metrics for lender-specific eligibility matching. Profit,
                EBITDA, EBIT, net worth, cash flow and bank balance can be negative.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
              {MAIN_FINANCIAL_FIELD_IDS.map((id) => financialField(id))}
            </div>

            <div className="border border-stone-200 rounded-lg">
              <button
                type="button"
                onClick={() => setMoreOpen((open) => !open)}
                aria-expanded={moreOpen}
                className="w-full flex items-center gap-2 px-3.5 py-2.5 text-xs font-semibold text-stone-800 text-left cursor-pointer"
              >
                {moreOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                More financial details
                <span className="font-normal text-stone-500">({MORE_FINANCIAL_FIELD_IDS.length} optional inputs)</span>
              </button>
              {moreOpen && (
                <div className="px-3.5 pb-4 pt-1 grid grid-cols-1 md:grid-cols-4 gap-5">
                  {MORE_FINANCIAL_FIELD_IDS.map((id) => financialField(id))}
                </div>
              )}
            </div>
          </div>

          {/* Section 5: Collateral & Other Relevant Requirements */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-stone-900 font-display">
                  05. Collateral Availability & Custom Requirements
                </h2>
                <p className="text-xs text-stone-500 mt-0.5">
                  Record available security and any specialized borrower parameters.
                </p>
              </div>
              <button
                type="button"
                onClick={handleAddCustomAttribute}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200/80 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Custom Field</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
              <FieldShell fieldId="collateralAvailable" label="Collateral / Security Available" className="md:col-span-4">
                <SegmentedControl
                  options={[
                    { value: 'no', label: 'Unsecured / None' },
                    { value: 'yes', label: 'Collateral Available' },
                  ]}
                  value={form.collateralAvailable}
                  onChange={(val) => setValue('collateralAvailable', val, 'typed')}
                />
              </FieldShell>

              {textField('collateralType', 'Collateral Asset Type', {
                value: form.collateralType,
                disabled: stillCollateralOff,
                className: 'md:col-span-4',
                placeholder: 'e.g., Residential, Commercial, Machinery, FD',
              })}

              {textField('collateralValue', `Estimated Collateral Value (${form.currency})`, {
                value: form.collateralValue,
                type: 'number',
                min: 0,
                mono: true,
                disabled: stillCollateralOff,
                className: 'md:col-span-4',
                placeholder: 'e.g., 15000000',
              })}
            </div>

            {textField('collateralDescription', 'Collateral / Security Summary', {
              value: form.collateralDescription,
              placeholder: 'Location, ownership clarity, or unsecured preference details',
            })}

            {form.customAttributes.length > 0 && (
              <div className="space-y-2.5 pt-2">
                {form.customAttributes.map((attr) => (
                  <div key={attr.id} className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                    <input
                      type="text"
                      value={attr.key}
                      onChange={(e) => handleUpdateCustomAttribute(attr.id, 'key', e.target.value)}
                      placeholder="Parameter Name"
                      className="sm:col-span-5 px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                    <input
                      type="text"
                      value={attr.value}
                      onChange={(e) => handleUpdateCustomAttribute(attr.id, 'value', e.target.value)}
                      placeholder="Recorded Value"
                      className="sm:col-span-6 px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveCustomAttribute(attr.id)}
                      aria-label="Remove custom attribute"
                      className="sm:col-span-1 p-2 text-stone-400 hover:text-red-600 rounded-lg transition-colors justify-self-end cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-1">
              <FieldShell fieldId="statedPurpose" label="Detailed Funding Requirement & Use Case">
                <textarea
                  rows={3}
                  value={form.statedPurpose}
                  onChange={(e) => setValue('statedPurpose', e.target.value, 'typed')}
                  placeholder="Describe end-use of funds and operational background..."
                  className={INPUT}
                />
              </FieldShell>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-stone-700">Internal Employee Notes</label>
                <textarea
                  rows={3}
                  value={form.advisorNotes}
                  onChange={(e) => patchForm((prev) => ({ ...prev, advisorNotes: e.target.value }))}
                  placeholder="Optional document readiness or credit observations..."
                  className={INPUT}
                />
              </div>
            </div>
          </div>

          {/* Form Actions */}
          <div className="px-6 sm:px-8 py-4 bg-stone-50/70 space-y-3 rounded-b-xl">
            {unresolvedWarning !== null && unresolvedWarning > 0 && <UnresolvedWarning count={unresolvedWarning} />}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <span className="text-xs text-stone-500">
                Submitting saves the borrower profile and opens the Two-Stage Product Matching Engine.
              </span>

              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={state.isMutating}
                  onClick={() => void submitForm(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Draft</span>
                </button>

                <button
                  type="submit"
                  disabled={state.isMutating}
                  className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {unresolvedWarning !== null && unresolvedWarning > 0
                      ? 'Submit Anyway'
                      : 'Submit & Find Matching Products'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </DocAiFieldContext.Provider>
  );
}
