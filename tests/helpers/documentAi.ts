/**
 * Builders for Document AI tests. Fictional values only.
 * Shapes follow src/types/documentAi.ts. Nothing here is a production code path.
 */
import type {
  DocumentExtractionSuccess,
  DocumentType,
  ExtractedField,
  FieldReasonCode,
  FieldStatus,
  FieldValue,
} from '../../src/types/documentAi.ts';

export const TODAY = '2026-11-02';

const CHECK_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character, from the contract pseudo-code (section 6.2), written independently of the validator. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHECK_ALPHABET.indexOf(first14[i]!);
    const p = value * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHECK_ALPHABET[(36 - (sum % 36)) % 36]!;
}

/** A GSTIN with a correct check character, for a fictional PAN. Format is only correct for a valid PAN. */
export function buildGstin(stateCode: string, pan: string, entityDigit = '1'): string {
  const body = `${stateCode}${pan}${entityDigit}Z`;
  return `${body}${gstinCheckChar(body)}`;
}

export function documentId(n: number): string {
  return `doc_${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

export interface CandidateSpec {
  documentId: string;
  documentType: DocumentType;
  fieldId: string;
  value: FieldValue | null;
  rawValue?: string;
  confidence?: number;
  snippet?: string;
  /** Defaults to 'FY 2024-25'. Pass null for "period not stated". */
  period?: string | null;
  subjectRef?: string | null;
  /** Reasons already on the candidate before merge, e.g. ambiguous_unit from the validators. */
  reasons?: FieldReasonCode[];
  status?: FieldStatus;
  derivation?: ExtractedField['derivation'];
  /** Index within the document, used in candidateId. */
  n?: number;
}

/**
 * Builds one candidate. The status is a placeholder: merge owns the final status and reasons.
 * The default snippet contains the raw value verbatim, so the snippet check passes unless a test overrides it.
 */
export function candidate(spec: CandidateSpec): ExtractedField {
  const raw = spec.rawValue ?? (spec.value === null ? '' : String(spec.value));
  const n = spec.n ?? 0;
  return {
    candidateId: `${spec.documentId}:${spec.fieldId}:${n}`,
    fieldId: spec.fieldId,
    value: spec.value,
    rawValue: raw,
    confidence: spec.confidence ?? 0.95,
    source: {
      documentId: spec.documentId,
      fileName: 'FICTIONAL-sample.pdf',
      documentType: spec.documentType,
      page: 1,
      sheetName: null,
      cellRef: null,
      snippet: spec.snippet ?? `Line item: ${raw}`,
    },
    status: spec.status ?? 'auto_applied',
    reasons: spec.reasons ?? [],
    period: spec.period === undefined ? 'FY 2024-25' : spec.period,
    subjectRef: spec.subjectRef ?? null,
    ...(spec.derivation ? { derivation: spec.derivation } : {}),
  };
}

export function successDocument(
  id: string,
  documentType: DocumentType,
  candidates: ExtractedField[],
  options: { injectionSuspected?: boolean } = {}
): DocumentExtractionSuccess {
  return {
    ok: true,
    documentId: id,
    documentType,
    classificationConfidence: 0.95,
    fields: candidates,
    bankMonthlyTotals: [],
    injectionSuspected: options.injectionSuspected ?? false,
    droppedLowConfidence: 0,
    model: 'FICTIONAL-fixture-model',
  };
}
