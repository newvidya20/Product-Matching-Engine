/**
 * Seam between the extraction pipeline and the storage routes (docs/contracts.md section 2).
 * Handles one file at a time, and does no storage. It logs nothing: document text and extracted
 * values must not reach a log, and error paths carry only an ExtractionErrorCode.
 */
import { DOCUMENT_AI_THRESHOLDS } from '../../src/types/documentAi.ts';
import type {
  AcceptedFileKind,
  DocumentExtractionResult,
  DocumentType,
  ExtractDocumentInput,
  MergeSessionInput,
  MergeSessionOutput,
  SpreadsheetPreview,
} from '../../src/types/documentAi.ts';
import { FILE_KIND_MIME } from '../../src/types/documentAi.ts';
import type { Part } from '@google/genai';
import { ExtractionError, generateJson, geminiModelName, isLlmConfigured } from './gemini.ts';
import { buildBankMonthlyTotals, buildCandidates, mergeSession } from './merge.ts';
import {
  buildClassificationInstruction,
  buildExtractionInstruction,
  CLASSIFICATION_REQUEST,
  CLASSIFICATION_SCHEMA,
  containsInjectionPhrases,
  EXTRACTION_REQUEST,
  EXTRACTION_SCHEMA,
  fieldsToRequest,
  newDelimiter,
  parseClassificationResponse,
  parseExtractionResponse,
  wrapDocumentText,
} from './prompt.ts';
import { buildSpreadsheetPreview, parseSpreadsheet, readPdfSource, renderSpreadsheetText } from './spreadsheet.ts';
import type { DocumentSource } from './validators.ts';

/** Enough to tell a balance sheet from a bank statement, and much cheaper than the whole sheet. */
const CLASSIFICATION_TEXT_CHARS = 20_000;

function isEncryptedPdf(bytes: Uint8Array): boolean {
  // Linearised files can hold the trailer near the start, so the whole file is scanned.
  return /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(Buffer.from(bytes).toString('latin1'));
}

interface PreparedDocument {
  classificationPart: Part;
  extractionPart: Part;
  sheetNames: string[];
  /** What the server read itself, to check the model against. Held in memory only. */
  source: DocumentSource;
  /** Pattern scan hit. Only spreadsheets have text to scan before the model sees them. */
  injectionInText: boolean;
}

async function prepareDocument(input: ExtractDocumentInput): Promise<PreparedDocument> {
  const { kind, bytes, signal } = input;
  if (kind !== 'xlsx' && kind !== 'csv') {
    const part: Part = {
      inlineData: { mimeType: FILE_KIND_MIME[kind], data: Buffer.from(bytes).toString('base64') },
    };
    const source: DocumentSource = kind === 'pdf' ? await readPdfSource(bytes, signal) : { kind: 'no_text' };
    return { classificationPart: part, extractionPart: part, sheetNames: [], source, injectionInText: false };
  }

  let text;
  try {
    text = renderSpreadsheetText(await parseSpreadsheet(bytes, kind));
  } catch {
    throw new ExtractionError('unreadable_document');
  }
  if (!text.promptText.trim()) throw new ExtractionError('unreadable_document');

  const delimiter = newDelimiter();
  return {
    classificationPart: { text: wrapDocumentText(text.promptText.slice(0, CLASSIFICATION_TEXT_CHARS), delimiter) },
    extractionPart: { text: wrapDocumentText(text.promptText, delimiter) },
    sheetNames: text.visibleSheetNames,
    source: { kind: 'cells', rows: text.sourceRows },
    injectionInText: containsInjectionPhrases(text.scanText),
  };
}

async function classify(
  prepared: PreparedDocument,
  signal: AbortSignal
): Promise<{ documentType: DocumentType; confidence: number; suspicious: boolean }> {
  const response = await generateJson({
    systemInstruction: buildClassificationInstruction(),
    parts: [prepared.classificationPart, { text: CLASSIFICATION_REQUEST }],
    responseSchema: CLASSIFICATION_SCHEMA,
    signal,
  });
  const parsed = parseClassificationResponse(response);
  if (!parsed) throw new ExtractionError('llm_invalid_response');
  if (!parsed.readable) throw new ExtractionError('unreadable_document');
  const confident = parsed.confidence >= DOCUMENT_AI_THRESHOLDS.discardBelow;
  return {
    documentType: confident ? parsed.documentType : 'other',
    confidence: Math.round(Math.min(Math.max(parsed.confidence, 0), 1) * 100) / 100,
    suspicious: parsed.suspiciousInstructions,
  };
}

async function runExtraction(input: ExtractDocumentInput): Promise<DocumentExtractionResult> {
  const { documentId, fileName, kind, bytes, declaredDocumentType, today, signal } = input;

  if (kind === 'pdf' && isEncryptedPdf(bytes)) {
    return { ok: false, documentId, errorCode: 'password_protected' };
  }
  if (!isLlmConfigured()) return { ok: false, documentId, errorCode: 'llm_not_configured' };

  const prepared = await prepareDocument(input);
  const classification = declaredDocumentType
    ? { documentType: declaredDocumentType, confidence: 1, suspicious: false }
    : await classify(prepared, signal);
  const { documentType } = classification;

  // No field accepts this document type, so there is nothing to ask the model.
  if (fieldsToRequest(documentType).length === 0) {
    return {
      ok: true,
      documentId,
      documentType,
      classificationConfidence: classification.confidence,
      fields: [],
      bankMonthlyTotals: [],
      injectionSuspected: prepared.injectionInText || classification.suspicious,
      droppedLowConfidence: 0,
      model: geminiModelName(),
    };
  }

  const response = await generateJson({
    systemInstruction: buildExtractionInstruction(documentType),
    parts: [prepared.extractionPart, { text: EXTRACTION_REQUEST }],
    responseSchema: EXTRACTION_SCHEMA,
    signal,
  });
  const extraction = parseExtractionResponse(response);
  if (!extraction) throw new ExtractionError('llm_invalid_response');
  if (!extraction.readable) throw new ExtractionError('unreadable_document');

  const injectionSuspected =
    prepared.injectionInText ||
    classification.suspicious ||
    extraction.suspiciousInstructions ||
    extraction.fields.some((field) => containsInjectionPhrases(field.snippet));

  const context = {
    documentId,
    fileName,
    documentType,
    kind,
    sheetNames: prepared.sheetNames,
    source: prepared.source,
    injectionSuspected,
    today,
  };
  const { fields, droppedLowConfidence } = buildCandidates(extraction.fields, context);

  return {
    ok: true,
    documentId,
    documentType,
    classificationConfidence: classification.confidence,
    fields,
    bankMonthlyTotals: buildBankMonthlyTotals(extraction.bankMonthlyTotals, context),
    injectionSuspected,
    droppedLowConfidence,
    model: geminiModelName(),
  };
}

/** Document failures resolve to `{ ok: false }`. Only an aborted signal rejects. */
export async function extractDocument(input: ExtractDocumentInput): Promise<DocumentExtractionResult> {
  const abortError = () => new DOMException('Extraction was aborted.', 'AbortError');
  if (input.signal.aborted) throw abortError();
  try {
    return await runExtraction(input);
  } catch (error) {
    if (input.signal.aborted) throw abortError();
    // Anything else is reduced to a code here, so no provider or parser text can leave.
    return {
      ok: false,
      documentId: input.documentId,
      errorCode: error instanceof ExtractionError ? error.code : 'llm_failed',
    };
  }
}

export function mergeSessionResults(input: MergeSessionInput): MergeSessionOutput {
  return mergeSession(input);
}

export async function readSpreadsheetPreview(
  bytes: Uint8Array,
  kind: Extract<AcceptedFileKind, 'xlsx' | 'csv'>
): Promise<SpreadsheetPreview> {
  return buildSpreadsheetPreview(await parseSpreadsheet(bytes, kind));
}
