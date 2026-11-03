/**
 * Field mapping (docs/eligibility-contracts.md sections 6 and 7.3). Pure: callers pass the assessment and the
 * Document AI session state. Precedence per field: assessment value > Document AI auto_applied value > null.
 * Only the fallbacks named in section 6 are used, and each is recorded in inputSources. ratios.* is never read.
 */
import { ELIGIBILITY_INPUT_FIELDS, EMPTY_ELIGIBILITY_INPUT } from '../../src/types/eligibility.ts';
import type {
  EligibilityAssessmentRecord,
  EligibilityInput,
  EligibilityInputField,
  EligibilityInputSources,
  NewAssessmentPrefill,
  PendingVerificationInput,
  PrefillEligibilityResponse,
} from '../../src/types/eligibility.ts';
import type { FieldResult } from '../../src/types/documentAi.ts';
import type { BorrowerAssessment } from '../../src/types/domain.ts';
import { ENUM_INPUT_VALUES, INPUT_FIELD_IDS } from './inputSchema.ts';

/** Absent, undefined, '', NaN -> null. A numeric string is read as its number. */
export function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** An allowed enum value for the field, else null ('not_provided' is not allowed, so it reads as null). */
function readEnum(field: EligibilityInputField, v: unknown): string | null {
  const allowed = ENUM_INPUT_VALUES[field] || [];
  return typeof v === 'string' && allowed.includes(v) ? v : null;
}

/** Inputs that live on BorrowerAssessment itself rather than financialProfile. */
const TOP_LEVEL: ReadonlySet<EligibilityInputField> = new Set([
  'entityType',
  'fundingPurpose',
  'requestedAmount',
  'requestedTenureMonths',
  'businessVintageYears',
  'profitabilityStatus',
]);

type Read = { value: number | string; path: string } | null;

function readFromAssessment(a: BorrowerAssessment, field: EligibilityInputField): Read {
  if (field === 'dscrStated') return null; // never from a saved assessment (section 6)
  const fp = (a.financialProfile || {}) as Record<string, unknown>;
  const top = a as unknown as Record<string, unknown>;
  const isEnum = Boolean(ENUM_INPUT_VALUES[field]);
  const primaryPath = TOP_LEVEL.has(field) ? field : `financialProfile.${field}`;
  const rawPrimary = TOP_LEVEL.has(field) ? top[field] : fp[field];
  let value: number | string | null = isEnum ? readEnum(field, rawPrimary) : readNumber(rawPrimary);
  if (field === 'requestedAmount' && value === 0) value = null; // the server stores 0 for blank
  if (value !== null) return { value, path: primaryPath };

  switch (field) {
    case 'personalCibilScore': {
      const v = readNumber(top.creditScore);
      return v === null ? null : { value: v, path: 'creditScore' };
    }
    case 'annualRevenue': {
      const v = readNumber(top.annualTurnoverOrIncome);
      return v !== null && v > 0 ? { value: v, path: 'annualTurnoverOrIncome' } : null; // 0 means unknown
    }
    case 'existingMonthlyEmi': {
      const v = readNumber(top.existingEmiObligations);
      return v === null ? null : { value: v, path: 'existingEmiObligations' }; // 0 is real
    }
    case 'gstComplianceStatus': {
      const g = top.gstTaxCompliant;
      if (g === 'yes') return { value: 'compliant', path: 'gstTaxCompliant' };
      if (g === 'no') return { value: 'not_compliant', path: 'gstTaxCompliant' };
      return null;
    }
    default:
      return null;
  }
}

/** A session's auto_applied value, typed for the input, or null. */
function readFromSession(field: EligibilityInputField, fr: FieldResult): number | string | null {
  if (fr.status !== 'auto_applied' || fr.value === null || fr.value === undefined) return null;
  if (ENUM_INPUT_VALUES[field]) return readEnum(field, fr.value);
  return typeof fr.value === 'number' && Number.isFinite(fr.value) ? fr.value : null;
}

export interface PrefillSources {
  assessment: BorrowerAssessment | null;
  /** The session whose fields are read, or null. */
  documentSessionId: string | null;
  /** `loadSessionState(id).fields`; null when the session has no state. */
  sessionFields: Record<string, FieldResult> | null;
}

export function buildPrefill(src: PrefillSources): PrefillEligibilityResponse {
  const input: Record<string, number | string | null> = { ...EMPTY_ELIGIBILITY_INPUT };
  const inputSources: EligibilityInputSources = {};
  const pendingVerification: PendingVerificationInput[] = [];

  for (const field of ELIGIBILITY_INPUT_FIELDS) {
    if (src.assessment) {
      const r = readFromAssessment(src.assessment, field);
      if (r) {
        input[field] = r.value;
        inputSources[field] = { kind: 'assessment', assessmentId: src.assessment.id, path: r.path };
        continue;
      }
    }
    if (field === 'dscrStated' || !src.sessionFields || !src.documentSessionId) continue; // ratios are not extractable
    const fieldId = INPUT_FIELD_IDS[field];
    const fr = src.sessionFields[fieldId];
    if (!fr || fr.mirrorOf) continue; // primaries only
    const v = readFromSession(field, fr);
    if (v !== null) {
      input[field] = v;
      inputSources[field] = { kind: 'document_ai', documentSessionId: src.documentSessionId, fieldId };
    } else if (fr.status !== 'auto_applied') {
      pendingVerification.push({ field, fieldId, status: fr.status });
    }
  }

  let applicantLabel: string | null = null;
  const fromAssessment = typeof src.assessment?.applicantLabel === 'string' ? src.assessment.applicantLabel.trim() : '';
  if (fromAssessment) applicantLabel = fromAssessment;
  else {
    const fr = src.sessionFields?.applicantLabel;
    if (fr && fr.status === 'auto_applied' && typeof fr.value === 'string' && fr.value.trim()) applicantLabel = fr.value.trim();
  }

  return {
    input: input as unknown as EligibilityInput,
    inputSources,
    pendingVerification,
    documentSessionId: src.documentSessionId,
    applicantLabel,
  };
}

// ---------------------------------------------------------------- continue (7.3)

export function buildNewAssessmentPrefill(record: EligibilityAssessmentRecord): NewAssessmentPrefill {
  const { input } = record;
  const assessment: Record<string, unknown> = {};
  const financialProfile: Record<string, unknown> = {};

  for (const field of ELIGIBILITY_INPUT_FIELDS) {
    const v = input[field];
    if (v === null) continue;
    switch (field) {
      case 'personalCibilScore':
        financialProfile.personalCibilScore = v;
        assessment.creditScore = v;
        break;
      case 'existingMonthlyEmi':
        financialProfile.existingMonthlyEmi = v;
        assessment.existingEmiObligations = v;
        break;
      case 'annualRevenue':
        financialProfile.annualRevenue = v;
        assessment.annualTurnoverOrIncome = v;
        break;
      case 'gstComplianceStatus':
        financialProfile.gstComplianceStatus = v;
        // 'no' is a real negative to the matching engine, so it is written only for not_compliant. not_applicable
        // has no yes/no equivalent: the mirror is left out and the form keeps 'not_provided' (section 7.3).
        if (v === 'compliant') assessment.gstTaxCompliant = 'yes';
        else if (v === 'not_compliant') assessment.gstTaxCompliant = 'no';
        break;
      case 'dscrStated':
        financialProfile.ratios = { dscr: v };
        break;
      default:
        if (TOP_LEVEL.has(field)) assessment[field] = v;
        else financialProfile[field] = v;
    }
  }
  // fieldMap fallback: the promoter score stands in for creditScore when there is no personal score.
  if (input.personalCibilScore === null && input.promoterCibilScore !== null) assessment.creditScore = input.promoterCibilScore;

  return {
    eligibilityRecordId: record.id,
    applicantLabel: record.applicantLabel,
    assessment: assessment as NewAssessmentPrefill['assessment'],
    financialProfile: financialProfile as NewAssessmentPrefill['financialProfile'],
    documentSessionId: record.documentSessionId,
  };
}
