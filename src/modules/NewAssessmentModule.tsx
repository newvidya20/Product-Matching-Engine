import React, { useState } from 'react';
import { Beaker, Plus, RotateCcw, Save, Send, Trash2 } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import { PageHeader, SegmentedControl } from '../components/ui/Primitives';
import type {
  EntityStructureType,
  FundingPurposeCategory,
  KeyValueAttribute,
  ProfitabilityStatus,
} from '../types/domain';

interface DynamicQuestionSpec {
  key: string;
  label: string;
  placeholder: string;
  options?: string[];
}

const DYNAMIC_QUESTIONS_BY_PURPOSE: Record<
  FundingPurposeCategory,
  DynamicQuestionSpec[]
> = {
  working_capital: [
    {
      key: 'receivableDays',
      label: 'Average Debtor / Receivable Cycle (Days)',
      placeholder: 'e.g., 45 Days',
    },
    {
      key: 'inventoryHoldingDays',
      label: 'Average Inventory Holding Period (Days)',
      placeholder: 'e.g., 30 Days',
    },
    {
      key: 'existingCashCreditOd',
      label: 'Existing Sanctioned CC / OD Facility',
      placeholder: 'Select status',
      options: ['None', 'Existing CC/OD — Enhancement Needed', 'Existing CC/OD — Takeover'],
    },
  ],
  machinery_equipment: [
    {
      key: 'equipmentCondition',
      label: 'Equipment Type & Origin',
      placeholder: 'Select condition',
      options: [
        'New Domestic Equipment',
        'New Imported Equipment',
        'Used / Refurbished Equipment',
      ],
    },
    {
      key: 'supplierQuotationReady',
      label: 'Proforma Invoice / Vendor Quotation Available',
      placeholder: 'Select',
      options: ['Yes', 'Pending Quotation'],
    },
    {
      key: 'borrowerMarginPercent',
      label: 'Borrower Down Payment / Margin Contribution (%)',
      placeholder: 'e.g., 20%',
    },
  ],
  commercial_property: [
    {
      key: 'propertyOccupancy',
      label: 'Property Occupancy & Stage',
      placeholder: 'Select stage',
      options: [
        'Ready Self-Occupied Commercial',
        'Ready Leased / Rental Yield',
        'Industrial Shed / Factory',
        'Under Construction',
      ],
    },
    {
      key: 'clearMarketableTitle',
      label: 'Clear Marketable Title & Approved Plan Available',
      placeholder: 'Select',
      options: ['Yes', 'In Verification', 'No'],
    },
  ],
  invoice_discounting: [
    {
      key: 'anchorBuyerProfile',
      label: 'Counterparty / Anchor Buyer Category',
      placeholder: 'Select buyer profile',
      options: [
        'Listed Corporate / MNC',
        'Government / PSU',
        'Mid-Market Private Enterprise',
        'MSME Buyer',
      ],
    },
    {
      key: 'averageInvoiceTenorDays',
      label: 'Invoice Credit Period (Days)',
      placeholder: 'e.g., 60 Days',
    },
    {
      key: 'acceptedInvoicesAvailable',
      label: 'Accepted Invoices / Confirmed Delivery Proof Ready',
      placeholder: 'Select',
      options: ['Yes', 'Purchase Order Stage Only'],
    },
  ],
  debt_consolidation: [
    {
      key: 'existingLenderCount',
      label: 'Number of Active Facilities to Consolidate',
      placeholder: 'e.g., 3 Facilities',
    },
    {
      key: 'repaymentTrackLast12M',
      label: 'Last 12 Months Repayment Track Record',
      placeholder: 'Select track record',
      options: ['0 DPD (Clean Track)', 'Minor Delays (<30 DPD)', '30+ DPD Observed'],
    },
  ],
  project_expansion: [
    {
      key: 'dprPrepared',
      label: 'Detailed Project Report (DPR) & Financial Projections Ready',
      placeholder: 'Select',
      options: ['Yes — Ready', 'In Preparation', 'No'],
    },
    {
      key: 'promoterContributionPercent',
      label: 'Promoter Equity Contribution (%)',
      placeholder: 'e.g., 25%',
    },
  ],
  trade_import_export: [
    {
      key: 'iecCodeAvailable',
      label: 'Valid Import-Export Code (IEC) Available',
      placeholder: 'Select',
      options: ['Yes', 'No'],
    },
    {
      key: 'tradeInstrument',
      label: 'Backing Trade Instrument',
      placeholder: 'Select instrument',
      options: ['Confirmed Letter of Credit (LC)', 'Confirmed Export Order', 'Open Account'],
    },
  ],
  general_business: [
    {
      key: 'deploymentTimeline',
      label: 'Expected Disbursement Timeline',
      placeholder: 'Select urgency',
      options: ['Immediate (Within 15 Days)', 'Standard (15–30 Days)', 'Planning (30+ Days)'],
    },
  ],
};

interface FormState {
  applicantLabel: string;
  entityType: EntityStructureType;
  industrySector: string;
  businessVintageYears: string;
  gstTaxCompliant: 'yes' | 'no' | 'not_provided';
  fundingPurpose: FundingPurposeCategory;
  dynamicPurposeAnswers: Record<string, string>;
  assignedOfficer: string;
  branchOrDesk: string;
  requestedAmount: string;
  currency: string;
  requestedTenureMonths: string;
  annualTurnoverOrIncome: string;
  creditScore: string;
  existingEmiObligations: string;
  profitabilityStatus: ProfitabilityStatus;
  collateralAvailable: 'yes' | 'no';
  collateralType: string;
  collateralValue: string;
  collateralDescription: string;
  statedPurpose: string;
  advisorNotes: string;
  isFictionalDemo: boolean;
  customAttributes: KeyValueAttribute[];
}

function createBlankForm(defaultCurrency: string, officerDefault = ''): FormState {
  return {
    applicantLabel: '',
    entityType: 'private_limited',
    industrySector: '',
    businessVintageYears: '',
    gstTaxCompliant: 'not_provided',
    fundingPurpose: 'working_capital',
    dynamicPurposeAnswers: {},
    assignedOfficer: officerDefault,
    branchOrDesk: 'Central Advisory Desk',
    requestedAmount: '',
    currency: defaultCurrency || 'INR',
    requestedTenureMonths: '36',
    annualTurnoverOrIncome: '',
    creditScore: '',
    existingEmiObligations: '',
    profitabilityStatus: 'not_provided',
    collateralAvailable: 'no',
    collateralType: '',
    collateralValue: '',
    collateralDescription: '',
    statedPurpose: '',
    advisorNotes: '',
    isFictionalDemo: false,
    customAttributes: [],
  };
}

export function NewAssessmentModule() {
  const { state, createAssessment } = useAppState();
  const officerDefault =
    state.currentUser?.displayName || state.currentUser?.email || '';

  const [form, setForm] = useState<FormState>(() =>
    createBlankForm(state.settings.defaultCurrency, officerDefault)
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const dynamicQuestions =
    DYNAMIC_QUESTIONS_BY_PURPOSE[form.fundingPurpose] || [];

  const handleLoadFictionalSample = () => {
    setValidationError(null);
    setForm({
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
      currency: state.settings.defaultCurrency || 'INR',
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
      statedPurpose:
        'Fictional sample intake: automated CNC assembly line acquisition.',
      advisorNotes:
        'Populate the borrower profile to test product fit analysis against the approved catalogue.',
      isFictionalDemo: true,
      customAttributes: [],
    });
  };

  const handleReset = () => {
    setValidationError(null);
    setForm(createBlankForm(state.settings.defaultCurrency, officerDefault));
  };

  const handleDynamicAnswerChange = (key: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      dynamicPurposeAnswers: {
        ...prev.dynamicPurposeAnswers,
        [key]: value,
      },
    }));
  };

  const handleAddCustomAttribute = () => {
    setForm((prev) => ({
      ...prev,
      customAttributes: [
        ...prev.customAttributes,
        { id: `ca-${Date.now()}`, key: '', value: '' },
      ],
    }));
  };

  const handleUpdateCustomAttribute = (
    id: string,
    field: 'key' | 'value',
    val: string
  ) => {
    setForm((prev) => ({
      ...prev,
      customAttributes: prev.customAttributes.map((item) =>
        item.id === id ? { ...item, [field]: val } : item
      ),
    }));
  };

  const handleRemoveCustomAttribute = (id: string) => {
    setForm((prev) => ({
      ...prev,
      customAttributes: prev.customAttributes.filter((item) => item.id !== id),
    }));
  };

  const submitForm = async (asDraft: boolean) => {
    setValidationError(null);

    if (!form.applicantLabel.trim()) {
      setValidationError(
        'Enter the company or applicant name before saving.'
      );
      return;
    }

    const parsedAmount = Number(form.requestedAmount);
    if (!asDraft && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
      setValidationError(
        'Enter a valid requested facility amount greater than zero.'
      );
      return;
    }

    const parsedTenure = Number(form.requestedTenureMonths);
    if (!Number.isFinite(parsedTenure) || parsedTenure <= 0) {
      setValidationError('Enter a valid requested tenure in months.');
      return;
    }

    const cleanAttributes = form.customAttributes.filter(
      (a) => a.key.trim().length > 0
    );

    await createAssessment(
      {
        applicantLabel: form.applicantLabel.trim(),
        entityType: form.entityType,
        industrySector: form.industrySector.trim(),
        businessVintageYears:
          form.businessVintageYears.trim() !== ''
            ? Number(form.businessVintageYears)
            : null,
        gstTaxCompliant: form.gstTaxCompliant,
        fundingPurpose: form.fundingPurpose,
        dynamicPurposeAnswers: form.dynamicPurposeAnswers,
        assignedOfficer: form.assignedOfficer.trim() || 'Internal Desk Officer',
        branchOrDesk: form.branchOrDesk.trim() || 'Central Advisory Desk',
        requestedAmount: Number.isFinite(parsedAmount) ? parsedAmount : 0,
        currency: form.currency,
        requestedTenureMonths: parsedTenure,
        annualTurnoverOrIncome: Number(form.annualTurnoverOrIncome) || 0,
        creditScore:
          form.creditScore.trim() !== '' ? Number(form.creditScore) : null,
        existingEmiObligations:
          form.existingEmiObligations.trim() !== ''
            ? Number(form.existingEmiObligations)
            : null,
        profitabilityStatus: form.profitabilityStatus,
        collateralAvailable: form.collateralAvailable === 'yes',
        collateralType: form.collateralType.trim(),
        collateralValue:
          form.collateralValue.trim() !== ''
            ? Number(form.collateralValue)
            : null,
        collateralDescription: form.collateralDescription.trim(),
        statedPurpose: form.statedPurpose.trim(),
        advisorNotes: form.advisorNotes.trim(),
        isFictionalDemo: form.isFictionalDemo,
        customAttributes: cleanAttributes,
        status: asDraft ? 'draft' : 'submitted',
      },
      !asDraft
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Borrower Assessment"
        description="Capture company profile, funding purpose with dynamic questions, business turnover & vintage, credit profile, financials, and collateral availability."
        metadataItems={[
          'Dynamic Purpose Intake',
          state.workspaceConfig.spreadsheetId
            ? 'Saves to Borrower_Assessments Sheet'
            : 'Local Workspace Storage',
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
        <div
          role="alert"
          className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 font-medium"
        >
          {validationError}
        </div>
      )}

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
              <h2 className="text-base font-semibold text-stone-900 font-display">
                01. Company & Business Details
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Legal entity structure, industry sector, operating vintage, and handling officer.
              </p>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-stone-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.isFictionalDemo}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    isFictionalDemo: e.target.checked,
                  }))
                }
                className="w-4 h-4 rounded border-stone-300 text-orange-600 focus:ring-orange-500"
              />
              <span>Label as Fictional Demo Record</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="md:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Company / Applicant Name <span className="text-orange-600">*</span>
              </label>
              <input
                type="text"
                value={form.applicantLabel}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    applicantLabel: e.target.value,
                  }))
                }
                placeholder="e.g.,Registered Enterprise or Individual Borrower Name"
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Legal Entity Structure
              </label>
              <select
                value={form.entityType}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    entityType: e.target.value as EntityStructureType,
                  }))
                }
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              >
                <option value="individual">Individual Applicant</option>
                <option value="proprietorship">Sole Proprietorship</option>
                <option value="partnership">Partnership Firm</option>
                <option value="llp">Limited Liability Partnership (LLP)</option>
                <option value="private_limited">Private Limited Company</option>
                <option value="public_limited">Public Limited Company</option>
                <option value="trust_society">Trust / Society</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Industry / Business Sector
              </label>
              <input
                type="text"
                value={form.industrySector}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    industrySector: e.target.value,
                  }))
                }
                placeholder="e.g., Manufacturing, Healthcare, Logistics, Retail"
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Business Operating Vintage (Years)
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={form.businessVintageYears}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    businessVintageYears: e.target.value,
                  }))
                }
                placeholder="Leave blank if unknown"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                GST / Tax Registration Compliant
              </label>
              <select
                value={form.gstTaxCompliant}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    gstTaxCompliant: e.target.value as
                      | 'yes'
                      | 'no'
                      | 'not_provided',
                  }))
                }
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              >
                <option value="not_provided">Not Verified Yet</option>
                <option value="yes">Yes — Active & Compliant</option>
                <option value="no">No / Exempt</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Assigned LoanBazaar Employee
              </label>
              <input
                type="text"
                value={form.assignedOfficer}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    assignedOfficer: e.target.value,
                  }))
                }
                placeholder="Employee Name / Email"
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="md:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Branch / Advisory Desk
              </label>
              <input
                type="text"
                value={form.branchOrDesk}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, branchOrDesk: e.target.value }))
                }
                placeholder="e.g., Central Advisory Desk"
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
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
              Questions adapt automatically based on the selected financing purpose for Stage 1
              Requirement Matching.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Primary Funding Purpose <span className="text-orange-600">*</span>
              </label>
              <select
                value={form.fundingPurpose}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    fundingPurpose: e.target.value as FundingPurposeCategory,
                    dynamicPurposeAnswers: {},
                  }))
                }
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              >
                <option value="working_capital">Working Capital & Inventory</option>
                <option value="machinery_equipment">
                  Machinery & Equipment Purchase
                </option>
                <option value="commercial_property">
                  Commercial Property / Expansion
                </option>
                <option value="invoice_discounting">
                  Invoice / Bill Discounting
                </option>
                <option value="debt_consolidation">
                  Debt Consolidation / Refinance
                </option>
                <option value="project_expansion">
                  Project / Infrastructure Finance
                </option>
                <option value="trade_import_export">
                  Trade / Import-Export Finance
                </option>
                <option value="general_business">
                  General Business Requirement
                </option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Requested Facility Amount ({form.currency}){' '}
                <span className="text-orange-600">*</span>
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={form.requestedAmount}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    requestedAmount: e.target.value,
                  }))
                }
                placeholder="e.g., 5000000"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Requested Tenure (Months) <span className="text-orange-600">*</span>
              </label>
              <input
                type="number"
                min="1"
                max="480"
                value={form.requestedTenureMonths}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    requestedTenureMonths: e.target.value,
                  }))
                }
                placeholder="e.g., 60"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>
          </div>

          {/* Dynamic Purpose-Specific Questions */}
          {dynamicQuestions.length > 0 && (
            <div className="pt-4 border-t border-stone-200/80 space-y-3">
              <div className="text-xs font-semibold text-amber-800">
                Purpose-Specific Intake Questions
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {dynamicQuestions.map((q) => (
                  <div key={q.key} className="space-y-1.5">
                    <label className="block text-xs font-medium text-stone-700">
                      {q.label}
                    </label>
                    {q.options ? (
                      <select
                        value={form.dynamicPurposeAnswers[q.key] || ''}
                        onChange={(e) =>
                          handleDynamicAnswerChange(q.key, e.target.value)
                        }
                        className="w-full px-3 py-2 text-xs bg-stone-50/70 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                      >
                        <option value="">Not specified yet</option>
                        {q.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={form.dynamicPurposeAnswers[q.key] || ''}
                        onChange={(e) =>
                          handleDynamicAnswerChange(q.key, e.target.value)
                        }
                        placeholder={q.placeholder}
                        className="w-full px-3 py-2 text-xs bg-stone-50/70 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                      />
                    )}
                  </div>
                ))}
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
              Leave unknown metrics blank—the matching engine will flag missing mandatory inputs
              rather than guessing eligibility.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Annual Turnover / Income ({form.currency})
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={form.annualTurnoverOrIncome}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    annualTurnoverOrIncome: e.target.value,
                  }))
                }
                placeholder="e.g., 25000000"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Credit Bureau Score (CIBIL / Commercial)
              </label>
              <input
                type="number"
                min="300"
                max="900"
                value={form.creditScore}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, creditScore: e.target.value }))
                }
                placeholder="e.g., 740 (or leave blank)"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Profitability Track Record
              </label>
              <select
                value={form.profitabilityStatus}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    profitabilityStatus: e.target.value as ProfitabilityStatus,
                  }))
                }
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              >
                <option value="not_provided">Not Provided Yet</option>
                <option value="profitable_2plus_years">
                  Profitable (Last 2+ Years)
                </option>
                <option value="profitable_1_year">
                  Profitable (Last 1 Year)
                </option>
                <option value="breakeven_or_early">
                  Break-Even / Early Stage
                </option>
                <option value="loss_making">Net Loss Reported</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Existing Monthly EMI ({form.currency})
              </label>
              <input
                type="number"
                min="0"
                step="500"
                value={form.existingEmiObligations}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    existingEmiObligations: e.target.value,
                  }))
                }
                placeholder="e.g., 85000"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>
          </div>
        </div>

        {/* Section 4: Collateral & Other Relevant Requirements */}
        <div className="p-6 sm:p-8 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-stone-900 font-display">
                04. Collateral Availability & Custom Requirements
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
            <div className="md:col-span-4 space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Collateral / Security Available
              </label>
              <SegmentedControl
                options={[
                  { value: 'no', label: 'Unsecured / None' },
                  { value: 'yes', label: 'Collateral Available' },
                ]}
                value={form.collateralAvailable}
                onChange={(val) =>
                  setForm((prev) => ({ ...prev, collateralAvailable: val }))
                }
              />
            </div>

            <div className="md:col-span-4 space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Collateral Asset Type
              </label>
              <input
                type="text"
                disabled={form.collateralAvailable === 'no'}
                value={form.collateralType}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    collateralType: e.target.value,
                  }))
                }
                placeholder="e.g., Residential, Commercial, Machinery, FD"
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600 disabled:bg-stone-50 disabled:text-stone-400"
              />
            </div>

            <div className="md:col-span-4 space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Estimated Collateral Value ({form.currency})
              </label>
              <input
                type="number"
                min="0"
                step="10000"
                disabled={form.collateralAvailable === 'no'}
                value={form.collateralValue}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    collateralValue: e.target.value,
                  }))
                }
                placeholder="e.g., 15000000"
                className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600 disabled:bg-stone-50 disabled:text-stone-400"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-stone-700">
              Collateral / Security Summary
            </label>
            <input
              type="text"
              value={form.collateralDescription}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  collateralDescription: e.target.value,
                }))
              }
              placeholder="Location, ownership clarity, or unsecured preference details"
              className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
            />
          </div>

          {form.customAttributes.length > 0 && (
            <div className="space-y-2.5 pt-2">
              {form.customAttributes.map((attr) => (
                <div
                  key={attr.id}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center"
                >
                  <input
                    type="text"
                    value={attr.key}
                    onChange={(e) =>
                      handleUpdateCustomAttribute(attr.id, 'key', e.target.value)
                    }
                    placeholder="Parameter Name"
                    className="sm:col-span-5 px-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
                  />
                  <input
                    type="text"
                    value={attr.value}
                    onChange={(e) =>
                      handleUpdateCustomAttribute(
                        attr.id,
                        'value',
                        e.target.value
                      )
                    }
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
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Detailed Funding Requirement & Use Case
              </label>
              <textarea
                rows={3}
                value={form.statedPurpose}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, statedPurpose: e.target.value }))
                }
                placeholder="Describe end-use of funds and operational background..."
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-stone-700">
                Internal Employee Notes
              </label>
              <textarea
                rows={3}
                value={form.advisorNotes}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, advisorNotes: e.target.value }))
                }
                placeholder="Optional document readiness or credit observations..."
                className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
              />
            </div>
          </div>
        </div>

        {/* Form Actions */}
        <div className="px-6 sm:px-8 py-4 bg-stone-50/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-b-xl">
          <span className="text-xs text-stone-500">
            Submitting saves the borrower profile and opens the Two-Stage Product Matching Engine.
          </span>

          <div className="flex items-center justify-end gap-3">
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
              <span>Submit & Find Matching Products</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
