/**
 * Initial Eligibility Check: shared types. Importable by server and client: no node-only imports.
 * Semantics, decision table, formulas and API: docs/eligibility-contracts.md.
 *
 * Field names reuse BorrowerAssessment and BorrowerFinancialProfile (src/types/domain.ts).
 * Thresholds never live in code: they are read from data/eligibility-rules.json (EligibilityRuleConfig).
 */
import type {
  CreditReportStatus,
  EntityStructureType,
  FundingPurposeCategory,
  GstComplianceStatus,
  ProfitabilityStatus,
} from './domain';
import type { FieldStatus } from './documentAi';

// ------------------------------------------------------------------ Outcome

/** Not the per-product `EligibilityStatus` in domain.ts: this is the borrower-level initial check. */
export const ELIGIBILITY_OUTCOMES = [
  'ELIGIBLE',
  'CONDITIONALLY_ELIGIBLE',
  'INCOMPLETE_DOCUMENTS',
  'NOT_ELIGIBLE',
] as const;
export type EligibilityOutcome = (typeof ELIGIBILITY_OUTCOMES)[number];

// ----------------------------------------------------------------- Criteria

export const ELIGIBILITY_CRITERION_IDS = [
  'business_vintage',
  'personal_cibil',
  'commercial_cmr',
  'dscr',
  'banking_credits_vs_requested',
  'banking_turnover_ratio',
  'annual_turnover',
  'gst_turnover',
  'gst_compliance',
  'tol_tnw',
  'existing_emi_foir',
  'profitability',
  'current_ratio',
  'interest_coverage',
] as const;
export type EligibilityCriterionId = (typeof ELIGIBILITY_CRITERION_IDS)[number];

export const CRITERION_STATUSES = ['passed', 'failed', 'conditional', 'missing'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/**
 * Derived from status and mandatory only (contracts section 2.3), never chosen by hand.
 * blocker: mandatory failed. action_required: mandatory missing.
 * condition: conditional, or non-mandatory failed or missing. none: passed.
 */
export type CriterionSeverity = 'blocker' | 'action_required' | 'condition' | 'none';

// -------------------------------------------------------------------- Input

/**
 * Every key is required and every value nullable. `null` means "not provided" and is never
 * replaced by a default, a zero, or a value from another field (except the mapping fallbacks
 * listed in contracts section 6, each recorded in inputSources). `0` is a real value.
 * Currency is INR rupees.
 */
export interface EligibilityInput {
  // Borrower and request
  entityType: EntityStructureType | null;
  fundingPurpose: FundingPurposeCategory | null;
  requestedAmount: number | null;
  requestedTenureMonths: number | null;
  businessVintageYears: number | null;

  // Bureau
  personalCibilScore: number | null;
  promoterCibilScore: number | null;
  commercialCmrRank: number | null;
  /** 'not_provided' is never stored: it is null. */
  commercialCreditReportStatus: Exclude<CreditReportStatus, 'not_provided'> | null;

  // P&L, latest full FY
  annualRevenue: number | null;
  netProfitAfterTax: number | null;
  ebitda: number | null;
  ebit: number | null;
  depreciation: number | null;
  amortization: number | null;
  interestExpense: number | null;
  /** 'not_provided' is never stored: it is null. */
  profitabilityStatus: Exclude<ProfitabilityStatus, 'not_provided'> | null;

  // Balance sheet
  currentAssets: number | null;
  currentLiabilities: number | null;
  totalOutsideLiabilities: number | null;
  tangibleNetWorth: number | null;

  // Obligations
  annualScheduledPrincipalRepayments: number | null;
  existingMonthlyEmi: number | null;
  /** Annual operating cash flow (signed). Informational: it does not feed DSCR. */
  operatingCashFlow: number | null;

  // Banking and GST
  averageMonthlyBankingCredits: number | null;
  gstAnnualTurnover: number | null;
  /** 'not_provided' is never stored: it is null. */
  gstComplianceStatus: Exclude<GstComplianceStatus, 'not_provided'> | null;

  /** A DSCR a person typed or a CMA states. Used only when DSCR cannot be computed (section 4.1). */
  dscrStated: number | null;
}

export type EligibilityInputField = keyof EligibilityInput;

export const ELIGIBILITY_INPUT_FIELDS = [
  'entityType',
  'fundingPurpose',
  'requestedAmount',
  'requestedTenureMonths',
  'businessVintageYears',
  'personalCibilScore',
  'promoterCibilScore',
  'commercialCmrRank',
  'commercialCreditReportStatus',
  'annualRevenue',
  'netProfitAfterTax',
  'ebitda',
  'ebit',
  'depreciation',
  'amortization',
  'interestExpense',
  'profitabilityStatus',
  'currentAssets',
  'currentLiabilities',
  'totalOutsideLiabilities',
  'tangibleNetWorth',
  'annualScheduledPrincipalRepayments',
  'existingMonthlyEmi',
  'operatingCashFlow',
  'averageMonthlyBankingCredits',
  'gstAnnualTurnover',
  'gstComplianceStatus',
  'dscrStated',
] as const satisfies readonly EligibilityInputField[];

/** Compile-time check that the list above names every key exactly. */
type _MissingInputKeys = Exclude<EligibilityInputField, (typeof ELIGIBILITY_INPUT_FIELDS)[number]>;
const _inputFieldsComplete: [_MissingInputKeys] extends [never] ? true : never = true;
void _inputFieldsComplete;

export const EMPTY_ELIGIBILITY_INPUT: Readonly<EligibilityInput> = Object.freeze(
  Object.fromEntries(ELIGIBILITY_INPUT_FIELDS.map((key) => [key, null])) as unknown as EligibilityInput
);

/** Where one input value came from. Shown beside the value; drives sourceField in results. */
export type EligibilityInputSource =
  | { kind: 'manual' }
  /** `path` is a BorrowerAssessment path, e.g. 'financialProfile.personalCibilScore' or 'creditScore'. */
  | { kind: 'assessment'; assessmentId: string; path: string }
  /** Only `auto_applied` field results are taken (section 6.2). */
  | { kind: 'document_ai'; documentSessionId: string; fieldId: string };

export type EligibilityInputSources = Partial<Record<EligibilityInputField, EligibilityInputSource>>;

// ---------------------------------------------------------------- Rule config

export type CriterionUnit = 'currency' | 'years' | 'score' | 'rank' | 'ratio' | 'multiple' | 'percent' | 'enum';

interface CriterionRuleBase {
  enabled: boolean;
  mandatory: boolean;
  label: string;
  /** Plain-language reason for the default. Shown in the rules view. */
  rationale: string;
  /** 'all', or the entity types it applies to. Others skip it (not a result row). */
  appliesToEntityTypes: 'all' | EntityStructureType[];
  /** Skip when this enum input holds one of these values, e.g. CMR when the report is not_applicable. */
  skipWhen?: { field: 'commercialCreditReportStatus' | 'gstComplianceStatus'; values: string[] } | null;
}

/**
 * number_min: value >= passAt passes; conditionalTo <= value < passAt is conditional; lower fails.
 * number_max: value <= passAt passes; passAt < value <= conditionalTo is conditional; higher fails.
 * conditionalTo null: no band, so anything not passing fails.
 * strict true: the pass bound is exclusive (number_min: value > passAt; number_max: value < passAt) and
 * conditionalTo must be null. E.g. DSCR strictly above 1.00, CMR rank below 7.
 * Comparison is on the value rounded to 2 decimal places, the value shown. Units 'score' and 'rank' are
 * compared and shown exactly, never rounded (contracts section 4).
 */
export interface NumericCriterionRule extends CriterionRuleBase {
  kind: 'number_min' | 'number_max';
  unit: Exclude<CriterionUnit, 'enum'>;
  passAt: number;
  conditionalTo: number | null;
  /** Exclusive pass bound; absent or false means inclusive. Requires conditionalTo null. */
  strict?: boolean;
}

/** Every allowed value except 'not_provided' appears in exactly one list (or skipWhen). */
export interface EnumCriterionRule extends CriterionRuleBase {
  kind: 'enum';
  unit: 'enum';
  pass: string[];
  conditional: string[];
  fail: string[];
}

export type CriterionRule = NumericCriterionRule | EnumCriterionRule;

/** Contents of data/eligibility-rules.json. Defaults in contracts section 5. */
export interface EligibilityRuleConfig {
  schemaVersion: 1;
  /** Bump on every edit, e.g. '2026-11-03.1'. Stored on every result. */
  rulesVersion: string;
  /** 'editable_default' until LoanBazaar credit confirms the values. */
  status: 'editable_default' | 'confirmed';
  confirmedBy: string | null;
  confirmedAt: string | null;
  currency: 'INR';
  criteria: Record<EligibilityCriterionId, CriterionRule>;
}

/** Fixed per criterion: its kind and inputs are code, its numbers are config. */
export interface CriterionDefinition {
  id: EligibilityCriterionId;
  kind: CriterionRule['kind'];
  unit: CriterionUnit;
  /** Inputs that must all be non-null to evaluate (section 4). Applicability inputs are separate. */
  requiredInputs: readonly EligibilityInputField[];
  /** Inputs used when present, whose absence can only make the result stricter. */
  optionalInputs: readonly EligibilityInputField[];
}

export const CRITERION_DEFINITIONS: Readonly<Record<EligibilityCriterionId, CriterionDefinition>> = {
  business_vintage: { id: 'business_vintage', kind: 'number_min', unit: 'years', requiredInputs: ['businessVintageYears'], optionalInputs: [] },
  personal_cibil: { id: 'personal_cibil', kind: 'number_min', unit: 'score', requiredInputs: [], optionalInputs: ['personalCibilScore', 'promoterCibilScore'] },
  commercial_cmr: { id: 'commercial_cmr', kind: 'number_max', unit: 'rank', requiredInputs: ['commercialCmrRank'], optionalInputs: [] },
  dscr: {
    id: 'dscr',
    kind: 'number_min',
    unit: 'ratio',
    requiredInputs: ['netProfitAfterTax', 'depreciation', 'interestExpense', 'existingMonthlyEmi'],
    optionalInputs: ['amortization', 'dscrStated'],
  },
  banking_credits_vs_requested: {
    id: 'banking_credits_vs_requested',
    kind: 'number_max',
    unit: 'multiple',
    requiredInputs: ['requestedAmount', 'averageMonthlyBankingCredits'],
    optionalInputs: [],
  },
  banking_turnover_ratio: {
    id: 'banking_turnover_ratio',
    kind: 'number_min',
    unit: 'percent',
    requiredInputs: ['averageMonthlyBankingCredits', 'annualRevenue'],
    optionalInputs: [],
  },
  annual_turnover: { id: 'annual_turnover', kind: 'number_min', unit: 'currency', requiredInputs: ['annualRevenue'], optionalInputs: [] },
  gst_turnover: { id: 'gst_turnover', kind: 'number_min', unit: 'currency', requiredInputs: ['gstAnnualTurnover'], optionalInputs: [] },
  gst_compliance: { id: 'gst_compliance', kind: 'enum', unit: 'enum', requiredInputs: ['gstComplianceStatus'], optionalInputs: [] },
  tol_tnw: { id: 'tol_tnw', kind: 'number_max', unit: 'ratio', requiredInputs: ['totalOutsideLiabilities', 'tangibleNetWorth'], optionalInputs: [] },
  existing_emi_foir: { id: 'existing_emi_foir', kind: 'number_max', unit: 'percent', requiredInputs: ['existingMonthlyEmi', 'ebitda'], optionalInputs: [] },
  profitability: { id: 'profitability', kind: 'enum', unit: 'enum', requiredInputs: ['profitabilityStatus'], optionalInputs: [] },
  current_ratio: { id: 'current_ratio', kind: 'number_min', unit: 'ratio', requiredInputs: ['currentAssets', 'currentLiabilities'], optionalInputs: [] },
  interest_coverage: { id: 'interest_coverage', kind: 'number_min', unit: 'ratio', requiredInputs: ['ebit', 'interestExpense'], optionalInputs: [] },
};

// ------------------------------------------------------------------- Result

export interface CriterionInputUsed {
  field: EligibilityInputField;
  value: number | string;
  /** Document AI field ID (fieldMap.ts) of the input, e.g. 'financialProfile.netProfitAfterTax'. */
  fieldId: string;
}

export interface CriterionResult {
  criterionId: EligibilityCriterionId;
  label: string;
  status: CriterionStatus;
  /** Measured or derived value, rounded to 2 dp (scores and ranks exact). Null when missing, or when not a number (zero denominator, see `actualDisplay`). */
  actual: number | string | null;
  /** E.g. '1.42', '₹ 48,00,000', 'No debt service', 'Not provided'. */
  actualDisplay: string;
  /** Plain-language threshold, e.g. 'Above 1.00' or 'At least 750 (700 to 749 is conditional)'. */
  expected: string;
  mandatory: boolean;
  severity: CriterionSeverity;
  /** Deterministic sentence from a template. No AI. */
  reason: string;
  /** fieldMap ID of the direct input, or 'derived:<criterionId>' for a computed metric, or null when missing. */
  sourceField: string | null;
  inputsUsed: CriterionInputUsed[];
  /** Non-null required inputs that were null. Empty unless status is 'missing'. */
  missingInputs: EligibilityInputField[];
}

export interface SkippedCriterion {
  criterionId: EligibilityCriterionId;
  reason: 'disabled' | 'entity_type_not_applicable' | 'skip_when_matched';
}

/** Each metric is null when any required input is null. Never computed from assumptions. */
export interface EligibilityDerivedMetrics {
  /** (netProfitAfterTax + depreciation + amortization + interestExpense) / (existingMonthlyEmi * 12), or the stated DSCR. */
  dscr: number | null;
  dscrBasis: 'computed' | 'stated' | null;
  /** requestedAmount / averageMonthlyBankingCredits. */
  requestedToMonthlyCreditsMultiple: number | null;
  /** averageMonthlyBankingCredits * 12 / annualRevenue * 100. */
  bankingTurnoverRatioPercent: number | null;
  tolTnw: number | null;
  /** existingMonthlyEmi * 12 / ebitda * 100. */
  foirPercent: number | null;
  currentRatio: number | null;
  interestCoverage: number | null;
}

export interface EligibilityResult {
  outcome: EligibilityOutcome;
  /** One sentence naming the rule in section 2.2 that decided the outcome. */
  outcomeReason: string;
  criteria: CriterionResult[];
  skipped: SkippedCriterion[];
  derived: EligibilityDerivedMetrics;
  /** Inputs to ask for: union of missingInputs over mandatory, then non-mandatory, criteria. */
  missingMandatoryInputs: EligibilityInputField[];
  missingOptionalInputs: EligibilityInputField[];
  counts: Record<CriterionStatus, number>;
  rulesVersion: string;
  /** sha256 hex of the canonical rules JSON, so an edit without a version bump is still visible. */
  rulesHash: string;
  evaluatedAt: string;
}

// ------------------------------------------------------------------ Records

export const ELIGIBILITY_RECORD_ID_PATTERN = /^elg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type EligibilityRecordStatus = 'draft' | 'final';

export interface EligibilityResultSnapshot {
  outcome: EligibilityOutcome;
  rulesVersion: string;
  rulesHash: string;
  evaluatedAt: string;
  counts: Record<CriterionStatus, number>;
}

export interface EligibilityAssessmentRecord {
  id: string;
  /** 'LB-ELG-<n>', n = 1001 + highest existing n. */
  referenceCode: string;
  applicantLabel: string;
  input: EligibilityInput;
  inputSources: EligibilityInputSources;
  /** Recomputed on every create, update (except a link-only update) and reassess, and on continue when stale. */
  result: EligibilityResult;
  rulesVersion: string;
  status: EligibilityRecordStatus;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  /** Read-only reference to a Document AI session. Never claims the session's assessment link. */
  documentSessionId: string | null;
  linkedAssessmentId: string | null;
  /** Older results, newest first, at most 20. */
  previousResults: EligibilityResultSnapshot[];
  /** Self-reported, attribution only. */
  createdBy: string | null;
  continuedAt: string | null;
}

export type EligibilityRecordSummary = Pick<
  EligibilityAssessmentRecord,
  'id' | 'referenceCode' | 'applicantLabel' | 'rulesVersion' | 'status' | 'createdAt' | 'updatedAt' | 'documentSessionId' | 'linkedAssessmentId'
> & { outcome: EligibilityOutcome; counts: Record<CriterionStatus, number> };

// ---------------------------------------------------------------------- API

export type EligibilityErrorCode =
  | 'invalid_input'
  | 'invalid_record_id'
  | 'record_not_found'
  | 'record_final'
  | 'continue_blocked_incomplete'
  | 'continue_blocked_not_eligible'
  | 'assessment_not_found'
  | 'session_not_found'
  | 'rules_unavailable'
  | 'rules_invalid'
  | 'unauthenticated'
  | 'internal_error';

export interface EligibilityErrorBody {
  error: string;
  code: EligibilityErrorCode;
  /** For invalid_input: the offending input keys or body keys. */
  fields?: string[];
}

export interface EligibilityRulesResponse {
  rules: EligibilityRuleConfig;
  rulesHash: string;
  definitions: Record<EligibilityCriterionId, CriterionDefinition>;
}

export interface EvaluateEligibilityRequest {
  input: EligibilityInput;
}
export interface EvaluateEligibilityResponse {
  result: EligibilityResult;
}

export interface PrefillEligibilityRequest {
  assessmentId?: string;
  documentSessionId?: string;
}
export interface PendingVerificationInput {
  field: EligibilityInputField;
  fieldId: string;
  status: Exclude<FieldStatus, 'auto_applied'>;
}
export interface PrefillEligibilityResponse {
  input: EligibilityInput;
  inputSources: EligibilityInputSources;
  /** Document values held back because they are not auto_applied. The input stays null. */
  pendingVerification: PendingVerificationInput[];
  documentSessionId: string | null;
  applicantLabel: string | null;
}

export interface CreateEligibilityRecordRequest {
  applicantLabel: string;
  input: EligibilityInput;
  inputSources?: EligibilityInputSources;
  status?: EligibilityRecordStatus;
  documentSessionId?: string | null;
  linkedAssessmentId?: string | null;
  createdBy?: string | null;
}

/** `input`, when sent, replaces the whole input and must carry every key. */
export interface UpdateEligibilityRecordRequest {
  applicantLabel?: string;
  input?: EligibilityInput;
  inputSources?: EligibilityInputSources;
  status?: EligibilityRecordStatus;
  documentSessionId?: string | null;
  linkedAssessmentId?: string | null;
}

export interface EligibilityRecordResponse {
  record: EligibilityAssessmentRecord;
}
export interface ListEligibilityRecordsResponse {
  records: EligibilityRecordSummary[];
}

/**
 * Values for New Assessment, in BorrowerAssessment shape so the form's assessmentToForm can
 * read them. Only non-null inputs appear. Mirrors follow fieldMap (contracts section 7).
 */
export interface NewAssessmentPrefill {
  eligibilityRecordId: string;
  applicantLabel: string;
  assessment: Partial<{
    entityType: EntityStructureType;
    fundingPurpose: FundingPurposeCategory;
    requestedAmount: number;
    requestedTenureMonths: number;
    businessVintageYears: number;
    creditScore: number;
    existingEmiObligations: number;
    annualTurnoverOrIncome: number;
    profitabilityStatus: ProfitabilityStatus;
    /** 'yes' for compliant, 'no' only for not_compliant. Absent for not_applicable or null (section 7.3). */
    gstTaxCompliant: 'yes' | 'no';
  }>;
  financialProfile: Partial<{
    annualRevenue: number;
    netProfitAfterTax: number;
    ebitda: number;
    ebit: number;
    depreciation: number;
    amortization: number;
    interestExpense: number;
    currentAssets: number;
    currentLiabilities: number;
    totalOutsideLiabilities: number;
    tangibleNetWorth: number;
    annualScheduledPrincipalRepayments: number;
    existingMonthlyEmi: number;
    operatingCashFlow: number;
    averageMonthlyBankingCredits: number;
    gstAnnualTurnover: number;
    gstComplianceStatus: GstComplianceStatus;
    personalCibilScore: number;
    promoterCibilScore: number;
    commercialCmrRank: number;
    commercialCreditReportStatus: CreditReportStatus;
    ratios: { dscr: number };
  }>;
  documentSessionId: string | null;
  /** Client-side only: conditions from the continue response, shown at the top of New Assessment. */
  conditions?: CriterionResult[];
}

export interface ContinueEligibilityResponse {
  record: EligibilityAssessmentRecord;
  /** Set when the record already links an assessment: open that one for edit, ignore prefill. */
  existingAssessmentId: string | null;
  prefill: NewAssessmentPrefill | null;
  /**
   * Every reason the outcome is CONDITIONALLY_ELIGIBLE (rule 3 of contracts section 2.2), from the fresh result the
   * gate decided on: each 'conditional' row (mandatory or not) and each non-mandatory row that is 'failed' or
   * 'missing'. The case proceeds with these shown to the officer. Empty for ELIGIBLE.
   */
  conditions: CriterionResult[];
}
