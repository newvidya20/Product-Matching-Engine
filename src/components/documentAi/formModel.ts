/**
 * Form state for New Assessment, plus the bridge between field IDs (docs/contracts.md) and form keys.
 * Pure, no React. Numbers stay as strings while a person types, so "-" survives; they are
 * parsed with parseNumericInput only when building the payload.
 */
import type {
  BorrowerAssessment,
  BorrowerFinancialProfile,
  CreditReportStatus,
  EntityStructureType,
  FinancialDataSource,
  FundingPurposeCategory,
  GstComplianceStatus,
  KeyValueAttribute,
  ProfitabilityStatus,
} from '../../types/domain';
import { getFieldDefinition, parseNumericInput, type FieldDefinition } from '../../documentAi/fieldMap';
import { calculateFinancialRatios } from '../../utils/financialMetrics';

export const FINANCIAL_NUMERIC_KEYS = [
  'annualRevenue',
  'previousAnnualRevenue',
  'netProfitAfterTax',
  'ebitda',
  'ebit',
  'depreciation',
  'amortization',
  'interestExpense',
  'currentAssets',
  'currentLiabilities',
  'totalAssets',
  'totalLiabilities',
  'totalOutstandingBorrowings',
  'totalOutsideLiabilities',
  'tangibleNetWorth',
  'shareholdersEquity',
  'annualScheduledPrincipalRepayments',
  'existingMonthlyEmi',
  'operatingCashFlow',
  'averageMonthlyBankingCredits',
  'averageMonthlyBankingBalance',
  'ccOdSanctionedLimit',
  'ccOdUtilisation',
  'gstAnnualTurnover',
  'personalCibilScore',
  'promoterCibilScore',
  'commercialCmrRank',
  'existingCorporateBorrowingExposure',
] as const satisfies readonly (keyof BorrowerFinancialProfile)[];

export type FinancialNumericKey = (typeof FINANCIAL_NUMERIC_KEYS)[number];

/** Financial profile as the form holds it: blank numbers are '' until saved. */
export type FinancialFormState = Record<FinancialNumericKey, string> & {
  financialYearLabel: string;
  dataSource: FinancialDataSource;
  gstComplianceStatus: GstComplianceStatus;
  commercialCreditReportStatus: CreditReportStatus;
  personalCreditReportDate: string;
  delinquencies: string;
  dscr: string;
};

export interface FormState {
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
  financialProfile: FinancialFormState;
  isFictionalDemo: boolean;
  customAttributes: KeyValueAttribute[];
}

export function createBlankFinancialForm(): FinancialFormState {
  const numeric = Object.fromEntries(FINANCIAL_NUMERIC_KEYS.map((key) => [key, ''])) as Record<
    FinancialNumericKey,
    string
  >;
  return {
    ...numeric,
    financialYearLabel: 'Latest Completed FY (Apr–Mar)',
    dataSource: 'audited',
    gstComplianceStatus: 'not_provided',
    commercialCreditReportStatus: 'not_provided',
    personalCreditReportDate: '',
    delinquencies: '',
    dscr: '',
  };
}

export function createBlankForm(defaultCurrency: string, officerDefault = ''): FormState {
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
    financialProfile: createBlankFinancialForm(),
    isFictionalDemo: false,
    customAttributes: [],
  };
}

// ------------------------------------------------------------ Field access

/** Form-level keys that hold plain strings and are addressed by fieldId. */
type StringFormKey = Exclude<
  keyof FormState,
  'dynamicPurposeAnswers' | 'financialProfile' | 'customAttributes' | 'isFictionalDemo'
>;

export function dynamicAnswerKey(definition: FieldDefinition): string | null {
  return definition.target.kind === 'dynamic' ? definition.target.key : null;
}

/** Current form value of a field as the string the input holds. '' when empty or not form-backed. */
export function readField(form: FormState, definition: FieldDefinition): string {
  const target = definition.target;
  switch (target.kind) {
    case 'form':
      return String((form as unknown as Record<string, unknown>)[target.key] ?? '');
    case 'financial':
      return String((form.financialProfile as unknown as Record<string, unknown>)[target.key] ?? '');
    case 'ratio':
      return target.key === 'dscr' ? form.financialProfile.dscr : '';
    case 'dynamic':
      return form.dynamicPurposeAnswers[target.key] ?? '';
    default:
      return '';
  }
}

/** True when the form has a writable input for this definition. */
export function isFormBacked(definition: FieldDefinition): boolean {
  const kind = definition.target.kind;
  if (kind === 'review_only') return false;
  if (kind === 'ratio') return definition.target.key === 'dscr';
  return true;
}

/** Writes a string value into the form without any side effects beyond the field itself. */
export function writeField(form: FormState, definition: FieldDefinition, value: string): FormState {
  const target = definition.target;
  switch (target.kind) {
    case 'form':
      return { ...form, [target.key as StringFormKey]: value } as FormState;
    case 'financial':
      return { ...form, financialProfile: { ...form.financialProfile, [target.key]: value } };
    case 'ratio':
      return target.key === 'dscr'
        ? { ...form, financialProfile: { ...form.financialProfile, dscr: value } }
        : form;
    case 'dynamic': {
      const answers = { ...form.dynamicPurposeAnswers };
      if (value === '') delete answers[target.key];
      else answers[target.key] = value;
      return { ...form, dynamicPurposeAnswers: answers };
    }
    default:
      return form;
  }
}

/** Field IDs of the dynamic questions that belong to a purpose other than the given one. */
export function fieldIdOfDynamic(purpose: FundingPurposeCategory, key: string): string {
  return `dynamicPurposeAnswers.${purpose}.${key}`;
}

/** Writes by field ID. A purpose change clears the dynamic answers, as the form always has. */
export function writeFieldById(form: FormState, fieldId: string, value: string): FormState {
  const definition = getFieldDefinition(fieldId);
  if (!definition || !isFormBacked(definition)) return form;
  const next = writeField(form, definition, value);
  if (fieldId === 'fundingPurpose' && value !== form.fundingPurpose) {
    return { ...next, dynamicPurposeAnswers: {} };
  }
  return next;
}

// ----------------------------------------------------------- Reopen a draft

const numToString = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? '' : String(value);

/** Required amount or turnover: a saved 0 means "not entered" (contracts 4.7), so it reopens blank. */
const positiveToString = (value: number | null | undefined): string =>
  value === 0 ? '' : numToString(value);

export function assessmentToForm(
  assessment: BorrowerAssessment,
  defaultCurrency: string
): FormState {
  const blank = createBlankForm(defaultCurrency, assessment.assignedOfficer ?? '');
  const profile = assessment.financialProfile;
  const financialProfile: FinancialFormState = { ...blank.financialProfile };
  if (profile) {
    for (const key of FINANCIAL_NUMERIC_KEYS) {
      financialProfile[key] = numToString(profile[key]);
    }
    financialProfile.financialYearLabel = profile.financialYearLabel ?? financialProfile.financialYearLabel;
    financialProfile.dataSource = profile.dataSource ?? financialProfile.dataSource;
    financialProfile.gstComplianceStatus = profile.gstComplianceStatus ?? 'not_provided';
    financialProfile.commercialCreditReportStatus = profile.commercialCreditReportStatus ?? 'not_provided';
    financialProfile.personalCreditReportDate = profile.personalCreditReportDate ?? '';
    financialProfile.delinquencies = profile.delinquencies ?? '';
    financialProfile.dscr = numToString(profile.ratios?.dscr);
  }
  return {
    ...blank,
    applicantLabel: assessment.applicantLabel ?? '',
    entityType: assessment.entityType,
    industrySector: assessment.industrySector ?? '',
    businessVintageYears: numToString(assessment.businessVintageYears),
    gstTaxCompliant: assessment.gstTaxCompliant ?? 'not_provided',
    fundingPurpose: assessment.fundingPurpose ?? 'working_capital',
    dynamicPurposeAnswers: { ...(assessment.dynamicPurposeAnswers ?? {}) },
    assignedOfficer: assessment.assignedOfficer ?? '',
    branchOrDesk: assessment.branchOrDesk ?? 'Central Advisory Desk',
    requestedAmount: positiveToString(assessment.requestedAmount),
    currency: assessment.currency || blank.currency,
    requestedTenureMonths: numToString(assessment.requestedTenureMonths),
    annualTurnoverOrIncome: positiveToString(assessment.annualTurnoverOrIncome),
    creditScore: numToString(assessment.creditScore),
    existingEmiObligations: numToString(assessment.existingEmiObligations),
    profitabilityStatus: assessment.profitabilityStatus ?? 'not_provided',
    collateralAvailable: assessment.collateralAvailable ? 'yes' : 'no',
    collateralType: assessment.collateralType ?? '',
    collateralValue: numToString(assessment.collateralValue),
    collateralDescription: assessment.collateralDescription ?? '',
    statedPurpose: assessment.statedPurpose ?? '',
    advisorNotes: assessment.advisorNotes ?? '',
    financialProfile,
    isFictionalDemo: Boolean(assessment.isFictionalDemo),
    customAttributes: (assessment.customAttributes ?? []).map((item) => ({ ...item })),
  };
}

// ------------------------------------------------------------ Save payload

/** Real 0 stays 0, blank stays null, via parseNumericInput. */
export function buildFinancialProfile(form: FormState): BorrowerFinancialProfile {
  const source = form.financialProfile;
  const base: BorrowerFinancialProfile = {
    financialYearLabel: source.financialYearLabel,
    dataSource: source.dataSource,
    gstComplianceStatus: source.gstComplianceStatus,
    commercialCreditReportStatus: source.commercialCreditReportStatus,
    personalCreditReportDate: source.personalCreditReportDate,
    delinquencies: source.delinquencies,
  };
  for (const key of FINANCIAL_NUMERIC_KEYS) {
    base[key] = parseNumericInput(source[key]);
  }
  base.ratios = { dscr: parseNumericInput(source.dscr) };
  return { ...base, ratios: calculateFinancialRatios(base) };
}

export function buildAssessmentPayload(
  form: FormState,
  asDraft: boolean
): Partial<BorrowerAssessment> {
  const parsedAmount = Number(form.requestedAmount);
  const parsedTenure = Number(form.requestedTenureMonths);
  return {
    applicantLabel: form.applicantLabel.trim(),
    entityType: form.entityType,
    industrySector: form.industrySector.trim(),
    businessVintageYears: parseNumericInput(form.businessVintageYears),
    gstTaxCompliant: form.gstTaxCompliant,
    fundingPurpose: form.fundingPurpose,
    dynamicPurposeAnswers: form.dynamicPurposeAnswers,
    assignedOfficer: form.assignedOfficer.trim() || 'Internal Desk Officer',
    branchOrDesk: form.branchOrDesk.trim() || 'Central Advisory Desk',
    requestedAmount: Number.isFinite(parsedAmount) ? parsedAmount : 0,
    currency: form.currency,
    requestedTenureMonths: parsedTenure,
    // Turnover is non_negative and 0 means unknown to the rule engine (contracts 4.7).
    annualTurnoverOrIncome: Number(form.annualTurnoverOrIncome) || 0,
    creditScore: parseNumericInput(form.creditScore),
    existingEmiObligations: parseNumericInput(form.existingEmiObligations),
    profitabilityStatus: form.profitabilityStatus,
    collateralAvailable: form.collateralAvailable === 'yes',
    collateralType: form.collateralType.trim(),
    collateralValue: parseNumericInput(form.collateralValue),
    collateralDescription: form.collateralDescription.trim(),
    statedPurpose: form.statedPurpose.trim(),
    advisorNotes: form.advisorNotes.trim(),
    isFictionalDemo: form.isFictionalDemo,
    customAttributes: form.customAttributes.filter((a) => a.key.trim().length > 0),
    financialProfile: buildFinancialProfile(form),
    status: asDraft ? 'draft' : 'submitted',
  };
}

// ------------------------------------------------------------------ Display

export function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatFieldValue(definition: FieldDefinition, value: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && definition.unit === 'currency') {
    return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }
  if (typeof value === 'number') return value.toLocaleString('en-IN', { maximumFractionDigits: 4 });
  return definition.valueType === 'enum' && /^[a-z0-9_]+$/.test(value) ? humanize(value) : value;
}
