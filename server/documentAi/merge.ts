/**
 * Candidate rules and session merge (docs/contracts.md sections 4 and 5). Pure: no I/O, no clock,
 * no env, and inputs are never mutated. `today` and the threshold always arrive as arguments.
 */
import {
  FIELD_DEFINITIONS,
  getFieldDefinition,
  type FieldDefinition,
} from '../../src/documentAi/fieldMap.ts';
import {
  DOCUMENT_AI_LIMITS,
  DOCUMENT_AI_THRESHOLDS,
} from '../../src/types/documentAi.ts';
import type {
  AcceptedFileKind,
  BankMonthlyTotal,
  DocumentExtractionSuccess,
  DocumentType,
  ExtractedField,
  FieldReasonCode,
  FieldResult,
  FieldValue,
  MergeSessionInput,
  MergeSessionOutput,
  SessionWarning,
  SourceRef,
} from '../../src/types/documentAi.ts';
import { deriveCandidates } from './derive.ts';
import type { RawBankMonth, RawField, RawLocation } from './prompt.ts';
import {
  applySignPolicy,
  createSourceVerifier,
  currencyEqual,
  fieldValuesEqual,
  findEnumEvidence,
  gstinEmbeddedPan,
  hasForeignUnit,
  hasPartYearWording,
  isFinancialYearLabel,
  normalizeComparableString,
  normalizeFinancialYear,
  normalizePeriod,
  parseDate,
  parseIndianAmount,
  parseMeasure,
  parsePercent,
  periodEndDate,
  positiveValueDoubted,
  previousFinancialYear,
  rawValueInSnippet,
  significantDigits,
  unitAgreesWithSnippet,
  unitTextSupports,
  validateGstin,
  validatePan,
  type AmountUnit,
  type DocumentSource,
  type SourceFinding,
  type SourceVerifier,
  type Validated,
} from './validators.ts';

const FIELD = {
  pan: 'identity.pan',
  gstin: 'identity.gstin',
  establishment: 'identity.dateOfEstablishment',
  applicantLabel: 'applicantLabel',
  entityType: 'entityType',
  fyLabel: 'financialProfile.financialYearLabel',
  dataSource: 'financialProfile.dataSource',
  revenue: 'financialProfile.annualRevenue',
  previousRevenue: 'financialProfile.previousAnnualRevenue',
  gstTurnover: 'financialProfile.gstAnnualTurnover',
  turnoverMirror: 'annualTurnoverOrIncome',
  personalScore: 'financialProfile.personalCibilScore',
  promoterScore: 'financialProfile.promoterCibilScore',
  reportDate: 'financialProfile.personalCreditReportDate',
  gstCompliance: 'financialProfile.gstComplianceStatus',
  gstCompliant: 'gstTaxCompliant',
} as const;

const DATE_FIELDS: ReadonlySet<string> = new Set([FIELD.establishment, FIELD.reportDate]);
/** Bank credits are never turnover. */
const TURNOVER_FIELDS: ReadonlySet<string> = new Set([FIELD.revenue, FIELD.previousRevenue, FIELD.gstTurnover]);
/** Entity types where a report on an individual is about a promoter, not the applicant. */
const SINGLE_PERSON_ENTITIES: ReadonlySet<FieldValue> = new Set(['individual', 'proprietorship']);
const PLACEHOLDER = /^(?:n\.?\/?a\.?|nil|none|null|undefined|not\s+(?:available|applicable|provided|stated|mentioned)|-+)?$/i;
const MAX_STRING_LENGTH = 500;
/** Not a cap: an older period's candidate is listed, not doubted. */
const NON_CAPPING_REASONS: ReadonlySet<FieldReasonCode> = new Set(['superseded_period']);

/** financialYearLabel names a period, so two statements of different years are not a conflict. */
function isPeriodGrouped(definition: FieldDefinition): boolean {
  return Boolean(definition.periodScoped) || definition.fieldId === FIELD.fyLabel;
}

// ------------------------------------------------------------ Value normalising

type Normalized =
  | { kind: 'value'; value: FieldValue; ambiguousUnit: boolean }
  | { kind: 'rejected' }
  /** No candidate at all: the document established nothing. */
  | { kind: 'absent' };

const rejected: Normalized = { kind: 'rejected' };

function withinRange(definition: FieldDefinition, value: number): boolean {
  return (
    (definition.min === undefined || value >= definition.min) &&
    (definition.max === undefined || value <= definition.max)
  );
}

function parseFieldAmount(
  definition: FieldDefinition,
  rawValue: string,
  documentType: DocumentType,
  statedUnit: AmountUnit | null | undefined
) {
  return parseIndianAmount(rawValue, { statedUnit, documentType, amountNature: definition.amountNature });
}

function normalizeNumber(definition: FieldDefinition, raw: RawField, documentType: DocumentType): Normalized {
  let value: number;
  let ambiguousUnit = false;
  if (definition.unit === 'currency') {
    const parsed = parseFieldAmount(definition, raw.rawValue, documentType, raw.statedUnit);
    if (!parsed.ok) {
      return parsed.code === 'empty_value' ? { kind: 'absent' } : rejected;
    }
    value = parsed.value;
    ambiguousUnit = parsed.ambiguousUnit;
  } else {
    const parsed = definition.unit === 'percent' ? parsePercent(raw.rawValue) : parseMeasure(raw.rawValue, definition.unit);
    if (!parsed.ok) return rejected;
    value = parsed.value;
  }
  const signed = applySignPolicy(value, definition.signPolicy);
  if (!signed.ok || !withinRange(definition, signed.value)) return rejected;
  return { kind: 'value', value: signed.value, ambiguousUnit };
}

function validateStringField(fieldId: string, text: string, today: string): Validated<string> {
  if (fieldId === FIELD.pan) return validatePan(text);
  if (fieldId === FIELD.gstin) return validateGstin(text);
  if (DATE_FIELDS.has(fieldId)) return parseDate(text, { today });
  if (fieldId === FIELD.fyLabel) return normalizeFinancialYear(text);
  return { ok: true, value: text.slice(0, MAX_STRING_LENGTH) };
}

function normalizeString(definition: FieldDefinition, raw: RawField, today: string): Normalized {
  const text = raw.rawValue.replace(/\s+/g, ' ').trim();
  const parsed = validateStringField(definition.fieldId, text, today);
  return parsed.ok ? { kind: 'value', value: parsed.value, ambiguousUnit: false } : rejected;
}

function normalizeEnum(definition: FieldDefinition, raw: RawField): Normalized {
  const value = raw.enumValue ?? raw.rawValue.trim();
  if (value === 'not_provided') return { kind: 'absent' };
  if (!definition.allowedValues.includes(value)) return rejected;
  // A document can establish "yes" or "available". Anything else proves nothing.
  if (definition.policy === 'positive_only' && value !== 'yes' && value !== 'available') {
    return { kind: 'absent' };
  }
  return { kind: 'value', value, ambiguousUnit: false };
}

function normalizeValue(
  definition: FieldDefinition,
  raw: RawField,
  documentType: DocumentType,
  today: string
): Normalized {
  if (PLACEHOLDER.test(raw.rawValue.trim()) && !raw.enumValue) return { kind: 'absent' };
  if (definition.valueType === 'number') return normalizeNumber(definition, raw, documentType);
  if (definition.valueType === 'enum') return normalizeEnum(definition, raw);
  return normalizeString(definition, raw, today);
}

// ---------------------------------------------------------- Candidate provenance

export interface DocumentContext {
  documentId: string;
  fileName: string;
  documentType: DocumentType;
  kind: AcceptedFileKind;
  /** Real sheet names, so a model-supplied name cannot point nowhere. */
  sheetNames: readonly string[];
  /** What the server read from the file itself. Never leaves extraction. */
  source: DocumentSource;
  injectionSuspected: boolean;
  today: string;
}

function buildSource(raw: RawLocation, ctx: DocumentContext): SourceRef {
  const isXlsx = ctx.kind === 'xlsx';
  const sheetName = isXlsx && raw.sheetName && ctx.sheetNames.includes(raw.sheetName) ? raw.sheetName : null;
  let cellRef: string | null = null;
  if (isXlsx && raw.cellRef && /^[A-Z]{1,3}[1-9]\d*$/.test(raw.cellRef)) cellRef = raw.cellRef;
  if (ctx.kind === 'csv' && raw.cellRef && /^row:[1-9]\d*$/.test(raw.cellRef)) cellRef = raw.cellRef;
  return {
    documentId: ctx.documentId,
    fileName: ctx.fileName,
    documentType: ctx.documentType,
    page: ctx.kind === 'pdf' ? raw.page : null,
    sheetName,
    cellRef,
    snippet: raw.snippet.trim().slice(0, DOCUMENT_AI_LIMITS.maxSnippetLength),
  };
}

/** Account last 4, or a credit report's subject. Never a full account number or an identifier. */
export function maskSubjectRef(raw: string | null, documentType: DocumentType): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (documentType === 'bank_statement') {
    const digits = text.replace(/\D/g, '');
    return digits.length >= 4 ? `XXXX${digits.slice(-4)}` : null;
  }
  if (documentType !== 'credit_report') return null;
  return /\d{4,}|[A-Z]{5}\d{4}[A-Z]/i.test(text) ? null : text.slice(0, 80);
}

const roundConfidence = (confidence: number) => Math.round(confidence * 100) / 100;

// ------------------------------------------------------------- Single-candidate rules

export interface SettleContext {
  threshold: number;
  today: string;
  /** Documents flagged injectionSuspected. */
  injectedDocuments: ReadonlySet<string>;
}

/** Rule 1 and rule 2 of section 4.2. A non-direct candidate needs the derivation its field names. */
function isDroppedCandidate(candidate: ExtractedField, definition: FieldDefinition | undefined): boolean {
  if (!definition || !definition.extractable) return true;
  if (!(candidate.confidence >= DOCUMENT_AI_THRESHOLDS.discardBelow) || candidate.confidence > 1) return true;
  if (definition.extractionMode === 'direct') return false;
  const { derivation } = candidate;
  return !derivation || derivation.ruleId !== definition.derivation || derivation.fromCandidateIds.length === 0;
}

/** Re-checks the stored value, since a candidate's input status is only a placeholder. */
function recheckValue(definition: FieldDefinition, value: FieldValue | null, today: string): FieldValue | null {
  if (value === null) return null;
  if (definition.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const signed = applySignPolicy(value, definition.signPolicy);
    return signed.ok && withinRange(definition, signed.value) ? signed.value : null;
  }
  if (typeof value !== 'string') return null;
  if (definition.valueType === 'enum') return definition.allowedValues.includes(value) ? value : null;
  const checked = validateStringField(definition.fieldId, value, today);
  return checked.ok ? checked.value : null;
}

function isNonInrRaw(definition: FieldDefinition, candidate: ExtractedField): boolean {
  if (definition.unit !== 'currency') return false;
  const parsed = parseIndianAmount(candidate.rawValue, { documentType: candidate.source.documentType });
  return !parsed.ok && parsed.code === 'non_inr_currency';
}

function isReviewOnlyEnum(definition: FieldDefinition): boolean {
  return definition.policy === 'explicit_request' || definition.alwaysReview === true;
}

/** Section 4.2: an enum is a judgement, so it needs its own evidence, or a person. */
function enumReasons(definition: FieldDefinition, candidate: ExtractedField, value: FieldValue): FieldReasonCode[] {
  if (isReviewOnlyEnum(definition)) return ['enum_review_required'];
  return findEnumEvidence(definition, value, candidate.source.snippet).length > 0 ? [] : ['enum_no_evidence'];
}

/** A bank statement's trailing Cr marks a credit, except beside a limit (section 6.3). */
function hasCreditMarker(definition: FieldDefinition, documentType: DocumentType): boolean {
  return documentType === 'bank_statement' && definition.amountNature !== 'limit';
}

/** Section 6.3: the unit in rawValue, the stated unit and the page must all agree. */
function unitReasons(definition: FieldDefinition, candidate: ExtractedField): FieldReasonCode[] {
  const { snippet, documentType } = candidate.source;
  const reasons: FieldReasonCode[] = [];
  const unitText = candidate.unitText ?? '';
  if (hasForeignUnit(`${snippet} ${unitText} ${candidate.rowLabel ?? ''}`)) reasons.push('non_inr_unit');

  const statedUnit = candidate.statedUnit ?? null;
  const parsed = parseFieldAmount(definition, candidate.rawValue, documentType, statedUnit);
  const snippetAgrees =
    !parsed.ok ||
    unitAgreesWithSnippet({
      rawValue: candidate.rawValue,
      inlineUnit: parsed.inlineUnit,
      statedUnit,
      snippet,
      creditMarker: hasCreditMarker(definition, documentType),
      rowText: candidate.rowLabel,
      unitText: candidate.unitText,
    });
  if (!snippetAgrees || (statedUnit !== null && !unitTextSupports(statedUnit, candidate.unitText))) {
    reasons.push('unit_mismatch');
  }
  return reasons;
}

/** Section 4.3: only a full-year figure may fill an annual flow field. */
function isPartYear(definition: FieldDefinition, candidate: ExtractedField): boolean {
  if (!definition.annualFlow) return false;
  if (candidate.period !== null && !isFinancialYearLabel(candidate.period)) return true;
  return hasPartYearWording(`${candidate.source.snippet} ${candidate.unitText ?? ''}`);
}

/** The checks that read the document's wording. A derived value has no wording of its own. */
function wordingReasons(definition: FieldDefinition, candidate: ExtractedField, value: FieldValue): FieldReasonCode[] {
  const reasons: FieldReasonCode[] = [];
  if (definition.valueType === 'enum') reasons.push(...enumReasons(definition, candidate, value));
  if (definition.unit === 'currency') reasons.push(...unitReasons(definition, candidate));
  if (isPartYear(definition, candidate)) reasons.push('part_year_period');
  const wording = `${candidate.source.snippet} ${candidate.rowLabel ?? ''}`;
  const isPositiveSigned = definition.signPolicy === 'signed' && typeof value === 'number' && value > 0;
  if (isPositiveSigned && positiveValueDoubted(wording, candidate.sourceSign)) reasons.push('loss_wording');
  return reasons;
}

function snippetShowsValue(definition: FieldDefinition, candidate: ExtractedField): boolean {
  const { snippet } = candidate.source;
  if (definition.valueType === 'enum') return snippet.trim().length > 0;
  // rawValue first: a scaled value is not what the page prints.
  const shown = candidate.rawValue.trim() || String(candidate.value ?? '');
  return rawValueInSnippet(shown, snippet, definition.valueType === 'number' ? 'number' : 'string');
}

/**
 * Section 4.2, in full, so nothing reaches auto_applied by any path. Input status and reasons are
 * placeholders, except ambiguous_unit, which needs the stated unit and cannot be recomputed.
 * Returns null for a dropped candidate. Idempotent.
 */
export function settleCandidate(
  candidate: ExtractedField,
  ctx: SettleContext,
  extraReasons: FieldReasonCode[] = []
): ExtractedField | null {
  const definition = getFieldDefinition(candidate.fieldId);
  if (isDroppedCandidate(candidate, definition) || !definition) return null;

  const { documentType } = candidate.source;
  const isDerived = candidate.derivation !== undefined;
  const nonInr = isNonInrRaw(definition, candidate);
  const periodEnd = periodEndDate(candidate.period);
  const value = nonInr ? null : recheckValue(definition, candidate.value, ctx.today);
  const isRejected =
    value === null ||
    // cma_projection is never a source for historical figures, nor bank credits for turnover.
    (documentType === 'cma_projection' && isPeriodGrouped(definition)) ||
    (documentType === 'bank_statement' && TURNOVER_FIELDS.has(definition.fieldId)) ||
    (isPeriodGrouped(definition) && periodEnd !== null && periodEnd > ctx.today);

  const reasons = new Set<FieldReasonCode>(extraReasons);
  if (candidate.reasons.includes('ambiguous_unit')) reasons.add('ambiguous_unit');
  if (isRejected) reasons.add('validation_failed');
  if (nonInr) reasons.add('non_inr_currency');
  if (candidate.confidence < ctx.threshold) reasons.add('low_confidence');
  if (!isDerived && !snippetShowsValue(definition, candidate)) reasons.add('value_not_in_snippet');
  if (!definition.sourceDocumentTypes.includes(documentType)) reasons.add('unexpected_source_type');
  if (ctx.injectedDocuments.has(candidate.source.documentId)) reasons.add('injection_suspected');
  if (!isDerived && definition.periodScoped && candidate.period === null) reasons.add('period_unknown');
  if (isDerived) reasons.add('derived_value');
  if (candidate.sourceCheck === 'failed') reasons.add('not_in_source');
  if (!isDerived && value !== null) {
    for (const reason of wordingReasons(definition, candidate, value)) reasons.add(reason);
  }

  const capped = reasons.size > 0 || definition.target.kind === 'review_only';
  return {
    ...candidate,
    value: isRejected ? null : value,
    reasons: [...reasons],
    status: isRejected ? 'rejected_validation' : capped ? 'needs_verification' : 'auto_applied',
  };
}

/** Compares the candidate with what the server read. The answer travels with it, since merge cannot. */
function checkAgainstSource(
  verify: SourceVerifier,
  definition: FieldDefinition,
  raw: RawField,
  source: SourceRef,
  value: FieldValue | null
): SourceFinding {
  if (value === null) return { check: 'no_text', rowLabel: null };
  const parsed =
    definition.unit === 'currency'
      ? parseFieldAmount(definition, raw.rawValue, source.documentType, raw.statedUnit)
      : null;
  return verify({
    valueType: definition.valueType,
    rawValue: raw.rawValue,
    value,
    snippet: source.snippet,
    unitText: raw.unitText,
    sheetName: source.sheetName,
    cellRef: source.cellRef,
    inlineUnit: parsed?.ok ? parsed.inlineUnit : null,
    creditMarker: hasCreditMarker(definition, source.documentType),
    evidence: definition.valueType === 'enum' ? findEnumEvidence(definition, value, source.snippet) : [],
    wantRowLabel: definition.signPolicy === 'signed' || definition.unit === 'currency',
  });
}

/** Parses and normalises the model's output. The status set here is provisional: merge re-settles it. */
export function buildCandidates(
  rawFields: RawField[],
  ctx: DocumentContext
): { fields: ExtractedField[]; droppedLowConfidence: number } {
  const fields: ExtractedField[] = [];
  const counters = new Map<string, number>();
  const settleContext: SettleContext = {
    threshold: DOCUMENT_AI_THRESHOLDS.defaultAutoApply,
    today: ctx.today,
    injectedDocuments: new Set(ctx.injectionSuspected ? [ctx.documentId] : []),
  };
  const verify = createSourceVerifier(ctx.source);
  let droppedLowConfidence = 0;

  for (const raw of rawFields) {
    const definition = getFieldDefinition(raw.fieldId);
    if (!definition || !definition.extractable || definition.extractionMode !== 'direct') continue;
    // Section 4.2: an explicit request has only the allowed sources. This is what stops an
    // existing sanction letter from supplying requestedAmount.
    if (definition.policy === 'explicit_request' && !definition.sourceDocumentTypes.includes(ctx.documentType)) {
      continue;
    }

    const confidence = roundConfidence(raw.confidence);
    if (!(confidence >= DOCUMENT_AI_THRESHOLDS.discardBelow) || confidence > 1) {
      droppedLowConfidence += 1;
      continue;
    }

    const normalized = normalizeValue(definition, raw, ctx.documentType, ctx.today);
    if (normalized.kind === 'absent') continue;
    const isValue = normalized.kind === 'value';

    const n = counters.get(definition.fieldId) ?? 0;
    counters.set(definition.fieldId, n + 1);

    const source = buildSource(raw, ctx);
    const value = isValue ? normalized.value : null;
    const finding = checkAgainstSource(verify, definition, raw, source, value);

    const settled = settleCandidate(
      {
        candidateId: `${ctx.documentId}:${definition.fieldId}:${n}`,
        fieldId: definition.fieldId,
        value,
        rawValue: raw.rawValue,
        confidence,
        source,
        status: 'needs_verification',
        reasons: isValue && normalized.ambiguousUnit ? ['ambiguous_unit'] : [],
        period:
          definition.fieldId === FIELD.fyLabel && isValue
            ? String(normalized.value)
            : normalizePeriod(raw.period, ctx.today),
        subjectRef: maskSubjectRef(raw.subjectRef, ctx.documentType),
        statedUnit: raw.statedUnit,
        unitText: raw.unitText,
        sourceCheck: finding.check,
        rowLabel: finding.rowLabel,
        ...(finding.sourceSign ? { sourceSign: finding.sourceSign } : {}),
      },
      settleContext
    );
    if (settled) fields.push(settled);
  }
  return { fields, droppedLowConfidence };
}

function parseBankAmount(raw: string | null, row: RawBankMonth, verify: SourceVerifier): number | null {
  if (raw === null) return null;
  const parsed = parseIndianAmount(raw, { statedUnit: row.statedUnit, documentType: 'bank_statement' });
  if (!parsed.ok || parsed.ambiguousUnit) return null;
  if (hasForeignUnit(`${row.snippet} ${row.unitText ?? ''}`)) return null;
  if (row.statedUnit !== null && !unitTextSupports(row.statedUnit, row.unitText)) return null;
  const unitAgrees = unitAgreesWithSnippet({
    rawValue: raw,
    inlineUnit: parsed.inlineUnit,
    statedUnit: row.statedUnit,
    snippet: row.snippet,
    creditMarker: true,
    unitText: row.unitText,
  });
  if (!unitAgrees) return null;
  // The figure must be on the page the snippet quotes. A model total that is not there is a guess.
  if (!rawValueInSnippet(raw, row.snippet, 'number')) return null;
  const finding = verify({
    valueType: 'number',
    rawValue: raw,
    value: parsed.value,
    snippet: row.snippet,
    unitText: row.unitText,
    sheetName: row.sheetName,
    cellRef: row.cellRef,
    inlineUnit: parsed.inlineUnit,
    creditMarker: true,
    evidence: [],
    wantRowLabel: false,
  });
  return finding.check === 'failed' ? null : parsed.value;
}

/**
 * The server parses the amounts. Rows that say nothing usable are dropped, never repaired. A PDF the
 * server could not read proves no row false, so its rows stay, marked failed: what is worked out
 * from them then carries not_in_source to the reviewer, where a drop would leave nothing to see.
 */
export function buildBankMonthlyTotals(rows: RawBankMonth[], ctx: DocumentContext): BankMonthlyTotal[] {
  if (ctx.documentType !== 'bank_statement') return [];
  const unreadable = ctx.source.kind === 'unreadable';
  const verify: SourceVerifier = unreadable
    ? () => ({ check: 'no_text', rowLabel: null })
    : createSourceVerifier(ctx.source);
  const totals: BankMonthlyTotal[] = [];
  for (const row of rows) {
    const confidence = roundConfidence(row.confidence);
    if (!(confidence >= DOCUMENT_AI_THRESHOLDS.discardBelow) || confidence > 1) continue;
    const month = row.month.trim();
    const monthStart = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : null;
    if (!monthStart || monthStart > ctx.today) continue;
    const totalCredits = parseBankAmount(row.totalCredits, row, verify);
    const closingBalance = parseBankAmount(row.closingBalance, row, verify);
    if (totalCredits === null && closingBalance === null) continue;
    totals.push({
      month,
      totalCredits,
      closingBalance,
      subjectRef: maskSubjectRef(row.subjectRef, ctx.documentType),
      source: buildSource(row, ctx),
      confidence,
      ...(unreadable ? { sourceCheck: 'failed' as const } : {}),
    });
  }
  return totals;
}

// ------------------------------------------------------------------- Identity check

interface IdentityOutcome {
  /** Documents whose candidates all take identity_mismatch. */
  mismatchedDocuments: Set<string>;
  /** Any GSTIN or non-P PAN in the session, which stops a P PAN card naming the applicant. */
  hasNonIndividualIdentity: boolean;
}

function checkIdentity(candidates: ExtractedField[]): IdentityOutcome {
  const eligible = candidates.filter((c) => c.status !== 'rejected_validation' && typeof c.value === 'string');
  const gstinPans = eligible
    .filter((c) => c.fieldId === FIELD.gstin)
    .map((c) => ({ pan: gstinEmbeddedPan(c.value as string), documentId: c.source.documentId }));
  const entityPans = eligible
    .filter((c) => c.fieldId === FIELD.pan && (c.value as string)[3] !== 'P')
    .map((c) => ({ pan: c.value as string, documentId: c.source.documentId }));

  const hasNonIndividualIdentity =
    entityPans.length > 0 || gstinPans.some((identity) => identity.pan[3] !== 'P');

  const distinctGstinPans = new Set(gstinPans.map((identity) => identity.pan));
  const mismatch =
    distinctGstinPans.size > 1 ||
    (distinctGstinPans.size === 1 && entityPans.some((identity) => !distinctGstinPans.has(identity.pan)));
  if (!mismatch) return { mismatchedDocuments: new Set(), hasNonIndividualIdentity };

  const documentsByPan = new Map<string, Set<string>>();
  for (const { pan, documentId } of [...gstinPans, ...entityPans]) {
    documentsByPan.set(pan, (documentsByPan.get(pan) ?? new Set()).add(documentId));
  }
  const allDocuments = new Set([...gstinPans, ...entityPans].map((identity) => identity.documentId));
  const majority = [...documentsByPan.values()].find((documents) => documents.size > allDocuments.size / 2);
  if (!majority) return { mismatchedDocuments: allDocuments, hasNonIndividualIdentity };

  const majorityPan = [...documentsByPan.entries()].find(([, documents]) => documents === majority)?.[0];
  const mismatchedDocuments = new Set(
    [...gstinPans, ...entityPans].filter(({ pan }) => pan !== majorityPan).map((identity) => identity.documentId)
  );
  return { mismatchedDocuments, hasNonIndividualIdentity };
}

// --------------------------------------------------------------------- Precedence

interface DocumentFacts {
  index: number;
  /** Audited, provisional or management, from the document's own statement. */
  dataSource: FieldValue | null;
  reportDate: string | null;
}

const FINANCIAL_GROUP = new Set([
  'annualRevenue', 'previousAnnualRevenue', 'gstAnnualTurnover', 'netProfitAfterTax', 'ebitda', 'ebit',
  'depreciation', 'amortization', 'interestExpense', 'currentAssets', 'currentLiabilities', 'totalAssets',
  'totalLiabilities', 'totalOutstandingBorrowings', 'totalOutsideLiabilities', 'tangibleNetWorth',
  'shareholdersEquity', 'operatingCashFlow', 'dataSource', 'financialYearLabel',
].map((key) => `financialProfile.${key}`));
const IDENTITY_GROUP = new Set([
  FIELD.applicantLabel, FIELD.entityType, 'industrySector', 'businessVintageYears',
  FIELD.pan, FIELD.gstin, FIELD.establishment,
]);
const BUREAU_GROUP = new Set([
  FIELD.personalScore, FIELD.promoterScore, FIELD.reportDate,
  ...['commercialCmrRank', 'commercialCreditReportStatus', 'existingCorporateBorrowingExposure', 'delinquencies'].map(
    (key) => `financialProfile.${key}`
  ),
]);
const FACILITY_GROUP = new Set(
  ['existingMonthlyEmi', 'annualScheduledPrincipalRepayments', 'ccOdSanctionedLimit', 'ccOdUtilisation'].map(
    (key) => `financialProfile.${key}`
  )
);

const IDENTITY_ORDER: readonly DocumentType[] = [
  'registration_certificate', 'gst_certificate', 'pan_card', 'itr', 'financial_statement',
];
const FACILITY_ORDER: readonly DocumentType[] = [
  'existing_sanction_letter', 'bank_statement', 'credit_report', 'loan_application',
];

function orderRank(order: readonly DocumentType[], type: DocumentType): number {
  const index = order.indexOf(type);
  return index === -1 ? order.length : index;
}

function financialRank(type: DocumentType, facts: DocumentFacts | undefined): number {
  switch (type) {
    case 'financial_statement':
      if (facts?.dataSource === 'audited') return 0;
      return facts?.dataSource === 'management' ? 4 : 3;
    case 'itr':
      return 1;
    case 'gst_return':
      return 2;
    case 'loan_application':
      return 5;
    default:
      return 6;
  }
}

function precedenceRank(fieldId: string, candidate: ExtractedField, facts: DocumentFacts | undefined): number {
  const type = candidate.source.documentType;
  // A turnover mirror keeps the group of the field it copies.
  if (FINANCIAL_GROUP.has(fieldId) || fieldId === FIELD.turnoverMirror) return financialRank(type, facts);
  if (IDENTITY_GROUP.has(fieldId)) return orderRank(IDENTITY_ORDER, type);
  if (BUREAU_GROUP.has(fieldId)) return type === 'credit_report' ? 0 : 1;
  if (FACILITY_GROUP.has(fieldId)) return orderRank(FACILITY_ORDER, type);
  return 0;
}

function strongest(fieldId: string, candidates: ExtractedField[], facts: Map<string, DocumentFacts>): ExtractedField {
  const reportDate = (c: ExtractedField) => facts.get(c.source.documentId)?.reportDate ?? '';
  const order = (a: ExtractedField, b: ExtractedField): number => {
    const rank =
      precedenceRank(fieldId, a, facts.get(a.source.documentId)) -
      precedenceRank(fieldId, b, facts.get(b.source.documentId));
    if (rank !== 0) return rank;
    if (BUREAU_GROUP.has(fieldId) && reportDate(a) !== reportDate(b)) {
      return reportDate(b).localeCompare(reportDate(a));
    }
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    // The documents array is the session's upload order, so later means a later upload.
    const upload = (facts.get(b.source.documentId)?.index ?? 0) - (facts.get(a.source.documentId)?.index ?? 0);
    return upload !== 0 ? upload : a.candidateId.localeCompare(b.candidateId);
  };
  return [...candidates].sort(order)[0];
}

// ----------------------------------------------------------------- Field resolution

function unionReasons(candidates: ExtractedField[]): FieldReasonCode[] {
  return [...new Set(candidates.flatMap((candidate) => candidate.reasons))].filter(
    (reason) => !NON_CAPPING_REASONS.has(reason)
  );
}

function everyPairAgrees(definition: FieldDefinition, candidates: ExtractedField[]): boolean {
  return candidates.every((a, i) =>
    candidates.slice(i + 1).every((b) => fieldValuesEqual(definition, a.value as FieldValue, b.value as FieldValue))
  );
}

function conflictResult(
  fieldId: string,
  candidates: ExtractedField[],
  contenders: ExtractedField[],
  facts: Map<string, DocumentFacts>
): FieldResult {
  return {
    fieldId,
    status: 'conflict',
    value: null,
    confidence: Math.max(...contenders.map((candidate) => candidate.confidence)),
    source: null,
    reasons: ['values_differ'],
    candidates,
    suggestedCandidateId: strongest(fieldId, contenders, facts).candidateId,
    mirrorOf: null,
    overriddenByUser: false,
  };
}

function resolveField(
  definition: FieldDefinition,
  candidates: ExtractedField[],
  facts: Map<string, DocumentFacts>
): { result: FieldResult; multipleSubjects: boolean } {
  const { fieldId } = definition;
  const eligible = candidates.filter((candidate) => candidate.status !== 'rejected_validation');

  if (eligible.length === 0) {
    return {
      multipleSubjects: false,
      result: {
        fieldId,
        status: 'rejected_validation',
        value: null,
        confidence: Math.max(...candidates.map((candidate) => candidate.confidence)),
        source: candidates[0].source,
        reasons: unionReasons(candidates),
        candidates,
        suggestedCandidateId: null,
        mirrorOf: null,
        overriddenByUser: false,
      },
    };
  }

  // Section 4.3: a part-year figure never beats a full-year one, and never casts doubt on it.
  const fullYear = eligible.filter((candidate) => !candidate.reasons.includes('part_year_period'));
  const contenders = fullYear.length > 0 ? fullYear : eligible;
  const setAside = new Set(eligible.filter((candidate) => !contenders.includes(candidate)));

  // Runs before the period logic: two accounts are not two periods of one account.
  const subjects = new Set(
    eligible.flatMap((candidate) =>
      candidate.subjectRef ? [normalizeComparableString(candidate.subjectRef)] : []
    )
  );
  if (subjects.size > 1) {
    const suggested = strongest(fieldId, contenders, facts);
    return {
      multipleSubjects: true,
      result: {
        fieldId,
        status: 'needs_verification',
        value: suggested.value,
        confidence: suggested.confidence,
        source: suggested.source,
        reasons: ['multiple_subjects'],
        candidates,
        suggestedCandidateId: suggested.candidateId,
        mirrorOf: null,
        overriddenByUser: false,
      },
    };
  }

  let group = contenders;
  let listed = candidates.map((candidate) =>
    setAside.has(candidate) ? { ...candidate, reasons: [...candidate.reasons, 'superseded_period' as const] } : candidate
  );
  let undated: ExtractedField[] = [];
  if (isPeriodGrouped(definition)) {
    const dated = contenders.filter((candidate) => periodEndDate(candidate.period) !== null);
    if (dated.length > 0) {
      const latestEnd = dated.reduce(
        (latest, candidate) => {
          const end = periodEndDate(candidate.period) as string;
          return end > latest ? end : latest;
        },
        ''
      );
      group = dated.filter((candidate) => periodEndDate(candidate.period) === latestEnd);
      undated = contenders.filter((candidate) => periodEndDate(candidate.period) === null);
      listed = candidates.map((candidate) => {
        const end = periodEndDate(candidate.period);
        const superseded = end !== null && end < latestEnd && candidate.status !== 'rejected_validation';
        return superseded || setAside.has(candidate)
          ? { ...candidate, reasons: [...candidate.reasons, 'superseded_period' as const] }
          : candidate;
      });
    }
  }

  if (!everyPairAgrees(definition, group)) {
    return { multipleSubjects: false, result: conflictResult(fieldId, listed, group, facts) };
  }

  const mostPrecise = Math.max(...group.map((candidate) => significantDigits(candidate.value as FieldValue)));
  const chosen = strongest(
    fieldId,
    group.filter((candidate) => significantDigits(candidate.value as FieldValue) === mostPrecise),
    facts
  );

  const reasons = unionReasons(group);
  // A figure with no stated period, which disagrees, might be this period or another. Say so.
  const undatedDisagrees = undated.some(
    (candidate) => !fieldValuesEqual(definition, candidate.value as FieldValue, chosen.value as FieldValue)
  );
  if (undatedDisagrees && !reasons.includes('period_unknown')) reasons.push('period_unknown');

  const needsReview = undatedDisagrees || group.some((candidate) => candidate.status === 'needs_verification');
  return {
    multipleSubjects: false,
    result: {
      fieldId,
      status: needsReview ? 'needs_verification' : 'auto_applied',
      value: chosen.value,
      confidence: Math.max(...group.map((candidate) => candidate.confidence)),
      source: chosen.source,
      reasons,
      candidates: listed,
      suggestedCandidateId: chosen.candidateId,
      mirrorOf: null,
      overriddenByUser: false,
    },
  };
}

// ---------------------------------------------------------------- Session rewrites

/** An older statement's revenue, for exactly the prior year, is that year's previous revenue. */
function previousRevenueCandidates(candidates: ExtractedField[]): ExtractedField[] {
  const revenues = candidates.filter(
    (candidate) =>
      candidate.fieldId === FIELD.revenue &&
      candidate.status !== 'rejected_validation' &&
      !candidate.reasons.includes('part_year_period')
  );
  const latestPeriod = revenues.reduce<string | null>((latest, candidate) => {
    const end = periodEndDate(candidate.period);
    return end !== null && end > (periodEndDate(latest) ?? '') ? candidate.period : latest;
  }, null);
  const priorPeriod = previousFinancialYear(latestPeriod);
  if (!priorPeriod) return [];
  return revenues
    .filter((candidate) => candidate.period === priorPeriod)
    .map((candidate, n) => ({
      ...candidate,
      candidateId: `${candidate.source.documentId}:${FIELD.previousRevenue}:p${n}`,
      fieldId: FIELD.previousRevenue,
    }));
}

/** Section 4.5: who a report on an individual speaks for depends on the applicant. */
function routeCreditScores(candidates: ExtractedField[]): ExtractedField[] {
  const entityValues = new Set(
    candidates
      .filter((c) => c.fieldId === FIELD.entityType && c.status !== 'rejected_validation')
      .map((c) => c.value as FieldValue)
  );
  // Unestablished entity: leave them as read. The prompt already sends individuals to personal.
  if (entityValues.size !== 1) return candidates;
  const isCompany = !SINGLE_PERSON_ENTITIES.has([...entityValues][0]);
  const from = isCompany ? FIELD.personalScore : FIELD.promoterScore;
  const to = isCompany ? FIELD.promoterScore : FIELD.personalScore;
  return candidates.map((candidate) => (candidate.fieldId === from ? { ...candidate, fieldId: to } : candidate));
}

function hasUsableValue(result: FieldResult | undefined): result is FieldResult {
  return result !== undefined && result.status !== 'rejected_validation';
}

function mirrorResult(
  definition: FieldDefinition,
  primary: FieldResult,
  isFallback: boolean
): FieldResult {
  const candidates = primary.candidates.map((candidate) => {
    const copy = { ...candidate, fieldId: definition.fieldId };
    if (!isFallback) return copy;
    return {
      ...copy,
      status: copy.status === 'auto_applied' ? ('needs_verification' as const) : copy.status,
      reasons: [...new Set<FieldReasonCode>([...copy.reasons, 'fallback_source'])],
    };
  });
  const capped = isFallback && primary.status === 'auto_applied';
  return {
    ...primary,
    fieldId: definition.fieldId,
    status: capped ? 'needs_verification' : primary.status,
    reasons:
      isFallback && primary.status !== 'conflict'
        ? [...new Set<FieldReasonCode>([...primary.reasons, 'fallback_source'])]
        : primary.reasons,
    candidates,
    mirrorOf: primary.fieldId,
  };
}

/** Section 4.3: revenue and GST turnover for the same period must agree, or turnover is a conflict. */
function applyTurnoverCrossCheck(
  mirror: FieldResult | undefined,
  fields: Record<string, FieldResult>,
  facts: Map<string, DocumentFacts>
): FieldResult | undefined {
  const revenue = fields[FIELD.revenue];
  const gst = fields[FIELD.gstTurnover];
  if (!mirror || mirror.mirrorOf !== FIELD.revenue || !revenue?.source || !gst || mirror.status === 'conflict') {
    return mirror;
  }
  const chosen = revenue.candidates.find((candidate) => candidate.candidateId === revenue.suggestedCandidateId);
  if (!chosen?.period || typeof revenue.value !== 'number') return mirror;

  const comparable = (candidate: ExtractedField) =>
    candidate.period === chosen.period &&
    candidate.status !== 'rejected_validation' &&
    !candidate.reasons.includes('part_year_period');
  const eligibleRevenue = revenue.candidates.filter(comparable);
  const eligibleGst = gst.candidates.filter(comparable);
  const differs = eligibleGst.some(
    (candidate) => !currencyEqual(revenue.value as number, candidate.value as number)
  );
  if (!differs) return mirror;

  const contenders = [...eligibleRevenue, ...eligibleGst].map((candidate) => ({
    ...candidate,
    fieldId: FIELD.turnoverMirror,
  }));
  const allCandidates = [...mirror.candidates, ...gst.candidates.map((c) => ({ ...c, fieldId: FIELD.turnoverMirror }))];
  return {
    ...conflictResult(FIELD.turnoverMirror, allCandidates, contenders, facts),
    mirrorOf: FIELD.revenue,
  };
}

const GST_COMPLIANCE_TO_FORM: Readonly<Record<string, string>> = {
  compliant: 'yes',
  not_compliant: 'no',
  not_applicable: 'no',
};

/** Unlike other derivations, this keeps the source's status. */
function gstCompliantResult(status: FieldResult | undefined): FieldResult | undefined {
  if (!hasUsableValue(status)) return undefined;
  const candidates = status.candidates.flatMap((candidate): ExtractedField[] => {
    const value = GST_COMPLIANCE_TO_FORM[String(candidate.value)];
    if (!value) return [];
    return [
      {
        ...candidate,
        fieldId: FIELD.gstCompliant,
        value,
        derivation: { ruleId: 'gst_compliance_mirror', fromCandidateIds: [candidate.candidateId] },
      },
    ];
  });
  if (candidates.length === 0) return undefined;
  const value = status.value === null ? null : (GST_COMPLIANCE_TO_FORM[String(status.value)] ?? null);
  return { ...status, fieldId: FIELD.gstCompliant, value, candidates, mirrorOf: FIELD.gstCompliance };
}

// ---------------------------------------------------------------------- The merge

function collectDocumentFacts(documents: DocumentExtractionSuccess[]): Map<string, DocumentFacts> {
  return new Map(
    documents.map((document, index) => {
      const eligible = document.fields.filter((c) => c.value !== null);
      return [
        document.documentId,
        {
          index,
          dataSource: eligible.find((c) => c.fieldId === FIELD.dataSource)?.value ?? null,
          reportDate: (eligible.find((c) => c.fieldId === FIELD.reportDate)?.value as string | undefined) ?? null,
        },
      ];
    })
  );
}

export function mergeSession(input: MergeSessionInput): MergeSessionOutput {
  const { documents, editedFieldIds, autoApplyThreshold: threshold, today } = input;
  const warnings: SessionWarning[] = [];
  const facts = collectDocumentFacts(documents);

  const injected = documents.filter((document) => document.injectionSuspected);
  const context: SettleContext = {
    threshold,
    today,
    injectedDocuments: new Set(injected.map((document) => document.documentId)),
  };

  const settled = documents
    .flatMap((document) => document.fields)
    .flatMap((candidate) => settleCandidate(candidate, context) ?? []);

  const identity = checkIdentity(settled);
  if (identity.mismatchedDocuments.size > 0) {
    warnings.push({
      code: 'identity_mismatch',
      documentIds: [...identity.mismatchedDocuments],
      fieldIds: [FIELD.pan, FIELD.gstin],
    });
  }
  if (injected.length > 0) {
    warnings.push({
      code: 'injection_suspected',
      documentIds: injected.map((document) => document.documentId),
      fieldIds: [],
    });
  }

  const individualPanCards = new Set(
    documents
      .filter(
        (document) =>
          document.documentType === 'pan_card' &&
          document.fields.some((c) => c.fieldId === FIELD.pan && String(c.value)[3] === 'P')
      )
      .map((document) => document.documentId)
  );

  /** Carries identity_mismatch on to every candidate of a minority document, copies included. */
  const settleInSession = (candidate: ExtractedField) =>
    settleCandidate(
      candidate,
      context,
      identity.mismatchedDocuments.has(candidate.source.documentId) ? ['identity_mismatch'] : []
    ) ?? [];

  const direct = routeCreditScores(
    settled
      .filter(
        (candidate) =>
          !(
            identity.hasNonIndividualIdentity &&
            candidate.fieldId === FIELD.applicantLabel &&
            individualPanCards.has(candidate.source.documentId)
          )
      )
      .flatMap(settleInSession)
  );

  const withPrevious = [...direct, ...previousRevenueCandidates(direct).flatMap(settleInSession)];
  const derived = deriveCandidates(withPrevious, documents, today).flatMap(settleInSession);
  const all = [...withPrevious, ...derived];

  const byField = new Map<string, ExtractedField[]>();
  for (const candidate of all) {
    byField.set(candidate.fieldId, [...(byField.get(candidate.fieldId) ?? []), candidate]);
  }

  const fields: Record<string, FieldResult> = {};
  for (const definition of FIELD_DEFINITIONS) {
    const candidates = byField.get(definition.fieldId);
    if (!candidates || candidates.length === 0) continue;
    const { result, multipleSubjects } = resolveField(definition, candidates, facts);
    fields[definition.fieldId] = result;
    if (multipleSubjects) {
      warnings.push({
        code: 'multiple_subjects',
        documentIds: [...new Set(candidates.map((candidate) => candidate.source.documentId))],
        fieldIds: [definition.fieldId],
      });
    }
  }

  for (const definition of FIELD_DEFINITIONS) {
    if (definition.extractionMode !== 'mirror' || !definition.mirrorOf) continue;
    const primary = fields[definition.mirrorOf];
    if (hasUsableValue(primary)) {
      fields[definition.fieldId] = mirrorResult(definition, primary, false);
      continue;
    }
    const fallback = (definition.mirrorFallbacks ?? []).map((id) => fields[id]).find(hasUsableValue);
    if (fallback) fields[definition.fieldId] = mirrorResult(definition, fallback, true);
  }

  const turnover = applyTurnoverCrossCheck(fields[FIELD.turnoverMirror], fields, facts);
  if (turnover) fields[FIELD.turnoverMirror] = turnover;

  const gstCompliant = gstCompliantResult(fields[FIELD.gstCompliance]);
  if (gstCompliant) fields[FIELD.gstCompliant] = gstCompliant;

  const edited = new Set(editedFieldIds);
  for (const fieldId of Object.keys(fields)) {
    fields[fieldId] = { ...fields[fieldId], overriddenByUser: edited.has(fieldId) };
  }
  return { fields, warnings };
}
