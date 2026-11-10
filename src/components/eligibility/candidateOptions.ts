import type { ExtractedField, FieldResult } from '../../types/documentAi';
import type { EligibilityInputField } from '../../types/eligibility';
import { ELIGIBILITY_DOC_FIELD_IDS } from './docFieldMap';

export interface CandidateOption {
  /** Document candidate id, or 'total' for the sum option. */
  candidateId: string;
  /** Document field the value came from (empty for the total). */
  docFieldId: string;
  /** What goes into the input. */
  value: string;
  /** Formatted for people ("1,20,000"). */
  display: string;
  sourceLabel: string;
  period: string | null;
  subject: string | null;
  confidence: number;
  isCurrent: boolean;
  isTotal: boolean;
  /** Full dropdown text, e.g. "712 - Promoter A (CIBIL report p. 1)". */
  label: string;
}

/** Only EMIs of different loans add up. Scores, ranks, percentages, revenue and profit never do. */
const ADDITIVE_FIELDS: ReadonlySet<EligibilityInputField> = new Set<EligibilityInputField>(['existingMonthlyEmi']);

/** Mirror document fields that feed the same Eligibility input. */
const ALIAS_DOC_FIELDS: Readonly<Partial<Record<EligibilityInputField, string[]>>> = {
  personalCibilScore: ['creditScore'],
  annualRevenue: ['annualTurnoverOrIncome'],
  existingMonthlyEmi: ['existingEmiObligations'],
};

function fileSourceLabel(c: ExtractedField): string {
  const s = c.source;
  if (!s) return 'document';
  const where = s.page ? `p. ${s.page}` : s.sheetName ? `${s.sheetName}${s.cellRef ? ` ${s.cellRef}` : ''}` : (s.cellRef ?? '');
  return where ? `${s.fileName} ${where}` : s.fileName;
}

function sourceKey(c: ExtractedField): string {
  const s = c.source;
  return s ? `${s.documentId}|${s.page ?? ''}|${s.sheetName ?? ''}|${s.cellRef ?? ''}` : '';
}

function display(value: string | number): string {
  return typeof value === 'number' ? value.toLocaleString('en-IN', { maximumFractionDigits: 4 }) : value;
}

/**
 * Every usable document value behind one Eligibility input. Pure. Rejected and empty values are left out;
 * identical value + source + subject collapse into one option. Current first, then by confidence.
 */
export function buildCandidateOptions(
  fields: Readonly<Record<string, FieldResult>>,
  field: EligibilityInputField,
  currentValue?: string
): CandidateOption[] {
  const docIds = [ELIGIBILITY_DOC_FIELD_IDS[field], ...(ALIAS_DOC_FIELDS[field] ?? [])].filter(
    (id): id is string => Boolean(id)
  );
  const seen = new Set<string>();
  const found: { c: ExtractedField; docFieldId: string }[] = [];
  for (const docFieldId of docIds) {
    for (const c of fields[docFieldId]?.candidates ?? []) {
      if (c.status === 'rejected_validation' || c.value === null || c.value === undefined || c.value === '') continue;
      const key = `${String(c.value)}|${sourceKey(c)}|${c.subjectRef ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ c, docFieldId });
    }
  }
  const current = (currentValue ?? '').trim();
  const options: CandidateOption[] = found.map(({ c, docFieldId }) => {
    const value = String(c.value);
    const src = fileSourceLabel(c);
    const subject = c.subjectRef ?? null;
    const shown = display(c.value as string | number);
    const label = `${shown}${subject ? ` - ${subject}` : ''} (${src}${c.period ? `, ${c.period}` : ''})`;
    return {
      candidateId: c.candidateId,
      docFieldId,
      value,
      display: shown,
      sourceLabel: src,
      period: c.period ?? null,
      subject,
      confidence: c.confidence,
      isCurrent: current !== '' && value === current,
      isTotal: false,
      label,
    };
  });
  options.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.confidence - a.confidence);

  if (ADDITIVE_FIELDS.has(field) && found.length >= 2) {
    const numeric = found.every(({ c }) => typeof c.value === 'number' && Number.isFinite(c.value));
    // Distinct places only: two readings of one figure (same source and subject) are not two loans.
    const places = new Set(found.map(({ c }) => `${sourceKey(c)}|${c.subjectRef ?? ''}`));
    if (numeric && places.size === found.length) {
      const cents = found.reduce((sum, { c }) => sum + Math.round((c.value as number) * 100), 0);
      const total = cents / 100;
      const value = String(total);
      options.push({
        candidateId: 'total',
        docFieldId: '',
        value,
        display: display(total),
        sourceLabel: `${found.length} values from documents`,
        period: null,
        subject: null,
        confidence: Math.min(...found.map(({ c }) => c.confidence)),
        isCurrent: current !== '' && value === current,
        isTotal: true,
        label: `Total of all ${found.length} values - ${display(total)}`,
      });
    }
  }
  return options;
}

export function buildCandidateOptionsMap(
  fields: Readonly<Record<string, FieldResult>>,
  currentValues: Readonly<Partial<Record<EligibilityInputField, string>>>
): Partial<Record<EligibilityInputField, CandidateOption[]>> {
  const out: Partial<Record<EligibilityInputField, CandidateOption[]>> = {};
  for (const field of Object.keys(ELIGIBILITY_DOC_FIELD_IDS) as EligibilityInputField[]) {
    const options = buildCandidateOptions(fields, field, currentValues[field]);
    if (options.length > 0) out[field] = options;
  }
  return out;
}
