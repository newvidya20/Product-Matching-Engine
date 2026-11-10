/**
 * Exhaustive field map for Document AI: every key of FormState (NewAssessmentModule)
 * and BorrowerFinancialProfile, plus dynamicPurposeAnswers per purpose.
 * Importable by server and client: no node-only imports. Semantics: docs/contracts.md.
 */
import type {
  BorrowerFinancialProfile,
  FundingPurposeCategory,
} from '../types/domain';
import type { DerivationRuleId, DocumentType, FieldValue } from '../types/documentAi';

export type FormSection = '01' | '02' | '03' | '04' | '05';
export type FieldValueType = 'number' | 'string' | 'enum';

/** How a number reads and renders. Currency is always INR rupees after parsing. */
export type NumericUnit =
  | 'currency'
  | 'score'
  | 'rank'
  | 'years'
  | 'months'
  | 'days'
  | 'percent'
  | 'count'
  | 'ratio';

/**
 * signed: negatives are real (a loss, negative net worth) and are kept.
 * non_negative: a negative fails validation.
 * expense_magnitude: statements print these in parentheses; keep the magnitude.
 */
export type SignPolicy = 'signed' | 'non_negative' | 'expense_magnitude';

/**
 * direct: the model is asked for it.
 * mirror: never asked; copied from primary by the merge step.
 * derived: never asked; computed by the server from other candidates.
 * none: not extractable; dropped even if the model returns it.
 */
export type ExtractionMode = 'direct' | 'mirror' | 'derived' | 'none';

/**
 * stated: any explicit statement in an allowed document.
 * explicit_request: only the borrower's own explicit ask, never inferred.
 * positive_only: a document can establish "yes"; absence never writes "no".
 */
export type ExtractionPolicy = 'stated' | 'explicit_request' | 'positive_only';

/** Option evidence: at least one `any` phrase, and no `none` phrase, in the snippet. */
export interface EnumEvidence {
  any: readonly string[];
  none?: readonly string[];
}

export type FieldTarget =
  | { kind: 'form'; key: string }
  | { kind: 'financial'; key: keyof BorrowerFinancialProfile }
  | { kind: 'ratio'; key: string }
  | { kind: 'dynamic'; purpose: FundingPurposeCategory; key: string }
  /** Extracted and shown in Review; never written to form or assessment. */
  | { kind: 'review_only'; key: string };

export interface FieldDefinition {
  fieldId: string;
  section: FormSection;
  label: string;
  valueType: FieldValueType;
  target: FieldTarget;
  /** Empty for anything other than enum. Values are exact form values. */
  allowedValues: readonly string[];
  /** Document types that may supply it. For mirror/derived, the types that feed it. */
  sourceDocumentTypes: readonly DocumentType[];
  extractable: boolean;
  extractionMode: ExtractionMode;
  policy: ExtractionPolicy;
  /** Submit needs it. See contracts section 4.6: some of these may stay blank. */
  required: boolean;
  /** False for a financial profile field with no input yet; ui-builder adds one. */
  hasVisibleInput: boolean;
  /** Form's initial value. Equal to this means "not yet provided", never "user chose". */
  defaultValue: string | null;
  mirrorOf?: string;
  /** Fallback primaries for a mirror, in order, used only when mirrorOf has no value. */
  mirrorFallbacks?: readonly string[];
  /** A server rule that can supply this when no document states it directly. */
  derivation?: DerivationRuleId;
  unit?: NumericUnit;
  signPolicy?: SignPolicy;
  min?: number;
  max?: number;
  /** Per-period or point-in-time value: conflicts compare within one period. */
  periodScoped?: boolean;
  /** Covers a whole year, so only a full FY period can supply it. Balance-sheet fields stay point-in-time. */
  annualFlow?: boolean;
  /** A sanctioned limit: a trailing Cr means crore even on a bank statement. */
  amountNature?: 'limit';
  /** Enum only: a person always confirms it, whatever the snippet says. */
  alwaysReview?: boolean;
  /** Enum only, by option. An option with no entry cannot auto-apply. */
  enumEvidence?: Readonly<Record<string, EnumEvidence>>;
  /** Rendered for dynamic questions, moved here so there is one source of truth. */
  placeholder?: string;
  notExtractableReason?: string;
}

// ------------------------------------------------------------- Enum values

export const ENTITY_TYPE_VALUES = [
  'individual',
  'proprietorship',
  'partnership',
  'llp',
  'private_limited',
  'public_limited',
  'trust_society',
] as const;

export const FUNDING_PURPOSE_VALUES = [
  'working_capital',
  'machinery_equipment',
  'commercial_property',
  'invoice_discounting',
  'debt_consolidation',
  'project_expansion',
  'trade_import_export',
  'general_business',
] as const satisfies readonly FundingPurposeCategory[];

const YES_NO_NOT_PROVIDED = ['yes', 'no', 'not_provided'] as const;
const PROFITABILITY_VALUES = [
  'profitable_2plus_years',
  'profitable_1_year',
  'breakeven_or_early',
  'loss_making',
  'not_provided',
] as const;
const DATA_SOURCE_VALUES = ['audited', 'provisional', 'management'] as const;
const GST_COMPLIANCE_VALUES = ['compliant', 'not_compliant', 'not_applicable', 'not_provided'] as const;
const CREDIT_REPORT_VALUES = ['available', 'pending', 'not_applicable', 'not_provided'] as const;

const ENTITY_TYPE_EVIDENCE: Readonly<Record<string, EnumEvidence>> = {
  individual: { any: ['individual', 'self employed'] },
  proprietorship: { any: ['proprietor', 'proprietorship', 'proprietary concern', 'sole proprietor'] },
  partnership: { any: ['partnership', 'partnership firm', 'partnership deed'], none: ['limited liability partnership'] },
  llp: { any: ['llp', 'limited liability partnership'] },
  private_limited: { any: ['private limited', 'private company'] },
  public_limited: { any: ['public limited', 'public company'] },
  trust_society: { any: ['trust', 'society', 'societies registration'] },
};

const DATA_SOURCE_EVIDENCE: Readonly<Record<string, EnumEvidence>> = {
  audited: { any: ['audited', 'auditor', 'auditors', 'audit report'], none: ['un audited', 'not audited'] },
  provisional: { any: ['provisional'] },
  management: { any: ['management accounts', 'management certified', 'prepared by management', 'management prepared'] },
};

const CREDIT_REPORT_EVIDENCE: Readonly<Record<string, EnumEvidence>> = {
  available: { any: ['commercial credit report', 'company credit report', 'cmr', 'ccr', 'commercial bureau'] },
};

/** `Collateral offered: No`. Punctuation goes before phrases are compared. */
const COLLATERAL_STATED_ABSENT = ['collateral', 'security'].flatMap((subject) =>
  ['offered', 'provided', 'available'].flatMap((verb) =>
    ['no', 'nil', 'none', 'not'].map((answer) => `${subject} ${verb} ${answer}`)
  )
);

const COLLATERAL_EVIDENCE: Readonly<Record<string, EnumEvidence>> = {
  yes: {
    any: ['collateral', 'security', 'mortgage', 'mortgaged', 'hypothecation', 'hypothecated', 'pledge', 'pledged', 'valuation'],
    none: [
      'no collateral',
      'no security',
      'no mortgage',
      'no pledge',
      'no hypothecation',
      'nil collateral',
      'nil security',
      'without collateral',
      'without security',
      'collateral free',
      'collateral nil',
      'collateral none',
      'collateral not',
      'security nil',
      'security none',
      'security not',
      'not mortgaged',
      'not pledged',
      'not hypothecated',
      'unsecured',
      ...COLLATERAL_STATED_ABSENT,
    ],
  },
};

// -------------------------------------------------------------- Builders

const NAME_SOURCES: readonly DocumentType[] = [
  'gst_certificate',
  'gst_return',
  'financial_statement',
  'itr',
  'pan_card',
  'bank_statement',
  'registration_certificate',
  'loan_application',
  'credit_report',
];
const STATEMENT_SOURCES: readonly DocumentType[] = ['financial_statement', 'itr'];
const BALANCE_SOURCES: readonly DocumentType[] = ['financial_statement'];

type DefinitionInput = Omit<
  FieldDefinition,
  'allowedValues' | 'extractable' | 'extractionMode' | 'policy' | 'required' | 'hasVisibleInput' | 'defaultValue'
> &
  Partial<
    Pick<
      FieldDefinition,
      'allowedValues' | 'extractionMode' | 'policy' | 'required' | 'hasVisibleInput' | 'defaultValue'
    >
  >;

function field(input: DefinitionInput): FieldDefinition {
  const extractionMode = input.extractionMode ?? 'direct';
  // The borrower's own intake profile / loan application states these too (it is the app's own form on
  // paper). Its figures are self-declared, so they sit beside the audited ones and surface as a
  // disagreement when they differ; they are never trusted over a statement.
  const own = input.sourceDocumentTypes ?? [];
  const sources =
    extractionMode === 'direct' && (input.policy ?? 'stated') === 'stated'
      ? [
          ...own,
          ...(own.includes('loan_application') ? [] : (['loan_application'] as const)),
          ...(own.includes('triangulation_report') ? [] : (['triangulation_report'] as const)),
        ]
      : input.sourceDocumentTypes;
  return {
    allowedValues: [],
    policy: 'stated',
    required: false,
    hasVisibleInput: true,
    defaultValue: '',
    ...input,
    sourceDocumentTypes: sources,
    extractionMode,
    extractable: extractionMode !== 'none',
  };
}

function excluded(
  input: Pick<FieldDefinition, 'fieldId' | 'section' | 'label' | 'valueType' | 'target' | 'notExtractableReason'> &
    Partial<FieldDefinition>
): FieldDefinition {
  return field({ sourceDocumentTypes: [], extractionMode: 'none', ...input });
}

function money(
  key: keyof BorrowerFinancialProfile,
  label: string,
  sources: readonly DocumentType[],
  opts: Partial<FieldDefinition> = {}
): FieldDefinition {
  return field({
    fieldId: `financialProfile.${key}`,
    section: '04',
    label,
    valueType: 'number',
    target: { kind: 'financial', key },
    sourceDocumentTypes: sources,
    unit: 'currency',
    signPolicy: 'non_negative',
    periodScoped: true,
    ...opts,
  });
}

function ratio(key: string, label: string): FieldDefinition {
  return excluded({
    fieldId: `financialProfile.ratios.${key}`,
    section: '04',
    label,
    valueType: 'number',
    target: { kind: 'ratio', key },
    unit: 'ratio',
    hasVisibleInput: key === 'dscr',
    notExtractableReason:
      'Computed by calculateFinancialRatios on save, which overwrites any stored value.',
  });
}

function dynamic(
  purpose: FundingPurposeCategory,
  key: string,
  label: string,
  placeholder: string,
  sources: readonly DocumentType[],
  shape: { options?: readonly string[]; unit?: NumericUnit; min?: number; max?: number }
): FieldDefinition {
  return field({
    fieldId: `dynamicPurposeAnswers.${purpose}.${key}`,
    section: '02',
    label,
    valueType: shape.options ? 'enum' : 'number',
    target: { kind: 'dynamic', purpose, key },
    allowedValues: shape.options ?? [],
    sourceDocumentTypes: sources,
    policy: 'explicit_request',
    placeholder,
    unit: shape.unit,
    signPolicy: shape.options ? undefined : 'non_negative',
    min: shape.min,
    max: shape.max,
  });
}

const ANNUAL = { annualFlow: true } as const;
const DAYS = { unit: 'days', min: 0, max: 3650 } as const;
const PERCENT = { unit: 'percent', min: 0, max: 100 } as const;

// ---------------------------------------------------------------- The map

export const FIELD_DEFINITIONS: readonly FieldDefinition[] = [
  // 01. Company & Business Details
  field({
    fieldId: 'applicantLabel',
    section: '01',
    label: 'Company / Applicant Name',
    valueType: 'string',
    target: { kind: 'form', key: 'applicantLabel' },
    sourceDocumentTypes: NAME_SOURCES,
    required: true,
  }),
  field({
    fieldId: 'entityType',
    section: '01',
    label: 'Legal Entity Structure',
    valueType: 'enum',
    target: { kind: 'form', key: 'entityType' },
    allowedValues: ENTITY_TYPE_VALUES,
    enumEvidence: ENTITY_TYPE_EVIDENCE,
    sourceDocumentTypes: [
      'registration_certificate',
      'gst_certificate',
      'financial_statement',
      'itr',
      'loan_application',
    ],
    defaultValue: 'private_limited',
  }),
  field({
    fieldId: 'industrySector',
    section: '01',
    label: 'Industry / Business Sector',
    valueType: 'string',
    target: { kind: 'form', key: 'industrySector' },
    sourceDocumentTypes: [
      'registration_certificate',
      'gst_certificate',
      'financial_statement',
      'loan_application',
    ],
  }),
  field({
    fieldId: 'businessVintageYears',
    section: '01',
    label: 'Business Operating Vintage (Years)',
    valueType: 'number',
    target: { kind: 'form', key: 'businessVintageYears' },
    sourceDocumentTypes: ['registration_certificate', 'gst_certificate', 'loan_application', 'financial_statement', 'itr', 'credit_report'],
    derivation: 'vintage_from_establishment_date',
    unit: 'years',
    signPolicy: 'non_negative',
    min: 0,
    max: 200,
  }),
  field({
    fieldId: 'gstTaxCompliant',
    section: '01',
    label: 'GST / Tax Registration Compliant',
    valueType: 'enum',
    target: { kind: 'form', key: 'gstTaxCompliant' },
    allowedValues: YES_NO_NOT_PROVIDED,
    sourceDocumentTypes: ['gst_certificate', 'gst_return'],
    extractionMode: 'derived',
    derivation: 'gst_compliance_mirror',
    defaultValue: 'not_provided',
  }),
  excluded({
    fieldId: 'assignedOfficer',
    section: '01',
    label: 'Assigned LoanBazaar Employee',
    valueType: 'string',
    target: { kind: 'form', key: 'assignedOfficer' },
    defaultValue: null,
    notExtractableReason: 'Internal routing. A document must not decide it.',
  }),
  excluded({
    fieldId: 'branchOrDesk',
    section: '01',
    label: 'Branch / Advisory Desk',
    valueType: 'string',
    target: { kind: 'form', key: 'branchOrDesk' },
    defaultValue: 'Central Advisory Desk',
    notExtractableReason: 'Internal routing. A document must not decide it.',
  }),
  excluded({
    fieldId: 'isFictionalDemo',
    section: '01',
    label: 'Label as Fictional Demo Record',
    valueType: 'enum',
    target: { kind: 'form', key: 'isFictionalDemo' },
    allowedValues: ['true', 'false'],
    defaultValue: 'false',
    notExtractableReason: 'Controls record classification. A document must not decide it.',
  }),
  field({
    fieldId: 'identity.pan',
    section: '01',
    label: 'PAN (review only)',
    valueType: 'string',
    target: { kind: 'review_only', key: 'pan' },
    sourceDocumentTypes: ['pan_card', 'itr', 'financial_statement', 'credit_report', 'loan_application'],
    hasVisibleInput: false,
    defaultValue: null,
  }),
  field({
    fieldId: 'identity.gstin',
    section: '01',
    label: 'GSTIN (review only)',
    valueType: 'string',
    target: { kind: 'review_only', key: 'gstin' },
    sourceDocumentTypes: ['gst_certificate', 'gst_return', 'loan_application'],
    hasVisibleInput: false,
    defaultValue: null,
  }),
  field({
    fieldId: 'identity.dateOfEstablishment',
    section: '01',
    label: 'Date of Incorporation / Registration (review only)',
    valueType: 'string',
    target: { kind: 'review_only', key: 'dateOfEstablishment' },
    sourceDocumentTypes: ['registration_certificate', 'gst_certificate', 'financial_statement', 'itr', 'credit_report'],
    hasVisibleInput: false,
    defaultValue: null,
  }),

  // The triangulation report's own printed (provisional) ratios: shown for review, never computed or applied.
  field({
    fieldId: 'review.statedDscr',
    section: '04',
    label: "DSCR as printed in the report (provisional, review only)",
    valueType: 'string',
    target: { kind: 'review_only', key: 'statedDscr' },
    sourceDocumentTypes: ['triangulation_report'],
    hasVisibleInput: false,
    defaultValue: null,
  }),
  // The intake profile's "Credit Bureau Score (CIBIL / Commercial)" row: kept for review beside the personal CIBIL,
  // never merged into it (the two values can differ and the profile does not say whose score it is).
  field({
    fieldId: 'review.bureauScore',
    section: '03',
    label: 'Credit Bureau Score as printed (review only)',
    valueType: 'string',
    target: { kind: 'review_only', key: 'bureauScore' },
    sourceDocumentTypes: ['loan_application', 'triangulation_report'],
    hasVisibleInput: false,
    defaultValue: null,
  }),
  field({
    fieldId: 'review.statedTolTnw',
    section: '04',
    label: "TOL / TNW as printed in the report (provisional, review only)",
    valueType: 'string',
    target: { kind: 'review_only', key: 'statedTolTnw' },
    sourceDocumentTypes: ['triangulation_report'],
    hasVisibleInput: false,
    defaultValue: null,
  }),

  // 02. Funding Purpose, Amount & Dynamic Requirements
  field({
    fieldId: 'fundingPurpose',
    section: '02',
    label: 'Primary Funding Purpose',
    valueType: 'enum',
    target: { kind: 'form', key: 'fundingPurpose' },
    allowedValues: FUNDING_PURPOSE_VALUES,
    sourceDocumentTypes: ['loan_application'],
    policy: 'explicit_request',
    required: true,
    defaultValue: 'working_capital',
  }),
  field({
    fieldId: 'requestedAmount',
    section: '02',
    label: 'Requested Facility Amount',
    valueType: 'number',
    target: { kind: 'form', key: 'requestedAmount' },
    sourceDocumentTypes: ['loan_application'],
    policy: 'explicit_request',
    required: true,
    unit: 'currency',
    signPolicy: 'non_negative',
  }),
  excluded({
    fieldId: 'currency',
    section: '02',
    label: 'Currency',
    valueType: 'string',
    target: { kind: 'form', key: 'currency' },
    defaultValue: null,
    notExtractableReason:
      'Workspace setting. Amounts are normalised to INR; a non-INR amount fails validation.',
  }),
  field({
    fieldId: 'requestedTenureMonths',
    section: '02',
    label: 'Requested Tenure (Months)',
    valueType: 'number',
    target: { kind: 'form', key: 'requestedTenureMonths' },
    sourceDocumentTypes: ['loan_application'],
    policy: 'explicit_request',
    required: true,
    defaultValue: '36',
    unit: 'months',
    signPolicy: 'non_negative',
    min: 1,
    max: 480,
  }),

  dynamic('working_capital', 'receivableDays', 'Average Debtor / Receivable Cycle (Days)', 'e.g., 45 Days',
    ['loan_application'], DAYS),
  dynamic('working_capital', 'inventoryHoldingDays', 'Average Inventory Holding Period (Days)', 'e.g., 30 Days',
    ['loan_application'], DAYS),
  dynamic('working_capital', 'existingCashCreditOd', 'Existing Sanctioned CC / OD Facility', 'Select status',
    ['loan_application'], {
      options: ['None', 'Existing CC/OD — Enhancement Needed', 'Existing CC/OD — Takeover'],
    }),

  dynamic('machinery_equipment', 'equipmentCondition', 'Equipment Type & Origin', 'Select condition',
    ['quotation_invoice', 'loan_application'], {
      options: ['New Domestic Equipment', 'New Imported Equipment', 'Used / Refurbished Equipment'],
    }),
  dynamic('machinery_equipment', 'supplierQuotationReady', 'Proforma Invoice / Vendor Quotation Available', 'Select',
    ['quotation_invoice', 'loan_application'], { options: ['Yes', 'Pending Quotation'] }),
  dynamic('machinery_equipment', 'borrowerMarginPercent', 'Borrower Down Payment / Margin Contribution (%)', 'e.g., 20%',
    ['loan_application', 'quotation_invoice'], PERCENT),

  dynamic('commercial_property', 'propertyOccupancy', 'Property Occupancy & Stage', 'Select stage',
    ['collateral_valuation', 'loan_application'], {
      options: [
        'Ready Self-Occupied Commercial',
        'Ready Leased / Rental Yield',
        'Industrial Shed / Factory',
        'Under Construction',
      ],
    }),
  dynamic('commercial_property', 'clearMarketableTitle', 'Clear Marketable Title & Approved Plan Available', 'Select',
    ['collateral_valuation', 'loan_application'], { options: ['Yes', 'In Verification', 'No'] }),

  dynamic('invoice_discounting', 'anchorBuyerProfile', 'Counterparty / Anchor Buyer Category', 'Select buyer profile',
    ['loan_application'], {
      options: [
        'Listed Corporate / MNC',
        'Government / PSU',
        'Mid-Market Private Enterprise',
        'MSME Buyer',
      ],
    }),
  dynamic('invoice_discounting', 'averageInvoiceTenorDays', 'Invoice Credit Period (Days)', 'e.g., 60 Days',
    ['loan_application', 'quotation_invoice'], DAYS),
  dynamic('invoice_discounting', 'acceptedInvoicesAvailable', 'Accepted Invoices / Confirmed Delivery Proof Ready', 'Select',
    ['loan_application'], { options: ['Yes', 'Purchase Order Stage Only'] }),

  dynamic('debt_consolidation', 'existingLenderCount', 'Number of Active Facilities to Consolidate', 'e.g., 3 Facilities',
    ['loan_application'], { unit: 'count', min: 0, max: 100 }),
  dynamic('debt_consolidation', 'repaymentTrackLast12M', 'Last 12 Months Repayment Track Record', 'Select track record',
    ['loan_application'], {
      options: ['0 DPD (Clean Track)', 'Minor Delays (<30 DPD)', '30+ DPD Observed'],
    }),

  dynamic('project_expansion', 'dprPrepared', 'Detailed Project Report (DPR) & Financial Projections Ready', 'Select',
    ['loan_application'], { options: ['Yes — Ready', 'In Preparation', 'No'] }),
  dynamic('project_expansion', 'promoterContributionPercent', 'Promoter Equity Contribution (%)', 'e.g., 25%',
    ['loan_application'], PERCENT),

  dynamic('trade_import_export', 'iecCodeAvailable', 'Valid Import-Export Code (IEC) Available', 'Select',
    ['registration_certificate', 'loan_application'], { options: ['Yes', 'No'] }),
  dynamic('trade_import_export', 'tradeInstrument', 'Backing Trade Instrument', 'Select instrument',
    ['loan_application'], {
      options: ['Confirmed Letter of Credit (LC)', 'Confirmed Export Order', 'Open Account'],
    }),

  dynamic('general_business', 'deploymentTimeline', 'Expected Disbursement Timeline', 'Select urgency',
    ['loan_application'], {
      options: ['Immediate (Within 15 Days)', 'Standard (15–30 Days)', 'Planning (30+ Days)'],
    }),

  // 03. Turnover, Credit Profile & Financial Information
  field({
    fieldId: 'annualTurnoverOrIncome',
    section: '03',
    label: 'Annual Turnover / Income',
    valueType: 'number',
    target: { kind: 'form', key: 'annualTurnoverOrIncome' },
    sourceDocumentTypes: ['financial_statement', 'itr', 'gst_return'],
    extractionMode: 'mirror',
    mirrorOf: 'financialProfile.annualRevenue',
    mirrorFallbacks: ['financialProfile.gstAnnualTurnover'],
    unit: 'currency',
    signPolicy: 'non_negative',
    periodScoped: true,
  }),
  field({
    fieldId: 'creditScore',
    section: '03',
    label: 'Credit Bureau Score (CIBIL / Commercial)',
    valueType: 'number',
    target: { kind: 'form', key: 'creditScore' },
    sourceDocumentTypes: ['credit_report'],
    extractionMode: 'mirror',
    mirrorOf: 'financialProfile.personalCibilScore',
    mirrorFallbacks: ['financialProfile.promoterCibilScore'],
    unit: 'score',
    signPolicy: 'non_negative',
    min: 300,
    max: 900,
  }),
  field({
    fieldId: 'profitabilityStatus',
    section: '03',
    label: 'Profitability Track Record',
    valueType: 'enum',
    target: { kind: 'form', key: 'profitabilityStatus' },
    allowedValues: PROFITABILITY_VALUES,
    sourceDocumentTypes: STATEMENT_SOURCES,
    extractionMode: 'derived',
    derivation: 'profitability_from_pat',
    defaultValue: 'not_provided',
  }),
  field({
    fieldId: 'existingEmiObligations',
    section: '03',
    label: 'Existing Monthly EMI',
    valueType: 'number',
    target: { kind: 'form', key: 'existingEmiObligations' },
    sourceDocumentTypes: ['credit_report', 'existing_sanction_letter', 'loan_application'],
    extractionMode: 'mirror',
    mirrorOf: 'financialProfile.existingMonthlyEmi',
    unit: 'currency',
    signPolicy: 'non_negative',
  }),

  // 04. Financial Assessment & Credit Signals
  field({
    fieldId: 'financialProfile.financialYearLabel',
    section: '04',
    label: 'Latest FY label',
    valueType: 'string',
    target: { kind: 'financial', key: 'financialYearLabel' },
    sourceDocumentTypes: BALANCE_SOURCES,
    defaultValue: 'Latest Completed FY (Apr–Mar)',
  }),
  field({
    fieldId: 'financialProfile.dataSource',
    section: '04',
    label: 'Data source',
    valueType: 'enum',
    target: { kind: 'financial', key: 'dataSource' },
    allowedValues: DATA_SOURCE_VALUES,
    enumEvidence: DATA_SOURCE_EVIDENCE,
    sourceDocumentTypes: BALANCE_SOURCES,
    defaultValue: 'audited',
    periodScoped: true,
  }),
  money('annualRevenue', 'Annual Revenue', STATEMENT_SOURCES, ANNUAL),
  money('previousAnnualRevenue', 'Previous FY Revenue', STATEMENT_SOURCES, ANNUAL),
  money('netProfitAfterTax', 'PAT', STATEMENT_SOURCES, { ...ANNUAL, signPolicy: 'signed' }),
  money('ebitda', 'EBITDA', BALANCE_SOURCES, { ...ANNUAL, signPolicy: 'signed' }),
  money('ebit', 'EBIT', BALANCE_SOURCES, { ...ANNUAL, signPolicy: 'signed' }),
  money('depreciation', 'Depreciation', BALANCE_SOURCES, {
    ...ANNUAL,
    signPolicy: 'expense_magnitude',
    hasVisibleInput: false,
  }),
  money('amortization', 'Amortization', BALANCE_SOURCES, {
    ...ANNUAL,
    signPolicy: 'expense_magnitude',
    hasVisibleInput: false,
  }),
  money('interestExpense', 'Interest Expense', BALANCE_SOURCES, { ...ANNUAL, signPolicy: 'expense_magnitude' }),
  money('currentAssets', 'Current Assets', BALANCE_SOURCES),
  money('currentLiabilities', 'Current Liabilities', BALANCE_SOURCES),
  money('totalAssets', 'Total Assets', BALANCE_SOURCES, { hasVisibleInput: false }),
  money('totalLiabilities', 'Total Liabilities', BALANCE_SOURCES, { hasVisibleInput: false }),
  money('totalOutstandingBorrowings', 'Total Outstanding Borrowings', ['financial_statement', 'credit_report'], {
    hasVisibleInput: false,
  }),
  money('totalOutsideLiabilities', 'Total Outside Liabilities', BALANCE_SOURCES),
  money('tangibleNetWorth', 'Tangible Net Worth', BALANCE_SOURCES, { signPolicy: 'signed' }),
  money('shareholdersEquity', "Shareholders' Equity", BALANCE_SOURCES, {
    signPolicy: 'signed',
    hasVisibleInput: false,
  }),
  money('annualScheduledPrincipalRepayments', 'Annual Scheduled Principal Repayments',
    ['financial_statement', 'existing_sanction_letter'], { ...ANNUAL, hasVisibleInput: false }),
  money('existingMonthlyEmi', 'Existing Monthly EMI (Financial)',
    ['credit_report', 'existing_sanction_letter', 'loan_application'], {
      hasVisibleInput: false,
      periodScoped: false,
    }),
  money('operatingCashFlow', 'Operating Cash Flow', BALANCE_SOURCES, {
    ...ANNUAL,
    signPolicy: 'signed',
    hasVisibleInput: false,
  }),
  money('averageMonthlyBankingCredits', 'Monthly Banking Credits', ['bank_statement'], {
    derivation: 'average_monthly_from_bank_table',
  }),
  money('averageMonthlyBankingBalance', 'Average Monthly Banking Balance', ['bank_statement'], {
    derivation: 'average_monthly_from_bank_table',
    hasVisibleInput: false,
    signPolicy: 'signed', // overdraft accounts run negative
  }),
  money('ccOdSanctionedLimit', 'CC / OD Sanctioned Limit', ['existing_sanction_letter', 'bank_statement'], {
    amountNature: 'limit',
    hasVisibleInput: false,
    periodScoped: false,
  }),
  money('ccOdUtilisation', 'CC / OD Utilisation', ['bank_statement'], { hasVisibleInput: false }),
  // A GSTR-9 or similar states it directly. With none, it is the sum of GSTR-3B Table 3.1
  // (a)+(b)+(c) over returns covering all 12 months of one FY: always reviewed, never auto-applied.
  money('gstAnnualTurnover', 'GST Annual Turnover', ['gst_return'], {
    ...ANNUAL,
    derivation: 'annual_from_gst_monthly_returns',
  }),
  field({
    fieldId: 'gst.monthlyOutwardSupplies',
    section: '04',
    label: 'GSTR-3B months read: outward supplies, Table 3.1 (a)+(b)+(c), excluding (d) reverse charge and (e) non-GST (review only)',
    valueType: 'string',
    target: { kind: 'review_only', key: 'gstMonthlyOutwardSupplies' },
    sourceDocumentTypes: ['gst_return'],
    extractionMode: 'derived',
    derivation: 'gst_monthly_returns_summary',
    periodScoped: true,
    hasVisibleInput: false,
    defaultValue: null,
  }),
  field({
    fieldId: 'financialProfile.gstComplianceStatus',
    section: '04',
    label: 'GST Compliance Status',
    valueType: 'enum',
    target: { kind: 'financial', key: 'gstComplianceStatus' },
    allowedValues: GST_COMPLIANCE_VALUES,
    alwaysReview: true,
    sourceDocumentTypes: ['gst_certificate', 'gst_return'],
    hasVisibleInput: false,
    defaultValue: 'not_provided',
  }),
  field({
    fieldId: 'financialProfile.personalCibilScore',
    section: '04',
    label: 'Personal CIBIL',
    valueType: 'number',
    target: { kind: 'financial', key: 'personalCibilScore' },
    sourceDocumentTypes: ['credit_report'],
    unit: 'score',
    signPolicy: 'non_negative',
    min: 300,
    max: 900,
  }),
  field({
    fieldId: 'financialProfile.promoterCibilScore',
    section: '04',
    label: 'Promoter CIBIL',
    valueType: 'number',
    target: { kind: 'financial', key: 'promoterCibilScore' },
    sourceDocumentTypes: ['credit_report'],
    hasVisibleInput: false,
    unit: 'score',
    signPolicy: 'non_negative',
    min: 300,
    max: 900,
  }),
  field({
    fieldId: 'financialProfile.personalCreditReportDate',
    section: '04',
    label: 'Personal Credit Report Date',
    valueType: 'string',
    target: { kind: 'financial', key: 'personalCreditReportDate' },
    sourceDocumentTypes: ['credit_report'],
    hasVisibleInput: false,
  }),
  field({
    fieldId: 'financialProfile.commercialCmrRank',
    section: '04',
    label: 'Commercial CMR Rank',
    valueType: 'number',
    target: { kind: 'financial', key: 'commercialCmrRank' },
    sourceDocumentTypes: ['credit_report'],
    unit: 'rank',
    signPolicy: 'non_negative',
    min: 1,
    max: 10,
  }),
  field({
    fieldId: 'financialProfile.commercialCreditReportStatus',
    section: '04',
    label: 'Commercial Credit Report Status',
    valueType: 'enum',
    target: { kind: 'financial', key: 'commercialCreditReportStatus' },
    allowedValues: CREDIT_REPORT_VALUES,
    enumEvidence: CREDIT_REPORT_EVIDENCE,
    sourceDocumentTypes: ['credit_report'],
    policy: 'positive_only',
    hasVisibleInput: false,
    defaultValue: 'not_provided',
  }),
  money('existingCorporateBorrowingExposure', 'Existing Corporate Borrowing Exposure', ['credit_report'], {
    hasVisibleInput: false,
  }),
  field({
    fieldId: 'financialProfile.delinquencies',
    section: '04',
    label: 'Delinquencies',
    valueType: 'string',
    target: { kind: 'financial', key: 'delinquencies' },
    sourceDocumentTypes: ['credit_report'],
    hasVisibleInput: false,
  }),
  ratio('netProfitMargin', 'Net Profit Margin'),
  ratio('ebitdaMargin', 'EBITDA Margin'),
  ratio('currentRatio', 'Current Ratio'),
  ratio('tolTnw', 'TOL / TNW'),
  ratio('debtEquity', 'Debt / Equity'),
  ratio('interestCoverage', 'Interest Coverage'),
  ratio('dscr', 'Debt Service Coverage (DSCR)'),
  ratio('revenueGrowth', 'Revenue Growth'),
  ratio('bankingTurnoverRatio', 'Banking Turnover Ratio'),

  // 05. Collateral Availability & Custom Requirements
  field({
    fieldId: 'collateralAvailable',
    section: '05',
    label: 'Collateral / Security Available',
    valueType: 'enum',
    target: { kind: 'form', key: 'collateralAvailable' },
    allowedValues: ['yes', 'no'],
    enumEvidence: COLLATERAL_EVIDENCE,
    sourceDocumentTypes: ['collateral_valuation', 'loan_application'],
    policy: 'positive_only',
    defaultValue: 'no',
  }),
  field({
    fieldId: 'collateralType',
    section: '05',
    label: 'Collateral Asset Type',
    valueType: 'string',
    target: { kind: 'form', key: 'collateralType' },
    sourceDocumentTypes: ['collateral_valuation', 'loan_application'],
  }),
  field({
    fieldId: 'collateralValue',
    section: '05',
    label: 'Estimated Collateral Value',
    valueType: 'number',
    target: { kind: 'form', key: 'collateralValue' },
    sourceDocumentTypes: ['collateral_valuation', 'loan_application'],
    unit: 'currency',
    signPolicy: 'non_negative',
  }),
  field({
    fieldId: 'collateralDescription',
    section: '05',
    label: 'Collateral / Security Summary',
    valueType: 'string',
    target: { kind: 'form', key: 'collateralDescription' },
    sourceDocumentTypes: ['collateral_valuation', 'loan_application'],
  }),
  field({
    fieldId: 'statedPurpose',
    section: '05',
    label: 'Detailed Funding Requirement & Use Case',
    valueType: 'string',
    target: { kind: 'form', key: 'statedPurpose' },
    sourceDocumentTypes: ['loan_application'],
    policy: 'explicit_request',
  }),
  excluded({
    fieldId: 'advisorNotes',
    section: '05',
    label: 'Internal Employee Notes',
    valueType: 'string',
    target: { kind: 'form', key: 'advisorNotes' },
    notExtractableReason: 'Employee judgement. A document must not decide it.',
  }),
  excluded({
    fieldId: 'customAttributes',
    section: '05',
    label: 'Custom Fields',
    valueType: 'string',
    target: { kind: 'form', key: 'customAttributes' },
    defaultValue: null,
    notExtractableReason: 'User-defined rows with no fixed meaning, and read without auth via bootstrap.',
  }),
];

// ---------------------------------------------------------------- Lookups

export const FIELD_MAP: Readonly<Record<string, FieldDefinition>> = Object.freeze(
  Object.fromEntries(FIELD_DEFINITIONS.map((definition) => [definition.fieldId, definition]))
);

export function getFieldDefinition(fieldId: string): FieldDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(FIELD_MAP, fieldId) ? FIELD_MAP[fieldId] : undefined;
}

export const EXTRACTABLE_FIELDS: readonly FieldDefinition[] = FIELD_DEFINITIONS.filter(
  (definition) => definition.extractable
);

/** The only fields the model may be asked for. */
export const DIRECT_FIELDS: readonly FieldDefinition[] = FIELD_DEFINITIONS.filter(
  (definition) => definition.extractionMode === 'direct'
);

export function directFieldsForDocumentType(documentType: DocumentType): FieldDefinition[] {
  return DIRECT_FIELDS.filter((definition) =>
    definition.sourceDocumentTypes.includes(documentType)
  );
}

export function dynamicFieldsForPurpose(purpose: FundingPurposeCategory): FieldDefinition[] {
  return FIELD_DEFINITIONS.filter(
    (definition) => definition.target.kind === 'dynamic' && definition.target.purpose === purpose
  );
}

export const REQUIRED_FIELDS: readonly FieldDefinition[] = FIELD_DEFINITIONS.filter(
  (definition) => definition.required
);

/** Financial inputs missing from the form today, which ui-builder must add to section 04. */
export const FINANCIAL_FIELDS_NEEDING_INPUT: readonly FieldDefinition[] = FIELD_DEFINITIONS.filter(
  (definition) => definition.target.kind === 'financial' && !definition.hasVisibleInput
);

/** Shared with the form: a real 0 stays 0, blank stays null, junk becomes null. */
export function parseNumericInput(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const DYNAMIC_UNIT_SUFFIX: Partial<Record<NumericUnit, (value: number) => string>> = {
  days: (value) => `${value} Days`,
  percent: (value) => `${value}%`,
  count: (value) => `${value} Facilities`,
};

/** Serialises a normalised value the way the form stores it. */
export function toFormValue(definition: FieldDefinition, value: FieldValue): string {
  if (
    definition.target.kind === 'dynamic' &&
    typeof value === 'number' &&
    definition.unit &&
    DYNAMIC_UNIT_SUFFIX[definition.unit]
  ) {
    return DYNAMIC_UNIT_SUFFIX[definition.unit]!(value);
  }
  return String(value);
}
