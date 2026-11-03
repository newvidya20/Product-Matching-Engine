import type {
  CriterionRule,
  EligibilityInput,
  EligibilityInputField,
  EligibilityInputSource,
  EligibilityOutcome,
} from '../../types/eligibility';

export type FieldKind = 'currency' | 'number' | 'integer' | 'enum';

export interface FieldMeta {
  field: EligibilityInputField;
  label: string;
  kind: FieldKind;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Plain-language document that normally supplies this value. Display only. */
  supplier: string;
}

export interface FieldGroup {
  title: string;
  description: string;
  fields: FieldMeta[];
}

const ENTITY_OPTIONS = [
  { value: 'individual', label: 'Individual' },
  { value: 'proprietorship', label: 'Proprietorship' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'llp', label: 'LLP' },
  { value: 'private_limited', label: 'Private limited' },
  { value: 'public_limited', label: 'Public limited' },
  { value: 'trust_society', label: 'Trust / society' },
];

const PURPOSE_OPTIONS = [
  { value: 'working_capital', label: 'Working capital' },
  { value: 'machinery_equipment', label: 'Machinery / equipment' },
  { value: 'commercial_property', label: 'Commercial property' },
  { value: 'invoice_discounting', label: 'Invoice discounting' },
  { value: 'debt_consolidation', label: 'Debt consolidation' },
  { value: 'project_expansion', label: 'Project expansion' },
  { value: 'trade_import_export', label: 'Trade import / export' },
  { value: 'general_business', label: 'General business' },
];

const CMR_REPORT_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'pending', label: 'Pending' },
  { value: 'not_applicable', label: 'Not applicable' },
];

const PROFIT_OPTIONS = [
  { value: 'profitable_2plus_years', label: 'Profitable 2+ years' },
  { value: 'profitable_1_year', label: 'Profitable 1 year' },
  { value: 'breakeven_or_early', label: 'Breakeven or early stage' },
  { value: 'loss_making', label: 'Loss making' },
];

const GST_OPTIONS = [
  { value: 'compliant', label: 'Compliant' },
  { value: 'not_compliant', label: 'Not compliant' },
  { value: 'not_applicable', label: 'Not applicable (not GST registered)' },
];

export const FIELD_GROUPS: FieldGroup[] = [
  {
    title: 'Borrower and request',
    description: 'Who is asking and for how much. Leave blank when not known.',
    fields: [
      { field: 'entityType', label: 'Entity type', kind: 'enum', options: ENTITY_OPTIONS, supplier: 'Constitution documents (incorporation certificate, partnership deed, PAN)' },
      { field: 'fundingPurpose', label: 'Funding purpose', kind: 'enum', options: PURPOSE_OPTIONS, hint: 'Informational. No criterion reads it.', supplier: 'Loan request or application form' },
      { field: 'requestedAmount', label: 'Requested amount (₹)', kind: 'currency', hint: 'Must be above 0.', supplier: 'Loan request or application form' },
      { field: 'requestedTenureMonths', label: 'Requested tenure (months)', kind: 'integer', hint: 'Informational. No criterion reads it.', supplier: 'Loan request or application form' },
      { field: 'businessVintageYears', label: 'Business vintage (years)', kind: 'number', supplier: 'Incorporation certificate, GST registration or Udyam certificate' },
    ],
  },
  {
    title: 'Credit bureau',
    description: 'Scores from bureau reports. Enter nothing for "NTC" or no score: it is not a score.',
    fields: [
      { field: 'personalCibilScore', label: 'Personal CIBIL score', kind: 'integer', supplier: 'Personal CIBIL report' },
      { field: 'promoterCibilScore', label: 'Promoter CIBIL score', kind: 'integer', hint: 'The lower of personal and promoter is used when both are given.', supplier: 'Promoter CIBIL report' },
      { field: 'commercialCmrRank', label: 'Commercial CMR rank (1 best, 10 worst)', kind: 'integer', supplier: 'Commercial CIBIL (CMR) report' },
      { field: 'commercialCreditReportStatus', label: 'Commercial credit report status', kind: 'enum', options: CMR_REPORT_OPTIONS, supplier: 'Commercial CIBIL (CMR) report' },
    ],
  },
  {
    title: 'Profit and loss (latest full year)',
    description: 'Amounts in rupees. Profit, EBITDA and EBIT may be negative.',
    fields: [
      { field: 'annualRevenue', label: 'Annual revenue / turnover (₹)', kind: 'currency', supplier: 'Audited financials or ITR (profit and loss)' },
      { field: 'netProfitAfterTax', label: 'Net profit after tax (₹)', kind: 'currency', supplier: 'Audited financials or ITR (profit and loss)' },
      { field: 'ebitda', label: 'EBITDA (₹)', kind: 'currency', supplier: 'Audited financials (profit and loss)' },
      { field: 'ebit', label: 'EBIT (₹)', kind: 'currency', supplier: 'Audited financials (profit and loss)' },
      { field: 'depreciation', label: 'Depreciation (₹)', kind: 'currency', hint: 'Enter as a positive amount.', supplier: 'Audited financials (profit and loss or schedules)' },
      { field: 'amortization', label: 'Amortisation (₹)', kind: 'currency', hint: 'Optional for DSCR. Leave blank if not stated separately.', supplier: 'Audited financials (profit and loss or schedules)' },
      { field: 'interestExpense', label: 'Interest expense (₹)', kind: 'currency', hint: 'Enter as a positive amount.', supplier: 'Audited financials (profit and loss)' },
      { field: 'profitabilityStatus', label: 'Profitability track record', kind: 'enum', options: PROFIT_OPTIONS, supplier: 'Last two years of audited financials or ITRs' },
    ],
  },
  {
    title: 'Balance sheet',
    description: 'From the latest balance sheet. Tangible net worth may be negative.',
    fields: [
      { field: 'currentAssets', label: 'Current assets (₹)', kind: 'currency', supplier: 'Audited financials (balance sheet)' },
      { field: 'currentLiabilities', label: 'Current liabilities (₹)', kind: 'currency', supplier: 'Audited financials (balance sheet)' },
      { field: 'totalOutsideLiabilities', label: 'Total outside liabilities (₹)', kind: 'currency', supplier: 'Audited financials (balance sheet)' },
      { field: 'tangibleNetWorth', label: 'Tangible net worth (₹)', kind: 'currency', supplier: 'Audited financials (balance sheet)' },
    ],
  },
  {
    title: 'Existing obligations',
    description: 'Zero is a real answer ("no debt"). Blank means not known.',
    fields: [
      { field: 'annualScheduledPrincipalRepayments', label: 'Annual scheduled principal repayments (₹)', kind: 'currency', supplier: 'Loan statements, repayment schedule or CMA data' },
      { field: 'existingMonthlyEmi', label: 'Existing monthly EMI (₹)', kind: 'currency', supplier: 'Loan statements or bureau report' },
    ],
  },
  {
    title: 'Banking and GST',
    description: 'Average of recent months from bank statements and filed GST returns.',
    fields: [
      { field: 'averageMonthlyBankingCredits', label: 'Average monthly banking credits (₹)', kind: 'currency', supplier: 'Last 6 to 12 months bank statements' },
      { field: 'gstAnnualTurnover', label: 'GST annual turnover (₹)', kind: 'currency', supplier: 'GST returns (GSTR-3B or GSTR-1)' },
      { field: 'gstComplianceStatus', label: 'GST filing status', kind: 'enum', options: GST_OPTIONS, supplier: 'GST returns filing history' },
    ],
  },
  {
    title: 'Stated DSCR',
    description: 'Used only when DSCR cannot be computed from the financials, and then it can at best be conditional.',
    fields: [
      { field: 'dscrStated', label: 'DSCR stated in a CMA or typed (ratio)', kind: 'number', hint: 'Not verified against the financials.', supplier: 'CMA data, or the audited financials to compute it' },
    ],
  },
];

export const FIELD_META: Record<EligibilityInputField, FieldMeta> = Object.fromEntries(
  FIELD_GROUPS.flatMap((g) => g.fields).map((meta) => [meta.field, meta])
) as Record<EligibilityInputField, FieldMeta>;

/** Form text for one input: blank is "not provided". */
export type FormValues = Record<EligibilityInputField, string>;

export function inputToForm(input: EligibilityInput): FormValues {
  const out = {} as FormValues;
  for (const key of Object.keys(input) as EligibilityInputField[]) {
    const v = input[key];
    out[key] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

export interface ParsedForm {
  input: EligibilityInput;
  /** Fields whose text is not a finite number. Nothing is coerced. */
  errors: Partial<Record<EligibilityInputField, string>>;
}

/** Fields that may legitimately be negative (matches the server's number rules). */
const SIGNED_FIELDS = new Set<string>(['netProfitAfterTax', 'ebitda', 'ebit', 'tangibleNetWorth', 'dscrStated']);

const DECIMAL = /^\d+(\.\d+)?$/;
const WESTERN_GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const INDIAN_GROUPED = /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/;

/** Plain decimal only: no hex, exponent, Infinity or empty. Null when the text is not acceptable. */
function parsePlainNumber(raw: string, signed: boolean): number | null {
  let text = raw;
  let sign = 1;
  if (text.startsWith('-') || text.startsWith('+')) {
    if (!signed && text.startsWith('-')) return null;
    if (text.startsWith('-')) sign = -1;
    text = text.slice(1);
  }
  if (WESTERN_GROUPED.test(text) || INDIAN_GROUPED.test(text)) text = text.replace(/,/g, '');
  if (!DECIMAL.test(text)) return null;
  const n = Number(text) * sign;
  return Number.isFinite(n) ? n : null;
}

export function formToInput(values: FormValues): ParsedForm {
  const input = {} as Record<string, number | string | null>;
  const errors: Partial<Record<EligibilityInputField, string>> = {};
  for (const key of Object.keys(FIELD_META) as EligibilityInputField[]) {
    const meta = FIELD_META[key];
    const raw = (values[key] ?? '').trim();
    if (raw === '') {
      input[key] = null;
    } else if (meta.kind === 'enum') {
      input[key] = raw;
    } else {
      const n = parsePlainNumber(raw, SIGNED_FIELDS.has(key));
      if (n === null) {
        errors[key] = 'Enter a plain number or leave blank';
        input[key] = null;
      } else if (meta.kind === 'integer' && !Number.isInteger(n)) {
        errors[key] = 'Enter a whole number or leave blank';
        input[key] = null;
      } else {
        input[key] = n;
      }
    }
  }
  return { input: input as unknown as EligibilityInput, errors };
}

export function fieldLabel(field: string): string {
  return FIELD_META[field as EligibilityInputField]?.label.replace(/ \(.*\)$/, '') ?? field;
}

export function fieldSupplier(field: string): string {
  return FIELD_META[field as EligibilityInputField]?.supplier ?? 'The supporting document';
}

export function sourceLabel(source: EligibilityInputSource | undefined): string {
  if (!source) return 'Not set';
  if (source.kind === 'manual') return 'Typed by you';
  if (source.kind === 'assessment') return `Assessment (${source.path})`;
  return `Document AI (${source.fieldId})`;
}

// ------------------------------------------------------------------ Outcome

export const OUTCOME_STYLE: Record<
  EligibilityOutcome,
  { label: string; box: string; badge: string; summary: string }
> = {
  ELIGIBLE: {
    label: 'Eligible',
    box: 'bg-emerald-50 border-emerald-300 text-emerald-900',
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    summary: 'Every checked criterion passed.',
  },
  CONDITIONALLY_ELIGIBLE: {
    label: 'Conditionally eligible',
    box: 'bg-amber-50 border-amber-300 text-amber-900',
    badge: 'bg-amber-100 text-amber-800 border-amber-300',
    summary: 'No mandatory criterion failed, but some need conditions or were not checked.',
  },
  INCOMPLETE_DOCUMENTS: {
    label: 'Incomplete documents',
    box: 'bg-stone-100 border-stone-400 text-stone-900',
    badge: 'bg-stone-200 text-stone-800 border-stone-400',
    summary: 'A mandatory input is missing, so the check cannot be completed.',
  },
  NOT_ELIGIBLE: {
    label: 'Not eligible',
    box: 'bg-red-50 border-red-300 text-red-900',
    badge: 'bg-red-100 text-red-800 border-red-300',
    summary: 'A mandatory criterion failed.',
  },
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------- Rule description

function fmtNumber(value: number, unit: string): string {
  if (unit === 'currency') return `₹ ${value.toLocaleString('en-IN')}`;
  if (unit === 'percent') return `${value}%`;
  if (unit === 'years') return `${value} years`;
  return String(value);
}

/** Describes a rule from the rules file. No numbers are held here. */
export function describeRule(rule: CriterionRule): string {
  if (rule.kind === 'enum') {
    const join = (xs: string[]) => (xs.length ? xs.map((x) => x.replace(/_/g, ' ')).join(', ') : 'none');
    return `Passes: ${join(rule.pass)}. Conditional: ${join(rule.conditional)}. Fails: ${join(rule.fail)}.`;
  }
  const dir = rule.kind === 'number_min' ? 'At least' : 'At most';
  const base = `${dir} ${fmtNumber(rule.passAt, rule.unit)} passes`;
  if (rule.conditionalTo === null) return `${base}; anything else fails.`;
  const bound = rule.kind === 'number_min' ? 'down to' : 'up to';
  return `${base}; ${bound} ${fmtNumber(rule.conditionalTo, rule.unit)} is conditional; beyond that fails.`;
}
