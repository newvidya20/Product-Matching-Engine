/**
 * Shape of EligibilityInput (docs/eligibility-contracts.md section 3): enum values, per-field validation, the
 * fieldMap ID of each input and its plain-language name. No thresholds live here: those are in the rules file.
 */
import { ELIGIBILITY_INPUT_FIELDS } from '../../src/types/eligibility.ts';
import type { EligibilityInput, EligibilityInputField } from '../../src/types/eligibility.ts';

export const ENTITY_TYPES = [
  'individual',
  'proprietorship',
  'partnership',
  'llp',
  'private_limited',
  'public_limited',
  'trust_society',
] as const;

export const FUNDING_PURPOSES = [
  'working_capital',
  'machinery_equipment',
  'commercial_property',
  'invoice_discounting',
  'debt_consolidation',
  'project_expansion',
  'trade_import_export',
  'general_business',
] as const;

/** Allowed values per enum input, `not_provided` excluded (it is sent as null). */
export const ENUM_INPUT_VALUES: Readonly<Partial<Record<EligibilityInputField, readonly string[]>>> = {
  entityType: ENTITY_TYPES,
  fundingPurpose: FUNDING_PURPOSES,
  commercialCreditReportStatus: ['available', 'pending', 'not_applicable'],
  profitabilityStatus: ['profitable_2plus_years', 'profitable_1_year', 'breakeven_or_early', 'loss_making'],
  gstComplianceStatus: ['compliant', 'not_compliant', 'not_applicable'],
};

/** Document AI field ID (fieldMap.ts) per input. dscrStated has none (section 6): its own key is used. */
export const INPUT_FIELD_IDS: Readonly<Record<EligibilityInputField, string>> = {
  entityType: 'entityType',
  fundingPurpose: 'fundingPurpose',
  requestedAmount: 'requestedAmount',
  requestedTenureMonths: 'requestedTenureMonths',
  businessVintageYears: 'businessVintageYears',
  personalCibilScore: 'financialProfile.personalCibilScore',
  promoterCibilScore: 'financialProfile.promoterCibilScore',
  commercialCmrRank: 'financialProfile.commercialCmrRank',
  commercialCreditReportStatus: 'financialProfile.commercialCreditReportStatus',
  annualRevenue: 'financialProfile.annualRevenue',
  netProfitAfterTax: 'financialProfile.netProfitAfterTax',
  ebitda: 'financialProfile.ebitda',
  ebit: 'financialProfile.ebit',
  depreciation: 'financialProfile.depreciation',
  amortization: 'financialProfile.amortization',
  interestExpense: 'financialProfile.interestExpense',
  profitabilityStatus: 'profitabilityStatus',
  currentAssets: 'financialProfile.currentAssets',
  currentLiabilities: 'financialProfile.currentLiabilities',
  totalOutsideLiabilities: 'financialProfile.totalOutsideLiabilities',
  tangibleNetWorth: 'financialProfile.tangibleNetWorth',
  annualScheduledPrincipalRepayments: 'financialProfile.annualScheduledPrincipalRepayments',
  existingMonthlyEmi: 'financialProfile.existingMonthlyEmi',
  averageMonthlyBankingCredits: 'financialProfile.averageMonthlyBankingCredits',
  gstAnnualTurnover: 'financialProfile.gstAnnualTurnover',
  gstComplianceStatus: 'financialProfile.gstComplianceStatus',
  dscrStated: 'dscrStated',
};

/** Plain names used in missing-input reasons. */
export const INPUT_LABELS: Readonly<Record<EligibilityInputField, string>> = {
  entityType: 'Entity type',
  fundingPurpose: 'Funding purpose',
  requestedAmount: 'Requested amount',
  requestedTenureMonths: 'Requested tenure',
  businessVintageYears: 'Business vintage',
  personalCibilScore: 'Personal CIBIL score',
  promoterCibilScore: 'Promoter CIBIL score',
  commercialCmrRank: 'Commercial CMR rank',
  commercialCreditReportStatus: 'Commercial credit report status',
  annualRevenue: 'Annual revenue',
  netProfitAfterTax: 'Net profit after tax',
  ebitda: 'EBITDA',
  ebit: 'EBIT',
  depreciation: 'Depreciation',
  amortization: 'Amortisation',
  interestExpense: 'Interest expense',
  profitabilityStatus: 'Profitability status',
  currentAssets: 'Current assets',
  currentLiabilities: 'Current liabilities',
  totalOutsideLiabilities: 'Total outside liabilities',
  tangibleNetWorth: 'Tangible net worth',
  annualScheduledPrincipalRepayments: 'Annual scheduled principal repayments',
  existingMonthlyEmi: 'Existing monthly EMI',
  averageMonthlyBankingCredits: 'Average monthly banking credits',
  gstAnnualTurnover: 'GST annual turnover',
  gstComplianceStatus: 'GST compliance status',
  dscrStated: 'Stated DSCR',
};

type NumberRule = { min: number; max: number; minExclusive?: boolean; integer?: boolean };
const ANY_SIGN: NumberRule = { min: -Infinity, max: Infinity };
const NON_NEGATIVE: NumberRule = { min: 0, max: Infinity };

/** Section 3 validation table. */
export const NUMBER_INPUT_RULES: Readonly<Partial<Record<EligibilityInputField, NumberRule>>> = {
  requestedAmount: { min: 0, max: Infinity, minExclusive: true },
  requestedTenureMonths: { min: 1, max: 480, integer: true },
  businessVintageYears: { min: 0, max: 200 },
  personalCibilScore: { min: 300, max: 900, integer: true },
  promoterCibilScore: { min: 300, max: 900, integer: true },
  commercialCmrRank: { min: 1, max: 10, integer: true },
  annualRevenue: NON_NEGATIVE,
  netProfitAfterTax: ANY_SIGN,
  ebitda: ANY_SIGN,
  ebit: ANY_SIGN,
  depreciation: NON_NEGATIVE,
  amortization: NON_NEGATIVE,
  interestExpense: NON_NEGATIVE,
  currentAssets: NON_NEGATIVE,
  currentLiabilities: NON_NEGATIVE,
  totalOutsideLiabilities: NON_NEGATIVE,
  tangibleNetWorth: ANY_SIGN,
  annualScheduledPrincipalRepayments: NON_NEGATIVE,
  existingMonthlyEmi: NON_NEGATIVE,
  averageMonthlyBankingCredits: NON_NEGATIVE,
  gstAnnualTurnover: NON_NEGATIVE,
  dscrStated: { min: -100, max: 100 },
};

const FIELD_SET = new Set<string>(ELIGIBILITY_INPUT_FIELDS);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks one value against section 3. Null is always valid. */
export function isValidInputValue(field: EligibilityInputField, value: unknown): boolean {
  if (value === null) return true;
  const allowed = ENUM_INPUT_VALUES[field];
  if (allowed) return typeof value === 'string' && allowed.includes(value);
  const rule = NUMBER_INPUT_RULES[field];
  if (!rule) return false;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (rule.integer && !Number.isInteger(value)) return false;
  if (rule.minExclusive ? value <= rule.min : value < rule.min) return false;
  if (value > rule.max) return false;
  return true;
}

export type InputValidation = { ok: true; input: EligibilityInput } | { ok: false; fields: string[] };

/**
 * Exactly the keys of EligibilityInput, each valid or null. Nothing is nulled, clamped or coerced.
 * On failure `fields` lists missing keys, extra keys and invalid values.
 */
export function validateEligibilityInput(raw: unknown): InputValidation {
  if (!isPlainObject(raw)) return { ok: false, fields: ['input'] };
  const bad: string[] = [];
  for (const key of ELIGIBILITY_INPUT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) bad.push(key);
    else if (!isValidInputValue(key, raw[key])) bad.push(key);
  }
  for (const key of Object.keys(raw)) if (!FIELD_SET.has(key)) bad.push(key);
  if (bad.length) return { ok: false, fields: bad };
  const input = {} as Record<string, unknown>;
  for (const key of ELIGIBILITY_INPUT_FIELDS) input[key] = raw[key];
  return { ok: true, input: input as unknown as EligibilityInput };
}

const ID_SHAPE = /^[A-Za-z0-9_\-:.]{1,200}$/;
const PATH_SHAPE = /^[A-Za-z0-9_.]{1,120}$/;

/** inputSources: keys are input fields; values a valid EligibilityInputSource. Returns the bad keys. */
export function invalidInputSourceKeys(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) return null;
  const bad: string[] = [];
  for (const [key, src] of Object.entries(raw)) {
    if (!FIELD_SET.has(key) || !isPlainObject(src)) {
      bad.push(key);
      continue;
    }
    const keys = Object.keys(src).sort().join(',');
    const ok =
      (src.kind === 'manual' && keys === 'kind') ||
      (src.kind === 'assessment' &&
        keys === 'assessmentId,kind,path' &&
        typeof src.assessmentId === 'string' &&
        ID_SHAPE.test(src.assessmentId) &&
        typeof src.path === 'string' &&
        PATH_SHAPE.test(src.path)) ||
      (src.kind === 'document_ai' &&
        keys === 'documentSessionId,fieldId,kind' &&
        typeof src.documentSessionId === 'string' &&
        ID_SHAPE.test(src.documentSessionId) &&
        typeof src.fieldId === 'string' &&
        PATH_SHAPE.test(src.fieldId));
    if (!ok) bad.push(key);
  }
  return bad;
}
